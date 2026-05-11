const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS deleted_user_history (
        id SERIAL PRIMARY KEY,
        deleted_user_id INTEGER,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        original_created_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_by_admin_id INTEGER,
        deleted_by_admin_username TEXT
      );

      CREATE TABLE IF NOT EXISTS deleted_jobs_history (
        id SERIAL PRIMARY KEY,
        deleted_job_id INTEGER,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT,
        original_created_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_by_admin_id INTEGER,
        deleted_by_admin_username TEXT
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        time_limit_type TEXT DEFAULT 'none',
        time_limit_value TEXT,
        time_limit_start TEXT,
        time_limit_end TEXT,
        deadline TIMESTAMPTZ,
        accept_time TIMESTAMPTZ,
        submit_time TIMESTAMPTZ,
        comments TEXT,
        edited BOOLEAN DEFAULT FALSE,
        edited_at TIMESTAMPTZ,
        admin_id INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS job_files (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_assignments (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(job_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS job_acceptances (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        accepted_at TIMESTAMPTZ NOT NULL,
        UNIQUE(job_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS job_submissions (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_path TEXT DEFAULT '',
        file_name TEXT DEFAULT '',
        submitted_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id INTEGER,
        message TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id INTEGER,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const adminCheck = await client.query("SELECT id FROM users WHERE username = 'admin'");
    if (!adminCheck.rows.length) {
      await client.query(
        "INSERT INTO users (username, password, role) VALUES ($1, $2, 'admin')",
        ['admin', bcrypt.hashSync('admin', 10)]
      );
      console.log('Created admin user');
    }

    // Optional demo user for first-time testing.
    // Keep disabled by default so deleted users do not get recreated on restart.
    if (process.env.SEED_DEMO_USER === 'true') {
      const user001Check = await client.query("SELECT id FROM users WHERE username = 'user001'");
      if (!user001Check.rows.length) {
        await client.query(
          "INSERT INTO users (username, password, role) VALUES ($1, $2, 'user')",
          ['user001', bcrypt.hashSync('user001', 10)]
        );
        console.log('Created user001');
      }
    }

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
