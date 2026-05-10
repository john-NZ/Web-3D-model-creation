# MESHY-PLAN.md

Plan for adding **Meshy AI** as a second 3D model generator alongside HiTem3D. The user picks which generator to use; the rest of the wizard is unchanged.

This document is the authoritative source for this feature. Read it first when resuming work. Locked decisions are at the top; build order is at the bottom; deferred work is at the very end.

---

## 1. Locked decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Scope = parity only.** Use Meshy's `multi-image-to-3d` endpoint. Skip `image-to-3d` (single image) and `text-to-3d` (pure text) for v1. | Smallest possible change; matches our existing front+back+left+right flow. |
| 2 | **No textures.** Send `should_texture: false` to Meshy. No texture prompt, no PBR, no HD texture. | The app is for 3D printing — textures aren't used and texturing costs +10 credits per task. |
| 3 | **Picker on Step 2 settings panel.** Generator choice persists on the project record so History can show which one was used. | Single place to make settings choices. |
| 4 | **Minimal Meshy settings UI for v1.** Polygon count + output format only. Hide HiTem3D-specific knobs (resolution, model version, generation mode) when Meshy is selected. | Don't double the settings surface; we can expose advanced Meshy options later. |
| 5 | **Polygon slider re-bounds on generator change.** HiTem3D: 50K–2M (current). Meshy: 100–300K. Clamp current value if it exceeds new max, with a small notice. | Different services support different ranges; user shouldn't see an error after submit. |
| 6 | **DB column from day one.** Add `generator` to projects so History UI can show "Meshy" badges immediately. | User explicitly asked for it. |
| 7 | **HiTem3D defaults unchanged.** New projects continue to default to HiTem3D. Existing projects in the DB get `generator='hitem3d'` via the column default. | Don't disturb existing flow. |
| 8 | **Image delivery to Meshy = base64 data URIs.** Read each PNG from `OUTPUT_DIR`, encode as `data:image/png;base64,…`, pass in `image_urls` array. | Self-contained request, works from local dev too, avoids Meshy needing to fetch from our Railway URL. ~33% size overhead is fine for 4× ~500 KB PNGs. |
| 9 | **Reuse the existing async-job pattern.** A new `runMeshyJob(pid, imagePaths, views, opts, settings)` function mirrors `runHitem3dJob`. The `/api/generate-model` route branches on `settings.generator`. | Frontend stays generator-agnostic for status polling. |
| 10 | **Cost display is still deferred.** But we record `consumed_credits` from Meshy responses so the data is ready when [costs.md](costs.md) work begins. HiTem3D rows stay `NULL` until that work picks up the HiTem3D side. | Per user — "we will want a costs indicator just like we have planned". |

---

## 2. Environment variables

Add one new variable to both local `.env` and Railway:

```
MESHY_API_KEY=msy_…
```

Where to get it: https://www.meshy.ai/settings/api → "Create new API key". The key is shown **once** — copy it immediately. Use a single key (Meshy doesn't have separate test/prod tiers).

`/api/status` health check (server.js) also gets a `meshy: !!process.env.MESHY_API_KEY` field so we can confirm the key is wired up.

---

## 3. Database schema changes

Three new columns on `projects`. Edit `init-db.js` (uses `ADD COLUMN IF NOT EXISTS`, idempotent). Run once with `node init-db.js` against production DB.

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS generator         TEXT NOT NULL DEFAULT 'hitem3d';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS external_task_id  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS consumed_credits  INTEGER;
```

| Column | Purpose | Set by |
|---|---|---|
| `generator` | `'hitem3d'` or `'meshy'`. Drives which job runs and which History badge to show. | Frontend on project create. |
| `external_task_id` | The 3rd-party service's task UUID. Useful for debug/manual lookup. Populated for both generators (HiTem3D currently doesn't persist this — we'll start). | Backend job after task creation. |
| `consumed_credits` | Meshy returns this on `SUCCEEDED`. Stays `NULL` for HiTem3D rows until [costs.md](costs.md) work covers HiTem3D billing. | Backend job after task completion. |

`db.js` `WRITABLE_COLUMNS` set must be expanded to include all three.

`db.js` `listProjects` SELECT list must include `generator` so History cards can render the badge without a second query.

`db.js` `createVariant` must copy `generator` from parent (a variant of a Meshy project should also be Meshy by default; the user can change it on Step 2 before generating).

---

## 4. Backend — server.js changes

### 4.1 New constants & helpers

```js
const MESHY_BASE = "https://api.meshy.ai";

// Map our internal format codes/strings to Meshy's target_formats values.
// HiTem3D uses numeric codes (1=obj, 2=glb, 3=stl, 4=fbx); Meshy uses strings.
// We'll standardize on lowercase strings on the frontend going forward,
// keeping the numeric mapping for HiTem3D backward compatibility.
const HITEM3D_FORMAT_CODE = { obj: 1, glb: 2, stl: 3, fbx: 4 };
const MESHY_FORMAT_NAMES  = { 1: "obj", 2: "glb", 3: "stl", 4: "fbx" };
```

### 4.2 New helper: `imageFileToDataUri(filePath)`

```js
function imageFileToDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const buf = fs.readFileSync(filePath);
  return "data:" + mime + ";base64," + buf.toString("base64");
}
```

### 4.3 New helpers (mirror the HiTem3D ones)

```js
async function meshyCreateTask(imagePaths, opts) {
  const apiKey = process.env.MESHY_API_KEY;
  if (!apiKey) throw new Error("Meshy API key not configured");

  const formatName = MESHY_FORMAT_NAMES[opts.format || 1] || "obj";
  const polycount = Math.max(100, Math.min(300000, Number(opts.face) || 30000));

  const body = {
    image_urls: imagePaths.map(imageFileToDataUri),
    ai_model: "latest",
    should_texture: false,
    should_remesh: true,
    target_polycount: polycount,
    target_formats: [formatName],
    symmetry_mode: "auto",
  };

  console.log("[Meshy] Creating task with " + imagePaths.length + " images, " +
              "polycount=" + polycount + ", format=" + formatName);

  const result = await jsonRequest("POST", MESHY_BASE + "/openapi/v1/multi-image-to-3d", {
    Authorization: "Bearer " + apiKey,
    "Content-Type": "application/json",
  }, JSON.stringify(body));

  if (result.status >= 400 || !result.data?.result) {
    throw new Error("Meshy task creation failed (HTTP " + result.status + "): " + JSON.stringify(result.data));
  }
  console.log("[Meshy] Task created: " + result.data.result);
  return result.data.result;  // task UUID string
}

async function meshyPoll(taskId) {
  const apiKey = process.env.MESHY_API_KEY;
  console.log("[Meshy] Polling task: " + taskId);
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const result = await jsonRequest("GET",
      MESHY_BASE + "/openapi/v1/multi-image-to-3d/" + encodeURIComponent(taskId),
      { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" }
    );
    const status = result.data?.status;
    const progress = result.data?.progress;
    console.log("[Meshy] Poll #" + attempt + " - status: " + status +
                (progress !== undefined ? ", progress: " + progress : ""));

    if (status === "SUCCEEDED") return result.data;
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error("Meshy task " + status + ": " + JSON.stringify(result.data?.task_error || result.data));
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Meshy task timed out after " + MAX_POLL_ATTEMPTS + " attempts");
}
```

### 4.4 New job runner: `runMeshyJob`

```js
async function runMeshyJob(pid, imagePaths, views, opts, settings) {
  const startedAt = Date.now();
  console.log("[Job " + pid + "] Starting Meshy pipeline");
  try {
    const taskId = await meshyCreateTask(imagePaths, opts);

    // Persist external_task_id immediately so it's available even if
    // polling times out and the user contacts Meshy support.
    await db.updateProject(pid, OWNER_USER_ID, { external_task_id: taskId });

    const taskData = await meshyPoll(taskId);

    const formatName = MESHY_FORMAT_NAMES[opts.format || 1] || "obj";
    const modelUrl = taskData.model_urls?.[formatName];
    if (!modelUrl) throw new Error("Meshy response missing model_urls." + formatName);

    const results = {};
    const modelFile = path.join(OUTPUT_DIR, taskId + "." + formatName);
    await downloadFile(modelUrl, modelFile);
    results.model = taskId + "." + formatName;

    if (taskData.thumbnail_url) {
      const previewFile = path.join(OUTPUT_DIR, taskId + "_preview.png");
      await downloadFile(taskData.thumbnail_url, previewFile);
      results.preview = taskId + "_preview.png";
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log("[Job " + pid + "] Done in " + elapsed + "s. Results:", JSON.stringify(results));

    await db.updateProject(pid, OWNER_USER_ID, {
      model_file: results.model || null,
      preview_image: results.preview || null,
      settings: settings || null,
      consumed_credits: taskData.consumed_credits ?? null,
      status: "success",
      error_message: null,
    });
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error("[Job " + pid + "] FAILED after " + elapsed + "s:", err.message);
    await db.updateProject(pid, OWNER_USER_ID, {
      status: "failed",
      error_message: err.message,
    }).catch((dbErr) => console.error("[Job " + pid + "] DB update on failure also failed:", dbErr.message));
  }
}
```

### 4.5 `/api/generate-model` branch

Inside the existing route handler, after settings parsing and project flag-as-processing:

```js
const generator = settings?.generator === "meshy" ? "meshy" : "hitem3d";

await db.updateProject(pid, OWNER_USER_ID, { generator });  // record on the row

if (generator === "meshy") {
  runMeshyJob(pid, imagePaths, views, opts, settings);
} else {
  runHitem3dJob(pid, imagePaths, views, opts, settings);
}
```

Note: HiTem3D's `external_task_id` write is tracked as its own TODO in CLAUDE.md ("Capture HiTem3D task ID in the database for traceability") and may land before this Meshy work. The `external_task_id` column itself is added by §3 of this plan if it doesn't already exist — both migrations use `ADD COLUMN IF NOT EXISTS` so whichever lands first wins, and the other is a no-op.

### 4.6 `/api/status` extension

```js
res.json({
  openai:  !!process.env.OPENAI_API_KEY,
  hitem3d: !!(process.env.HITEM3D_CLIENT_ID && process.env.HITEM3D_CLIENT_SECRET),
  meshy:   !!process.env.MESHY_API_KEY,
});
```

---

## 5. Frontend — public/index.html changes

### 5.1 Settings panel additions

Add a "3D Generator" radio group (or `<select>`) at the top of the Step 2 settings panel:

```
3D Generator:  ( ) HiTem3D (default)   ( ) Meshy
```

Persist the choice in the existing `settings` object that's POSTed to `/api/generate-model`. Key: `settings.generator = "hitem3d" | "meshy"`.

### 5.2 Conditional settings UI

When generator changes, swap visible controls:

| Control | HiTem3D | Meshy |
|---|---|---|
| Polygon count slider | min 50K, max 2M, default 800K | min 100, max 300K, default 30K |
| Output format select (obj/glb/stl/fbx) | shown | shown |
| Resolution select | shown | hidden |
| Model version select | shown | hidden |
| Generation mode select | shown | hidden |

A small JS function `applyGeneratorUI(gen)` toggles `display: none` on the generator-specific controls and reconfigures the polygon slider's `min`/`max`/`step` and clamps its current value.

When clamping happens (e.g. user had slider at 1.5M and switches to Meshy), show a one-line notice next to the slider: *"Meshy supports up to 300K polygons — adjusted from 1,500,000."*

### 5.3 History card badge

Each history card already shows lineage (`↳ #N`). Add a generator badge in the corner — small text or pill. Conditional on `project.generator === "meshy"` so HiTem3D cards stay visually unchanged (since HiTem3D is the implicit default users have been using). Suggested label: `Meshy` in a colored pill.

The list endpoint (`/api/projects`) already returns `generator` once we add it to `db.listProjects`'s SELECT list (see §3).

### 5.4 No changes to

- Step 1 upload, Step 1 history strip layout, Step 3 viewer, Step 3 download.
- The backend status-polling loop the frontend uses to watch a processing project.
- The variant-creation flow (variants inherit `generator` from parent at the DB layer; the user can change it on Step 2 before regenerating).

---

## 6. Build order

Bundle all changes for a single feature into one commit per the workflow doc — frontend + backend + schema together so a deploy never lands a half-feature.

- [ ] **0. Get the API key.** John creates a Meshy account at meshy.ai, generates an API key. Add to local `.env` and Railway env vars.
- [ ] **1. Schema migration.** Edit `init-db.js` to add the three columns. Run `node init-db.js` against production DB. Verify with `node -e "import('./db.js')..."` that the columns exist.
- [ ] **2. db.js updates.** Add the new columns to `WRITABLE_COLUMNS`, the `listProjects` SELECT list, and `createVariant`'s field copy.
- [ ] **3. Backend Meshy code.** Add `MESHY_BASE`, `imageFileToDataUri`, `meshyCreateTask`, `meshyPoll`, `runMeshyJob`. Branch in `/api/generate-model`. Extend `/api/status`. Add `external_task_id` write to `runHitem3dJob` for parity.
- [ ] **4. Frontend generator picker + conditional settings.** Add the radio group, `applyGeneratorUI()`, slider re-bound logic, history card badge.
- [ ] **5. Manual test on Railway.** Single commit, push, wait for deploy. Test plan: §7.
- [ ] **6. User verification.** John runs through the test plan and reports back. No item marked done until he confirms.
- [ ] **7. Update CLAUDE.md.** Move the "Meshy integration" line from Build Status's TODO list (we'll add it in step 0) to the done list. Mention generator picker in the architecture section.

---

## 7. Manual test plan (production)

After deploy:

1. Open the app. Open `/api/status` in another tab — confirm `"meshy": true`.
2. Start a fresh project, upload a front image, add 3 views (any mix of AI + manual).
3. On Step 2, expand settings. Verify:
   - Default generator is HiTem3D.
   - Polygon slider range is 50K–2M, current value 800K (or whatever the prior default was).
4. Switch generator to Meshy. Verify:
   - Polygon slider rebounds to 100–300K, slider value clamped if it was above 300K.
   - Resolution / model version / generation mode controls hide.
   - Format select still visible.
5. Click "Generate 3D Model". Watch loading overlay. Confirm:
   - Step 3 eventually shows the 3D model (OBJ should preview in viewer; GLB/STL/FBX show download-only message per existing behavior).
   - Refresh during processing — the elapsed timer should resume cleanly (existing async-job behavior).
6. Back to Step 1. Verify the new project's history card shows a "Meshy" badge.
7. Check DB: `SELECT id, generator, external_task_id, consumed_credits, status FROM projects ORDER BY id DESC LIMIT 5;` — confirm a populated row.
8. Make a variant of the Meshy project. Confirm Step 2 inherits `generator='meshy'` and the slider is in the Meshy range.
9. Make a NEW project from scratch (Step 1 → upload). Confirm default is still HiTem3D, ranges and controls are HiTem3D's. Submit a HiTem3D job. Confirm it still works exactly as before, badge does NOT appear (since HiTem3D is the default).

If any step fails, do not mark done — fix and retest.

---

## 8. Open questions (non-blocking, surface as we go)

- **Image format**: Meshy accepts only PNG/JPG. Our pipeline produces PNGs from OpenAI and accepts whatever the user uploads. If the user uploads a non-PNG/JPG (e.g. WebP), Meshy will reject. Same constraint exists for HiTem3D today. Out of scope to enforce in this pass — fail loudly and let the error message surface.
- **Polling timeout**: Meshy's typical generation time is similar to HiTem3D (a few minutes). We're reusing `MAX_POLL_ATTEMPTS = 360` and `POLL_INTERVAL_MS = 5000` (30 min cap). If Meshy is consistently faster, we could shorten — non-urgent.
- **`expires_at`**: Meshy returns an expiration timestamp on results. We immediately download the file to our Railway Volume so this doesn't matter for our flow.
- **Errors during base64 encoding**: very large reference images (>10MB) could push request size up. Not expected for normal use; defer until we see a real failure.

---

## 9. Deferred work (post-v1)

Pulled out of scope intentionally. Don't build these without re-reviewing this doc.

- **Single-image generation** (`/openapi/v1/image-to-3d`). Useful when the user has only one good reference and doesn't want to fight AI back/left/right generation.
- **Pure text-to-3D** (`/openapi/v1/text-to-3d`). Skip Step 1 image upload entirely; user types a description.
- **Texture options** (texture_prompt, PBR, HD texture). The 3D printing use case doesn't need them.
- **Symmetry / pose-mode UI**. Currently sending `symmetry_mode: "auto"` blind. Could expose as advanced settings later.
- **SSE streaming** instead of polling. Real-time progress would feel snappier; not required.
- **Cost / credit display**. Tracked separately in [costs.md](costs.md). Schema is already prepared via `consumed_credits`.
- **GLB/STL/FBX live viewer**. Pre-existing limitation, not specific to this work.
- **Generator filter in History UI**. If we end up with lots of projects, filter buttons "All / HiTem3D / Meshy" would help. Not needed yet.
