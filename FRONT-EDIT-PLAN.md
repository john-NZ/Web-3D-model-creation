# Front-Image Editing — Implementation Plan

> Working document. If context is lost mid-build, this should be enough to resume.

## Goal

Let the user edit the reference (front) image in Step 2 the same way they edit back/left/right — via either re-upload (Replace button) or AI prompt-edit (AI Generate button + editable prompt). The edited image becomes the new front, and is persisted on the project row.

## Decisions locked in

| Decision | Choice |
|---|---|
| Default prompt for front | Structured placeholder: `"Keep the object exactly as is, but [your instruction here]"` |
| Existing back/left/right after front edit | Show a yellow "stale views" banner; do not auto-clear |
| Original front file | Stays on disk, no revert button. User can make a New Variant if they regret the edit. |
| Schema | One new column: `projects.front_prompt TEXT` |
| New routes | None — extend `/api/upload-view` and `/api/generate-view` to accept `view: "front"` |

## Schema

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS front_prompt TEXT;
```

Idempotent — applied via `init-db.js`.

## Backend changes

- `init-db.js` — add the ALTER TABLE line
- `db.js`:
  - Add `front_prompt` to `WRITABLE_COLUMNS`
  - Extend `createVariant` to copy `front_prompt` from parent
- `server.js`:
  - `/api/upload-view` — change validation from `["back","left","right"]` to `["front","back","left","right"]`. Existing dynamic update (`{ [view + "_image"]: fileName }`) already handles `front` once allowed.
  - `/api/generate-view` — same validation lift. Existing dynamic update (`{ [view + "_image"]: fileName, [view + "_prompt"]: prompt }`) writes both `front_image` and `front_prompt` when `view === "front"`.

## Frontend changes

- `DEFAULT_PROMPTS.front = "Keep the object exactly as is, but [your instruction here]"`
- `renderGallery`:
  - Remove the `key !== 'front'` guards on the Replace button and the prompt editor / AI Generate button
  - Front card now matches the structure of back/left/right
- `generateSingleView('front')`:
  - Source is `viewImages.front` (the *current* front, which may already be an edit)
  - Result replaces `viewImages.front`
  - On success, if any of `back`/`left`/`right` has an image, show stale-views banner
- New stale-views banner element + CSS — yellow, dismisses when the user regenerates any of back/left/right
- `loadProject` — rehydrate `front_prompt` from project row
- "Start Over" hides the stale-views banner

## Build order (resumable checklist)

- [ ] **1.** Add `front_prompt` column via `init-db.js` migration; run it.
- [ ] **2.** Update `db.js`: whitelist + `createVariant` copy.
- [ ] **3.** Update `server.js`: lift the view-validation restriction in both routes.
- [ ] **4.** Update `public/index.html`:
  - Default prompt for front
  - Drop the front-special-casing in `renderGallery`
  - Stale-views banner element + CSS + show/hide hooks
  - Start Over clears the banner state
- [ ] **5.** Commit + push, redeploy on Railway.
- [ ] **6.** End-to-end test: load existing project, click Replace + AI Generate on front, confirm DB row updates and banner appears, regenerate a stale view, confirm banner clears.

## Out of scope

- Storing every front-edit attempt (we only keep the latest).
- Prompt history per view (orthogonal to this feature, would apply to all views).
- Undo / revert.

## Progress log

- **2026-05-07** — Plan written, recommendations approved. No code changes yet. Next step: build-order item #1.
