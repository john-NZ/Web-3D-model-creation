// Data access layer. All Postgres knowledge lives here.
// The rest of the app calls these helpers without writing SQL.

import "dotenv/config";
import pg from "pg";

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Use SSL when reaching Postgres over the public internet (e.g. local dev).
// Skip SSL on Railway's internal network — handshake adds latency for no benefit.
const useSsl = !DATABASE_URL.includes(".railway.internal");

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err.message);
});

// ----------------------------------------------------------------------------
// Users
// ----------------------------------------------------------------------------

export async function getUser(id) {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
}

// ----------------------------------------------------------------------------
// Projects
// ----------------------------------------------------------------------------

// Whitelist of project columns that callers may write via createProject /
// updateProject. Anything not in this set is rejected — protects against
// passing arbitrary keys into SQL.
const WRITABLE_COLUMNS = new Set([
  "title",
  "front_image",
  "back_image",
  "left_image",
  "right_image",
  "back_prompt",
  "left_prompt",
  "right_prompt",
  "settings",
  "model_file",
  "preview_image",
  "parent_id",
]);

function pickWritable(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (WRITABLE_COLUMNS.has(k)) out[k] = v;
  }
  return out;
}

export async function createProject(userId, fields = {}) {
  const safe = pickWritable(fields);
  const keys = ["user_id", ...Object.keys(safe)];
  const values = [userId, ...Object.values(safe)];
  const placeholders = keys.map((_, i) => "$" + (i + 1));

  const sql =
    "INSERT INTO projects (" + keys.join(", ") + ") " +
    "VALUES (" + placeholders.join(", ") + ") " +
    "RETURNING *";
  const result = await pool.query(sql, values);
  return result.rows[0];
}

export async function updateProject(id, userId, fields) {
  const safe = pickWritable(fields);
  const keys = Object.keys(safe);
  if (keys.length === 0) return getProject(id, userId);

  const setClauses = keys.map((k, i) => k + " = $" + (i + 1));
  const values = keys.map((k) => safe[k]);
  values.push(id, userId);

  const sql =
    "UPDATE projects SET " + setClauses.join(", ") + " " +
    "WHERE id = $" + (keys.length + 1) + " AND user_id = $" + (keys.length + 2) + " " +
    "RETURNING *";
  const result = await pool.query(sql, values);
  return result.rows[0] || null;
}

export async function listProjects(userId) {
  const result = await pool.query(
    "SELECT id, parent_id, created_at, title, front_image, preview_image, model_file " +
    "FROM projects WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  return result.rows;
}

export async function getProject(id, userId) {
  const result = await pool.query(
    "SELECT * FROM projects WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return result.rows[0] || null;
}

export async function deleteProject(id, userId) {
  const result = await pool.query(
    "DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id",
    [id, userId]
  );
  return result.rows.length > 0;
}

// Creates a new project that is a "variant" of an existing one. Copies all
// fields except model_file/preview_image (the user will regenerate those)
// and sets parent_id to the source.
export async function createVariant(parentId, userId) {
  const parent = await getProject(parentId, userId);
  if (!parent) return null;
  return createProject(userId, {
    parent_id: parent.id,
    title: parent.title ? parent.title + " (variant)" : null,
    front_image: parent.front_image,
    back_image: parent.back_image,
    left_image: parent.left_image,
    right_image: parent.right_image,
    back_prompt: parent.back_prompt,
    left_prompt: parent.left_prompt,
    right_prompt: parent.right_prompt,
    settings: parent.settings,
    // model_file and preview_image intentionally NOT copied
  });
}
