const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { pool, initDB } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

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
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.session.userId || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  next();
};

// ── AUTH ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid username or password' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
});

// ── USERS ──────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, role, created_at FROM users WHERE role = 'user' ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hashed = bcrypt.hashSync(password, 10);
    const { rows } = await pool.query(
      "INSERT INTO users (username, password, role) VALUES ($1, $2, 'user') RETURNING id, username, role",
      [username, hashed]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id = $1 AND role = 'user'", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BUILD JOB HELPER ──────────────────────────────────────────────────
async function buildJob(job) {
  if (!job) return null;
  const [files, assignments, acceptances, submissions] = await Promise.all([
    pool.query('SELECT id, job_id, filename, original_name FROM job_files WHERE job_id = $1', [job.id]),
    pool.query('SELECT ja.user_id, u.username FROM job_assignments ja JOIN users u ON ja.user_id = u.id WHERE ja.job_id = $1', [job.id]),
    pool.query('SELECT ac.user_id, u.username, ac.accepted_at FROM job_acceptances ac JOIN users u ON ac.user_id = u.id WHERE ac.job_id = $1', [job.id]),
    pool.query('SELECT s.user_id, u.username, s.submitted_at, s.file_name FROM job_submissions s JOIN users u ON s.user_id = u.id WHERE s.job_id = $1', [job.id]),
  ]);
  return { ...job, files: files.rows, assignments: assignments.rows, acceptances: acceptances.rows, submissions: submissions.rows };
}

// ── JOBS ───────────────────────────────────────────────────────────────
app.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    let rawJobs;
    if (req.session.role === 'admin') {
      rawJobs = (await pool.query('SELECT * FROM jobs ORDER BY created_at DESC')).rows;
    } else {
      rawJobs = (await pool.query(`
        SELECT DISTINCT j.* FROM jobs j
        LEFT JOIN job_assignments ja ON j.id = ja.job_id
        WHERE ja.user_id = $1 OR j.id NOT IN (SELECT DISTINCT job_id FROM job_assignments)
        ORDER BY j.created_at DESC
      `, [req.session.userId])).rows;
    }
    const jobs = await Promise.all(rawJobs.map(buildJob));
    res.json(jobs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const job = (await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(await buildJob(job));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs', requireAdmin, upload.array('files'), async (req, res) => {
  const { title, description, time_limit_type, time_limit_value, time_limit_start, time_limit_end, deadline, assigned_users } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const now = new Date();
  try {
    const { rows } = await pool.query(`
      INSERT INTO jobs (title, description, time_limit_type, time_limit_value, time_limit_start, time_limit_end, deadline, status, created_at, admin_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING *
    `, [title.trim(), (description || '').trim(), time_limit_type || 'none',
        time_limit_value || null, time_limit_start || null, time_limit_end || null,
        deadline || null, now, req.session.userId]);
    const jobId = rows[0].id;

    if (req.files) {
      for (const file of req.files) {
        await pool.query(
          'INSERT INTO job_files (job_id, filename, original_name, file_path) VALUES ($1,$2,$3,$4)',
          [jobId, file.filename, file.originalname, file.path]
        );
      }
    }

    const usersList = parseArrayField(assigned_users);
    for (const uid of usersList) {
      await pool.query('INSERT INTO job_assignments (job_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [jobId, parseInt(uid)]);
      const notifResult = await pool.query(
        'INSERT INTO notifications (user_id, job_id, message, created_at) VALUES ($1,$2,$3,$4) RETURNING id',
        [parseInt(uid), jobId, `New job assigned to you: ${title.trim()}`, now]
      );
      emitToUser(parseInt(uid), 'notification', { id: notifResult.rows[0].id, message: `New job assigned: ${title.trim()}`, job_id: jobId, created_at: now });
    }

    const job = await buildJob((await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId])).rows[0]);
    io.emit('job_created', job);
    res.json(job);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/jobs/:id', requireAdmin, upload.array('files'), async (req, res) => {
  try {
    const existing = (await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Job not found' });
    const { title, description, time_limit_type, time_limit_value, time_limit_start, time_limit_end, deadline, assigned_users, remove_files } = req.body;
    const now = new Date();

    await pool.query(`
      UPDATE jobs SET title=$1, description=$2, time_limit_type=$3, time_limit_value=$4,
      time_limit_start=$5, time_limit_end=$6, deadline=$7, edited=true, edited_at=$8 WHERE id=$9
    `, [
      title || existing.title,
      (description !== undefined ? description : existing.description || '').trim(),
      time_limit_type || existing.time_limit_type,
      time_limit_value !== undefined ? (time_limit_value || null) : existing.time_limit_value,
      time_limit_start !== undefined ? (time_limit_start || null) : existing.time_limit_start,
      time_limit_end !== undefined ? (time_limit_end || null) : existing.time_limit_end,
      deadline !== undefined ? (deadline || null) : existing.deadline,
      now, req.params.id,
    ]);

    for (const fid of parseArrayField(remove_files)) {
      const f = (await pool.query('SELECT * FROM job_files WHERE id = $1 AND job_id = $2', [parseInt(fid), parseInt(req.params.id)])).rows[0];
      if (f) {
        if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path);
        await pool.query('DELETE FROM job_files WHERE id = $1', [f.id]);
      }
    }

    if (req.files) {
      for (const file of req.files) {
        await pool.query(
          'INSERT INTO job_files (job_id, filename, original_name, file_path) VALUES ($1,$2,$3,$4)',
          [req.params.id, file.filename, file.originalname, file.path]
        );
      }
    }

    if (assigned_users !== undefined) {
      await pool.query('DELETE FROM job_assignments WHERE job_id = $1', [req.params.id]);
      for (const uid of parseArrayField(assigned_users)) {
        await pool.query('INSERT INTO job_assignments (job_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, parseInt(uid)]);
      }
    }

    const job = await buildJob((await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0]);
    io.emit('job_updated', job);
    res.json(job);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/jobs/:id', requireAdmin, async (req, res) => {
  try {
    const files = (await pool.query('SELECT file_path FROM job_files WHERE job_id = $1', [req.params.id])).rows;
    for (const f of files) { if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path); }
    await pool.query('DELETE FROM jobs WHERE id = $1', [req.params.id]);
    io.emit('job_deleted', { id: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/:id/accept', requireAuth, async (req, res) => {
  if (req.session.role === 'admin') return res.status(403).json({ error: 'Admins cannot accept jobs' });
  try {
    const job = (await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'pending' && job.status !== 'accepted') return res.status(400).json({ error: 'Job cannot be accepted in current state' });
    const already = (await pool.query('SELECT id FROM job_acceptances WHERE job_id = $1 AND user_id = $2', [req.params.id, req.session.userId])).rows[0];
    if (already) return res.status(400).json({ error: 'You already accepted this job' });
    const now = new Date();
    await pool.query('INSERT INTO job_acceptances (job_id, user_id, accepted_at) VALUES ($1,$2,$3)', [req.params.id, req.session.userId, now]);
    if (job.status === 'pending') {
      await pool.query('UPDATE jobs SET status=$1, accept_time=$2 WHERE id=$3', ['accepted', now, req.params.id]);
    }
    const updated = await buildJob((await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0]);
    io.emit('job_updated', updated);
    res.json({ success: true, accepted_at: now });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/:id/submit', requireAuth, upload.array('files'), async (req, res) => {
  if (req.session.role === 'admin') return res.status(403).json({ error: 'Admins cannot submit jobs' });
  try {
    const job = (await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const hasAccepted = (await pool.query('SELECT id FROM job_acceptances WHERE job_id = $1 AND user_id = $2', [req.params.id, req.session.userId])).rows[0];
    if (!hasAccepted) return res.status(400).json({ error: 'You must accept the job before submitting' });
    const alreadySubmitted = (await pool.query('SELECT id FROM job_submissions WHERE job_id = $1 AND user_id = $2', [req.params.id, req.session.userId])).rows[0];
    if (alreadySubmitted) return res.status(400).json({ error: 'You already submitted this job' });
    const now = new Date();
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        await pool.query(
          'INSERT INTO job_submissions (job_id, user_id, file_path, file_name, submitted_at) VALUES ($1,$2,$3,$4,$5)',
          [req.params.id, req.session.userId, file.path, file.originalname, now]
        );
      }
    } else {
      await pool.query(
        'INSERT INTO job_submissions (job_id, user_id, file_path, file_name, submitted_at) VALUES ($1,$2,$3,$4,$5)',
        [req.params.id, req.session.userId, '', '', now]
      );
    }
    await pool.query('UPDATE jobs SET status=$1, submit_time=$2 WHERE id=$3', ['submitted', now, req.params.id]);
    const updated = await buildJob((await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0]);
    io.emit('job_updated', updated);
    res.json({ success: true, submitted_at: now });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/:id/complete', requireAdmin, async (req, res) => {
  const { comments } = req.body;
  try {
    const job = (await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await pool.query('UPDATE jobs SET status=$1, comments=$2 WHERE id=$3', ['complete', comments || '', req.params.id]);
    const updated = await buildJob((await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id])).rows[0]);
    io.emit('job_updated', updated);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── NOTIFICATIONS ──────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Must come BEFORE /:id/read so Express doesn't treat 'read-all' as an id
app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read_at=$1 WHERE user_id=$2 AND read_at IS NULL', [new Date(), req.session.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read_at=$1 WHERE id=$2 AND user_id=$3', [new Date(), req.params.id, req.session.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MESSAGES ───────────────────────────────────────────────────────────
app.get('/api/messages', requireAuth, async (req, res) => {
  const { job_id } = req.query;
  try {
    const query = job_id
      ? 'SELECT m.*, u.username, u.role FROM messages m JOIN users u ON m.user_id = u.id WHERE m.job_id = $1 ORDER BY m.created_at ASC LIMIT 200'
      : 'SELECT m.*, u.username, u.role FROM messages m JOIN users u ON m.user_id = u.id WHERE m.job_id IS NULL ORDER BY m.created_at ASC LIMIT 200';
    const { rows } = job_id ? await pool.query(query, [job_id]) : await pool.query(query);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SOCKET.IO ──────────────────────────────────────────────────────────
const userSockets = {};
function emitToUser(userId, event, data) {
  const sid = userSockets[userId];
  if (sid) io.to(sid).emit(event, data);
}

io.on('connection', (socket) => {
  socket.on('authenticate', (userId) => {
    userSockets[userId] = socket.id;
    socket.userId = userId;
  });

  socket.on('send_message', async ({ text, job_id }) => {
    if (!socket.userId || !text || !text.trim()) return;
    const safeText = text.trim().slice(0, 2000);
    const now = new Date();
    try {
      const result = await pool.query(
        'INSERT INTO messages (user_id, job_id, text, created_at) VALUES ($1,$2,$3,$4) RETURNING id',
        [socket.userId, job_id || null, safeText, now]
      );
      const user = (await pool.query('SELECT username, role FROM users WHERE id = $1', [socket.userId])).rows[0];
      const msg = { id: result.rows[0].id, user_id: socket.userId, username: user?.username || 'Unknown', role: user?.role, job_id: job_id || null, text: safeText, created_at: now };
      if (job_id) { io.emit(`message_job_${job_id}`, msg); io.emit('new_message', msg); }
      else { io.emit('new_message', msg); }
    } catch (err) { console.error('Message error:', err.message); }
  });

  socket.on('disconnect', () => { if (socket.userId) delete userSockets[socket.userId]; });
});

// ── HELPERS ────────────────────────────────────────────────────────────
function parseArrayField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === 'string' && val.trim()) return [val.trim()];
  return [];
}

// ── START ──────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => console.log(`Job Platform running on port ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
