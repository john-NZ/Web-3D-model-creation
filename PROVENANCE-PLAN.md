# PROVENANCE-PLAN.md

Plan for tracking **the source of each image and 3D model** on every project. Pass 2 of the notes/provenance work (pass 1 — notes — already shipped).

This document is the authoritative source for the `front_image_source`, `back_image_source`, `left_image_source`, `right_image_source`, and `generator` columns. Read it first when resuming this work.

---

## 1. Locked decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Variants pattern (not simultaneous models per project).** Comparing HiTem3D vs Meshy on the same images = make a variant of the project, switch generator on Step 2 settings, regenerate. The two related projects link via `parent_id`. | (a) is small and uses the existing data model. (b) — one project, two simultaneous 3D models — is bigger (schema + Step 3 viewer switcher) and is parked in the deferred section. |
| 2 | **Five new columns**, all simple `TEXT`. Four for image sources, one for the 3D model generator. Stored on the `projects` row, not in JSONB or a separate table. | Same shape as the rest of `projects`. Trivial to filter ("all my Meshy projects"), trivial to render. |
| 3 | **Generator stores the specific model version**, not just the service. Example values: `"hitem3dv2.0"` (today), `"meshy-6"` (when Meshy lands). Service is implied by the value's prefix. | User asked for specificity ("be specific about exactly which model we used"). One column is enough; we can derive the service from the value when needed. |
| 4 | **Backfill `generator` for existing rows** from `settings->>'model'` (JSONB lookup), falling back to `'hitem3dv2.0'` when the setting is absent. Only backfill rows with a `model_file` (i.e. an actual generation happened). | User asked to include existing HiTem3D models. The settings JSONB already records which model version was used — we just lift it. |
| 5 | **Image source columns stay NULL for existing rows.** No retroactive guessing. | We don't have a record of which views were AI-generated vs uploaded; pretending otherwise would corrupt the data. User can edit them via the dropdown if desired. |
| 6 | **Source vocabulary = hybrid.** Dropdown options: Midjourney, OpenAI, Other… (with a free-text field that appears when "Other" is picked). | User signed off on this. Two known values cover today's reality; "Other" is the escape hatch. |
| 7 | **AI generations auto-stamp** the source code-side. `/api/generate-view` writes `"openai_gpt-image-1.5"` (the model actually called). `/api/generate-model` writes the actual HiTem3D model from `opts.model`. The user doesn't have to set anything for AI flows. | User said "if we know the source then don't ask the user to add it." |
| 8 | **Manual uploads pre-fill the dropdown from `localStorage`** (last-used value per upload type). User can change before saving. | User asked for last-used pre-fill. Keeps repeat-uploads from the same external tool zero-click. |
| 9 | **Variants inherit the four image source values** (since the images themselves are inherited). Variants do NOT inherit `generator` — it's set fresh when the variant generates a model. | A variant of a Midjourney project is still a Midjourney project (image-wise), but a variant exists specifically to try a different generator. |
| 10 | **History cards: extend the status label** to include the service name when a model exists. `"Model"` becomes `"Model · HiTem3D"` (full version on hover). No separate badge. | Avoids cluttering the card with a new visual element. The status label is the natural place for "what kind of result is this?". |
| 11 | **Step 2 source UI: small Source dropdown at the bottom of each image card.** Disabled when no image is loaded. AI-generated views show the auto-stamped value, still user-editable in case the user wants to override. | Compact; lives next to the image it describes. |

---

## 2. Source vocabulary

Stored as lowercase strings in the four `*_image_source` columns. Frontend maps display labels to values.

| Display | Stored value |
|---|---|
| Midjourney | `"midjourney"` |
| OpenAI | `"openai"` |
| OpenAI (gpt-image-1.5) | `"openai_gpt-image-1.5"` *(auto-stamped only — not picked by user)* |
| Other… | user-typed string, lowercased and trimmed (`"adobe firefly"`, `"stable diffusion"`, etc.) |

Generator values use the actual model id from the underlying API: `"hitem3dv2.0"`, `"meshy-6"`, `"meshy-latest"`. Service is inferred by prefix.

---

## 3. Schema migration

Edit `init-db.js`. All five additions are idempotent (`ADD COLUMN IF NOT EXISTS`). Backfill runs once and is also idempotent (`WHERE generator IS NULL`).

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS front_image_source TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS back_image_source  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS left_image_source  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS right_image_source TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS generator          TEXT;

UPDATE projects
   SET generator = COALESCE(settings->>'model', 'hitem3dv2.0')
 WHERE generator IS NULL
   AND model_file IS NOT NULL;
```

Run via `node init-db.js` against production once locally before pushing the code.

---

## 4. Backend — server.js + db.js

### 4.1 `db.js` updates

- Add all 5 new columns to `WRITABLE_COLUMNS`.
- Add all 5 to the `listProjects` SELECT list (history cards need `generator` for the status label; sources are not shown on cards but are included so the round-trip is consistent — already small per-project).
- `createVariant` copies the 4 `*_image_source` columns from the parent. Does NOT copy `generator` (variant gets a fresh stamp on next generation).

### 4.2 New auto-stamp writes

- `POST /api/upload-front` — accept optional `source` body field; persist to `front_image_source`. If absent, leave NULL (frontend will normally send a value from localStorage).
- `POST /api/upload-view` — accept optional `source`; persist to `<view>_image_source`. Same NULL-on-absent rule.
- `POST /api/generate-view` — after the OpenAI call succeeds, write `<view>_image_source = "openai_gpt-image-1.5"` (use the actual model variable from the call so future model swaps stamp the new value automatically).
- `runHitem3dJob` (inside `/api/generate-model`) — after `model_file` is downloaded, write `generator = opts.model` (e.g. `"hitem3dv2.0"`). Same pattern will apply to `runMeshyJob` once Meshy lands — it stamps `ai_model` from the Meshy request.

### 4.3 Extend `PATCH /api/projects/:id` allow-list

Currently accepts `notes`. Extend to also accept the 4 `*_image_source` fields. Do NOT accept `generator` via PATCH — it's auto-stamped only, never user-edited.

```js
const allowed = ["notes", "front_image_source", "back_image_source", "left_image_source", "right_image_source"];
for (const k of allowed) {
  if (typeof req.body[k] === "string") fields[k] = req.body[k];
}
```

---

## 5. Frontend — public/index.html

### 5.1 Step 2 per-card Source dropdown

Below each image inside the gallery card. Mark-up roughly:

```html
<div class="card-source">
  <label>Source:</label>
  <select class="source-select" data-view="front">
    <option value="">—</option>
    <option value="midjourney">Midjourney</option>
    <option value="openai">OpenAI</option>
    <option value="__other">Other…</option>
  </select>
  <input type="text" class="source-other" data-view="front" placeholder="e.g. Stable Diffusion" hidden>
</div>
```

Behavior:

- `disabled` when the card has no image.
- On image load (upload, AI gen, or project load): set the select to match the saved value. If the value isn't one of the known options (e.g. `"openai_gpt-image-1.5"`, `"adobe firefly"`), show "Other…" with the value visible in the text input.
- On `change` (select) or `blur` (text input): PATCH the project with the resolved value. Show a tiny inline "Saved" / "Save failed" status next to the field, identical pattern to notes.
- Pre-fill on fresh upload: read `localStorage.lastSource` (or `localStorage.lastSourceOther` if Other), use as the initial value before PATCHing.
- Save changes also update localStorage so the next upload defaults to the same value.

### 5.2 History card status label

In `renderHistory`, change the status block when `status === "done"`:

```js
let label = "Model";
if (p.generator) {
  const service =
    p.generator.startsWith("hitem3d") ? "HiTem3D" :
    p.generator.startsWith("meshy")   ? "Meshy"   :
    p.generator;
  label = "Model · " + service;
  statusEl.title = "Generated with " + p.generator;  // tooltip = full model id
}
statusEl.textContent = label;
```

No new CSS needed; the existing `.history-card-status.done` styling absorbs the longer label. If it overflows visually we can shrink the font in a follow-up.

### 5.3 No changes to

- Step 1 upload UI / drag-and-drop (the source value is collected via the dropdown on the next step).
- Step 3 viewer.
- Settings panel layout.
- Variant creation flow.

---

## 6. Build order

Bundle all changes for this feature into a single commit per the workflow doc — schema, backend, frontend together.

- [ ] **1. Schema migration.** Edit `init-db.js`, run `node init-db.js` against production. Verify with a quick query that `generator` is populated for the 5 existing rows and that the 4 source columns are NULL.
- [ ] **2. db.js updates.** Add columns to `WRITABLE_COLUMNS`, `listProjects` SELECT, `createVariant` copy.
- [ ] **3. Backend auto-stamps.** `/api/upload-front`, `/api/upload-view`, `/api/generate-view`, `runHitem3dJob`. Extend PATCH allow-list.
- [ ] **4. Frontend Step 2 Source dropdown.** Markup, behavior, localStorage pre-fill, PATCH on change.
- [ ] **5. Frontend history-card status label.** Extend the "done" branch in `renderHistory`.
- [ ] **6. Single commit + push.** Test plan in §7. Wait for John's confirmation before marking done in CLAUDE.md.

---

## 7. Test plan

After deploy:

1. **Existing projects backfilled.** Reload the app. On Step 1, history cards for projects that already had a model should show `Model · HiTem3D` (with `hitem3dv2.0` on hover).
2. **Fresh upload pre-fills source.** First time using Step 2 after deploy: the front image's Source dropdown is empty (no localStorage yet). Pick "Midjourney", upload another front image (new project) — the dropdown defaults to Midjourney.
3. **AI gen auto-stamps.** Click AI Generate on the back card. Once the image returns, the back card's Source dropdown shows "Other… openai_gpt-image-1.5" (because that value isn't a known dropdown option). Verify by changing it to "OpenAI" and reloading the project — it now shows OpenAI. (This is a UX edge — we can decide later whether `openai_gpt-image-1.5` should display as "OpenAI" automatically.)
4. **Variants inherit image sources.** Make a variant of a project that has sources set on its views. The variant opens with the same dropdown values pre-selected.
5. **Variants don't inherit generator.** Same variant: status label says "Draft" (no generator yet), not "Model · HiTem3D". After generating, it shows the appropriate generator.
6. **PATCH on dropdown change.** Change a source value, refresh the page, reopen the project — value persisted.
7. **Save status indicator.** Change a source — small "Saved" appears next to the field, fades or stays subtle. Block network and try again — "Save failed" shows.
8. **Other field flow.** Pick "Other…" from the dropdown, type "stable diffusion", blur — saved. Reload, the field shows the typed value in the Other input with the dropdown set to "Other…".

---

## 8. Open questions / minor

- **Display of `openai_gpt-image-1.5` in the dropdown.** Test step 3 above flags this. Two options: (a) leave as-is, "Other…" with the full string; (b) extend the display-mapping so any value starting with `openai_` shows as "OpenAI" in the dropdown but the precise model is preserved in the DB. Prefer (b) — cleaner UX, no data loss. Will implement (b) unless John says otherwise.
- **Source dropdown layout.** Adding it to each card may push the card height up. If it feels cramped, we could put it in a hover-only popover or a single "Sources" disclosure below the gallery. Will eyeball after first deploy.

---

## 9. Deferred work

- **Option (b): simultaneous models per project.** Schema split (`hitem3d_model_file`, `meshy_model_file`) or new `project_models` table; Step 3 viewer switcher. Useful for side-by-side compare but bigger change. Revisit after Meshy ships.
- **Filter history by source/generator.** Once there are more projects, filter buttons "All / Midjourney / OpenAI / HiTem3D / Meshy" would help. Not needed yet.
- **Cost / credit display.** Already tracked separately in [costs.md](costs.md).
