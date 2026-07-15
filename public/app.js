/* ═══════════════════════════════════════════════════════════════════════════
   SyncFlow — Jira → ClickUp Scheduler
   Frontend Application
═══════════════════════════════════════════════════════════════════════════ */



// ── State ─────────────────────────────────────────────────────────────────
const state = {
  jira: { connected: false, url: '', email: '', token: '' },
  clickup: { connected: false, token: '', teams: [] },
  issues: [],
  selected: [],
  sourceMode: 'project',
  currentPage: 'dashboard',
  schedules: [],
  editingScheduleId: null,
  webhook: { active: false },
};

// ── Helpers ───────────────────────────────────────────────────────────────

function jiraHeaders() {
  return {
    'x-jira-url': state.jira.url,
    'x-jira-email': state.jira.email,
    'x-jira-token': state.jira.token,
  };
}

function cuHeaders() {
  return { 'x-clickup-token': state.clickup.token };
}

async function api(method, path, body, extraHeaders = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  };
  if (body) opts.body = JSON.stringify(body);
  
  // Dynamically prefix the path for subpath hosting (e.g. /clickup-service)
  const basePath = window.location.pathname.replace(/\/$/, '');
  const res = await fetch(basePath + path, opts);
  
  const data = await res.json();
  if (!res.ok) throw new Error(extractError(data));
  return data;
}

function extractError(data) {
  if (typeof data?.error === 'string') return data.error;
  if (data?.error?.errorMessages?.length) return data.error.errorMessages.join(', ');
  if (data?.error?.message) return data.error.message;
  if (data?.err) return data.err;
  return JSON.stringify(data);
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const text = btn.querySelector('.btn-text');
  const spin = btn.querySelector('.btn-spinner');
  btn.disabled = loading;
  text?.classList.toggle('hidden', loading);
  spin?.classList.toggle('hidden', !loading);
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError(id) {
  const el = document.getElementById(id);
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toggleVis(id) {
  const el = document.getElementById(id);
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const INTERVAL_LABELS = {
  every_15_min: 'Every 15 min',
  every_30_min: 'Every 30 min',
  every_hour: 'Every hour',
  every_2_hours: 'Every 2 hours',
  every_6_hours: 'Every 6 hours',
  every_12_hours: 'Every 12 hours',
  daily_at: 'Daily',
};

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

function navigateTo(page) {
  state.currentPage = page;

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1));
  if (target) {
    void target.offsetWidth;
    target.classList.add('active');
  }

  if (page === 'dashboard') refreshDashboard();
  if (page === 'schedules') loadSchedules();

  document.getElementById('sidebar')?.classList.remove('open');
}

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('open');
}

// ═══════════════════════════════════════════════════════════════════════════
// SIDEBAR STATUS
// ═══════════════════════════════════════════════════════════════════════════

function updateSidebarStatus() {
  const jiraPill = document.getElementById('sidebarJiraStatus');
  const cuPill = document.getElementById('sidebarClickupStatus');
  if (jiraPill) jiraPill.classList.toggle('connected', state.jira.connected);
  if (cuPill) cuPill.classList.toggle('connected', state.clickup.connected);

  const prompt = document.getElementById('connectPrompt');
  if (prompt) {
    prompt.classList.toggle('hidden', state.jira.connected && state.clickup.connected);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS — JIRA CONNECT
// ═══════════════════════════════════════════════════════════════════════════

async function connectJira() {
  clearError('jiraError');
  const url = document.getElementById('jiraUrl')?.value.trim();
  const email = document.getElementById('jiraEmail')?.value.trim();
  const token = document.getElementById('jiraToken')?.value.trim();

  if (!url || !email || !token) return showError('jiraError', 'Please fill in all Jira credential fields.');

  state.jira = { connected: false, url, email, token };
  setLoading('jiraConnectBtn', true);

  try {
    const me = await api('GET', '/api/jira/me', null, jiraHeaders());
    state.jira.connected = true;
    state.jira.displayName = me.displayName || email;

    const statusEl = document.getElementById('jiraStatus');
    if (statusEl) statusEl.innerHTML = `&#10003; ${escHtml(state.jira.displayName)}`;
    updateSidebarStatus();

    const rememberEl = document.getElementById('jiraRemember');
    if (rememberEl?.checked) {
      localStorage.setItem('jira_creds', JSON.stringify({ url, email, token }));
    } else {
      localStorage.removeItem('jira_creds');
    }

    loadJiraProjects();
    loadJiraFilters();
  } catch (e) {
    showError('jiraError', `Connection failed: ${e.message}`);
  } finally {
    setLoading('jiraConnectBtn', false);
  }
}

async function loadJiraProjects() {
  try {
    const data = await api('GET', '/api/jira/projects', null, jiraHeaders());
    const select = document.getElementById('jiraProject');
    if (!select) return;
    select.innerHTML = '<option value="">— Select a project —</option>';
    (data.values || []).forEach(p => {
      select.appendChild(new Option(`${p.name} (${p.key})`, p.key));
    });
  } catch (_) {}
}

async function loadJiraFilters() {
  try {
    const data = await api('GET', '/api/jira/filters', null, jiraHeaders());
    const filters = data.values || [];

    const select = document.getElementById('jiraFilter');
    if (select) {
      select.innerHTML = '<option value="">— Select a filter —</option>';
      filters.forEach(f => {
        const opt = new Option(f.name, f.id);
        opt.dataset.jql = f.jql;
        select.appendChild(opt);
      });
    }

    const schedSelect = document.getElementById('schedFilter');
    if (schedSelect) {
      schedSelect.innerHTML = '<option value="">— Select a filter —</option>';
      filters.forEach(f => {
        const opt = new Option(f.name, f.id);
        opt.dataset.jql = f.jql;
        opt.dataset.name = f.name;
        schedSelect.appendChild(opt);
      });
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS — CLICKUP CONNECT
// ═══════════════════════════════════════════════════════════════════════════

async function connectClickUp() {
  clearError('clickupError');
  const token = document.getElementById('clickupToken')?.value.trim();
  if (!token) return showError('clickupError', 'Please enter your ClickUp API token.');

  state.clickup = { connected: false, token, teams: [] };
  setLoading('clickupConnectBtn', true);

  try {
    const data = await api('GET', '/api/clickup/teams', null, cuHeaders());
    state.clickup.teams = data.teams || [];
    state.clickup.connected = true;

    const statusEl = document.getElementById('clickupStatus');
    if (statusEl) statusEl.innerHTML = `&#10003; ${state.clickup.teams.length} workspace(s)`;
    updateSidebarStatus();

    const rememberEl = document.getElementById('clickupRemember');
    if (rememberEl?.checked) {
      localStorage.setItem('clickup_creds', JSON.stringify({ token }));
    } else {
      localStorage.removeItem('clickup_creds');
    }

    populateWorkspaces();
    loadAllSpacesForWebhook();
  } catch (e) {
    showError('clickupError', `Connection failed: ${e.message}`);
  } finally {
    setLoading('clickupConnectBtn', false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL SYNC — SOURCE MODE
// ═══════════════════════════════════════════════════════════════════════════

function setSourceMode(mode) {
  state.sourceMode = mode;
  ['project', 'filter', 'jql'].forEach(m => {
    const modeEl = document.getElementById('mode' + m.charAt(0).toUpperCase() + m.slice(1));
    const tabEl = document.getElementById('tab' + m.charAt(0).toUpperCase() + m.slice(1));
    if (modeEl) modeEl.classList.toggle('hidden', m !== mode);
    if (tabEl) tabEl.classList.toggle('active', m === mode);
  });
}

async function fetchIssues() {
  clearError('jiraSourceError');
  const preview = document.getElementById('issuesPreview');
  if (preview) preview.classList.add('hidden');
  setLoading('fetchIssuesBtn', true);

  try {
    let jql = '';
    if (state.sourceMode === 'project') {
      const project = document.getElementById('jiraProject')?.value;
      if (!project) throw new Error('Please select a project.');
      const statusFilter = document.getElementById('jiraStatusFilter')?.value.trim();
      jql = `project = "${project}"`;
      if (statusFilter) {
        const statuses = statusFilter.split(',').map(s => `"${s.trim()}"`).join(',');
        jql += ` AND status in (${statuses})`;
      }
      jql += ' ORDER BY created DESC';
    } else if (state.sourceMode === 'filter') {
      const filterEl = document.getElementById('jiraFilter');
      const selected = filterEl?.options[filterEl.selectedIndex];
      if (!filterEl?.value) throw new Error('Please select a filter.');
      jql = selected.dataset.jql || `filter = ${filterEl.value}`;
    } else {
      jql = document.getElementById('jiraJql')?.value.trim();
      if (!jql) throw new Error('Please enter a JQL query.');
    }

    const data = await api('GET', `/api/jira/search?jql=${encodeURIComponent(jql)}&maxResults=100`, null, jiraHeaders());
    state.issues = data.issues || [];
    renderIssues();
  } catch (e) {
    showError('jiraSourceError', e.message);
  } finally {
    setLoading('fetchIssuesBtn', false);
  }
}

const PRIORITY_CLASS = { Highest: 1, Critical: 1, Blocker: 1, High: 2, Major: 2, Medium: 3, Low: 4, Minor: 4, Lowest: 4, Trivial: 4 };

function renderIssues() {
  const list = document.getElementById('issuesList');
  const count = document.getElementById('issueCount');
  const wrap = document.getElementById('issuesPreview');
  if (!list || !wrap) return;

  list.innerHTML = '';
  if (count) count.textContent = `${state.issues.length} tasks found`;
  wrap.classList.remove('hidden');

  if (!state.issues.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;padding:12px 0">No issues matched.</div>';
    return;
  }

  state.issues.forEach(issue => {
    const priority = issue.fields.priority?.name || 'Medium';
    const pClass = 'badge-priority-' + (PRIORITY_CLASS[priority] || 3);
    const div = document.createElement('div');
    div.className = 'issue-item';
    div.innerHTML = `
      <input type="checkbox" id="issue_${issue.key}" value="${issue.key}" checked onchange="updateSelected()" />
      <label for="issue_${issue.key}" class="issue-info" style="cursor:pointer">
        <div class="issue-key">${issue.key}</div>
        <div class="issue-summary" title="${escHtml(issue.fields.summary)}">${escHtml(issue.fields.summary)}</div>
        <div class="issue-meta">
          <span class="badge badge-status">${escHtml(issue.fields.status?.name || '—')}</span>
          <span class="badge ${pClass}">${escHtml(priority)}</span>
          ${issue.fields.assignee ? `<span class="badge badge-status">${escHtml(issue.fields.assignee.displayName)}</span>` : ''}
        </div>
      </label>`;
    list.appendChild(div);
  });

  updateSelected();
}

function updateSelected() {
  state.selected = state.issues.filter(i => document.getElementById(`issue_${i.key}`)?.checked);
  updateSyncSummary();
}

function toggleSelectAll(cb) {
  document.querySelectorAll('.issues-list input[type=checkbox]').forEach(el => el.checked = cb.checked);
  updateSelected();
}

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL SYNC — CLICKUP DESTINATION
// ═══════════════════════════════════════════════════════════════════════════

function populateWorkspaces() {
  const sel = document.getElementById('cuWorkspace');
  if (sel) {
    sel.innerHTML = '<option value="">— Select workspace —</option>';
    state.clickup.teams.forEach(t => sel.appendChild(new Option(t.name, t.id)));
  }

  const schedSel = document.getElementById('schedWorkspace');
  if (schedSel) {
    schedSel.innerHTML = '<option value="">— Select —</option>';
    state.clickup.teams.forEach(t => schedSel.appendChild(new Option(t.name, t.id)));
  }
}

async function onWorkspaceChange() {
  const teamId = document.getElementById('cuWorkspace')?.value;
  resetSelect('cuSpace', '— Select space —');
  resetSelect('cuFolder', '— No folder (root lists) —');
  resetSelect('cuList', '— Select list —');
  setDisabled(['cuSpace', 'cuFolder', 'cuList'], true);
  if (!teamId) return;

  try {
    const data = await api('GET', `/api/clickup/team/${teamId}/spaces`, null, cuHeaders());
    const sel = document.getElementById('cuSpace');
    if (sel) {
      (data.spaces || []).forEach(s => sel.appendChild(new Option(s.name, s.id)));
      sel.disabled = false;
    }
  } catch (e) { showError('cuDestError', e.message); }
}

async function onSpaceChange() {
  const spaceId = document.getElementById('cuSpace')?.value;
  resetSelect('cuFolder', '— No folder (root lists) —');
  resetSelect('cuList', '— Select list —');
  setDisabled(['cuFolder', 'cuList'], true);
  clearError('cuDestError');
  if (!spaceId) return;

  try {
    const [folderData, listData] = await Promise.all([
      api('GET', `/api/clickup/space/${spaceId}/folders`, null, cuHeaders()),
      api('GET', `/api/clickup/space/${spaceId}/lists`, null, cuHeaders()),
    ]);
    const folderSel = document.getElementById('cuFolder');
    if (folderSel) {
      (folderData.folders || []).forEach(f => folderSel.appendChild(new Option(f.name, f.id)));
      folderSel.disabled = false;
    }
    const listSel = document.getElementById('cuList');
    if (listSel) {
      (listData.lists || []).forEach(l => listSel.appendChild(new Option(l.name, l.id)));
      listSel.disabled = false;
    }
    updateSyncSummary();
  } catch (e) { showError('cuDestError', e.message); }
}

async function onFolderChange() {
  const folderId = document.getElementById('cuFolder')?.value;
  resetSelect('cuList', '— Select list —');
  clearError('cuDestError');
  const spaceId = document.getElementById('cuSpace')?.value;
  if (!spaceId) return;

  try {
    const data = folderId
      ? await api('GET', `/api/clickup/folder/${folderId}/lists`, null, cuHeaders())
      : await api('GET', `/api/clickup/space/${spaceId}/lists`, null, cuHeaders());
    const listSel = document.getElementById('cuList');
    if (listSel) {
      (data.lists || []).forEach(l => listSel.appendChild(new Option(l.name, l.id)));
      listSel.disabled = false;
    }
    updateSyncSummary();
  } catch (e) { showError('cuDestError', e.message); }
}

function resetSelect(id, placeholder) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `<option value="">${placeholder}</option>`;
}

function setDisabled(ids, val) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = val;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL SYNC — SYNC SUMMARY & ACTION
// ═══════════════════════════════════════════════════════════════════════════

function updateSyncSummary() {
  const count = state.selected.length;
  const listEl = document.getElementById('cuList');
  const listName = listEl?.options[listEl.selectedIndex]?.text || '—';
  const countEl = document.getElementById('syncTaskCount');
  const destEl = document.getElementById('syncDestName');
  if (countEl) countEl.textContent = `${count} task${count !== 1 ? 's' : ''}`;
  if (destEl) destEl.textContent = listName !== '— Select list —' ? listName : '—';
}

async function startSync() {
  const listId = document.getElementById('cuList')?.value;
  if (!listId) return alert('Please select a ClickUp list first.');
  if (!state.selected.length) return alert('No tasks selected to sync.');

  const options = {
    syncPriority: document.getElementById('optPriority')?.checked,
    syncLabels: document.getElementById('optLabels')?.checked,
    syncDescription: document.getElementById('optDescription')?.checked,
    syncDueDate: document.getElementById('optDueDate')?.checked,
  };

  const syncBtn = document.getElementById('syncBtn');
  const progressWrap = document.getElementById('progressWrap');
  const resultsWrap = document.getElementById('resultsWrap');
  const progressFill = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');

  if (syncBtn) syncBtn.disabled = true;
  if (progressWrap) progressWrap.classList.remove('hidden');
  if (resultsWrap) resultsWrap.classList.add('hidden');
  if (progressFill) progressFill.style.width = '0%';
  if (progressLabel) progressLabel.textContent = `Syncing 0 / ${state.selected.length}…`;

  const batchSize = 10;
  const allResults = [];
  let done = 0;

  for (let i = 0; i < state.selected.length; i += batchSize) {
    const batch = state.selected.slice(i, i + batchSize);
    try {
      const data = await api('POST', '/api/sync', { issues: batch, listId, options }, { ...jiraHeaders(), ...cuHeaders() });
      allResults.push(...(data.results || []));
    } catch (e) {
      batch.forEach(issue => allResults.push({ key: issue.key, status: 'failed', error: e.message }));
    }
    done += batch.length;
    const pct = Math.round((done / state.selected.length) * 100);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressLabel) progressLabel.textContent = `Syncing ${done} / ${state.selected.length}…`;
    await new Promise(r => setTimeout(r, 50));
  }

  if (progressLabel) progressLabel.textContent = 'Done!';
  renderResults(allResults);
  if (syncBtn) syncBtn.disabled = false;
}

function renderResults(results) {
  const wrap = document.getElementById('resultsWrap');
  const stats = document.getElementById('resultsStats');
  const tbody = document.getElementById('resultsBody');
  if (!wrap || !stats || !tbody) return;

  const created = results.filter(r => r.status === 'created').length;
  const updated = results.filter(r => r.status === 'updated').length;
  const failed = results.filter(r => r.status === 'failed').length;

  stats.innerHTML = `
    <span class="stat-chip stat-created">✓ ${created} Created</span>
    ${updated ? `<span class="stat-chip stat-updated">↻ ${updated} Updated</span>` : ''}
    ${failed ? `<span class="stat-chip stat-failed">✗ ${failed} Failed</span>` : ''}
  `;

  tbody.innerHTML = '';
  results.forEach(r => {
    const tr = document.createElement('tr');
    let statusLabel = '', statusClass = '';
    if (r.status === 'created') { statusLabel = '✓ Created'; statusClass = 'result-status-created'; }
    else if (r.status === 'updated') { statusLabel = '↻ Updated'; statusClass = 'result-status-updated'; }
    else { statusLabel = '✗ Failed'; statusClass = 'result-status-failed'; }

    tr.innerHTML = `
      <td class="result-key">${escHtml(r.key)}</td>
      <td class="${statusClass}">${statusLabel}</td>
      <td>${r.url ? `<a class="result-task-link" href="${escHtml(r.url)}" target="_blank">${escHtml(r.taskId)}</a>` : '—'}</td>
      <td class="result-error">${r.error ? escHtml(r.error) : ''}</td>`;
    tbody.appendChild(tr);
  });

  wrap.classList.remove('hidden');
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULES — CRUD
// ═══════════════════════════════════════════════════════════════════════════

async function loadSchedules() {
  try {
    state.schedules = await api('GET', '/api/schedules');
    renderSchedules();
  } catch (e) {
    console.error('Failed to load schedules:', e.message);
  }
}

function renderSchedules() {
  const container = document.getElementById('schedulesList');
  if (!container) return;

  if (!state.schedules.length) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
        </svg>
        <h3>No Schedules Yet</h3>
        <p>Create your first recurring sync schedule to automatically keep Jira and ClickUp in sync.</p>
        <button class="btn btn-accent" onclick="openScheduleModal()">Create First Schedule</button>
      </div>`;
    return;
  }

  container.innerHTML = '';
  state.schedules.forEach(s => {
    const card = document.createElement('div');
    card.className = `schedule-card${s.enabled ? '' : ' disabled'}`;

    const intervalLabel = s.interval === 'daily_at'
      ? `Daily at ${s.time || '09:00'}`
      : (INTERVAL_LABELS[s.interval] || s.interval);

    card.innerHTML = `
      <div class="schedule-card-header">
        <div class="schedule-card-title">
          <span class="pulse${s.enabled ? '' : ' off'}"></span>
          ${escHtml(s.name)}
        </div>
        <div class="schedule-card-actions">
          <button class="btn btn-sm btn-ghost" onclick="runScheduleNow('${s.id}')" title="Run now">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
          <button class="btn btn-sm btn-ghost" onclick="viewScheduleLogs('${s.id}', '${escHtml(s.name)}')" title="View logs">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>
          </button>
          <button class="btn btn-sm btn-ghost" onclick="toggleScheduleEnabled('${s.id}', ${!s.enabled})" title="${s.enabled ? 'Pause' : 'Resume'}">
            ${s.enabled
              ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
              : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
            }
          </button>
          <button class="btn btn-sm btn-ghost" onclick="deleteSchedule('${s.id}')" title="Delete" style="color:var(--red-light)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="schedule-meta">
        <div class="schedule-meta-item">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          ${intervalLabel}
        </div>
        <div class="schedule-meta-item">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          ${escHtml(s.listName || 'Unknown List')}
        </div>
        ${s.filterName ? `<div class="schedule-meta-item">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          ${escHtml(s.filterName)}
        </div>` : ''}
      </div>
      <div class="schedule-status-row">
        <div class="schedule-last-run">
          ${s.lastRun ? `Last run: ${timeAgo(s.lastRun)}` : 'Never run'}
          ${s.lastStatus ? `<span class="run-badge ${s.lastStatus}">${s.lastStatus}</span>` : ''}
        </div>
        <span style="color:var(--text-dim)">${s.enabled ? 'Active' : 'Paused'}</span>
      </div>`;

    container.appendChild(card);
  });
}

async function runScheduleNow(id) {
  try {
    await api('POST', `/api/schedules/${id}/run`);
    setTimeout(() => loadSchedules(), 2000);
    setTimeout(() => loadSchedules(), 5000);
  } catch (e) {
    alert(`Failed to run: ${e.message}`);
  }
}

async function toggleScheduleEnabled(id, enabled) {
  try {
    await api('PUT', `/api/schedules/${id}`, { enabled });
    await loadSchedules();
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

async function deleteSchedule(id) {
  if (!confirm('Delete this schedule permanently?')) return;
  try {
    await api('DELETE', `/api/schedules/${id}`);
    await loadSchedules();
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULE MODAL
// ═══════════════════════════════════════════════════════════════════════════

function openScheduleModal() {
  state.editingScheduleId = null;
  const titleEl = document.getElementById('modalTitle');
  if (titleEl) titleEl.textContent = 'New Schedule';

  const saveBtnText = document.querySelector('#schedSaveBtn .btn-text');
  if (saveBtnText) saveBtnText.textContent = 'Create Schedule';

  // Reset form
  const fields = {
    schedName: '', schedSourceType: 'filter', schedJql: '',
    schedInterval: 'every_hour', schedTime: '09:00',
  };
  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });

  ['schedOptPriority', 'schedOptLabels', 'schedOptDescription', 'schedOptDueDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = true;
  });

  onSchedSourceTypeChange();
  onSchedIntervalChange();

  if (state.clickup.connected) {
    const sel = document.getElementById('schedWorkspace');
    if (sel) {
      sel.innerHTML = '<option value="">— Select —</option>';
      state.clickup.teams.forEach(t => sel.appendChild(new Option(t.name, t.id)));
    }
  }

  const modal = document.getElementById('scheduleModal');
  if (modal) modal.classList.remove('hidden');
}

function closeScheduleModal() {
  const modal = document.getElementById('scheduleModal');
  if (modal) modal.classList.add('hidden');
}

function onSchedSourceTypeChange() {
  const type = document.getElementById('schedSourceType')?.value;
  const filterGroup = document.getElementById('schedFilterGroup');
  const jqlGroup = document.getElementById('schedJqlGroup');
  if (filterGroup) filterGroup.classList.toggle('hidden', type !== 'filter');
  if (jqlGroup) jqlGroup.classList.toggle('hidden', type !== 'jql');
}

function onSchedIntervalChange() {
  const val = document.getElementById('schedInterval')?.value;
  const timeGroup = document.getElementById('schedTimeGroup');
  if (timeGroup) timeGroup.classList.toggle('hidden', val !== 'daily_at');
}

// ─── Schedule modal — ClickUp drill-down ─────────────────────────────────

async function onSchedWorkspaceChange() {
  const teamId = document.getElementById('schedWorkspace')?.value;
  resetSelect('schedSpace', '— Select —');
  resetSelect('schedFolder', '— No folder —');
  resetSelect('schedList', '— Select —');
  setDisabled(['schedSpace', 'schedFolder', 'schedList'], true);
  if (!teamId) return;

  try {
    const data = await api('GET', `/api/clickup/team/${teamId}/spaces`, null, cuHeaders());
    const sel = document.getElementById('schedSpace');
    if (sel) {
      (data.spaces || []).forEach(s => sel.appendChild(new Option(s.name, s.id)));
      sel.disabled = false;
    }
  } catch (e) { alert('Failed to load spaces: ' + e.message); }
}

async function onSchedSpaceChange() {
  const spaceId = document.getElementById('schedSpace')?.value;
  resetSelect('schedFolder', '— No folder —');
  resetSelect('schedList', '— Select —');
  setDisabled(['schedFolder', 'schedList'], true);
  if (!spaceId) return;

  try {
    const [folderData, listData] = await Promise.all([
      api('GET', `/api/clickup/space/${spaceId}/folders`, null, cuHeaders()),
      api('GET', `/api/clickup/space/${spaceId}/lists`, null, cuHeaders()),
    ]);
    const folderSel = document.getElementById('schedFolder');
    if (folderSel) {
      (folderData.folders || []).forEach(f => folderSel.appendChild(new Option(f.name, f.id)));
      folderSel.disabled = false;
    }
    const listSel = document.getElementById('schedList');
    if (listSel) {
      (listData.lists || []).forEach(l => listSel.appendChild(new Option(l.name, l.id)));
      listSel.disabled = false;
    }
  } catch (e) { alert('Failed to load: ' + e.message); }
}

async function onSchedFolderChange() {
  const folderId = document.getElementById('schedFolder')?.value;
  const spaceId = document.getElementById('schedSpace')?.value;
  resetSelect('schedList', '— Select —');
  if (!spaceId) return;

  try {
    const data = folderId
      ? await api('GET', `/api/clickup/folder/${folderId}/lists`, null, cuHeaders())
      : await api('GET', `/api/clickup/space/${spaceId}/lists`, null, cuHeaders());
    const listSel = document.getElementById('schedList');
    if (listSel) {
      (data.lists || []).forEach(l => listSel.appendChild(new Option(l.name, l.id)));
      listSel.disabled = false;
    }
  } catch (e) { alert('Failed to load lists: ' + e.message); }
}

// ─── Save schedule ──────────────────────────────────────────────────────

async function saveSchedule() {
  const name = document.getElementById('schedName')?.value.trim();
  if (!name) return alert('Please enter a schedule name.');

  const sourceType = document.getElementById('schedSourceType')?.value;
  let jql = '';
  let filterName = null;

  if (sourceType === 'filter') {
    const filterEl = document.getElementById('schedFilter');
    const selected = filterEl?.options[filterEl.selectedIndex];
    if (!filterEl?.value) return alert('Please select a filter.');
    jql = selected.dataset.jql || `filter = ${filterEl.value}`;
    filterName = selected.dataset.name || selected.text;
  } else {
    jql = document.getElementById('schedJql')?.value.trim();
    if (!jql) return alert('Please enter a JQL query.');
  }

  const listEl = document.getElementById('schedList');
  const listId = listEl?.value;
  if (!listId) return alert('Please select a ClickUp list.');
  const listName = listEl.options[listEl.selectedIndex]?.text || 'Unknown';

  if (!state.jira.connected) return alert('Please connect to Jira first in Settings.');
  if (!state.clickup.connected) return alert('Please connect to ClickUp first in Settings.');

  const payload = {
    name,
    jiraCredentials: { url: state.jira.url, email: state.jira.email, token: state.jira.token },
    clickupToken: state.clickup.token,
    jql, listId, listName, filterName,
    interval: document.getElementById('schedInterval')?.value || 'every_hour',
    time: document.getElementById('schedTime')?.value || '09:00',
    options: {
      syncPriority: document.getElementById('schedOptPriority')?.checked !== false,
      syncLabels: document.getElementById('schedOptLabels')?.checked !== false,
      syncDescription: document.getElementById('schedOptDescription')?.checked !== false,
      syncDueDate: document.getElementById('schedOptDueDate')?.checked !== false,
    },
  };

  setLoading('schedSaveBtn', true);

  try {
    if (state.editingScheduleId) {
      await api('PUT', `/api/schedules/${state.editingScheduleId}`, payload);
    } else {
      await api('POST', '/api/schedules', payload);
    }
    closeScheduleModal();
    await loadSchedules();
    refreshDashboard();
  } catch (e) {
    alert(`Failed to save: ${e.message}`);
  } finally {
    setLoading('schedSaveBtn', false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG MODAL
// ═══════════════════════════════════════════════════════════════════════════

async function viewScheduleLogs(id, name) {
  const titleEl = document.getElementById('logModalTitle');
  if (titleEl) titleEl.textContent = `Run History — ${name}`;

  const modal = document.getElementById('logModal');
  if (modal) modal.classList.remove('hidden');

  const timeline = document.getElementById('logTimeline');
  if (!timeline) return;
  timeline.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px">Loading...</div>';

  try {
    const logs = await api('GET', `/api/schedules/${id}/logs`);
    if (!logs.length) {
      timeline.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px">No runs recorded yet.</div>';
      return;
    }

    timeline.innerHTML = logs.map(log => `
      <div class="log-entry">
        <div class="log-dot ${log.status}"></div>
        <div class="log-content">
          <div style="font-weight:500;color:var(--text)">${log.status === 'success' ? 'Sync Completed' : log.status === 'failed' ? 'Sync Failed' : 'Running...'}</div>
          ${log.error ? `<div style="color:var(--red-light);font-size:0.75rem;margin-top:4px">${escHtml(log.error)}</div>` : ''}
          <div class="log-stats">
            <span class="log-stat created">✓ ${log.created || 0} created</span>
            <span class="log-stat updated">↻ ${log.updated || 0} updated</span>
            <span class="log-stat failed">✗ ${log.failed || 0} failed</span>
            <span style="color:var(--text-dim)">${log.issueCount || 0} issues</span>
          </div>
        </div>
        <div class="log-time">${new Date(log.timestamp).toLocaleString()}</div>
      </div>
    `).join('');
  } catch (e) {
    timeline.innerHTML = `<div style="color:var(--red-light);padding:24px">Failed to load logs: ${e.message}</div>`;
  }
}

function closeLogModal() {
  const modal = document.getElementById('logModal');
  if (modal) modal.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════

async function refreshDashboard() {
  try {
    state.schedules = await api('GET', '/api/schedules');
  } catch (_) {}

  const total = state.schedules.length;
  const active = state.schedules.filter(s => s.enabled).length;

  const today = new Date().toDateString();
  let synced = 0;
  let failedRuns = 0;

  state.schedules.forEach(s => {
    (s.logs || []).forEach(log => {
      if (new Date(log.timestamp).toDateString() === today) {
        synced += (log.created || 0) + (log.updated || 0);
        if (log.status === 'failed') failedRuns++;
      }
    });
  });

  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setVal('statTotal', total);
  setVal('statActive', active);
  setVal('statSynced', synced);
  setVal('statFailed', failedRuns);

  // Activity feed
  const feed = document.getElementById('activityFeed');
  if (!feed) return;

  const allLogs = [];
  state.schedules.forEach(s => {
    (s.logs || []).forEach(log => {
      allLogs.push({ ...log, scheduleName: s.name });
    });
  });

  allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const recent = allLogs.slice(0, 20);

  if (!recent.length) {
    feed.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
        </svg>
        <p>No activity yet. Create a schedule to get started.</p>
      </div>`;
    return;
  }

  feed.innerHTML = recent.map(log => `
    <div class="activity-item">
      <div class="activity-dot ${log.status === 'success' ? 'success' : log.status === 'failed' ? 'failed' : 'info'}"></div>
      <div class="activity-info">
        <div class="activity-title">${escHtml(log.scheduleName)}</div>
        <div class="activity-detail">
          ${log.status === 'success'
            ? `✓ ${log.created || 0} created, ↻ ${log.updated || 0} updated${log.failed ? `, ✗ ${log.failed} failed` : ''}`
            : log.error ? escHtml(log.error) : 'Run failed'}
        </div>
      </div>
      <div class="activity-time">${timeAgo(log.timestamp)}</div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK (Settings — preserved)
// ═══════════════════════════════════════════════════════════════════════════

async function loadAllSpacesForWebhook() {
  const spaceList = document.getElementById('webhookSpaceList');
  if (!spaceList) return;
  spaceList.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem;">Loading spaces…</div>';
  try {
    const teamId = state.clickup.teams[0]?.id;
    if (!teamId) return;
    const data = await api('GET', `/api/clickup/team/${teamId}/spaces?archived=false`, null, cuHeaders());
    const spaces = data.spaces || [];
    spaceList.innerHTML = '';
    if (!spaces.length) {
      spaceList.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem;">No spaces found.</div>';
      return;
    }
    spaces.forEach(s => {
      const div = document.createElement('div');
      div.innerHTML = `<label class="checkbox-row"><input type="checkbox" name="webhookSpace" value="${s.id}" /><span>${escHtml(s.name)}</span></label>`;
      spaceList.appendChild(div);
    });
  } catch (e) {
    spaceList.innerHTML = `<div style="color:var(--red-light); font-size:0.82rem;">Failed: ${e.message}</div>`;
  }
}

async function initiateWebhook() {
  const publicUrl = document.getElementById('webhookPublicUrl')?.value.trim();
  const selectedSpaces = Array.from(document.querySelectorAll('input[name="webhookSpace"]:checked')).map(cb => cb.value);
  if (!publicUrl) return alert('Please enter your Public Server URL.');

  setLoading('initWebhookBtn', true);
  try {
    const teamId = state.clickup.teams[0]?.id;
    const payload = {
      teamId,
      endpointBase: publicUrl.replace(/\/$/, ''),
      token: state.clickup.token,
      spaces: selectedSpaces.join(','),
    };
    await api('POST', '/api/clickup/webhook/setup', payload, cuHeaders());
    await checkWebhookStatus();
    alert('Webhook created successfully!');
  } catch (e) {
    alert(`Failed: ${e.message}`);
  } finally {
    setLoading('initWebhookBtn', false);
  }
}

async function disableWebhook() {
  if (!confirm('Disable and remove this webhook?')) return;
  setLoading('initWebhookBtn', true);
  try {
    await api('DELETE', '/api/clickup/webhook', null, cuHeaders());
    await checkWebhookStatus();
    alert('Webhook disabled.');
  } catch (e) {
    alert(`Failed: ${e.message}`);
  } finally {
    setLoading('initWebhookBtn', false);
  }
}

function toggleWebhook() {
  if (state.webhook?.active) disableWebhook();
  else initiateWebhook();
}

async function checkWebhookStatus() {
  try {
    const status = await api('GET', '/api/webhook/status');
    state.webhook = status?.active ? status : { active: false };
  } catch (_) {
    state.webhook = { active: false };
  }
  updateWebhookUI();
}

function updateWebhookUI() {
  const badge = document.getElementById('webhookStatusBadge');
  const btn = document.getElementById('initWebhookBtn');
  if (!badge || !btn) return;

  if (state.webhook?.active) {
    badge.textContent = 'Status: Active';
    badge.style.cssText = 'background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);font-size:0.72rem;padding:4px 10px;border-radius:12px;';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg> Disable Webhook';
    btn.style.background = 'var(--red)';
    const logSection = document.getElementById('webhookLogSection');
    if (logSection) logSection.classList.remove('hidden');
  } else {
    badge.textContent = 'Status: Inactive';
    badge.style.cssText = 'background:rgba(255,255,255,0.05);color:var(--text-muted);border:1px solid var(--border);font-size:0.72rem;padding:4px 10px;border-radius:12px;';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/></svg> Initiate Webhook';
    btn.style.background = '';
  }
}

async function listAllWebhooks() {
  const teamId = state.clickup.teams[0]?.id;
  if (!teamId) return alert('Connect ClickUp first.');
  try {
    const data = await api('GET', `/api/clickup/webhooks?teamId=${teamId}`, null, cuHeaders());
    const webhooks = data.webhooks || [];
    if (webhooks.length > 0) {
      const list = webhooks.map(w => `• ${w.endpoint} (${w.status})`).join('\n');
      alert(`Found ${webhooks.length} webhook(s):\n\n${list}`);
    } else {
      alert('No webhooks found for this team.');
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

async function pollWebhookLogs() {
  const logContainer = document.getElementById('webhookLogs');
  if (!logContainer) { setTimeout(pollWebhookLogs, 10000); return; }
  try {
    const logs = await api('GET', '/api/webhook/logs');
    if (logs?.length) {
      const logSection = document.getElementById('webhookLogSection');
      if (logSection) logSection.classList.remove('hidden');
      logContainer.innerHTML = logs.map(l => {
        const time = new Date(l.timestamp).toLocaleTimeString();
        return `<div style="margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.04);padding-bottom:4px">
          <span style="color:var(--accent-light)">[${time}]</span>
          <span style="color:var(--green-light);font-weight:bold"> ${l.event}</span><br/>
          <span style="color:var(--text-muted)">${l.details || ''}</span>
        </div>`;
      }).join('');
    }
  } catch (_) {}
  setTimeout(pollWebhookLogs, 10000);
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

function initPersistence() {


  const jiraCreds = localStorage.getItem('jira_creds');
  if (jiraCreds) {
    try {
      const { url, email, token } = JSON.parse(jiraCreds);
      const urlEl = document.getElementById('jiraUrl');
      const emailEl = document.getElementById('jiraEmail');
      const tokenEl = document.getElementById('jiraToken');
      if (urlEl) urlEl.value = url;
      if (emailEl) emailEl.value = email;
      if (tokenEl) tokenEl.value = token;
      connectJira();
    } catch (_) {}
  }

  const cuCreds = localStorage.getItem('clickup_creds');
  if (cuCreds) {
    try {
      const { token } = JSON.parse(cuCreds);
      const tokenEl = document.getElementById('clickupToken');
      if (tokenEl) tokenEl.value = token;
      connectClickUp();
    } catch (_) {}
  }

  checkWebhookStatus();
  pollWebhookLogs();
  updateSidebarStatus();
  refreshDashboard();
}

// Listen for list change on manual sync
const cuListEl = document.getElementById('cuList');
if (cuListEl) cuListEl.addEventListener('change', updateSyncSummary);

// Boot
window.addEventListener('DOMContentLoaded', initPersistence);

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const schedModal = document.getElementById('scheduleModal');
    const logModal = document.getElementById('logModal');
    if (schedModal) schedModal.classList.add('hidden');
    if (logModal) logModal.classList.add('hidden');
  }
});

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});
