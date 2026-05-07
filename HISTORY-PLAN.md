# History & Database — Implementation Plan

> Working document for adding persistent project history to the 3D Model Creator.
> If context is lost mid-build, this file should be enough to resume.
>
> See [PLAN.md](PLAN.md) for the original Railway deployment plan. Some pieces overlap (the Volume in particular) — references to it are noted below.

## Goal

Today, every session is throwaway: uploaded images, generated views, and `.obj`/`.glb` files live in `uploads/` and `output/` and are wiped on every Railway redeploy (Railway container filesystems are ephemeral). We want a persistent **history of past projects** so the user can:

- See thumbnails of every 3D model they've made
- Re-open a past project to view its images, prompts, settings, and 3D model
- Create a **"New variant"** — a fresh project derived from an existing one with edited prompts/settings, with the lineage preserved

## Two problems being solved together

1. **Metadata persistence** (which images go with which model, what prompts, what settings, when) → Postgres
2. **File persistence** (the actual `.png` and `.obj`/`.glb`/`.stl`/`.fbx` files) → Railway Volume mounted into the container

A database is the wrong place for big binary files; a filesystem is the wrong place for queryable metadata. We use both.

## Decisions locked in

| Decision | Choice | Notes |
|---|---|---|
| Database | **PostgreSQL on Railway** (managed add-on) | Provides `DATABASE_URL` env var automatically |
| DB client library | **`pg`** (no ORM) | Small surface area, easy to learn |
| File storage | **Railway Volume** | Already covered by [PLAN.md](PLAN.md) §3.3. Object storage (R2/S3) deferred until needed. |
| Dev/test environment | **Production only** | No local Postgres. User OK with losing local data. Local server points at production `DATABASE_URL`. |
| Auth | **Deferred (Stage 2)**. Schema ready, single hardcoded owner user for now. | Library plan: `express-session` + `connect-pg-simple` + `bcrypt` |
| BYO API keys | **Deferred (Stage 2)**. Schema columns reserved, encryption helper to be added later. | AES-256-GCM via Node `crypto`, master key from `MASTER_KEY` env |
| Re-run terminology | **"New variant"** | Tracked via `projects.parent_id` |
| Lineage model | One project = one 3D model + its 4 source views. Variants link via `parent_id`. | Flat list with "↳ variant of #42" badge in UI; tree view can come later |

## Schema

```sql
CREATE TABLE users (
  id                SERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  email             TEXT UNIQUE,
  password_hash     TEXT,                    -- nullable until Stage 2 auth
  display_name      TEXT,

  -- BYO API credentials, encrypted at rest. Plaintext NEVER stored.
  openai_api_key_enc        TEXT,
  hitem3d_client_id_enc     TEXT,
  hitem3d_client_secret_enc TEXT
);

CREATE TABLE projects (
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

CREATE INDEX projects_user_id_idx   ON projects(user_id);
CREATE INDEX projects_parent_id_idx ON projects(parent_id);
```

**Why these choices:**

- `parent_id` nullable → originals have NULL, variants point to their source.
- `ON DELETE CASCADE` on `user_id` → deleting a user removes their projects.
- `ON DELETE SET NULL` on `parent_id` → deleting a source project orphans variants but doesn't destroy them.
- `settings JSONB` → flexible schema for HiTem3D options (polygon count, format, resolution, mode); evolves without migrations.
- `*_enc` suffix on user columns → reminder these hold ciphertext, never plaintext.

## File-storage strategy

**Already covered by [PLAN.md](PLAN.md) §1.2 and §3.3.** That plan introduces:

```js
const STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
const UPLOAD_DIR  = path.join(STORAGE_DIR, "uploads");
const OUTPUT_DIR  = path.join(STORAGE_DIR, "output");
```

with `STORAGE_DIR=/app/storage` on Railway, mounted to a Volume. **No additional file-storage work needed for this feature** — we just keep saving filenames in the database that point at files in `OUTPUT_DIR`.

If the deployment plan hasn't been completed yet when we start this work, we need to confirm the Volume is mounted before any of this is useful (otherwise the DB will accumulate references to files that get wiped on redeploy).

## Auth — staged plan

### Stage 1 (now)
- `users` table created
- A single owner row inserted at app startup (id=1, email = `johnhwagner@gmail.com`)
- Every project route hardcodes `user_id = 1`
- No login screen

### Stage 2 (deferred)
- Add login route + session middleware (`express-session` + `connect-pg-simple` for DB-backed sessions)
- `bcrypt` for password hashing
- Middleware reads `req.session.userId`, attaches to `req.user`
- Project routes change from hardcoded id to `req.user.id`
- **Schema does not change between stages**

## BYO API keys — staged plan

### Stage 1 (now)
- Reserved columns on `users` (`openai_api_key_enc`, `hitem3d_client_id_enc`, `hitem3d_client_secret_enc`)
- No encryption code yet; columns stay NULL
- All requests fall back to env-var keys (your shared keys)

### Stage 2 (deferred)
- `crypto.js` with `encrypt(plaintext)` / `decrypt(ciphertext)` using AES-256-GCM
- `MASTER_KEY` env var (32 random bytes, base64 — generated once, stored in Railway)
- Settings UI for users to paste their own keys
- Resolver:
  ```
  resolveOpenAIKey(user) =
    user.openai_api_key_enc ? decrypt(...) : process.env.OPENAI_API_KEY
  ```
- Add `express-rate-limit` to protect the shared (owner-funded) keys

## API surface

### New routes
- `GET  /api/projects` — list current user's projects (newest first), includes `parent_id` for lineage badges
- `GET  /api/projects/:id` — full project for re-loading into the wizard
- `POST /api/projects/:id/variant` — create a "New variant" (copies fields, sets `parent_id`)
- `DELETE /api/projects/:id` — optional, nice to have

### Existing routes — modifications
- `/api/upload-front` — creates a new in-progress project row, returns `{ image, projectId }`
- `/api/upload-view` — updates the project row's relevant view column
- `/api/generate-view` — persists the prompt and resulting filename onto the project row
- `/api/generate-model` — finalizes the row with `model_file`, `preview_image`, and `settings`

The frontend will need to track `projectId` once `/api/upload-front` returns it and pass it along to subsequent calls.

## Frontend changes

- New "History" panel/page: thumbnail grid of past projects (`preview_image`), click to load
- Loading a project re-populates Step 2 (images + prompts + settings) and Step 3 (3D viewer) without re-running anything
- "New variant" button on a loaded project → POSTs to `/api/projects/:id/variant`, then opens the new project for editing
- Variant badge: "↳ variant of #42" near the project title

## Build order (resumable checklist)

- [ ] **1. Confirm Railway Postgres add-on exists** — provision in Railway dashboard if not already done. Confirm `DATABASE_URL` appears in service variables. Add it to local `.env` so local dev points at production DB.
- [ ] **2. Confirm Railway Volume is mounted** — see [PLAN.md](PLAN.md) §3.3. If deployment plan was never completed, complete it first. Without the Volume, this entire feature is pointless because files will still vanish on redeploy.
- [ ] **3. Add `pg` dependency** — `npm install pg`.
- [ ] **4. Create `init-db.js`** — runs `CREATE TABLE IF NOT EXISTS …` for both tables and `INSERT … ON CONFLICT DO NOTHING` for the owner user (id=1, email = `johnhwagner@gmail.com`). Idempotent. Run once manually: `node init-db.js`. Could also be wired to run on server startup.
- [ ] **5. Create `db.js`** — exports a `pg` Pool plus helpers:
  - `getUser(id)`
  - `createProject(userId, fields)` → returns new row
  - `updateProject(id, fields)`
  - `listProjects(userId)`
  - `getProject(id, userId)` — returns project only if owned by userId
  - `createVariant(parentId, userId)` — copies prompts/images/settings, sets `parent_id`, clears `model_file` so user can regenerate
- [ ] **6. Wire DB into existing routes** — `user_id = 1` hardcoded throughout. Verify rows appear via Railway DB console or `psql`.
- [ ] **7. Add new routes** — `/api/projects` list / get / variant / delete.
- [ ] **8. Frontend History UI** — list view, click-to-load, "New variant" button, lineage badges.
- [ ] **9. End-to-end test on Railway production** — upload → generate views → generate model → see in history → reload → make variant → confirm `parent_id` set.
- [ ] **10. *(Later)* Stage 2 auth** — sessions, login screen, bcrypt, middleware.
- [ ] **11. *(Later)* Stage 2 BYO keys** — `crypto.js`, settings UI, resolver wiring, rate limiting.

## Environment variables

| Var | Stage | Where | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | existing | Railway + local | OpenAI image gen |
| `HITEM3D_CLIENT_ID` | existing | Railway + local | HiTem3D auth |
| `HITEM3D_CLIENT_SECRET` | existing | Railway + local | HiTem3D auth |
| `STORAGE_DIR` | existing (PLAN.md) | Railway = `/app/storage`, local = unset | Where files live |
| `DATABASE_URL` | **new, Stage 1** | auto-set by Railway Postgres; copy to local `.env` | Postgres connection |
| `SESSION_SECRET` | Stage 2 | Railway | Cookie signing |
| `MASTER_KEY` | Stage 2 | Railway | AES key for BYO API key encryption |

## Open questions / future work

- Multi-image regeneration history (keeping all 3 attempts of a back view, not just the latest) — current schema only stores the latest. Could add a `view_attempts` table later if needed.
- Support for variable view counts (>4 views, or fewer with different angles).
- Migrating from Railway Volume to object storage (R2/S3) once file volume justifies it.
- Tree visualization for deep variant lineages (recursive CTE in Postgres).
- Smoke-test additions for the new routes (`/api/projects` list returns 200, `/api/projects/:id` 404 for missing IDs).

## Progress log

- **2026-05-07** — Plan written. No code changes yet. Decisions locked: Postgres, "New variant" terminology, multi-user schema with deferred auth, deferred BYO keys with reserved columns. Next step: build order item #1.
