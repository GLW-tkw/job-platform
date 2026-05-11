/* ═══════════════════════════════════════════
   JOB PLATFORM — main.js
═══════════════════════════════════════════ */

// ── STATE ──────────────────────────────────────────────────────────────
const state = {
  user: null,
  jobs: [],
  users: [],
  notifications: [],
  currentView: 'dashboard',
  currentFilter: 'all',
  socket: null,
  chat: {
    currentJobId: null,
    currentChannelName: 'General Chat',
    messages: [],
    refJobId: null,
    refJobTitle: null,
    unreadGeneral: 0,
  },
  deletedUserHistory: [],
  editingJobFiles: [],       // files to remove on edit
  newSelectedFiles: [],      // newly selected files for job form
  submitFiles: [],           // files selected for job submission
};

// ── API HELPERS ────────────────────────────────────────────────────────
async function api(method, url, body, isForm) {
  const opts = { method, credentials: 'same-origin' };
  if (body) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const GET  = (url)         => api('GET', url);
const POST = (url, body)   => api('POST', url, body);
const PUT  = (url, body)   => api('PUT', url, body);
const DEL  = (url)         => api('DELETE', url);

// ── INIT ───────────────────────────────────────────────────────────────
async function init() {
  try {
    const me = await GET('/api/auth/me');
    onLoginSuccess(me);
  } catch (_) {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('loginPage').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

// ── AUTH ───────────────────────────────────────────────────────────────
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn   = document.getElementById('loginBtn');
  errEl.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const user = await POST('/api/auth/login', { username, password });
    onLoginSuccess(user);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In';
  }
});

function onLoginSuccess(user) {
  state.user = user;
  setUserUI(user);
  showApp();
  initSocket();
  loadDashboard();
  loadNotifications();
  if (user.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }
}

function setUserUI(user) {
  document.getElementById('sidebarUsername').textContent = user.username;
  document.getElementById('sidebarRole').textContent = user.role === 'admin' ? 'Administrator' : 'User';
  document.getElementById('sidebarAvatar').textContent = user.username[0].toUpperCase();
}

async function logout() {
  await POST('/api/auth/logout');
  state.user = null;
  state.jobs = [];
  if (state.socket) state.socket.disconnect();
  showLogin();
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
}

// ── SOCKET.IO ──────────────────────────────────────────────────────────
function initSocket() {
  const socket = window.io();
  state.socket = socket;

  socket.on('connect', () => {
    socket.emit('authenticate', state.user.id);
  });

  socket.on('notification', (notif) => {
    state.notifications.unshift(notif);
    renderNotifications();
    showToast(notif.message, 'info');
  });

  socket.on('job_created', (job) => {
    const existing = state.jobs.findIndex(j => j.id === job.id);
    if (existing === -1) state.jobs.unshift(job);
    else state.jobs[existing] = job;
    renderJobGrid();
    loadChatJobList();
  });

  socket.on('job_updated', (job) => {
    const idx = state.jobs.findIndex(j => j.id === job.id);
    if (idx !== -1) state.jobs[idx] = job;
    else state.jobs.unshift(job);
    renderJobGrid();
  });

  socket.on('job_deleted', ({ id }) => {
    state.jobs = state.jobs.filter(j => j.id !== id);
    renderJobGrid();
  });

  socket.on('new_message', (msg) => {
    if (msg.job_id === null && state.chat.currentJobId === null) {
      appendChatMessage(msg);
    } else if (msg.job_id && String(msg.job_id) === String(state.chat.currentJobId)) {
      appendChatMessage(msg);
    } else if (state.currentView !== 'chat') {
      // Unread indicator
      if (!msg.job_id) {
        state.chat.unreadGeneral++;
        updateChatBadge();
      }
    }
  });

  socket.on(`message_job_${state.chat.currentJobId}`, (msg) => {
    appendChatMessage(msg);
  });
}

// ── VIEWS ──────────────────────────────────────────────────────────────
function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`${view}View`).classList.remove('hidden');

  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  document.querySelectorAll('.bottom-nav-btn').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });

  const titles = { dashboard: 'Dashboard', chat: 'Chat Room', users: 'User Management' };
  document.getElementById('viewTitle').textContent = titles[view] || view;

  // Close sidebar on mobile
  closeSidebar();

  if (view === 'dashboard') loadDashboard();
  else if (view === 'chat') { loadChat(); state.chat.unreadGeneral = 0; updateChatBadge(); }
  else if (view === 'users') loadUsers();
}

// ── SIDEBAR ────────────────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('hidden');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.add('hidden');
}

// ── DASHBOARD ──────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    state.jobs = await GET('/api/jobs');
    renderJobGrid();
    loadChatJobList();
  } catch (err) {
    document.getElementById('jobGrid').innerHTML = `<div class="loading-state">Error loading jobs: ${esc(err.message)}</div>`;
  }
}

function setFilter(filter) {
  state.currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  renderJobGrid();
}

function renderJobGrid() {
  const grid = document.getElementById('jobGrid');
  let jobs = state.jobs;
  if (state.currentFilter !== 'all') {
    jobs = jobs.filter(j => {
      if (state.currentFilter === 'complete') return j.status === 'complete';
      return j.status === state.currentFilter;
    });
  }
  if (!jobs.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5V3h6v2M9 5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <p>No jobs found</p>
      </div>`;
    return;
  }
  grid.innerHTML = jobs.map(renderJobCard).join('');
}

function renderJobCard(job) {
  const isAdmin = state.user.role === 'admin';
  const userId  = state.user.id;
  const hasAccepted  = (job.acceptances || []).some(a => a.user_id === userId);
  const hasSubmitted = (job.submissions || []).some(s => s.user_id === userId);
  const isAssigned   = !(job.assignments || []).length || (job.assignments || []).some(a => a.user_id === userId);

  const { label: statusLabel, cls: statusCls } = getStatusInfo(job);
  const deadlineText  = getDeadlineText(job);
  const editedBadge   = job.edited ? `<span class="badge badge-edited">Edited ${formatTime(job.edited_at)}</span>` : '';

  // Files display
  const filesHtml = (job.files && job.files.length)
    ? `<div class="job-meta-row">
        <strong>Files:</strong>
        <div class="files-list">${job.files.map(f => renderFileItem(f)).join('')}</div>
      </div>`
    : '';

  // Responsible people
  const assignedHtml = (job.assignments && job.assignments.length)
    ? `<div class="job-meta-row">
        <strong>Responsible:</strong>
        <span>${job.assignments.map(a => esc(a.username)).join(', ')}</span>
      </div>`
    : '';

  const deadlineHtml = deadlineText
    ? `<div class="job-meta-row"><strong>Deadline:</strong><span class="deadline-text">${esc(deadlineText)}</span></div>`
    : '';

  // Action buttons
  let leftActions = '';
  let rightActions = '';

  if (isAdmin) {
    if (job.status !== 'complete') {
      rightActions += `<button class="btn btn-sm btn-warning" onclick="openEditJob(${job.id})">
        <svg viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Edit
      </button>`;
    }
    if (job.status === 'accepted' || job.status === 'submitted') {
      rightActions += `<button class="btn btn-sm btn-success" onclick="openComplete(${job.id})">
        <svg viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Complete
      </button>`;
    }
    if (job.status === 'complete') {
      rightActions += `<button class="btn btn-sm btn-warning" onclick="openEditJob(${job.id})">
        <svg viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Edit
      </button>`;
    }
  } else {
    if (job.status === 'pending' && isAssigned && !hasAccepted) {
      rightActions += `<button class="btn btn-sm btn-primary" onclick="acceptJob(${job.id})">Accept</button>`;
    } else if ((job.status === 'accepted' || job.status === 'pending') && hasAccepted && !hasSubmitted) {
      rightActions += `<button class="btn btn-sm btn-success" onclick="openSubmit(${job.id})">Submit</button>`;
    } else if (hasSubmitted) {
      rightActions += `<span class="badge badge-submitted" style="font-size:.75rem;">Submitted</span>`;
    }
  }

  leftActions = `<button class="btn btn-sm btn-outline" onclick="openDetails(${job.id})">Details</button>`;

  return `<div class="job-card" id="job-card-${job.id}">
    <div class="job-card-header">
      <h3 class="job-title">${esc(job.title)}</h3>
      <div class="job-badges">
        <span class="badge badge-${statusCls}">${esc(statusLabel)}</span>
        ${editedBadge}
      </div>
    </div>
    <div class="job-card-body">
      ${job.description ? `<p class="job-description">${esc(job.description)}</p>` : ''}
      ${filesHtml}
      ${assignedHtml}
      ${deadlineHtml}
    </div>
    <div class="job-card-footer">
      <div class="left-actions">${leftActions}</div>
      <div class="right-actions">${rightActions}</div>
    </div>
  </div>`;
}

function renderFileItem(f) {
  const isImg = isImage(f.original_name);
  const url   = `/uploads/${encodeURIComponent(f.filename)}`;
  const name  = esc(f.original_name);
  return `<div class="file-item">
    ${isImg
      ? `<img src="${url}" class="file-thumb" alt="${name}" onclick="previewImage('${url}')" title="Click to preview" />`
      : `<div class="file-icon-placeholder">${fileIcon(f.original_name)}</div>`}
    <a href="${url}" download="${name}" class="file-link" title="${name}">${name}</a>
  </div>`;
}

// ── JOB DETAILS MODAL ─────────────────────────────────────────────────
async function openDetails(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  const { label: statusLabel, cls: statusCls } = getStatusInfo(job);
  const deadlineText = getDeadlineText(job);

  const firstAccept = (job.acceptances || []).sort((a, b) => new Date(a.accepted_at) - new Date(b.accepted_at))[0];
  const firstSubmit = (job.submissions || []).sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))[0];

  const submFiles = (job.submissions || []).filter(s => s.file_name);

  document.getElementById('detailsModalBody').innerHTML = `
    <div class="details-section">
      <h3>Job Information</h3>
      <div class="details-row"><span class="details-label">Title</span><span class="details-value">${esc(job.title)}</span></div>
      ${job.description ? `<div class="details-row"><span class="details-label">Description</span><span class="details-value" style="white-space:pre-wrap">${esc(job.description)}</span></div>` : ''}
      ${deadlineText ? `<div class="details-row"><span class="details-label">Deadline</span><span class="details-value deadline-text">${esc(deadlineText)}</span></div>` : ''}
      ${(job.assignments||[]).length ? `<div class="details-row"><span class="details-label">Responsible</span><span class="details-value">${job.assignments.map(a=>esc(a.username)).join(', ')}</span></div>` : ''}
    </div>
    ${(job.files||[]).length ? `
    <div class="details-section">
      <h3>Attached Files</h3>
      ${job.files.map(f => renderFileItem(f)).join('')}
    </div>` : ''}
    <div class="details-section">
      <h3>Timeline</h3>
      <div class="details-row"><span class="details-label">Post Time</span><span class="details-value">${formatDateTime(job.created_at)}</span></div>
      <div class="details-row"><span class="details-label">Accept Time</span><span class="details-value">${firstAccept ? formatDateTime(firstAccept.accepted_at) + (firstAccept.username ? ' — ' + esc(firstAccept.username) : '') : '—'}</span></div>
      <div class="details-row"><span class="details-label">Submit Time</span><span class="details-value">${firstSubmit ? formatDateTime(firstSubmit.submitted_at) + (firstSubmit.username ? ' — ' + esc(firstSubmit.username) : '') : '—'}</span></div>
      <div class="details-row"><span class="details-label">Status</span><span class="details-value"><span class="badge badge-${statusCls}">${esc(statusLabel)}</span></span></div>
      ${job.comments ? `<div class="details-row"><span class="details-label">Comments</span><span class="details-value">${esc(job.comments)}</span></div>` : ''}
      ${job.edited ? `<div class="details-row"><span class="details-label">Last Edited</span><span class="details-value">${formatDateTime(job.edited_at)}</span></div>` : ''}
    </div>
    ${submFiles.length ? `
    <div class="details-section">
      <h3>Submission Files</h3>
      ${submFiles.map(s => {
        const downloadHref = s.stored_filename ? `/uploads/${encodeURIComponent(s.stored_filename)}` : '';
        const fileCell = downloadHref
          ? `<a href="${downloadHref}" download="${esc(s.file_name)}" class="file-link">${esc(s.file_name)}</a>`
          : esc(s.file_name);
        return `<div class="details-row"><span class="details-label">${esc(s.username||'')}</span><span class="details-value">${fileCell}</span></div>`;
      }).join('')}
    </div>` : ''}
    ${(job.acceptances||[]).length > 1 ? `
    <div class="details-section">
      <h3>All Acceptances</h3>
      ${job.acceptances.map(a => `<div class="details-row"><span class="details-label">${esc(a.username)}</span><span class="details-value">${formatDateTime(a.accepted_at)}</span></div>`).join('')}
    </div>` : ''}`;

  openModal('detailsModal');
}

// ── CREATE / EDIT JOB ─────────────────────────────────────────────────
async function openCreateJob() {
  state.editingJobFiles = [];
  state.newSelectedFiles = [];
  document.getElementById('jobFormId').value = '';
  document.getElementById('jobTitle').value = '';
  document.getElementById('jobDescription').value = '';
  document.getElementById('timeLimitType').value = 'none';
  document.getElementById('jobModalTitle').textContent = 'Create New Job';
  document.getElementById('jobFormSubmitBtn').textContent = 'Post Job';
  document.getElementById('selectedFilesList').innerHTML = '';
  document.getElementById('existingFilesList').innerHTML = '';
  updateTimeLimitUI();
  await loadUserCheckboxes([]);
  openModal('jobModal');
}

async function openEditJob(jobId) {
  const job = await GET(`/api/jobs/${jobId}`);
  state.editingJobFiles = [];
  state.newSelectedFiles = [];
  document.getElementById('jobFormId').value = job.id;
  document.getElementById('jobTitle').value = job.title;
  document.getElementById('jobDescription').value = job.description || '';
  document.getElementById('timeLimitType').value = job.time_limit_type || 'none';
  document.getElementById('jobModalTitle').textContent = 'Edit Job';
  document.getElementById('jobFormSubmitBtn').textContent = 'Save Changes';
  document.getElementById('selectedFilesList').innerHTML = '';
  updateTimeLimitUI(job);

  // Restore time fields
  if (job.time_limit_type === 'fixed' && job.deadline) {
    const inp = document.getElementById('inputFixed');
    if (inp) inp.value = job.deadline.slice(0,16);
  }
  if (job.time_limit_type === 'duration' && job.time_limit_value) {
    const inp = document.getElementById('inputDuration');
    if (inp) inp.value = job.time_limit_value;
  }
  if ((job.time_limit_type === 'before' || job.time_limit_type === 'range') && job.time_limit_end) {
    const inp = document.getElementById('inputTimeLimitEnd');
    if (inp) inp.value = job.time_limit_end;
  }
  if (job.time_limit_type === 'range' && job.time_limit_start) {
    const inp = document.getElementById('inputTimeLimitStart');
    if (inp) inp.value = job.time_limit_start;
  }

  // Existing files
  const existingList = document.getElementById('existingFilesList');
  existingList.innerHTML = (job.files || []).map(f => `
    <div class="existing-file-item" id="existing-file-${f.id}">
      <span style="font-size:1.1rem;">${fileIcon(f.original_name)}</span>
      <span class="file-name-text">${esc(f.original_name)}</span>
      <button class="remove-file-btn" onclick="markRemoveFile(${f.id}, '${esc(f.original_name)}')" title="Remove">×</button>
    </div>`).join('');

  const assignedIds = (job.assignments || []).map(a => a.user_id);
  await loadUserCheckboxes(assignedIds);
  openModal('jobModal');
}

function markRemoveFile(fileId, name) {
  if (!state.editingJobFiles.includes(fileId)) {
    state.editingJobFiles.push(fileId);
  }
  const el = document.getElementById(`existing-file-${fileId}`);
  if (el) {
    el.style.opacity = '0.4';
    el.style.textDecoration = 'line-through';
    el.querySelector('button').disabled = true;
  }
}

function updateTimeLimitUI(job) {
  const type = document.getElementById('timeLimitType').value;
  const container = document.getElementById('timeLimitInputs');
  container.innerHTML = '';
  container.classList.add('hidden');
  if (type === 'none') return;
  container.classList.remove('hidden');

  let html = '';
  if (type === 'fixed') {
    html = `<div class="form-group"><label>Deadline (date &amp; time)</label><input type="datetime-local" id="inputFixed" /></div>`;
  } else if (type === 'duration') {
    html = `<div class="form-group"><label>Duration (hours from acceptance)</label><input type="number" id="inputDuration" min="0.25" step="0.25" placeholder="e.g. 2" /></div>`;
  } else if (type === 'before') {
    html = `<div class="form-group"><label>Before time (today)</label><input type="time" id="inputTimeLimitEnd" /></div>`;
  } else if (type === 'range') {
    html = `<div class="time-range-inputs">
      <div class="form-group"><label>Start time</label><input type="time" id="inputTimeLimitStart" /></div>
      <div class="form-group"><label>End time</label><input type="time" id="inputTimeLimitEnd" /></div>
    </div>`;
  }
  container.innerHTML = html;
}

async function loadUserCheckboxes(selected = []) {
  const container = document.getElementById('userCheckboxList');
  try {
    const users = await GET('/api/users');
    state.users = users;
    if (!users.length) {
      container.innerHTML = '<span style="color:var(--text-muted);font-size:.85rem">No users yet</span>';
      return;
    }
    container.innerHTML = users.map(u => `
      <label class="user-checkbox-item">
        <input type="checkbox" name="assigned_users" value="${u.id}" ${selected.includes(u.id) ? 'checked' : ''} />
        <label>${esc(u.username)}</label>
      </label>`).join('');
  } catch (_) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:.85rem">Could not load users</span>';
  }
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  state.newSelectedFiles = [...state.newSelectedFiles, ...files];
  renderSelectedFiles();
}

function renderSelectedFiles() {
  const list = document.getElementById('selectedFilesList');
  list.innerHTML = state.newSelectedFiles.map((f, i) => `
    <div class="selected-file-item">
      <span style="font-size:1rem;">${fileIcon(f.name)}</span>
      <span class="file-name-text">${esc(f.name)}</span>
      <button class="remove-file-btn" onclick="removeNewFile(${i})">×</button>
    </div>`).join('');
}

function removeNewFile(idx) {
  state.newSelectedFiles.splice(idx, 1);
  renderSelectedFiles();
}

async function submitJobForm() {
  const jobId = document.getElementById('jobFormId').value;
  const title = document.getElementById('jobTitle').value.trim();
  if (!title) { showToast('Title is required', 'error'); return; }

  const fd = new FormData();
  fd.append('title', title);
  fd.append('description', document.getElementById('jobDescription').value.trim());

  const type = document.getElementById('timeLimitType').value;
  fd.append('time_limit_type', type);
  if (type === 'fixed') {
    const v = document.getElementById('inputFixed')?.value;
    if (v) fd.append('deadline', new Date(v).toISOString());
  } else if (type === 'duration') {
    const v = document.getElementById('inputDuration')?.value;
    if (v) fd.append('time_limit_value', v);
  } else if (type === 'before') {
    const v = document.getElementById('inputTimeLimitEnd')?.value;
    if (v) fd.append('time_limit_end', v);
  } else if (type === 'range') {
    const vs = document.getElementById('inputTimeLimitStart')?.value;
    const ve = document.getElementById('inputTimeLimitEnd')?.value;
    if (vs) fd.append('time_limit_start', vs);
    if (ve) fd.append('time_limit_end', ve);
  }

  // Assigned users
  document.querySelectorAll('#userCheckboxList input[name="assigned_users"]:checked').forEach(cb => {
    fd.append('assigned_users', cb.value);
  });

  // New files
  for (const file of state.newSelectedFiles) fd.append('files', file);

  // Files to remove (edit mode)
  if (jobId && state.editingJobFiles.length) {
    for (const fid of state.editingJobFiles) fd.append('remove_files', fid);
  }

  const btn = document.getElementById('jobFormSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    if (jobId) {
      await api('PUT', `/api/jobs/${jobId}`, fd, true);
      showToast('Job updated', 'success');
    } else {
      await api('POST', '/api/jobs', fd, true);
      showToast('Job posted', 'success');
    }
    closeModal('jobModal');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = jobId ? 'Save Changes' : 'Post Job';
  }
}

// ── ACCEPT / SUBMIT / COMPLETE ────────────────────────────────────────
async function acceptJob(jobId) {
  try {
    await POST(`/api/jobs/${jobId}/accept`);
    showToast('Job accepted!', 'success');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openSubmit(jobId) {
  document.getElementById('submitJobId').value = jobId;
  document.getElementById('submitFilesList').innerHTML = '';
  state.submitFiles = [];
  openModal('submitModal');
}

function handleSubmitFileSelect(e) {
  state.submitFiles = Array.from(e.target.files);
  document.getElementById('submitFilesList').innerHTML = state.submitFiles.map((f, i) => `
    <div class="selected-file-item">
      <span>${fileIcon(f.name)}</span>
      <span class="file-name-text">${esc(f.name)}</span>
    </div>`).join('');
}

async function confirmSubmit() {
  const jobId = document.getElementById('submitJobId').value;
  const fd = new FormData();
  for (const f of state.submitFiles) fd.append('files', f);
  try {
    await api('POST', `/api/jobs/${jobId}/submit`, fd, true);
    showToast('Job submitted!', 'success');
    closeModal('submitModal');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openComplete(jobId) {
  document.getElementById('completeJobId').value = jobId;
  document.getElementById('completeComments').value = '';
  openModal('completeModal');
}

async function confirmComplete() {
  const jobId   = document.getElementById('completeJobId').value;
  const comments = document.getElementById('completeComments').value.trim();
  try {
    await POST(`/api/jobs/${jobId}/complete`, { comments });
    showToast('Job marked as complete', 'success');
    closeModal('completeModal');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────────
async function loadNotifications() {
  try {
    state.notifications = await GET('/api/notifications');
    renderNotifications();
  } catch (_) {}
}

function renderNotifications() {
  const list  = document.getElementById('notifList');
  const badge = document.getElementById('notifBadge');
  const unread = state.notifications.filter(n => !n.read_at);
  badge.textContent = unread.length;
  badge.classList.toggle('hidden', !unread.length);

  if (!state.notifications.length) {
    list.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }
  list.innerHTML = state.notifications.map(n => `
    <div class="notif-item ${n.read_at ? '' : 'unread'}" onclick="clickNotif(${n.id}, ${n.job_id || 'null'})">
      ${!n.read_at ? '<div class="notif-dot"></div>' : '<div style="width:8px"></div>'}
      <div>
        <div class="notif-text">${esc(n.message)}</div>
        <div class="notif-time">${formatRelativeTime(n.created_at)}</div>
      </div>
    </div>`).join('');
}

async function clickNotif(id, jobId) {
  await PUT(`/api/notifications/${id}/read`);
  const n = state.notifications.find(n => n.id === id);
  if (n) n.read_at = new Date().toISOString();
  renderNotifications();
  closeNotifDropdown();
  if (jobId) openDetails(jobId);
}

async function markAllNotifRead() {
  await PUT('/api/notifications/read-all');
  state.notifications.forEach(n => n.read_at = n.read_at || new Date().toISOString());
  renderNotifications();
}

function toggleNotifDropdown() {
  document.getElementById('notifDropdown').classList.toggle('hidden');
}
function closeNotifDropdown() {
  document.getElementById('notifDropdown').classList.add('hidden');
}
document.addEventListener('click', (e) => {
  if (!document.getElementById('notifWrapper').contains(e.target)) closeNotifDropdown();
});

// ── CHAT ───────────────────────────────────────────────────────────────
async function loadChat() {
  await loadChatMessages(state.chat.currentJobId);
  loadChatJobList();
}

function loadChatJobList() {
  const list = document.getElementById('chatJobList');
  if (!state.jobs.length) { list.innerHTML = ''; return; }
  list.innerHTML = state.jobs.map(j => `
    <div class="chat-job-channel ${String(state.chat.currentJobId) === String(j.id) ? 'active' : ''}"
      onclick="switchChannel(${j.id}, '${esc(j.title).replace(/'/g, "\\'")}')">
      # ${esc(j.title.slice(0, 20))}${j.title.length > 20 ? '…' : ''}
    </div>`).join('');
}

async function loadChatMessages(jobId) {
  const chatMsgs = document.getElementById('chatMessages');
  chatMsgs.innerHTML = '<div class="chat-loading">Loading…</div>';
  try {
    const url = jobId ? `/api/messages?job_id=${jobId}` : '/api/messages';
    const messages = await GET(url);
    state.chat.messages = messages;
    renderChatMessages(messages, chatMsgs);
  } catch (_) {
    chatMsgs.innerHTML = '<div class="chat-loading">Could not load messages</div>';
  }
}

function renderChatMessages(messages, container) {
  if (!messages.length) {
    container.innerHTML = '<div class="chat-loading">No messages yet. Say hi! 👋</div>';
    return;
  }
  container.innerHTML = messages.map(m => renderChatMsg(m)).join('');
  container.scrollTop = container.scrollHeight;
}

function renderChatMsg(m) {
  const isOwn = m.user_id === state.user.id;
  const job = m.job_id ? state.jobs.find(j => j.id === m.job_id) : null;
  const jobRef = job && !state.chat.currentJobId
    ? `<div class="chat-job-ref" onclick="switchChannel(${job.id}, '${esc(job.title).replace(/'/g,"\\'")}')">📎 ${esc(job.title)}</div>`
    : '';
  return `<div class="chat-msg ${isOwn ? 'own' : 'other'}">
    <div class="chat-msg-meta">
      ${!isOwn ? `<span>${esc(m.username)}</span>` : ''}
      ${m.role === 'admin' ? '<span class="admin-tag">ADMIN</span>' : ''}
    </div>
    <div class="chat-bubble">${esc(m.text)}</div>
    ${jobRef}
    <div class="chat-msg-time">${formatRelativeTime(m.created_at)}</div>
  </div>`;
}

function appendChatMessage(m) {
  if (state.currentView !== 'chat') return;
  const container = document.getElementById('chatMessages');
  const wasAtBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 60;
  const noMsg = container.querySelector('.chat-loading');
  if (noMsg) container.innerHTML = '';
  container.insertAdjacentHTML('beforeend', renderChatMsg(m));
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

async function switchChannel(jobId, name) {
  state.chat.currentJobId = jobId;
  state.chat.currentChannelName = name;
  state.chat.refJobId = null;
  state.chat.refJobTitle = null;
  document.getElementById('chatChannelName').textContent = name;
  document.getElementById('chatRefTag').classList.add('hidden');

  document.querySelectorAll('.chat-channel').forEach(el => {
    el.classList.toggle('active', el.dataset.jobId === String(jobId || ''));
  });
  document.querySelectorAll('.chat-job-channel').forEach(el => {
    const match = String(jobId) === el.textContent.replace('# ', '').replace('…', '').trim()
      || el.onclick && String(el.onclick).includes(`switchChannel(${jobId},`);
    el.classList.remove('active');
  });
  loadChatJobList();
  await loadChatMessages(jobId);
}

function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  state.socket.emit('send_message', {
    text,
    job_id: state.chat.refJobId || state.chat.currentJobId || null
  });
  input.value = '';
  state.chat.refJobId = null;
  state.chat.refJobTitle = null;
  document.getElementById('chatRefTag').classList.add('hidden');
}

function handleChatKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }

function updateChatBadge() {
  const n = state.chat.unreadGeneral;
  document.getElementById('chatBadge').classList.toggle('hidden', !n);
  document.getElementById('chatBadge').textContent = n;
  document.getElementById('bottomChatBadge').classList.toggle('hidden', !n);
}

function openJobRefPicker() {
  const list = document.getElementById('jobRefList');
  if (!state.jobs.length) { list.innerHTML = '<p style="color:var(--text-muted);padding:.5rem">No jobs available</p>'; }
  else {
    list.innerHTML = state.jobs.map(j => `
      <div class="job-ref-item" onclick="selectJobRef(${j.id}, '${esc(j.title).replace(/'/g,"\\'")}')">
        <strong>${esc(j.title)}</strong>
        <span>${esc(getStatusInfo(j).label)}</span>
      </div>`).join('');
  }
  openModal('jobRefModal');
}

function selectJobRef(jobId, title) {
  state.chat.refJobId = jobId;
  state.chat.refJobTitle = title;
  document.getElementById('chatRefTagText').textContent = `📎 ${title}`;
  document.getElementById('chatRefTag').classList.remove('hidden');
  closeModal('jobRefModal');
}

function clearJobRef() {
  state.chat.refJobId = null;
  state.chat.refJobTitle = null;
  document.getElementById('chatRefTag').classList.add('hidden');
}

// ── USERS ──────────────────────────────────────────────────────────────
async function loadUsers() {
  const list = document.getElementById('usersList');
  const historyList = document.getElementById('deletedUsersHistoryList');
  list.innerHTML = '<div class="loading-state">Loading…</div>';
  historyList.innerHTML = '<div class="loading-state">Loading…</div>';
  try {
    const [users, history] = await Promise.all([
      GET('/api/users'),
      GET('/api/users/deleted-history'),
    ]);
    state.users = users;
    state.deletedUserHistory = history;

    if (!state.users.length) {
      list.innerHTML = '<div class="loading-state">No active users yet.</div>';
    } else {
      list.innerHTML = state.users.map(u => `
      <div class="user-card">
        <div class="user-card-avatar">${u.username[0].toUpperCase()}</div>
        <div class="user-card-info">
          <div class="user-card-name">${esc(u.username)}</div>
          <div class="user-card-joined">Joined ${formatDate(u.created_at)}</div>
        </div>
        <div class="user-card-actions">
          <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, '${esc(u.username)}')">Delete</button>
        </div>
      </div>`).join('');
    }

    if (!state.deletedUserHistory.length) {
      historyList.innerHTML = '<div class="loading-state">No deleted account history.</div>';
    } else {
      historyList.innerHTML = state.deletedUserHistory.map(h => `
        <div class="user-card">
          <div class="user-card-avatar" style="background:#64748b;">${(h.username || '?')[0].toUpperCase()}</div>
          <div class="user-card-info">
            <div class="user-card-name">${esc(h.username)}</div>
            <div class="user-card-joined">Deleted ${formatDateTime(h.deleted_at)} by ${esc(h.deleted_by_admin_username || 'admin')}</div>
          </div>
          <div class="user-card-actions">
            <button class="btn btn-sm btn-danger" onclick="deleteHistoryRecord(${h.id}, '${esc(h.username)}')">Delete History</button>
          </div>
        </div>
      `).join('');
    }
  } catch (err) {
    list.innerHTML = `<div class="loading-state">Error: ${esc(err.message)}</div>`;
    historyList.innerHTML = `<div class="loading-state">Error: ${esc(err.message)}</div>`;
  }
}

function openCreateUser() {
  document.getElementById('newUsername').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('createUserError').classList.add('hidden');
  openModal('createUserModal');
}

async function submitCreateUser() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const errEl    = document.getElementById('createUserError');
  errEl.classList.add('hidden');
  if (!username || !password) { errEl.textContent = 'Please fill all fields'; errEl.classList.remove('hidden'); return; }
  try {
    await POST('/api/users', { username, password });
    showToast(`User "${username}" created`, 'success');
    closeModal('createUserModal');
    loadUsers();
          rightActions += `<button class="btn btn-sm btn-danger" onclick="deleteJob(${job.id}, '${esc(job.title).replace(/'/g,"\\'")}')">
            <svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2m-9 0l1 14h6l1-14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Delete
          </button>`;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function deleteUser(id, name) {
  if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
  try {
    await DEL(`/api/users/${id}`);
    showToast(`User "${name}" deleted`, 'success');
    loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteJob(jobId, title) {
  if (!confirm(`Delete job "${title}"? This cannot be undone.`)) return;
  try {
    await DEL(`/api/jobs/${jobId}`);
    showToast(`Job "${title}" deleted`, 'success');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteHistoryRecord(historyId, username) {
  if (!confirm(`Delete history for "${username}"? This only removes the history record.`)) return;
  try {
    await DEL(`/api/users/deleted-history/${historyId}`);
    showToast(`Deleted history for "${username}"`, 'success');
    loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── MODALS ─────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function closeModalOnBg(e, id) { if (e.target.id === id) closeModal(id); }

// Image preview
function previewImage(url) {
  document.getElementById('imagePreviewImg').src = url;
  openModal('imagePreviewModal');
}

// ── TOAST ──────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 3500) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span>${esc(msg)}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ── UTILITY ────────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function isImage(filename) {
  return /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(filename || '');
}

function fileIcon(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const icons = { pdf:'📕', xls:'📊', xlsx:'📊', doc:'📝', docx:'📝', ppt:'📎', pptx:'📎', txt:'📄', zip:'📦', rar:'📦', mp4:'🎬', mp3:'🎵', csv:'📊' };
  return icons[ext] || '📎';
}

function getStatusInfo(job) {
  if (job.status === 'pending')  return { label: 'Pending',  cls: 'pending' };
  if (job.status === 'accepted') return { label: 'Accepted', cls: 'accepted' };

  if (job.status === 'submitted' || job.status === 'complete') {
    if (!job.submit_time) return { label: job.status === 'complete' ? 'Complete' : 'Submitted', cls: 'complete' };
    const deadline = getEffectiveDeadline(job);
    if (!deadline) return { label: job.status === 'complete' ? 'Complete' : 'Submitted', cls: 'complete' };
    const diffMs = new Date(job.submit_time) - deadline;
    if (diffMs <= 0) return { label: 'Complete In Time', cls: 'complete' };
    const mins = Math.round(diffMs / 60000);
    if (mins < 60) return { label: `Over Due ${mins} Minute${mins !== 1 ? 's' : ''}`, cls: 'overdue' };
    const h = Math.floor(mins / 60), m = mins % 60;
    return { label: `Over Due ${h}h${m ? ` ${m}m` : ''}`, cls: 'overdue' };
  }
  return { label: job.status, cls: 'pending' };
}

function getEffectiveDeadline(job) {
  switch (job.time_limit_type) {
    case 'fixed':
      return job.deadline ? new Date(job.deadline) : null;
    case 'duration':
      if (job.time_limit_value && job.accept_time)
        return new Date(new Date(job.accept_time).getTime() + parseFloat(job.time_limit_value) * 3600000);
      return null;
    case 'before':
    case 'range':
      if (job.time_limit_end) {
        const ref = job.submit_time ? new Date(job.submit_time) : new Date();
        const [h, m] = job.time_limit_end.split(':').map(Number);
        return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, m);
      }
      return null;
    default:
      return null;
  }
}

function getDeadlineText(job) {
  switch (job.time_limit_type) {
    case 'fixed':
      return job.deadline ? 'By ' + formatDateTime(job.deadline) : null;
    case 'duration':
      return job.time_limit_value ? `Within ${job.time_limit_value} hour(s) of acceptance` : null;
    case 'before':
      return job.time_limit_end ? `Before ${job.time_limit_end}` : null;
    case 'range':
      return (job.time_limit_start && job.time_limit_end) ? `${job.time_limit_start} – ${job.time_limit_end}` : null;
    default:
      return null;
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-HK', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-HK', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-HK', { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return formatDate(iso);
}

// ── KICK OFF ───────────────────────────────────────────────────────────
init();
