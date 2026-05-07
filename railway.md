# Railway Deployment Guide

General-purpose instructions for deploying and operating a web project on Railway. Written for Claude Sonnet/Opus — follow these procedures exactly when deploying, verifying, and maintaining a Railway-hosted application.

---

## What Railway Is

Railway is a cloud platform that hosts web apps and services. It:

- **Auto-deploys from a GitHub branch** — every push to the configured branch triggers a new deploy.
- **Provides persistent storage via Volumes** — a mounted filesystem that survives redeploys (unlike the container's own filesystem, which is ephemeral).
- **Manages environment variables** — secrets and config are set in the Railway dashboard, not in code.
- **Assigns a public URL** — Railway generates a `*.up.railway.app` domain, or you can attach a custom domain.

The container filesystem is **ephemeral** — any files written outside a mounted Volume are lost on redeploy. Never store persistent data (user uploads, database files, JSON data) on the ephemeral filesystem.

---

## Project Setup

### Required files

| File | Purpose |
|------|---------|
| `package.json` | `"start"` script must be defined — Railway runs `npm start` (or the command you configure) |
| `.gitignore` | Data files and secrets must be gitignored |

### Environment variables

Set these in the Railway dashboard under **Variables**, not in code or `.env` files committed to git.

Minimum variables for most projects:

| Variable | Description |
|----------|-------------|
| `PORT` | Railway injects this automatically — read it in your server (`process.env.PORT`) |
| `NODE_ENV` | Set to `production` |
| Any secrets | API keys, tokens, database URLs — never hardcode these |

**Railway injects `PORT` automatically.** Your server must bind to `process.env.PORT`, not a hardcoded port.

### Persistent Volume

Railway Volumes provide persistent storage. Attach a Volume in the Railway dashboard and configure a mount path (e.g. `/app/storage`).

Then in your app, read the mount path from an environment variable:

```javascript
const STORAGE_DIR = process.env.STORAGE_DIR || '/app/storage';
```

Set `STORAGE_DIR=/app/storage` (or equivalent) as a Railway environment variable.

**What to store on the Volume:**
- User-generated data (JSON files, database files, uploaded files)
- Anything that must survive a redeploy

**What NOT to store on the Volume:**
- Application code (that comes from git)
- Node modules (Railway installs these during build)

### First-deploy initialisation

On first deploy the Volume is empty. Your app must handle this gracefully — create default empty data files or directories on startup if they don't exist:

```javascript
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
```

---

## Health Check Endpoint

**You must implement a `/api/health` endpoint.** This is how Claude verifies that a new deploy is live and serving the correct version of your code.

Minimum implementation:

```javascript
const { execSync } = require('child_process');

let commitHash = 'unknown';
try {
  commitHash = execSync('git rev-parse HEAD').toString().trim();
} catch (_) {}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', commit: commitHash });
});
```

The `commit` field is critical — it allows Claude to confirm that the deployed version matches the local HEAD commit after a push.

---

## Deploy Workflow

Every production deploy follows this sequence. **Never skip steps.**

```
1. Test locally
2. Commit changes
3. git push → triggers Railway auto-deploy
4. Poll /api/health until commit matches local HEAD
5. Run smoke tests
6. Report results to user
```

### Step-by-step

**1. Verify local tests pass** before pushing. Never push knowingly broken code.

**2. Commit and push:**
```bash
git add <files>
git commit -m "descriptive message"
git push
```

**3. Poll the health endpoint** every 5–10 seconds until the deployed commit hash matches the local HEAD. Time out after 3 minutes and report failure if it hasn't updated.

```bash
# Get local HEAD
git rev-parse HEAD

# Poll health endpoint
curl -s https://YOUR-APP.up.railway.app/api/health
# Response: {"status":"ok","commit":"abc1234..."}
```

Compare the `commit` field to local HEAD. Keep polling until they match.

**4. Run smoke tests** immediately after deploy is confirmed live. See the Smoke Tests section below.

**5. Report to the user** — state whether deploy succeeded and whether smoke tests passed or failed.

### Never go silent during deploys

Deployments have two time-consuming phases: waiting for deploy, then running smoke tests. Always report progress at each stage. Do not run both as a single background task and go silent. Either:
- Run in the foreground and narrate progress, or
- Run in the background and actively check within 30 seconds using `TaskOutput`, then report back

---

## Smoke Tests

Smoke tests are fast, automated checks that verify the production app is working after a deploy. They are **not** a full test suite — they check that the critical paths are alive.

### What smoke tests should cover

- Health endpoint returns `200 OK`
- Key API endpoints return expected responses (not `500` errors)
- Static pages load (return `200`)
- Any critical write operation (create, update) if feasible to test safely

### Implementation pattern

Create a `smoke-test.js` script at the project root that accepts `--url` as a parameter:

```javascript
// smoke-test.js
const BASE_URL = process.argv.find(a => a.startsWith('--url='))?.split('=')[1]
  || 'http://localhost:3000';

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

async function run() {
  await check('health endpoint', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  // Add more checks here...

  console.log(process.exitCode === 1 ? '\nSome checks FAILED.' : '\nAll checks passed.');
}

run();
```

Add to `package.json`:
```json
"scripts": {
  "smoke-test": "node smoke-test.js"
}
```

Run against production:
```bash
npm run smoke-test -- --url=https://YOUR-APP.up.railway.app
```

### Smoke test rules

- Use a `TEST-` prefix for any test data created during smoke tests so it can be identified and cleaned up.
- Never modify or delete the user's real production data.
- Tests should be read-heavy; write operations only where essential.
- Exit with a non-zero code if any check fails so CI/scripts can detect failure.

---

## Environment Variables: Local vs Production

| Setting | Local | Railway |
|---------|-------|---------|
| `PORT` | Hardcode in dev (e.g. `3000`) | Injected automatically by Railway |
| `NODE_ENV` | `development` (or omit) | `production` |
| Storage paths | Local paths (e.g. `./data`) | Volume paths (e.g. `/app/storage/data`) |
| Secrets | `.env` file (gitignored) | Railway dashboard Variables |

**Never commit `.env` files or secrets to git.**

For local development, use a `.env` file with a package like `dotenv`, loaded only in development:

```javascript
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
```

---

## Timezone Handling

**Railway containers run in UTC.** This is a common source of bugs when your users are in a different timezone.

Rules:
1. Never use `new Date().getDay()` or `new Date().getDate()` for anything user-visible — these return UTC values.
2. Always pass an explicit `timeZone` option when formatting dates:
   ```javascript
   const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
   ```
3. Compare dates as `YYYY-MM-DD` strings, not as Date objects.
4. For day-difference calculations, anchor to UTC noon to avoid DST edge cases:
   ```javascript
   function daysBetween(dateStrA, dateStrB) {
     const a = new Date(dateStrA + 'T12:00:00Z');
     const b = new Date(dateStrB + 'T12:00:00Z');
     return Math.round((b - a) / 86400000);
   }
   ```
5. Store the user's timezone as a configurable setting rather than hardcoding it.

---

## Data & File Management

### Gitignored data files

Runtime data files (JSON stores, SQLite databases, user uploads) must be gitignored. They live on the Railway Volume, not in git. Add to `.gitignore`:

```
data/
uploads/
*.db
```

### Seeding initial/bundled assets

If your app ships with default assets (e.g. seed images, default config), bundle them in git and copy them to the Volume on first startup:

```javascript
const path = require('path');
const fs = require('fs');

function seedAssets() {
  const srcDir = path.join(__dirname, 'public/seed-images');
  const destDir = path.join(UPLOADS_DIR);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    const dest = path.join(destDir, file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(srcDir, file), dest);
    }
  }
}
```

Only copy if the file doesn't already exist — this avoids overwriting user data on redeploy.

### Syncing production data locally

Production data accumulates through user activity on the live app. Local data drifts. When testing behaviour that depends on real data:

```bash
# Pull production data to local (implement as needed for your project)
npm run sync-data
```

When to sync before testing:
- When the user reports production behaviour you can't reproduce locally
- Before testing features that depend on accumulated data (schedules, history, etc.)
- When in doubt, ask the user: "Should I sync local data from production before testing?"

---

## Railway-Specific Gotchas

| Gotcha | Fix |
|--------|-----|
| Container filesystem is ephemeral | Store all persistent data on a Volume |
| `PORT` is dynamic | Always use `process.env.PORT` |
| Container runs UTC | Use explicit timezone in all date formatting |
| Deploy takes 1–3 minutes | Always poll health endpoint before running smoke tests — don't assume it's live |
| Volume mount not configured | App crashes with path errors; check Railway Volume settings in dashboard |
| Environment variable missing | App crashes silently or with cryptic errors; check Railway Variables dashboard |
| Node modules not installed | Add a `build` command (`npm install`) or let Railway detect it via `package.json` |

---

## Recommended Project Structure

```
project/
├── server.js              # Entry point
├── package.json           # "start" and "smoke-test" scripts
├── smoke-test.js          # Post-deploy health checks
├── .gitignore             # data/, uploads/, .env, node_modules/
├── .env                   # Local secrets (gitignored)
├── public/                # Static assets served by Express
├── src/                   # Server-side modules
│   └── config.js          # Paths, env vars, constants
└── data/                  # Runtime data (gitignored, lives on Volume in production)
```

`src/config.js` pattern — single place for all environment-dependent paths:

```javascript
const path = require('path');

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');
const DATA_DIR    = process.env.DATA_DIR    || path.join(STORAGE_DIR, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(STORAGE_DIR, 'uploads');
const PORT        = process.env.PORT        || 3000;

module.exports = { STORAGE_DIR, DATA_DIR, UPLOADS_DIR, PORT };
```

---

## Quick Reference Commands

```bash
# Push and trigger deploy
git push

# Poll health endpoint (run repeatedly until commit matches)
curl -s https://YOUR-APP.up.railway.app/api/health

# Get local HEAD commit to compare
git rev-parse HEAD

# Run smoke tests against production
npm run smoke-test -- --url=https://YOUR-APP.up.railway.app

# Run smoke tests against local
npm run smoke-test
```
