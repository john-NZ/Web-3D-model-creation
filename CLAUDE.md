# 3D Model Creator — Web Application

## Project Goal

A unified web application that lets a user generate 3D printable models from a single reference image. The app combines OpenAI image generation and HiTem3D 3D model generation into a step-by-step wizard.

## User Flow

1. **Upload** — User uploads a reference image (the "front" view of their object)
2. **Add Views** — User either generates back/left/right views with AI (OpenAI gpt-image-1.5), or manually uploads them individually via per-card drag-and-drop
3. **Review Images** — User sees all 4 images in a gallery with replace/regenerate options
4. **Configure** — User optionally adjusts 3D generation settings (polygon count, format, resolution, generation mode)
5. **Generate 3D Model** — App sends all 4 views to HiTem3D API as multi-view input
6. **View 3D Model** — The resulting model loads in the Three.js viewer (OrbitControls, rotate/zoom/pan)
7. **Download** — User can download the model file in their chosen format (OBJ/GLB/STL/FBX)

## Architecture

- **Backend**: Node.js + Express (ESM modules), single file `server.js`
- **Frontend**: Vanilla HTML/JS/CSS in `public/index.html`, Three.js r0.169.0 via CDN importmap
- **APIs**: OpenAI Image API (direct fetch, not SDK), HiTem3D cloud API (raw http/https, no external HTTP library)

### File Structure

```
server.js              — Unified Express server (port 3001)
public/index.html      — Full frontend (HTML + CSS + JS, single file)
package.json           — ESM project config
.env                   — API keys (not committed)
uploads/               — Temporary uploaded reference images (multer)
output/                — Generated images and 3D model files
archive/               — Original standalone scripts (generate.js, 3Dviewer.js) kept for reference
```

### Backend Routes (server.js)

- `POST /api/upload-front` — Upload front reference image, copies to output dir with timestamp
- `POST /api/upload-view` — Upload a single view image (back/left/right), copies to output dir
- `POST /api/generate-view` — Accepts JSON `{ frontImage, view, prompt }`, calls OpenAI `/v1/images/edits` once for the requested view (back/left/right) using the user-supplied prompt and the already-uploaded front image, returns the new filename
- `POST /api/generate-views` — Bulk endpoint: accepts reference image, calls OpenAI `/v1/images/edits` three times with hard-coded prompts, returns all 4 filenames. Superseded by `/api/generate-view` (see Potentially Redundant Code)
- `POST /api/generate-model` — Accepts array of image filenames + view labels array + optional settings, authenticates with HiTem3D, computes `multi_images_bit` bitmask from the view labels, submits multi-view task, polls until complete, downloads result, returns model filename
- `GET /api/status` — Health check showing which API keys are configured
- `GET /api/images/*` — Static serving of generated images and models from `output/`
- `GET /api/uploads/*` — Static serving of uploaded files
- Static serving for frontend (`public/`)

### Frontend (public/index.html)

Single-file app with all HTML, CSS, and JS inline:

- **3-step wizard UI** with step indicator dots in header
- **Step 1** — Drag-and-drop or file picker upload with image preview
- **Step 2** — 4-card image gallery (front/back/left/right) with per-card drag-and-drop upload zones, replace buttons, and an "AI Generate" button. Collapsible settings panel for HiTem3D options (polygon count slider 50K–2M, output format, resolution 512–2048, model version, generation mode)
- **Step 3** — Three.js 3D viewer (OBJLoader, OrbitControls, ambient + directional lighting, grid, auto-center/scale, vertex count and dimensions display). Download button for the generated model
- **Loading overlay** with spinner for long operations
- **Error display** per step
- Dark theme UI

## Environment Variables (.env)

```
OPENAI_API_KEY=<key>
HITEM3D_CLIENT_ID=<id>
HITEM3D_CLIENT_SECRET=<secret>
```

## Dependencies (package.json)

```json
{
  "type": "module",
  "dependencies": {
    "express": "^4.18.2",
    "dotenv": "^16.4.0",
    "multer": "^1.4.5-lts.1"
  }
}
```

`node_modules` are installed. No build step required — `npm start` or `node server.js` runs the app.

## Build Status

- [x] Create merged `package.json` (ESM, express + dotenv + multer)
- [x] Build unified Express server (`server.js`) with API routes
- [x] Extract and integrate OpenAI image generation logic into server
- [x] Extract and integrate HiTem3D logic (auth, task submission, polling, download) into server
- [x] Build frontend UI (`public/index.html`) with upload + gallery + viewer + wizard steps
- [x] Add error handling and loading states in UI
- [x] Add manual per-view image upload (drag-and-drop per card, replace buttons)
- [x] Add HiTem3D settings panel (polygon count, format, resolution, mode)
- [x] Support multiple output formats (OBJ/GLB/STL/FBX) with appropriate viewer/download handling
- [ ] Test end-to-end flow with live API keys
- [ ] Add GLB/STL/FBX viewer support (currently only OBJ gets live 3D preview; other formats show download-only message)
- [ ] OpenAI cost / usage display in the UI — plan and research in [costs.md](costs.md). Needs admin key from John before code is written.
- [ ] Add **Meshy AI** as an alternate 3D generator alongside HiTem3D. Plan and research in [MESHY-PLAN.md](MESHY-PLAN.md). User picks generator on Step 2 settings panel; choice persists per-project so History shows a "Meshy" badge. Needs `MESHY_API_KEY` env var on local + Railway before any code lands.
- [ ] Capture HiTem3D task ID in the database for traceability. Currently the task ID returned by `hitem3dCreateTask` (used for looking up jobs on HiTem3D's console when something goes wrong) is only printed to the server console and never persisted. Add a new `external_task_id TEXT` column to `projects` via `init-db.js` (idempotent `ADD COLUMN IF NOT EXISTS`), include it in `WRITABLE_COLUMNS` in `db.js`, and in `runHitem3dJob` after the task is created call `db.updateProject(pid, OWNER_USER_ID, { external_task_id: taskId })`. Pure backend / observability win — no frontend changes. If [MESHY-PLAN.md](MESHY-PLAN.md) lands first, it adds this same column already, in which case this task collapses to just the one-line write inside `runHitem3dJob`.
- [x] Add per-project notes section. New `notes TEXT` column on projects (idempotent migration). Step 2 has a collapsible Notes panel between the image gallery and the 3D generation settings, with a plain textarea that autosaves on blur via a new `PATCH /api/projects/:id` route (allow-list pattern — currently only accepts `notes`). Save status ("Saving…" / "Saved" / "Save failed — …") shows below the textarea. History cards display the first line of notes truncated to 40 chars when present, with the full text on hover. `loadProject` populates the textarea; `btnStartOver`, `btnNextStep`, and the in-place delete handler all reset it via a small `clearNotesUI()` helper. Variants do not inherit notes (per-attempt journal, not a setting). Save-failure path not yet exercised end-to-end.
- [x] Add Remove/Delete button to each card in the History strip on Step 1. Frontend adds a small "×" in the top-right corner of each `.history-card` (variant badge moved to top-left to avoid overlap); click → confirm → `DELETE /api/projects/:id` → reload history. If the deleted project is the currently-loaded one (`currentProjectId === deletedId`), wizard state is reset (mirrors btnStartOver) and the user stays on Step 1. Backend extends DELETE to also free disk space: reads the project's filenames before removing the row, then for each filename calls a new `db.isFileReferenced` helper that checks every project image/model column; only unlinks files no other project still references (variants share filenames with parents via `createVariant`). Unlink errors are logged but non-fatal — the DB is the source of truth, orphaned files can be cleaned up later. Note: schema uses `ON DELETE SET NULL` on `projects.parent_id`, so variants of a deleted parent survive with an orphaned `parent_id`; their lineage badge keeps showing "↳ #N" but loading them works — out of scope to handle the orphan reference more gracefully.
- [x] Quick link to HiTem3D usage console on every page — small footer/header link to `https://platform.hitem3d.ai/console/usage/detail` so the user can check prior usage without leaving the app context. No API integration; just an `<a target="_blank">`.
- [x] Bug: stale views carry over when starting a new project. Repro: load a project from history → "Back to Step 1" → upload a new front image → Next. Step 2 still shows the previous project's back/left/right. Fix: in `btnNextStep` (public/index.html), after successful `/api/upload-front`, clear `viewImages.back/left/right`, `modelFilename`, `loadingViews`, `expandedPrompts`, and hide both `stale-views-banner` and `variant-banner`. Leave localStorage prompts alone (those are user defaults, not per-project state). Only apply on btnNext, not on file-pick (user may still be choosing a different file before committing).
- [x] Add Remove/Delete button on back/left/right cards in Step 2, so the user can clear a view without replacing it and submit fewer than 4 images to HiTem3D. Backend: new route e.g. `POST /api/clear-view` taking `{projectId, view}` that nulls out `<view>_image` and `<view>_prompt`. Validate view is one of back/left/right (front is required, never removable). Frontend: small "Remove" link/button on each non-front card next to Replace; on click confirm, then call clear-view, set `viewImages[view] = null`, `renderGallery()`, `updateViewsStatus()`. The existing generate-model already handles fewer-than-4 (uses `filledViews()` and `multi_images_bit` bitmask) so no other backend change needed. Don't delete the file from disk — it may be referenced by variant projects.
- [x] On Step 2, allow navigating to Step 3 when the loaded project already has a 3D model. Currently if the user goes back from Step 3 to Step 2 (or loads a project with a model), there's no way to return to the viewer without regenerating. Frontend: add a "View 3D Model" button to Step 2's button row (next to "Generate 3D Model"), shown only when `modelFilename` is truthy. Click handler reuses `showCompletedModel({ model_file: modelFilename })` (refactor that function to accept a filename if cleaner). Button visibility should refresh whenever `modelFilename` changes — `loadProject`, `showCompletedModel`, `btnStartOver`, `btnNextStep`. Frontend-only change, no backend.

## Potentially Redundant Code

Code that has been superseded but is left in place pending review. Once the replacement is confirmed working end-to-end, consider removing.

- `POST /api/generate-views` ([server.js](server.js)) — bulk endpoint that generated all 3 views from hard-coded prompts in one call. Superseded by `POST /api/generate-view` (singular), which the frontend now calls once per view (in parallel) so the user can edit each prompt and generate views independently. Kept for now in case the bulk path is needed again.

## Key Technical Notes

- OpenAI SDK has a known bug rejecting GPT Image models — server bypasses SDK, calls REST API directly via fetch
- HiTem3D multi-view requires front image FIRST in the array (frontend sends: front, back, left, right)
- HiTem3D `multi_images_bit` parameter is always sent: a 4-char bitmask (e.g. "1010" = front+left) telling the API which views are present. Required when fewer than 4 images are submitted.
- Minimum submission is front view + one other view; all 4 views produce best results
- HiTem3D polling runs every 5s, up to 360 attempts (~30 min timeout) — UI shows loading overlay
- Three.js OBJLoader parses text, so we fetch .obj content from our own server
- The 3D viewer is lazily initialized (only created when a model is first loaded)
- Server runs on port 3001 (configurable via PORT env var)
- No `openai` npm package needed — direct fetch to the REST API
