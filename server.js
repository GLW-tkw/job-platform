const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  secret: process.env.SESSION_SECRET || 'jp-secret-change-in-production-xyz987',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// File upload config
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.session.userId || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  next();
};

// ── AUTH ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid username or password' });
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ id: user.id, username: user.username, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
});

// ── USERS (admin only) ────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare("SELECT id, username, role, created_at FROM users WHERE role = 'user'").all();
  res.json(users);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username already exists' });
  const hashed = bcrypt.hashSync(password, 10);
  const result = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, 'user')").run(username, hashed);
  res.json({ id: result.lastInsertRowid, username, role: 'user' });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'user'").run(req.params.id);
  res.json({ success: true });
});

// ── HELPER: build full job object ─────────────────────────────────────
function buildJob(job) {
  if (!job) return null;
  const files = db.prepare('SELECT id, job_id, filename, original_name FROM job_files WHERE job_id = ?').all(job.id);
  const assignments = db.prepare(
    'SELECT ja.user_id, u.username FROM job_assignments ja JOIN users u ON ja.user_id = u.id WHERE ja.job_id = ?'
  ).all(job.id);
  const acceptances = db.prepare(
    'SELECT ac.user_id, u.username, ac.accepted_at FROM job_acceptances ac JOIN users u ON ac.user_id = u.id WHERE ac.job_id = ?'
  ).all(job.id);
  const submissions = db.prepare(
    'SELECT s.user_id, u.username, s.submitted_at, s.file_name FROM job_submissions s JOIN users u ON s.user_id = u.id WHERE s.job_id = ?'
  ).all(job.id);
  return { ...job, files, assignments, acceptances, submissions };
}

// ── JOBS ──────────────────────────────────────────────────────────────
app.get('/api/jobs', requireAuth, (req, res) => {
  let rawJobs;
  if (req.session.role === 'admin') {
    rawJobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  } else {
    // Users see jobs explicitly assigned to them OR jobs with no assignment
    rawJobs = db.prepare(`
      SELECT DISTINCT j.* FROM jobs j
      LEFT JOIN job_assignments ja ON j.id = ja.job_id
      WHERE ja.user_id = ? OR j.id NOT IN (SELECT DISTINCT job_id FROM job_assignments)
      ORDER BY j.created_at DESC
    `).all(req.session.userId);
  }
  res.json(rawJobs.map(buildJob));
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(buildJob(job));
});

app.post('/api/jobs', requireAdmin, upload.array('files'), (req, res) => {
  const { title, description, time_limit_type, time_limit_value, time_limit_start, time_limit_end, deadline, assigned_users } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO jobs (title, description, time_limit_type, time_limit_value, time_limit_start, time_limit_end, deadline, status, created_at, admin_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    title.trim(), (description || '').trim(),
    time_limit_type || 'none', time_limit_value || null,
    time_limit_start || null, time_limit_end || null,
    deadline || null, now, req.session.userId
  );
  const jobId = result.lastInsertRowid;

  // Save uploaded files
  if (req.files) {
    for (const file of req.files) {
      db.prepare('INSERT INTO job_files (job_id, filename, original_name, file_path) VALUES (?, ?, ?, ?)').run(
        jobId, file.filename, file.originalname, file.path
      );
    }
  }

  // Assign users and send notifications
  const usersList = parseArrayField(assigned_users);
  for (const uid of usersList) {
    try {
      db.prepare('INSERT INTO job_assignments (job_id, user_id) VALUES (?, ?)').run(jobId, parseInt(uid));
    } catch (_) { /* ignore duplicate */ }
    const notify = db.prepare('INSERT INTO notifications (user_id, job_id, message, created_at) VALUES (?, ?, ?, ?)').run(
      parseInt(uid), jobId, `New job assigned to you: ${title.trim()}`, now
    );
    emitToUser(parseInt(uid), 'notification', {
      id: notify.lastInsertRowid,
      message: `New job assigned: ${title.trim()}`,
      job_id: jobId,
      created_at: now
    });
  }

  const job = buildJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId));
  io.emit('job_created', job);
  res.json(job);
});

app.put('/api/jobs/:id', requireAdmin, upload.array('files'), (req, res) => {
  const existing = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  const { title, description, time_limit_type, time_limit_value, time_limit_start, time_limit_end, deadline, assigned_users, remove_files } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE jobs SET title=?, description=?, time_limit_type=?, time_limit_value=?,
    time_limit_start=?, time_limit_end=?, deadline=?, edited=1, edited_at=? WHERE id=?
  `).run(
    title || existing.title, (description !== undefined ? description : existing.description).trim(),
    time_limit_type || existing.time_limit_type,
    time_limit_value !== undefined ? (time_limit_value || null) : existing.time_limit_value,
    time_limit_start !== undefined ? (time_limit_start || null) : existing.time_limit_start,
    time_limit_end !== undefined ? (time_limit_end || null) : existing.time_limit_end,
    deadline !== undefined ? (deadline || null) : existing.deadline,
    now, req.params.id
  );

  // Remove specified files
  const removeList = parseArrayField(remove_files);
  for (const fid of removeList) {
    const f = db.prepare('SELECT * FROM job_files WHERE id = ? AND job_id = ?').get(parseInt(fid), parseInt(req.params.id));
    if (f) {
      if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path);
      db.prepare('DELETE FROM job_files WHERE id = ?').run(f.id);
    }
  }

  // Add new files
  if (req.files) {
    for (const file of req.files) {
      db.prepare('INSERT INTO job_files (job_id, filename, original_name, file_path) VALUES (?, ?, ?, ?)').run(
        req.params.id, file.filename, file.originalname, file.path
      );
    }
  }

  // Update assignments
  if (assigned_users !== undefined) {
    db.prepare('DELETE FROM job_assignments WHERE job_id = ?').run(req.params.id);
    const usersList = parseArrayField(assigned_users);
    for (const uid of usersList) {
      try {
        db.prepare('INSERT INTO job_assignments (job_id, user_id) VALUES (?, ?)').run(req.params.id, parseInt(uid));
      } catch (_) { /* ignore */ }
    }
  }

  const job = buildJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
  io.emit('job_updated', job);
  res.json(job);
});

app.delete('/api/jobs/:id', requireAdmin, (req, res) => {
  const files = db.prepare('SELECT file_path FROM job_files WHERE job_id = ?').all(req.params.id);
  for (const f of files) {
    if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path);
  }
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  io.emit('job_deleted', { id: parseInt(req.params.id) });
  res.json({ success: true });
});

app.post('/api/jobs/:id/accept', requireAuth, (req, res) => {
  if (req.session.role === 'admin') return res.status(403).json({ error: 'Admins cannot accept jobs' });
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'pending' && job.status !== 'accepted') return res.status(400).json({ error: 'Job cannot be accepted in current state' });

  const alreadyAccepted = db.prepare('SELECT id FROM job_acceptances WHERE job_id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (alreadyAccepted) return res.status(400).json({ error: 'You already accepted this job' });

  const now = new Date().toISOString();
  db.prepare('INSERT INTO job_acceptances (job_id, user_id, accepted_at) VALUES (?, ?, ?)').run(
    req.params.id, req.session.userId, now
  );
  if (job.status === 'pending') {
    db.prepare('UPDATE jobs SET status = ?, accept_time = ? WHERE id = ?').run('accepted', now, req.params.id);
  }
  const updated = buildJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
  io.emit('job_updated', updated);
  res.json({ success: true, accepted_at: now });
});

app.post('/api/jobs/:id/submit', requireAuth, upload.array('files'), (req, res) => {
  if (req.session.role === 'admin') return res.status(403).json({ error: 'Admins cannot submit jobs' });
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const hasAccepted = db.prepare('SELECT id FROM job_acceptances WHERE job_id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!hasAccepted) return res.status(400).json({ error: 'You must accept the job before submitting' });

  const alreadySubmitted = db.prepare('SELECT id FROM job_submissions WHERE job_id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (alreadySubmitted) return res.status(400).json({ error: 'You already submitted this job' });

  const now = new Date().toISOString();
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      db.prepare('INSERT INTO job_submissions (job_id, user_id, file_path, file_name, submitted_at) VALUES (?, ?, ?, ?, ?)').run(
        req.params.id, req.session.userId, file.path, file.originalname, now
      );
    }
  } else {
    db.prepare('INSERT INTO job_submissions (job_id, user_id, file_path, file_name, submitted_at) VALUES (?, ?, ?, ?, ?)').run(
      req.params.id, req.session.userId, '', '', now
    );
  }

  db.prepare('UPDATE jobs SET status = ?, submit_time = ? WHERE id = ?').run('submitted', now, req.params.id);
  const updated = buildJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
  io.emit('job_updated', updated);
  res.json({ success: true, submitted_at: now });
});

app.post('/api/jobs/:id/complete', requireAdmin, (req, res) => {
  const { comments } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  db.prepare('UPDATE jobs SET status = ?, comments = ? WHERE id = ?').run('complete', comments || '', req.params.id);
  const updated = buildJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
  io.emit('job_updated', updated);
  res.json({ success: true });
});

// ── NOTIFICATIONS ────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifs = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.session.userId);
  res.json(notifs);
});

app.put('/api/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(
    new Date().toISOString(), req.params.id, req.session.userId
  );
  res.json({ success: true });
});

app.put('/api/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(
    new Date().toISOString(), req.session.userId
  );
  res.json({ success: true });
});

// ── MESSAGES ─────────────────────────────────────────────────────────
app.get('/api/messages', requireAuth, (req, res) => {
  const { job_id } = req.query;
  const messages = job_id
    ? db.prepare('SELECT m.*, u.username, u.role FROM messages m JOIN users u ON m.user_id = u.id WHERE m.job_id = ? ORDER BY m.created_at ASC LIMIT 200').all(job_id)
    : db.prepare('SELECT m.*, u.username, u.role FROM messages m JOIN users u ON m.user_id = u.id WHERE m.job_id IS NULL ORDER BY m.created_at ASC LIMIT 200').all();
  res.json(messages);
});

// ── SOCKET.IO ────────────────────────────────────────────────────────
const userSockets = {}; // userId -> socketId

function emitToUser(userId, event, data) {
  const sid = userSockets[userId];
  if (sid) io.to(sid).emit(event, data);
}

io.on('connection', (socket) => {
  socket.on('authenticate', (userId) => {
    userSockets[userId] = socket.id;
    socket.userId = userId;
  });

  socket.on('send_message', ({ text, job_id }) => {
    if (!socket.userId || !text || !text.trim()) return;
    const safeText = text.trim().slice(0, 2000);
    const now = new Date().toISOString();
    const result = db.prepare('INSERT INTO messages (user_id, job_id, text, created_at) VALUES (?, ?, ?, ?)').run(
      socket.userId, job_id || null, safeText, now
    );
    const user = db.prepare('SELECT username, role FROM users WHERE id = ?').get(socket.userId);
    const msg = {
      id: result.lastInsertRowid,
      user_id: socket.userId,
      username: user?.username || 'Unknown',
      role: user?.role,
      job_id: job_id || null,
      text: safeText,
      created_at: now
    };
    // Emit to all in same channel (global or job-specific)
    if (job_id) {
      io.emit(`message_job_${job_id}`, msg);
      io.emit('new_message', msg); // also emit globally for unread indicators
    } else {
      io.emit('new_message', msg);
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) delete userSockets[socket.userId];
  });
});

// ── HELPERS ──────────────────────────────────────────────────────────
function parseArrayField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === 'string' && val.trim()) return [val.trim()];
  return [];
}

server.listen(PORT, () => {
  console.log(`Job Platform running on port ${PORT}`);
});
