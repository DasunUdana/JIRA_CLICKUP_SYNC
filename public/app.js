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
            const isActive = state.webhook?.active && state.webhook.spaces?.split(',').includes(s.id);
            const isDisabled = state.webhook?.active ? 'disabled' : '';
            div.innerHTML = `
        <label class="checkbox-row" style="color:var(--text)">
          <input type="checkbox" name="webhookSpace" value="${s.id}" onchange="updateWebhookUrl()" ${isActive ? 'checked' : ''} ${isDisabled} />
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

    setLoading('initWebhookBtn', true);

    try {
        const teamId = document.getElementById('cuWorkspace').value || state.clickup.teams[0]?.id;
        const payload = {
            teamId,
            endpointBase: publicUrl.replace(/\/$/, ''),
            token: state.clickup.token,
            spaces: selectedSpaces.join(',')
        };

        const result = await api('POST', '/api/clickup/webhook/setup', payload, cuHeaders());
        
        // Save to state and update UI
        state.webhook = { 
            active: true, 
            ...result, 
            endpointBase: payload.endpointBase, 
            spaces: payload.spaces 
        };
        updateWebhookUI();
        
        alert(`Successfully created webhook in ClickUp!\nWebhook ID: ${result.id}`);
    } catch (e) {
        alert(`Failed to create webhook: ${e.message}`);
    } finally {
        setLoading('initWebhookBtn', false);
    }
}

async function disableWebhook() {
    if (!confirm('Are you sure you want to disable and remove this webhook?')) return;

    setLoading('initWebhookBtn', true);
    try {
        await api('DELETE', '/api/clickup/webhook', null, cuHeaders());
        
        state.webhook.active = false;
        alert('Webhook disabled and removed successfully.');
        updateWebhookUI();
    } catch (e) {
        alert(`Failed to disable webhook: ${e.message}`);
    } finally {
        setLoading('initWebhookBtn', false);
    }
}

function toggleWebhook() {
    if (state.webhook?.active) {
        disableWebhook();
    } else {
        initiateWebhook();
    }
}

function updateWebhookUI() {
    const btn = document.getElementById('initWebhookBtn');
    const badge = document.getElementById('webhookStatusBadge');
    const publicUrlInput = document.getElementById('webhookPublicUrl');
    const spaceCheckboxes = document.querySelectorAll('input[name="webhookSpace"]');

    if (state.webhook?.active) {
        // Show values and disable inputs
        if (state.webhook.endpointBase) {
            publicUrlInput.value = state.webhook.endpointBase;
        }
        publicUrlInput.disabled = true;
        
        const activeSpaces = state.webhook.spaces ? state.webhook.spaces.split(',') : [];
        spaceCheckboxes.forEach(cb => {
            cb.checked = activeSpaces.includes(cb.value);
            cb.disabled = true;
        });

        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            Disable Webhook
        `;
        btn.style.background = 'var(--red)';
        
        badge.innerText = 'Status: Active';
        badge.style.background = 'rgba(16, 185, 129, 0.2)';
        badge.style.color = '#10b981';
        badge.style.borderColor = '#10b981';

        document.getElementById('webhookLogSection').classList.remove('hidden');
    } else {
        // Restore/Enable inputs
        publicUrlInput.disabled = false;
        spaceCheckboxes.forEach(cb => cb.disabled = false);

        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2v20M2 12h20" />
            </svg>
            Initiate Webhook
        `;
        btn.style.background = '';

        badge.innerText = 'Status: Not Setup';
        badge.style.background = 'var(--bg-card)';
        badge.style.color = 'var(--text-muted)';
        badge.style.borderColor = 'var(--border)';
    }
    
    // Always update the manual URL box
    updateWebhookUrl();
}

async function listAllWebhooks() {
    const teamId = document.getElementById('cuWorkspace').value || state.clickup.teams[0]?.id;
    if (!teamId) return alert('Please connect ClickUp first.');

    setLoading('checkWebhookBtn', true);
    try {
        const data = await api('GET', `/api/clickup/webhooks?teamId=${teamId}`, null, cuHeaders());
        const webhooks = data.webhooks || [];
        
        if (webhooks.length > 0) {
            const list = webhooks.map(w => `• ${w.endpoint} (${w.status})`).join('\n');
            alert(`Found ${webhooks.length} webhooks in ClickUp:\n\n${list}\n\nNote: If your URL matches, you can manually update the server status if needed.`);
            
            // If any webhook matches our current URL logic, we could auto-activate
            // For now, just show them to the user as requested.
        } else {
            alert('No webhooks found for this team in ClickUp.');
        }
    } catch (e) {
        alert(`Failed to check ClickUp: ${e.message}`);
    } finally {
        setLoading('checkWebhookBtn', false);
    }
}

async function checkWebhookStatus() {
    try {
        const status = await api('GET', '/api/webhook/status');
        if (status && status.active) {
            state.webhook = status;
        } else {
            state.webhook = { active: false };
        }
        updateWebhookUI();
    } catch (e) {
        console.error('Failed to fetch webhook status:', e.message);
    }
}

async function pollWebhookLogs() {
    const logContainer = document.getElementById('webhookLogs');
    const pulse = document.getElementById('logUpdatePulse');
    const logSection = document.getElementById('webhookLogSection');

    try {
        const logs = await api('GET', '/api/webhook/logs');
        if (logs && logs.length > 0) {
            logSection.classList.remove('hidden');
            
            // Pulsate to show update
            pulse.classList.remove('hidden');
            setTimeout(() => pulse.classList.add('hidden'), 1000);

            logContainer.innerHTML = logs.map(l => {
                const time = new Date(l.timestamp).toLocaleTimeString();
                return `<div style="margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px;">
                    <span style="color: var(--blue)">[${time}]</span> 
                    <span style="color: #10b981; font-weight: bold;">${l.event}</span><br/>
                    <span style="color: var(--text-muted)">${l.details || ''}</span>
                </div>`;
            }).join('');
        }
    } catch (e) {
        console.error('Log polling failed:', e.message);
    }
    
    // Poll every 5 seconds
    setTimeout(pollWebhookLogs, 5000);
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

    checkWebhookStatus();
    pollWebhookLogs();
}

// Listen for list change to update sync summary
document.getElementById('cuList').addEventListener('change', updateSyncSummary);

// Load persisted credentials on start
window.addEventListener('DOMContentLoaded', initPersistence);
