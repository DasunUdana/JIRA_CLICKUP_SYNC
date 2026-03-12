const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

const STATUS_FILE = path.join(__dirname, 'webhook_status.json');

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
  } catch (e) {
    console.error('Error writing status file:', e.message);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build Jira axios instance from request headers
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build ClickUp axios instance from request headers
// ─────────────────────────────────────────────────────────────────────────────
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

// Validate credentials + get current user
app.get('/api/jira/me', async (req, res) => {
  try {
    const client = jiraClient(req);
    const { data } = await client.get('/myself');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// List projects
app.get('/api/jira/projects', async (req, res) => {
  try {
    const client = jiraClient(req);
    const { data } = await client.get('/project/search?maxResults=100&orderBy=name');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// List saved filters
app.get('/api/jira/filters', async (req, res) => {
  try {
    const client = jiraClient(req);
    const { data } = await client.get('/filter/search?maxResults=50&expand=jql&orderBy=name');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// Search issues by JQL
app.get('/api/jira/search', async (req, res) => {
  try {
    const client = jiraClient(req);
    const jql = req.query.jql || '';
    const maxResults = parseInt(req.query.maxResults) || 50;
    const startAt = parseInt(req.query.startAt) || 0;
    const { data } = await client.get('/search/jql', {
      params: {
        jql,
        maxResults,
        startAt,
        fields: 'summary,description,status,priority,assignee,issuetype,labels,created,updated,duedate',
      },
    });
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLICKUP ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Validate credentials + get teams/workspaces
app.get('/api/clickup/teams', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get('/team');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// Get spaces in a team
app.get('/api/clickup/team/:teamId/spaces', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get(`/team/${req.params.teamId}/space?archived=false`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// Get folders in a space
app.get('/api/clickup/space/:spaceId/folders', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get(`/space/${req.params.spaceId}/folder?archived=false`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// Get folderless lists in a space
app.get('/api/clickup/space/:spaceId/lists', async (req, res) => {
  try {
    const client = clickupClient(req);
    const { data } = await client.get(`/space/${req.params.spaceId}/list?archived=false`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// Get lists in a folder
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
// SYNC ROUTE
// ─────────────────────────────────────────────────────────────────────────────

// Priority mapping: Jira → ClickUp
const PRIORITY_MAP = {
  Highest: 1,
  High: 2,
  Medium: 3,
  Low: 4,
  Lowest: 4,
  Major: 2,
  Minor: 4,
  Critical: 1,
  Blocker: 1,
  Trivial: 4,
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

app.post('/api/sync', async (req, res) => {
  const { issues, listId, options } = req.body;
  if (!issues || !listId) {
    return res.status(400).json({ error: 'issues and listId are required' });
  }

  const cuClient = clickupClient(req);
  const results = [];

  try {
    // 1. Fetch existing tasks in the list to deduplicate
    const { data: existingTasksData } = await cuClient.get(`/list/${listId}/task?archived=false&include_closed=true`);
    const existingTasks = existingTasksData.tasks || [];

    // Map existing tasks by Jira Key [KEY-123] found in title
    const existingMap = {};
    existingTasks.forEach(t => {
      const match = t.name.match(/\[([A-Z0-9]+-[0-9]+)\]/i);
      if (match) {
        existingMap[match[1].toUpperCase()] = t.id;
      }
    });

    for (const issue of issues) {
      try {
        const description = issue.fields.description
          ? jiraDescToMarkdown(issue.fields.description)
          : '';

        const payload = {
          name: `[${issue.key}] ${issue.fields.summary}`,
          description: description || undefined,
          priority: options?.syncPriority !== false ? mapPriority(issue.fields.priority?.name) : undefined,
          tags: options?.syncLabels !== false && issue.fields.labels?.length
            ? issue.fields.labels
            : undefined,
          due_date: issue.fields.duedate
            ? new Date(issue.fields.duedate).getTime()
            : undefined,
        };

        const existingTaskId = existingMap[issue.key.toUpperCase()];

        if (existingTaskId) {
          // UPDATE
          const { data } = await cuClient.put(`/task/${existingTaskId}`, payload);
          results.push({ key: issue.key, status: 'updated', taskId: data.id, url: data.url });
        } else {
          // CREATE
          const { data } = await cuClient.post(`/list/${listId}/task`, payload);
          results.push({ key: issue.key, status: 'created', taskId: data.id, url: data.url });
        }
      } catch (e) {
        results.push({
          key: issue.key,
          status: 'failed',
          error: e.response?.data?.err || e.message,
        });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: `Failed to fetch existing tasks: ${e.message}` });
  }

  res.json({ results });
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK ROUTE (ClickUp -> ClickUp Linked Task Sync)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/webhook/clickup', async (req, res) => {
  const { token, spaces } = req.query;
  const event = req.body;

  if (!token) {
    console.error('Webhook: Missing token query param');
    return res.status(400).send('Missing token');
  }

  // ClickUp health check or verification
  if (event.event === 'webhook_health_check') {
    return res.send('ok');
  }

  if (event.event !== 'taskStatusUpdated') {
    return res.send('ignored event');
  }

  const allowedSpaces = spaces ? spaces.split(',') : [];
  const taskId = event.task_id;

  try {
    const cuClient = axios.create({
      baseURL: 'https://api.clickup.com/api/v2',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });

    // 1. Fetch task details to check space and find links
    const { data: task } = await cuClient.get(`/task/${taskId}`);

    // Check space filter
    if (allowedSpaces.length && !allowedSpaces.includes(task.space.id)) {
      return res.send('skipped: space not in filter');
    }

    // Check if new status is QA PARK
    const newStatus = task.status.status.toUpperCase();
    if (newStatus !== 'QA PARK') {
      return res.send(`skipped: status is ${newStatus}, not QA PARK`);
    }

    console.log(`Webhook Triggered: Task ${taskId} is now QA PARK. Syncing linked tasks...`);

    // 2. Identify linked tasks (Task Links)
    // ClickUp returns links in task.linked_tasks
    let linkedTasks = (task.linked_tasks || []).map(l => l.link_id === task.id ? l.task_id : l.link_id);

    // Deduplicate IDs
    linkedTasks = [...new Set(linkedTasks)];

    if (!linkedTasks.length) {
      return res.send('no linked tasks found');
    }

    // 3. Update all linked tasks to 'complete'
    // Note: 'complete' (lowercase) is the standard API identifier for Closed status in many ClickUp lists.
    const updatePromises = linkedTasks.map(targetId =>
      cuClient.put(`/task/${targetId}`, { status: 'complete' })
        .catch(e => {
          const errMsg = e.response?.data?.err || e.response?.data || e.message;
          console.error(`Failed to update linked task ${targetId}: ${errMsg}`);
        })
    );

    await Promise.all(updatePromises);
    res.send(`Successfully processed ${linkedTasks.length} linked tasks`);

  } catch (e) {
    console.error('Webhook Error:', e.response?.data?.err || e.response?.data || e.message);
    res.status(500).send('Internal error');
  }
});

app.get('/api/webhook/status', (req, res) => {
  res.json(getWebhookStatus());
});

app.post('/api/clickup/webhook/setup', async (req, res) => {
  const { teamId, endpointBase, token, spaces } = req.body;

  if (!teamId || !endpointBase || !token) {
    return res.status(400).json({ error: 'Missing teamId, endpointBase, or token' });
  }

  try {
    const cuClient = axios.create({
      baseURL: 'https://api.clickup.com/api/v2',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });

    const endpoint = `${endpointBase}/api/webhook/clickup?token=${encodeURIComponent(token)}${spaces ? `&spaces=${spaces}` : ''}`;

    const { data } = await cuClient.post(`/team/${teamId}/webhook`, {
      endpoint,
      events: ['taskStatusUpdated']
    });

    const status = {
      active: true,
      webhookId: data.webhook.id,
      teamId,
      endpoint,
      spaces: spaces || null,
      createdAt: new Date().toISOString()
    };
    saveWebhookStatus(status);

    res.json(data.webhook);
  } catch (e) {
    console.error('Webhook Setup Error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data?.err || e.message });
  }
});

// Serve index.html for any unmatched routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Jira → ClickUp Sync server running at http://localhost:${PORT}`);
});
