# Deployment Plan — 3D Model Creator → Railway

This plan covers everything needed to take the project from local-only to live on Railway, pulled from GitHub.

---

## Prerequisites (confirmed)

- [x] GitHub account exists
- [x] Git CLI installed locally
- [ ] Railway account exists (sign up at railway.app if needed)
- [ ] Separate production API keys ready (OpenAI, HiTem3D)

---

## Phase 1: Prepare the codebase for deployment

These changes make the app production-ready without changing any existing functionality.

### 1.1 Create `.gitignore`

- [ ] Create `.gitignore` in the project root with:
  ```
  node_modules/
  .env
  uploads/
  output/
  ```
  The `uploads/` and `output/` directories contain runtime data that should not be committed. `node_modules/` will be installed by Railway during build. `.env` contains secrets.

### 1.2 Make storage paths configurable via environment variables

- [ ] Update `server.js` so `UPLOAD_DIR` and `OUTPUT_DIR` read from environment variables with local fallbacks:
  ```javascript
  const STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
  const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
  const OUTPUT_DIR = path.join(STORAGE_DIR, "output");
  ```
  This lets Railway point storage at a persistent Volume while keeping the current local behavior unchanged.

### 1.3 Make the server bind to `process.env.PORT`

- [ ] Verify `server.js` uses `process.env.PORT || 3001` — **already done**, no change needed. Just confirm.

### 1.4 Add a `/api/health` endpoint

- [ ] Add to `server.js`:
  ```javascript
  import { execSync } from "child_process";
  let commitHash = "unknown";
  try { commitHash = execSync("git rev-parse HEAD").toString().trim(); } catch (_) {}

  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      commit: commitHash,
      openai: !!process.env.OPENAI_API_KEY,
      hitem3d: !!(process.env.HITEM3D_CLIENT_ID && process.env.HITEM3D_CLIENT_SECRET),
    });
  });
  ```
  This merges the existing `/api/status` info into the health endpoint. The `commit` field is required so we can verify deploys landed correctly. Keep the existing `/api/status` route as-is for backward compatibility.

### 1.5 Write `smoke-test.js`

- [ ] Create `smoke-test.js` in the project root. It should test:
  1. `GET /api/health` returns 200 with `status: "ok"` and a `commit` field
  2. `GET /` (frontend) returns 200
  3. `GET /api/status` returns 200 with `openai` and `hitem3d` fields
  4. `POST /api/generate-model` with missing body returns 400 (not 500) — confirms the route is alive and validates input
  5. `POST /api/upload-front` with no file returns 400 (not 500)
- [ ] Use the pattern from `railway.md`: accept `--url=` parameter, default to `http://localhost:3001`
- [ ] Add `"smoke-test": "node smoke-test.js"` to `package.json` scripts

**Smoke test rules:**
- No real API calls to OpenAI or HiTem3D (those cost money and take minutes)
- Read-heavy; only test that routes respond correctly to bad/missing input
- Exit with non-zero code on any failure
- Prefix any test data with `TEST-` if write operations are needed

### 1.6 Run smoke tests locally

- [ ] Start the server locally (`npm start`)
- [ ] Run `npm run smoke-test` and verify all checks pass
- [ ] Fix any issues before proceeding

---

## Phase 2: Git setup and GitHub push

### 2.1 Initialize the local Git repo

- [ ] Run in the project root:
  ```bash
  git init
  git add .
  git status
  ```
- [ ] Review `git status` output — confirm no secrets (`.env`), no `node_modules/`, no `uploads/` or `output/` files are staged. Only application code and config files should be included.

### 2.2 Create the initial commit

- [ ] Commit:
  ```bash
  git commit -m "Initial commit: 3D Model Creator web app"
  ```

### 2.3 Create the GitHub repository

- [ ] Create a new repository on GitHub (private recommended since API integration code is involved)
- [ ] Repository name suggestion: `3d-model-creator`
- [ ] Do NOT initialize with README, .gitignore, or license (we already have our own files)

### 2.4 Push to GitHub

- [ ] Add the remote and push:
  ```bash
  git remote add origin https://github.com/<your-username>/3d-model-creator.git
  git branch -M main
  git push -u origin main
  ```

### 2.5 Verify on GitHub

- [ ] Open the GitHub repo in a browser and confirm all files are present
- [ ] Confirm `.env` is NOT visible in the repo
- [ ] Confirm `node_modules/` is NOT in the repo

---

## Phase 3: Railway deployment

### 3.1 Create the Railway project

- [ ] Log in to Railway dashboard (railway.app)
- [ ] Create a new project → "Deploy from GitHub repo"
- [ ] Connect your GitHub account if not already connected
- [ ] Select the `3d-model-creator` repository
- [ ] Railway will auto-detect it as a Node.js project

### 3.2 Configure environment variables

- [ ] In the Railway dashboard → service → Variables, set:
  | Variable | Value |
  |----------|-------|
  | `NODE_ENV` | `production` |
  | `OPENAI_API_KEY` | *(your production key)* |
  | `HITEM3D_CLIENT_ID` | *(your production client ID)* |
  | `HITEM3D_CLIENT_SECRET` | *(your production client secret)* |
  | `STORAGE_DIR` | `/app/storage` |

  **Do NOT set `PORT`** — Railway injects this automatically.

### 3.3 Attach a persistent Volume

- [ ] In the Railway dashboard → service → Volumes
- [ ] Create a new Volume, mount path: `/app/storage`
- [ ] This will store `uploads/` and `output/` directories persistently across redeploys

### 3.4 Generate the public URL

- [ ] In the Railway dashboard → service → Settings → Networking
- [ ] Click "Generate Domain" to get a `*.up.railway.app` URL
- [ ] Note this URL — you'll need it for smoke tests

### 3.5 Deploy and verify

- [ ] Railway should auto-deploy when the GitHub repo is connected
- [ ] Watch the build logs in the Railway dashboard for errors
- [ ] Once deployed, poll the health endpoint:
  ```bash
  curl -s https://YOUR-APP.up.railway.app/api/health
  ```
- [ ] Confirm the response includes `"status": "ok"` and the `commit` hash matches your local HEAD (`git rev-parse HEAD`)

### 3.6 Run smoke tests against production

- [ ] Run:
  ```bash
  npm run smoke-test -- --url=https://YOUR-APP.up.railway.app
  ```
- [ ] All checks should pass
- [ ] If any fail, check Railway build/deploy logs and fix before proceeding

### 3.7 Manual end-to-end test

- [ ] Open the Railway URL in a browser
- [ ] Verify the frontend loads (dark theme, step 1 upload screen)
- [ ] Upload a test image and confirm it reaches step 2
- [ ] (Optional) Run a full generation if you want to verify API keys work in production

---

## Phase 4: Ongoing deploy workflow

Once initial setup is complete, every future deploy follows this pattern:

```
1. Make changes locally
2. Test locally (npm start, verify in browser)
3. Run smoke tests locally (npm run smoke-test)
4. git add + git commit
5. git push → triggers Railway auto-deploy
6. Poll /api/health until commit matches local HEAD
7. Run smoke tests against production URL
8. Confirm everything is live
```

---

## Files to create or modify

| File | Action | Purpose |
|------|--------|---------|
| `.gitignore` | **Create** | Exclude secrets, node_modules, runtime data |
| `server.js` | **Modify** | Add `/api/health` endpoint, make storage paths configurable |
| `smoke-test.js` | **Create** | Post-deploy verification script |
| `package.json` | **Modify** | Add `smoke-test` script |
| `CLAUDE.md` | **Modify** | Add deployment section with Railway URL and deploy workflow |

---

## Things to watch out for

- **Ephemeral filesystem**: The Railway container filesystem resets on every deploy. All uploaded images and generated models must go to the Volume (`/app/storage/uploads` and `/app/storage/output`). The `STORAGE_DIR` env var handles this.
- **PORT is dynamic**: Railway injects `PORT` — our server already reads `process.env.PORT`, so this is covered.
- **Build step**: Railway will run `npm install` automatically when it detects `package.json`. No additional build command is needed since we have no compilation step.
- **Cold starts**: The first request after a deploy may be slow. The health endpoint helps verify the app is ready before running smoke tests.
- **API key costs**: Smoke tests must NOT call OpenAI or HiTem3D. They only test that routes respond correctly to validation errors.
- **UTC timezone**: Railway runs in UTC. Not currently an issue (we don't display dates to users) but worth noting for future features.
