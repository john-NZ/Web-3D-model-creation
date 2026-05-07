// One-shot script to create tables and seed the owner user.
// Idempotent — safe to re-run. Run with: node init-db.js
//
// Reads DATABASE_URL from .env. Uses SSL automatically when connecting
// to a non-internal host (e.g. from your laptop). On Railway's internal
// network the connection is unencrypted and SSL is skipped.

import "dotenv/config";
import pg from "pg";

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error("[init-db] DATABASE_URL is not set. Add it to .env and try again.");
  process.exit(1);
}

const useSsl = !DATABASE_URL.includes(".railway.internal");
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                        SERIAL PRIMARY KEY,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  email                     TEXT UNIQUE,
  password_hash             TEXT,
  display_name              TEXT,
  openai_api_key_enc        TEXT,
  hitem3d_client_id_enc     TEXT,
  hitem3d_client_secret_enc TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  parent_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  title         TEXT,
  front_image   TEXT,
  back_image    TEXT,
  left_image    TEXT,
  right_image   TEXT,
  back_prompt   TEXT,
  left_prompt   TEXT,
  right_prompt  TEXT,
  settings      JSONB,
  model_file    TEXT,
  preview_image TEXT
);

CREATE INDEX IF NOT EXISTS projects_user_id_idx   ON projects(user_id);
CREATE INDEX IF NOT EXISTS projects_parent_id_idx ON projects(parent_id);

-- Migration: async generate-model status tracking. ADD COLUMN IF NOT EXISTS
-- means re-running is safe even after the columns are created.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS error_message TEXT;
`;

const SEED_OWNER = `
INSERT INTO users (email, display_name)
VALUES ('johnhwagner@gmail.com', 'John Wagner')
ON CONFLICT (email) DO NOTHING
RETURNING id;
`;

async function main() {
  console.log("[init-db] Connecting to " + (useSsl ? "external" : "internal") + " host...");
  const client = await pool.connect();
  try {
    console.log("[init-db] Creating tables (IF NOT EXISTS)...");
    await client.query(SCHEMA);

    console.log("[init-db] Seeding owner user...");
    const result = await client.query(SEED_OWNER);
    if (result.rows.length > 0) {
      console.log("[init-db] Owner created with id=" + result.rows[0].id);
    } else {
      console.log("[init-db] Owner already exists, no insert performed.");
    }

    const counts = await client.query("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM projects) AS projects");
    console.log("[init-db] Row counts:", counts.rows[0]);

    console.log("[init-db] Done.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[init-db] FAILED:", err.message);
  console.error(err);
  process.exit(1);
});
