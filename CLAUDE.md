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
- `POST /api/generate-views` — Accepts reference image, calls OpenAI `/v1/images/edits` three times (back/left/right prompts), returns all 4 filenames
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
