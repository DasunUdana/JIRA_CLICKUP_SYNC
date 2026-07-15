require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// Persistence files
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_FILE = path.join(process.cwd(), 'webhook_status.json');
const SCHEDULES_FILE = path.join(process.cwd(), 'schedules.json');

const WEBHOOK_LOGS = [];
let healthCheckInterval = null;

// ─── Active cron jobs map ────────────────────────────────────────────────────
const activeJobs = new Map(); // scheduleId -> cron.ScheduledTask

// ─────────────────────────────────────────────────────────────────────────────
// Webhook status helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function getWebhookStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading status file:', e.message);
  }
  return { active: false };
}

function saveWebhookStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
    if (status.active) startHealthCheck();
    else stopHealthCheck();
  } catch (e) {
    console.error('Error writing status file:', e.message);
  }
}

async function verifyWebhookConnectivity() {
  const status = getWebhookStatus();
  if (!status.active || !status.webhookId || !status.teamId || !status.token) return;
  try {
    const cuClient = axios.create({
      baseURL: 'https://api.clickup.com/api/v2',
      headers: { Authorization: status.token, 'Content-Type': 'application/json' },
    });
    const { data } = await cuClient.get(`/team/${status.teamId}/webhook`);
    const exists = (data.webhooks || []).find(w => w.id === status.webhookId && w.status === 'active');
    if (!exists) {
      console.warn(`Health Check: Webhook ${status.webhookId} not found or inactive.`);
      saveWebhookStatus({ ...status, active: false, error: 'Webhook disconnected or removed in ClickUp' });
      WEBHOOK_LOGS.unshift({ timestamp: new Date().toISOString(), event: 'Health Check Failed', details: 'Webhook was removed or deactivated in ClickUp.' });
    }
  } catch (e) {
    console.error('Health Check Error:', e.message);
  }
}

function startHealthCheck() {
  if (healthCheckInterval) return;
  healthCheckInterval = setInterval(verifyWebhookConnectivity, 10 * 60 * 1000);
  setTimeout(verifyWebhookConnectivity, 30000);
}

function stopHealthCheck() {
  if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedules persistence
// ─────────────────────────────────────────────────────────────────────────────
function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULES_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading schedules file:', e.message);
  }
  return [];
}

function saveSchedules(schedules) {
  try {
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  } catch (e) {
    console.error('Error writing schedules file:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interval → Cron expression mapping
// ─────────────────────────────────────────────────────────────────────────────
function intervalToCron(interval, time) {
  // time is "HH:MM" for daily schedules
  const [hours, minutes] = (time || '09:00').split(':').map(Number);

  switch (interval) {
    case 'every_15_min': return '*/15 * * * *';
    case 'every_30_min': return '*/30 * * * *';
    case 'every_hour': return '0 * * * *';
    case 'every_2_hours': return '0 */2 * * *';
    case 'every_6_hours': return '0 */6 * * *';
    case 'every_12_hours': return '0 */12 * * *';
    case 'daily_at': return `${minutes} ${hours} * * *`;
    default: return '0 * * * *';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync logic (extracted from existing POST /api/sync)
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_MAP = {
  Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 4,
  Major: 2, Minor: 4, Critical: 1, Blocker: 1, Trivial: 4,
};

function mapPriority(jiraPriority) {
  if (!jiraPriority) return 3;
  return PRIORITY_MAP[jiraPriority] || 3;
}

function jiraDescToMarkdown(adfDoc) {
  if (!adfDoc || !adfDoc.content) return '';
  const lines = [];
  function walk(nodes) {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.type === 'paragraph') {
        const text = (node.content || []).map(n => n.text || '').join('');
        lines.push(text);
      } else if (node.type === 'heading') {
        const text = (node.content || []).map(n => n.text || '').join('');
        lines.push(`${'#'.repeat(node.attrs?.level || 1)} ${text}`);
      } else if (node.type === 'bulletList' || node.type === 'orderedList') {
        walk(node.content);
      } else if (node.type === 'listItem') {
        const text = (node.content || []).flatMap(n => (n.content || []).map(c => c.text || '')).join('');
        lines.push(`- ${text}`);
      } else if (node.type === 'codeBlock') {
        const text = (node.content || []).map(n => n.text || '').join('');
        lines.push(`\`\`\`\n${text}\n\`\`\``);
      } else if (node.content) {
        walk(node.content);
      }
    }
  }
  walk(adfDoc.content);
  return lines.join('\n\n');
}

/**
 * Core sync function used by both manual sync and scheduled jobs.
 * @param {object} jiraCreds - { url, email, token }
 * @param {string} clickupToken
 * @param {string} jql
 * @param {string} listId
 * @param {object} options - { syncPriority, syncLabels, syncDescription, syncDueDate }
 * @returns {Promise<{results: Array, issueCount: number}>}
 */
async function performSync(jiraCreds, clickupToken, jql, listId, options = {}) {

  const cuClient = axios.create({
    baseURL: 'https://api.clickup.com/api/v2',
    headers: { Authorization: clickupToken, 'Content-Type': 'application/json' },
  });

  let allIssues = [];

  if (options.prefetchedIssues) {
    allIssues = options.prefetchedIssues;
  } else {
    const jClient = axios.create({
      baseURL: `${jiraCreds.url.replace(/\/$/, '')}/rest/api/3`,
      auth: { username: jiraCreds.email, password: jiraCreds.token },
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    });

    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const { data } = await jClient.get('/search/jql', {
        params: { jql, maxResults, startAt, fields: 'summary,description,status,priority,assignee,issuetype,labels,created,updated,duedate' },
      });
      allIssues = allIssues.concat(data.issues || []);
      if (startAt + maxResults >= (data.total || 0)) break;
      startAt += maxResults;
    }
  }

  if (!allIssues.length) {
    return { results: [], issueCount: 0 };
  }

  // Fetch the ClickUp UUID for the "JIRA ID" custom field
  let jiraCustomFieldId = null;
  try {
    const { data: fieldsData } = await cuClient.get(`/list/${listId}/field`);
    const fields = fieldsData.fields || [];
    const matchedField = fields.find(f => f.name.toLowerCase() === 'jira id');
    if (matchedField) {
      jiraCustomFieldId = matchedField.id;
    } else {
      console.warn(`Custom field "JIRA ID" not found in list ${listId}. Falling back to name matching.`);
    }
  } catch (e) {
    console.warn(`Failed to fetch custom fields for list ${listId}:`, e.message);
  }

  // 2. Create/update tasks
  const results = [];
  for (const issue of allIssues) {
    try {
      const description = issue.fields.description ? jiraDescToMarkdown(issue.fields.description) : '';

      const projectKey = issue.key.split('-')[0];
      let taskTags = options.syncLabels !== false && issue.fields.labels?.length ? [...issue.fields.labels] : [];
      if (projectKey && !taskTags.includes(projectKey)) {
        taskTags.push(projectKey);
      }

      const payload = {
        name: `[${issue.key}] ${issue.fields.summary}`,
        description: options.syncDescription !== false ? (description || undefined) : undefined,
        priority: options.syncPriority !== false ? mapPriority(issue.fields.priority?.name) : undefined,
        tags: taskTags.length > 0 ? taskTags : undefined,
        due_date: options.syncDueDate !== false && issue.fields.duedate ? new Date(issue.fields.duedate).getTime() : undefined,
      };

      if (jiraCustomFieldId) {
        // Set the custom field in the payload so it gets populated when a new task is created
        payload.custom_fields = [
          {
            id: jiraCustomFieldId,
            value: issue.key
          }
        ];
      }

      let existingTaskId = null;

      if (jiraCustomFieldId) {
        // Filter ClickUp tasks directly using the custom field
        const customFieldsFilter = [
          {
            field_id: jiraCustomFieldId,
            operator: "=",
            value: issue.key
          }
        ];

        const { data: existingTasksData } = await cuClient.get(`/list/${listId}/task`, {
          params: {
            archived: false,
            include_closed: true,
            custom_fields: JSON.stringify(customFieldsFilter)
          }
        });

        const tasks = existingTasksData.tasks || [];
        if (tasks.length > 0) {
          existingTaskId = tasks[0].id;
        }
      }
      if (existingTaskId) {
        const { data } = await cuClient.put(`/task/${existingTaskId}`, payload);
        results.push({ key: issue.key, status: 'updated', taskId: data.id, url: data.url });
      } else {
        const { data } = await cuClient.post(`/list/${listId}/task`, payload);
        results.push({ key: issue.key, status: 'created', taskId: data.id, url: data.url });
      }
    } catch (e) {
      results.push({ key: issue.key, status: 'failed', error: e.response?.data?.err || e.message });
    }
  }

  return { results, issueCount: allIssues.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule runner
// ─────────────────────────────────────────────────────────────────────────────

async function runSchedule(scheduleId) {
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === scheduleId);
  if (!schedule) return;

  console.log(`[Scheduler] Running schedule "${schedule.name}" (${scheduleId})...`);

  const logEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    status: 'running',
    created: 0,
    updated: 0,
    failed: 0,
    issueCount: 0,
    error: null,
  };

  try {
    const { results, issueCount } = await performSync(
      schedule.jiraCredentials,
      schedule.clickupToken,
      schedule.jql,
      schedule.listId,
      schedule.options || {}
    );

    logEntry.status = 'success';
    logEntry.issueCount = issueCount;
    logEntry.created = results.filter(r => r.status === 'created').length;
    logEntry.updated = results.filter(r => r.status === 'updated').length;
    logEntry.failed = results.filter(r => r.status === 'failed').length;
    logEntry.duration = Date.now() - new Date(logEntry.timestamp).getTime();

    if (logEntry.failed > 0 && logEntry.created === 0 && logEntry.updated === 0) {
      logEntry.status = 'failed';
    }

    console.log(`[Scheduler] "${schedule.name}" completed: ${logEntry.created} created, ${logEntry.updated} updated, ${logEntry.failed} failed`);
  } catch (e) {
    logEntry.status = 'failed';
    logEntry.error = e.message;
    console.error(`[Scheduler] "${schedule.name}" failed:`, e.message);
  }

  // Persist log
  const freshSchedules = loadSchedules();
  const idx = freshSchedules.findIndex(s => s.id === scheduleId);
  if (idx !== -1) {
    if (!freshSchedules[idx].logs) freshSchedules[idx].logs = [];
    freshSchedules[idx].logs.unshift(logEntry);
    // Keep only last 50 logs
    freshSchedules[idx].logs = freshSchedules[idx].logs.slice(0, 50);
    freshSchedules[idx].lastRun = logEntry.timestamp;
    freshSchedules[idx].lastStatus = logEntry.status;
    saveSchedules(freshSchedules);
  }
}

function startScheduleJob(schedule) {
  if (activeJobs.has(schedule.id)) {
    activeJobs.get(schedule.id).stop();
  }

  const cronExpr = intervalToCron(schedule.interval, schedule.time);
  if (!cron.validate(cronExpr)) {
    console.error(`[Scheduler] Invalid cron for "${schedule.name}": ${cronExpr}`);
    return;
  }

  const job = cron.schedule(cronExpr, () => runSchedule(schedule.id));
  activeJobs.set(schedule.id, job);
  console.log(`[Scheduler] Started "${schedule.name}" with cron: ${cronExpr}`);
}

function stopScheduleJob(scheduleId) {
  if (activeJobs.has(scheduleId)) {
    activeJobs.get(scheduleId).stop();
    activeJobs.delete(scheduleId);
  }
}

function initAllSchedules() {
  const schedules = loadSchedules();
  schedules.filter(s => s.enabled).forEach(s => startScheduleJob(s));
  console.log(`[Scheduler] Initialized ${schedules.filter(s => s.enabled).length} active schedule(s)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Express setup
// ─────────────────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jiraClient(req) {
  const baseURL = req.headers['x-jira-url'];
  const email = req.headers['x-jira-email'];
  const token = req.headers['x-jira-token'];
  if (!baseURL || !email || !token) throw new Error('Missing Jira credentials');
  return axios.create({
    baseURL: `${baseURL.replace(/\/$/, '')}/rest/api/3`,
    auth: { username: email, password: token },
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
  });
}

function clickupClient(req) {
  const token = req.headers['x-clickup-token'];
  if (!token) throw new Error('Missing ClickUp token');
  return axios.create({
    baseURL: 'https://api.clickup.com/api/v2',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JIRA ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/jira/me', async (req, res) => {
  try {
    const client = jiraClient(req);
    const { data } = await client.get('/myself');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/jira/projects', async (req, res) => {
  try {
    const client = jiraClient(req);
    const { data } = await client.get('/project/search?maxResults=100&orderBy=name');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/jira/filters', async (req, res) => {
  try {
    const client = jiraClient(req);
    const { data: myself } = await client.get('/myself');
    const { data } = await client.get('/filter/search', {
      params: { maxResults: 500, expand: 'jql', orderBy: 'name', accountId: myself.accountId },
    });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/jira/search', async (req, res) => {
  try {
    const client = jiraClient(req);
    const jql = req.query.jql || '';
    const maxResults = parseInt(req.query.maxResults) || 50;
    const startAt = parseInt(req.query.startAt) || 0;
    const { data } = await client.get('/search/jql', {
      params: { jql, maxResults, startAt, fields: 'summary,description,status,priority,assignee,issuetype,labels,created,updated,duedate' },
    });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLICKUP ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/clickup/teams', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get('/team');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/clickup/team/:teamId/spaces', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get(`/team/${req.params.teamId}/space?archived=false`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/clickup/space/:spaceId/folders', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get(`/space/${req.params.spaceId}/folder?archived=false`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/clickup/space/:spaceId/lists', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get(`/space/${req.params.spaceId}/list?archived=false`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/clickup/folder/:folderId/lists', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get(`/folder/${req.params.folderId}/list?archived=false`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL SYNC ROUTE (existing, refactored to use performSync)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/sync', async (req, res) => {
  const { issues, listId, options } = req.body;
  if (!issues || !listId) {
    return res.status(400).json({ error: 'issues and listId are required' });
  }

  const clickupToken = req.headers['x-clickup-token'];
  if (!clickupToken) {
    return res.status(401).json({ error: 'Missing ClickUp token' });
  }

  try {
    const result = await performSync(null, clickupToken, null, listId, {
      ...options,
      prefetchedIssues: issues
    });
    // The previous implementation returned { results } which performSync already returns inside the object, 
    // along with issueCount. We can return just what performSync returns.
    res.json(result);
  } catch (e) {
    console.error('Manual sync error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE CRUD ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// List all schedules
app.get('/api/schedules', (req, res) => {
  const schedules = loadSchedules();
  // Strip sensitive credentials from response
  const safe = schedules.map(s => ({
    ...s,
    jiraCredentials: s.jiraCredentials ? { url: s.jiraCredentials.url, email: s.jiraCredentials.email, hasToken: !!s.jiraCredentials.token } : null,
    clickupToken: s.clickupToken ? '••••••' : null,
  }));
  res.json(safe);
});

// Create new schedule
app.post('/api/schedules', (req, res) => {
  const { name, jiraCredentials, clickupToken, jql, listId, listName, interval, time, options, filterName } = req.body;

  if (!name || !jiraCredentials || !clickupToken || !jql || !listId || !interval) {
    return res.status(400).json({ error: 'Missing required fields: name, jiraCredentials, clickupToken, jql, listId, interval' });
  }

  const schedule = {
    id: uuidv4(),
    name,
    jiraCredentials,
    clickupToken,
    jql,
    listId,
    listName: listName || 'Unknown List',
    filterName: filterName || null,
    interval,
    time: time || '09:00',
    options: options || {},
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastStatus: null,
    logs: [],
  };

  const schedules = loadSchedules();
  schedules.push(schedule);
  saveSchedules(schedules);

  startScheduleJob(schedule);

  res.json({
    ...schedule,
    jiraCredentials: { url: schedule.jiraCredentials.url, email: schedule.jiraCredentials.email, hasToken: true },
    clickupToken: '••••••',
  });
});

// Update schedule
app.put('/api/schedules/:id', (req, res) => {
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

  const updates = req.body;
  const schedule = schedules[idx];

  // Update allowed fields
  if (updates.name !== undefined) schedule.name = updates.name;
  if (updates.jql !== undefined) schedule.jql = updates.jql;
  if (updates.listId !== undefined) schedule.listId = updates.listId;
  if (updates.listName !== undefined) schedule.listName = updates.listName;
  if (updates.filterName !== undefined) schedule.filterName = updates.filterName;
  if (updates.interval !== undefined) schedule.interval = updates.interval;
  if (updates.time !== undefined) schedule.time = updates.time;
  if (updates.options !== undefined) schedule.options = updates.options;
  if (updates.jiraCredentials !== undefined) schedule.jiraCredentials = updates.jiraCredentials;
  if (updates.clickupToken !== undefined) schedule.clickupToken = updates.clickupToken;

  if (updates.enabled !== undefined) {
    schedule.enabled = updates.enabled;
    if (schedule.enabled) {
      startScheduleJob(schedule);
    } else {
      stopScheduleJob(schedule.id);
    }
  } else if (schedule.enabled) {
    // Restart cron if config changed
    startScheduleJob(schedule);
  }

  schedules[idx] = schedule;
  saveSchedules(schedules);

  res.json({
    ...schedule,
    jiraCredentials: { url: schedule.jiraCredentials.url, email: schedule.jiraCredentials.email, hasToken: true },
    clickupToken: '••••••',
  });
});

// Delete schedule
app.delete('/api/schedules/:id', (req, res) => {
  let schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

  stopScheduleJob(req.params.id);
  schedules.splice(idx, 1);
  saveSchedules(schedules);

  res.json({ success: true });
});

// Run schedule immediately
app.post('/api/schedules/:id/run', async (req, res) => {
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  // Run async – return immediately
  res.json({ message: 'Schedule run initiated', scheduleId: schedule.id });
  runSchedule(schedule.id);
});

// Get schedule logs
app.get('/api/schedules/:id/logs', (req, res) => {
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  res.json(schedule.logs || []);
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK ROUTES (preserved from original)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/webhook/clickup', async (req, res) => {
  const { token, spaces } = req.query;
  const event = req.body;
  if (!token) return res.status(400).send('Missing token');
  if (event.event === 'webhook_health_check') return res.send('ok');
  if (event.event !== 'taskStatusUpdated') return res.send('ignored event');

  const allowedSpaces = spaces ? spaces.split(',') : [];
  const taskId = event.task_id;

  try {
    const cuClient = axios.create({
      baseURL: 'https://api.clickup.com/api/v2',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    const { data: task } = await cuClient.get(`/task/${taskId}`);
    if (allowedSpaces.length && !allowedSpaces.includes(task.space.id)) return res.send('skipped: space not in filter');
    const newStatus = task.status.status.toUpperCase();
    if (newStatus !== 'QA PARK') return res.send(`skipped: status is ${newStatus}, not QA PARK`);

    console.log(`Webhook Triggered: Task ${taskId} is now QA PARK.`);
    WEBHOOK_LOGS.unshift({ timestamp: new Date().toISOString(), event: 'Status Change: QA PARK', task_id: taskId, details: `Task ${taskId} reached QA PARK. Updating linked tasks.` });

    let linkedTasks = (task.linked_tasks || []).map(l => l.link_id === task.id ? l.task_id : l.link_id);
    linkedTasks = [...new Set(linkedTasks)];
    if (!linkedTasks.length) return res.send('no linked tasks found');

    const updatePromises = linkedTasks.map(targetId =>
      cuClient.put(`/task/${targetId}`, { status: 'complete' }).catch(e => {
        console.error(`Failed to update linked task ${targetId}: ${e.response?.data?.err || e.message}`);
      })
    );
    await Promise.all(updatePromises);
    res.send(`Successfully processed ${linkedTasks.length} linked tasks`);
  } catch (e) {
    console.error('Webhook Error:', e.response?.data?.err || e.message);
    res.status(500).send('Internal error');
  }
});

app.get('/api/webhook/status', (req, res) => res.json(getWebhookStatus()));
app.get('/api/webhook/logs', (req, res) => res.json(WEBHOOK_LOGS.slice(0, 50)));

app.delete('/api/clickup/webhook', async (req, res) => {
  const status = getWebhookStatus();
  if (!status.active || !status.webhookId) return res.status(400).json({ error: 'No active webhook to delete' });
  try {
    const client = clickupClient(req);
    await client.delete(`/webhook/${status.webhookId}`);
    const oldStatus = { ...status };
    saveWebhookStatus({ active: false });
    WEBHOOK_LOGS.unshift({ timestamp: new Date().toISOString(), event: 'Webhook Disabled', details: `Removed webhook ${oldStatus.webhookId}` });
    res.json({ success: true });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.err || e.message });
  }
});

app.get('/api/clickup/webhooks', async (req, res) => {
  const { teamId } = req.query;
  if (!teamId) return res.status(400).json({ error: 'teamId is required' });
  try {
    const client = clickupClient(req);
    const { data } = await client.get(`/team/${teamId}/webhook`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.post('/api/clickup/webhook/setup', async (req, res) => {
  const { teamId, endpointBase, token, spaces } = req.body;
  if (!teamId || !endpointBase || !token) return res.status(400).json({ error: 'Missing teamId, endpointBase, or token' });

  try {
    const cuClient = axios.create({
      baseURL: 'https://api.clickup.com/api/v2',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    const endpoint = `${endpointBase}/api/webhook/clickup?token=${encodeURIComponent(token)}${spaces ? `&spaces=${spaces}` : ''}`;
    const { data } = await cuClient.post(`/team/${teamId}/webhook`, { endpoint, events: ['taskStatusUpdated'] });
    const status = { active: true, webhookId: data.webhook.id, teamId, endpoint, endpointBase, spaces: spaces || null, token, createdAt: new Date().toISOString() };
    saveWebhookStatus(status);
    WEBHOOK_LOGS.unshift({ timestamp: new Date().toISOString(), event: 'Webhook Initiated', details: `Registered endpoint ${endpoint}` });
    res.json(data.webhook);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.err || e.message });
  }
});

// Catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});



// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Jira → ClickUp Sync server running at http://localhost:${PORT}`);
  const status = getWebhookStatus();
  if (status.active) startHealthCheck();
  initAllSchedules();
});
