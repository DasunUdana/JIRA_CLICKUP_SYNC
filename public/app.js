/* ─────────────────────────────────────────────────────────────────────────────
   Jira → ClickUp Sync — frontend app.js
   All API calls go through the local Express proxy at /api/*
───────────────────────────────────────────────────────────────────────────── */

// ── State ─────────────────────────────────────────────────────────────────
const state = {
    jira: { connected: false, url: '', email: '', token: '' },
    clickup: { connected: false, token: '', teams: [] },
    issues: [],     // all fetched Jira issues
    selected: [],   // issues user has checked
    sourceMode: 'project',
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
    const res = await fetch(path, opts);
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

function unlockStep(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('locked'); el.classList.add('unlocked'); }
}

function setStepStatus(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

function updateHeaderStatus() {
    const dot = document.querySelector('.status-dot');
    const text = document.getElementById('headerStatusText');
    if (state.jira.connected && state.clickup.connected) {
        dot.className = 'status-dot connected';
        text.textContent = 'Jira + ClickUp connected';
    } else if (state.jira.connected || state.clickup.connected) {
        dot.className = 'status-dot partial';
        text.textContent = state.jira.connected ? 'Jira connected' : 'ClickUp connected';
    } else {
        dot.className = 'status-dot';
        text.textContent = 'Not connected';
    }
}

function toggleVis(id) {
    const el = document.getElementById(id);
    el.type = el.type === 'password' ? 'text' : 'password';
}

// ── STEP 1: Jira Connect ──────────────────────────────────────────────────

async function connectJira() {
    clearError('jiraError');
    const url = document.getElementById('jiraUrl').value.trim();
    const email = document.getElementById('jiraEmail').value.trim();
    const token = document.getElementById('jiraToken').value.trim();

    if (!url || !email || !token) {
        return showError('jiraError', 'Please fill in all Jira credential fields.');
    }

    state.jira = { connected: false, url, email, token };
    setLoading('jiraConnectBtn', true);

    try {
        const me = await api('GET', '/api/jira/me', null, jiraHeaders());
        state.jira.connected = true;
        state.jira.displayName = me.displayName || email;

        setStepStatus('jiraStatus', `✓ ${state.jira.displayName}`);
        updateHeaderStatus();
        unlockStep('step3');

        // Persistence
        if (document.getElementById('jiraRemember').checked) {
            localStorage.setItem('jira_creds', JSON.stringify({ url, email, token }));
        } else {
            localStorage.removeItem('jira_creds');
        }

        // Prefetch projects + filters for step 3
        loadJiraProjects();
        loadJiraFilters();

        maybeUnlockSyncPanel();
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
        (data.values || []).forEach(p => {
            const opt = new Option(`${p.name} (${p.key})`, p.key);
            select.appendChild(opt);
        });
    } catch (_) { /* non-blocking */ }
}

async function loadJiraFilters() {
    try {
        const data = await api('GET', '/api/jira/filters', null, jiraHeaders());
        const select = document.getElementById('jiraFilter');
        (data.values || []).forEach(f => {
            const opt = new Option(f.name, f.id);
            opt.dataset.jql = f.jql;
            select.appendChild(opt);
        });
    } catch (_) { /* non-blocking */ }
}

// ── STEP 2: ClickUp Connect ───────────────────────────────────────────────

async function connectClickUp() {
    clearError('clickupError');
    const token = document.getElementById('clickupToken').value.trim();
    if (!token) return showError('clickupError', 'Please enter your ClickUp API token.');

    state.clickup = { connected: false, token, teams: [] };
    setLoading('clickupConnectBtn', true);

    try {
        const data = await api('GET', '/api/clickup/teams', null, cuHeaders());
        state.clickup.teams = data.teams || [];
        state.clickup.connected = true;

        setStepStatus('clickupStatus', `✓ ${state.clickup.teams.length} workspace(s)`);
        updateHeaderStatus();
        unlockStep('step4');

        // Persistence
        if (document.getElementById('clickupRemember').checked) {
            localStorage.setItem('clickup_creds', JSON.stringify({ token }));
        } else {
            localStorage.removeItem('clickup_creds');
        }

        populateWorkspaces();
        loadAllSpacesForWebhook(); // <-- Fetch spaces for Step 7
        unlockStep('step7');
        maybeUnlockSyncPanel();
    } catch (e) {
        showError('clickupError', `Connection failed: ${e.message}`);
    } finally {
        setLoading('clickupConnectBtn', false);
    }
}

// ── STEP 3: Source Mode ───────────────────────────────────────────────────

function setSourceMode(mode) {
    state.sourceMode = mode;
    ['project', 'filter', 'jql'].forEach(m => {
        document.getElementById('mode' + m.charAt(0).toUpperCase() + m.slice(1)).classList.toggle('hidden', m !== mode);
        document.getElementById('tab' + m.charAt(0).toUpperCase() + m.slice(1)).classList.toggle('active', m === mode);
    });
}

async function fetchIssues() {
    clearError('jiraSourceError');
    document.getElementById('issuesPreview').classList.add('hidden');
    setLoading('fetchIssuesBtn', true);

    try {
        let jql = '';
        if (state.sourceMode === 'project') {
            const project = document.getElementById('jiraProject').value;
            if (!project) throw new Error('Please select a project.');
            const statusFilter = document.getElementById('jiraStatusFilter').value.trim();
            jql = `project = "${project}"`;
            if (statusFilter) {
                const statuses = statusFilter.split(',').map(s => `"${s.trim()}"`).join(',');
                jql += ` AND status in (${statuses})`;
            }
            jql += ' ORDER BY created DESC';
        } else if (state.sourceMode === 'filter') {
            const filterEl = document.getElementById('jiraFilter');
            const selected = filterEl.options[filterEl.selectedIndex];
            if (!filterEl.value) throw new Error('Please select a filter.');
            jql = selected.dataset.jql || `filter = ${filterEl.value}`;
        } else {
            jql = document.getElementById('jiraJql').value.trim();
            if (!jql) throw new Error('Please enter a JQL query.');
        }

        const data = await api('GET', `/api/jira/search?jql=${encodeURIComponent(jql)}&maxResults=100`, null, jiraHeaders());
        state.issues = data.issues || [];
        renderIssues();
        unlockStep('step5');
        unlockStep('step6');
        maybeUnlockSyncPanel();
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

    list.innerHTML = '';
    count.textContent = `${state.issues.length} tasks found`;
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
    state.selected = state.issues.filter(i =>
        document.getElementById(`issue_${i.key}`)?.checked
    );
    updateSyncSummary();
}

function toggleSelectAll(cb) {
    document.querySelectorAll('.issues-list input[type=checkbox]').forEach(el => el.checked = cb.checked);
    updateSelected();
}

function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── STEP 4: ClickUp Destination ───────────────────────────────────────────

function populateWorkspaces() {
    const sel = document.getElementById('cuWorkspace');
    sel.innerHTML = '<option value="">— Select workspace —</option>';
    state.clickup.teams.forEach(t => sel.appendChild(new Option(t.name, t.id)));
}

async function onWorkspaceChange() {
    const teamId = document.getElementById('cuWorkspace').value;
    resetSelect('cuSpace', '— Select space —');
    resetSelect('cuFolder', '— No folder (root lists) —');
    resetSelect('cuList', '— Select list —');
    setDisabled(['cuSpace', 'cuFolder', 'cuList'], true);
    if (!teamId) return;

    try {
        const data = await api('GET', `/api/clickup/team/${teamId}/spaces`, null, cuHeaders());
        const sel = document.getElementById('cuSpace');
        (data.spaces || []).forEach(s => sel.appendChild(new Option(s.name, s.id)));
        sel.disabled = false;
    } catch (e) { showError('cuDestError', e.message); }
}

async function onSpaceChange() {
    const spaceId = document.getElementById('cuSpace').value;
    resetSelect('cuFolder', '— No folder (root lists) —');
    resetSelect('cuList', '— Select list —');
    setDisabled(['cuFolder', 'cuList'], true);
    clearError('cuDestError');
    if (!spaceId) return;

    try {
        // Load folders
        const [folderData, listData] = await Promise.all([
            api('GET', `/api/clickup/space/${spaceId}/folders`, null, cuHeaders()),
            api('GET', `/api/clickup/space/${spaceId}/lists`, null, cuHeaders()),
        ]);
        const folderSel = document.getElementById('cuFolder');
        (folderData.folders || []).forEach(f => folderSel.appendChild(new Option(f.name, f.id)));
        folderSel.disabled = false;

        // Also populate root lists
        const listSel = document.getElementById('cuList');
        (listData.lists || []).forEach(l => listSel.appendChild(new Option(l.name, l.id)));
        listSel.disabled = false;
        updateSyncSummary();
    } catch (e) { showError('cuDestError', e.message); }
}

async function onFolderChange() {
    const folderId = document.getElementById('cuFolder').value;
    resetSelect('cuList', '— Select list —');
    clearError('cuDestError');

    const spaceId = document.getElementById('cuSpace').value;
    if (!spaceId) return;

    try {
        if (folderId) {
            // Lists inside chosen folder
            const data = await api('GET', `/api/clickup/folder/${folderId}/lists`, null, cuHeaders());
            const listSel = document.getElementById('cuList');
            (data.lists || []).forEach(l => listSel.appendChild(new Option(l.name, l.id)));
        } else {
            // Back to root lists
            const data = await api('GET', `/api/clickup/space/${spaceId}/lists`, null, cuHeaders());
            const listSel = document.getElementById('cuList');
            (data.lists || []).forEach(l => listSel.appendChild(new Option(l.name, l.id)));
        }
        document.getElementById('cuList').disabled = false;
        updateSyncSummary();
    } catch (e) { showError('cuDestError', e.message); }
}

function resetSelect(id, placeholder) {
    const el = document.getElementById(id);
    el.innerHTML = `<option value="">${placeholder}</option>`;
}
function setDisabled(ids, val) { ids.forEach(id => { document.getElementById(id).disabled = val; }); }

// ── STEP 6: Sync Summary ───────────────────────────────────────────────────

function updateSyncSummary() {
    const count = state.selected.length;
    const listEl = document.getElementById('cuList');
    const listName = listEl.options[listEl.selectedIndex]?.text || '—';
    document.getElementById('syncTaskCount').textContent = `${count} task${count !== 1 ? 's' : ''}`;
    document.getElementById('syncDestName').textContent = listName !== '— Select list —' ? listName : '—';
}

function maybeUnlockSyncPanel() {
    if (state.jira.connected && state.clickup.connected) {
        unlockStep('step6');
    }
}

// ── Sync ──────────────────────────────────────────────────────────────────

async function startSync() {
    const listId = document.getElementById('cuList').value;
    if (!listId) return alert('Please select a ClickUp list first.');
    if (!state.selected.length) return alert('No tasks selected to sync.');

    const options = {
        syncPriority: document.getElementById('optPriority').checked,
        syncLabels: document.getElementById('optLabels').checked,
        syncDescription: document.getElementById('optDescription').checked,
        syncDueDate: document.getElementById('optDueDate').checked,
    };
    const prefix = document.getElementById('taskPrefix').value.trim();

    // Apply prefix to summaries if provided
    const issuesPayload = state.selected.map(issue => {
        if (prefix) {
            return {
                ...issue,
                fields: { ...issue.fields, summary: `${prefix} ${issue.fields.summary}` },
            };
        }
        return issue;
    });

    document.getElementById('syncBtn').disabled = true;
    document.getElementById('progressWrap').classList.remove('hidden');
    document.getElementById('resultsWrap').classList.add('hidden');
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressLabel').textContent = `Syncing 0 / ${issuesPayload.length}…`;

    // Send in batches of 10 for live progress
    const batchSize = 10;
    const allResults = [];
    let done = 0;

    for (let i = 0; i < issuesPayload.length; i += batchSize) {
        const batch = issuesPayload.slice(i, i + batchSize);
        try {
            const data = await api('POST', '/api/sync', { issues: batch, listId, options }, {
                ...jiraHeaders(),
                ...cuHeaders(),
            });
            allResults.push(...(data.results || []));
        } catch (e) {
            batch.forEach(issue => allResults.push({ key: issue.key, status: 'failed', error: e.message }));
        }
        done += batch.length;
        const pct = Math.round((done / issuesPayload.length) * 100);
        document.getElementById('progressFill').style.width = `${pct}%`;
        document.getElementById('progressLabel').textContent = `Syncing ${done} / ${issuesPayload.length}…`;
        await new Promise(r => setTimeout(r, 50)); // allow repaint
    }

    document.getElementById('progressLabel').textContent = 'Done!';
    renderResults(allResults);
    document.getElementById('syncBtn').disabled = false;
}

function renderResults(results) {
    const wrap = document.getElementById('resultsWrap');
    const stats = document.getElementById('resultsStats');
    const tbody = document.getElementById('resultsBody');

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
        let statusLabel = '';
        let statusClass = '';
        if (r.status === 'created') {
            statusLabel = '✓ Created';
            statusClass = 'result-status-created';
        } else if (r.status === 'updated') {
            statusLabel = '↻ Updated';
            statusClass = 'result-status-updated';
        } else {
            statusLabel = '✗ Failed';
            statusClass = 'result-status-failed';
        }

        tr.innerHTML = `
      <td class="result-key">${escHtml(r.key)}</td>
      <td class="${statusClass}">
        ${statusLabel}
      </td>
      <td>${r.url ? `<a class="result-task-link" href="${escHtml(r.url)}" target="_blank">${escHtml(r.taskId)}</a>` : '—'}</td>
      <td class="result-error">${r.error ? escHtml(r.error) : ''}</td>`;
        tbody.appendChild(tr);
    });

    wrap.classList.remove('hidden');
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── STEP 7: Webhook Control (Sync-Back) ───────────────────────────────────

async function loadAllSpacesForWebhook() {
    const spaceList = document.getElementById('webhookSpaceList');
    spaceList.innerHTML = '<div style="color:var(--text-muted); font-size:0.82rem;">Loading spaces…</div>';

    try {
        const teamId = document.getElementById('cuWorkspace').value || state.clickup.teams[0]?.id;
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
            div.innerHTML = `
        <label class="checkbox-row" style="color:var(--text)">
          <input type="checkbox" name="webhookSpace" value="${s.id}" onchange="updateWebhookUrl()" />
          <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escHtml(s.name)}">${escHtml(s.name)}</span>
        </label>`;
            spaceList.appendChild(div);
        });

        updateWebhookUrl();
    } catch (e) {
        spaceList.innerHTML = `<div style="color:var(--red); font-size:0.82rem;">Failed to load spaces: ${e.message}</div>`;
    }
}

function updateWebhookUrl() {
    const baseUrl = window.location.origin;
    const token = state.clickup.token;
    const selectedSpaces = Array.from(document.querySelectorAll('input[name="webhookSpace"]:checked')).map(cb => cb.value);

    const input = document.getElementById('webhookUrlInput');
    if (!token) {
        input.value = 'Connect ClickUp first...';
        return;
    }

    let url = `${baseUrl}/api/webhook/clickup?token=${encodeURIComponent(token)}`;
    if (selectedSpaces.length) {
        url += `&spaces=${selectedSpaces.join(',')}`;
    }

    input.value = url;
}

async function initiateWebhook() {
    const publicUrl = document.getElementById('webhookPublicUrl').value.trim();
    const selectedSpaces = Array.from(document.querySelectorAll('input[name="webhookSpace"]:checked')).map(cb => cb.value);

    if (!publicUrl) {
        alert('Please enter your Public Server URL (e.g. your ngrok URL)');
        return;
    }

    const btn = document.getElementById('initWebhookBtn');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = 'Creating Webhook…';

    try {
        const teamId = document.getElementById('cuWorkspace').value || state.clickup.teams[0]?.id;
        const payload = {
            teamId,
            endpointBase: publicUrl.replace(/\/$/, ''),
            token: state.clickup.token,
            spaces: selectedSpaces.join(',')
        };

        const result = await api('POST', '/api/clickup/webhook/setup', payload);

        alert(`Successfully created webhook in ClickUp!\nWebhook ID: ${result.id}`);
        btn.innerText = '✓ Webhook Created';
        btn.style.background = 'var(--green)';
    } catch (e) {
        alert(`Failed to create webhook: ${e.message}`);
        btn.innerText = 'Failed';
        btn.style.background = 'var(--red)';
        setTimeout(() => {
            btn.disabled = false;
            btn.innerText = originalText;
            btn.style.background = '';
        }, 3000);
    } finally {
        btn.disabled = false;
    }
}

function copyWebhookUrl() {
    const input = document.getElementById('webhookUrlInput');
    if (!input.value || input.value.startsWith('Connect')) return;

    input.select();
    input.setSelectionRange(0, 99999); // For mobile
    navigator.clipboard.writeText(input.value);

    // Visual feedback
    const btn = document.querySelector('.btn-copy');
    const svg = btn.innerHTML;
    btn.innerHTML = '✓';
    btn.style.background = 'var(--green)';
    btn.style.color = 'white';
    setTimeout(() => {
        btn.innerHTML = svg;
        btn.style.background = '';
        btn.style.color = '';
    }, 2000);
}

// ── Init ──────────────────────────────────────────────────────────────────

function initPersistence() {
    const jiraCreds = localStorage.getItem('jira_creds');
    if (jiraCreds) {
        const { url, email, token } = JSON.parse(jiraCreds);
        document.getElementById('jiraUrl').value = url;
        document.getElementById('jiraEmail').value = email;
        document.getElementById('jiraToken').value = token;
        connectJira();
    }

    const cuCreds = localStorage.getItem('clickup_creds');
    if (cuCreds) {
        const { token } = JSON.parse(cuCreds);
        document.getElementById('clickupToken').value = token;
        connectClickUp();
    }
}

// Listen for list change to update sync summary
document.getElementById('cuList').addEventListener('change', updateSyncSummary);

// Load persisted credentials on start
window.addEventListener('DOMContentLoaded', initPersistence);
