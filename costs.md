# OpenAI Cost / Usage Display — Plan

> Resumable plan. Read this first when picking up the cost-display feature.
> No code has been written yet. Driven by 2026-05-07 incident where John's
> OpenAI hard-limit blocked a front-edit and the app gave no warning.

## Goal

Show current month-to-date OpenAI spend somewhere in the UI so the user can monitor burn rate against their billing cap, and not be surprised by a "hard limit reached" error mid-flow.

## Research findings (2026-05-08)

### What does NOT exist
- No supported "current balance" or "remaining credits" endpoint. Long-standing user request, OpenAI has not delivered it.
- No way to query the configured Hard Limit value programmatically. The cap has to be a value the user enters somewhere on our side.

### What DOES exist (and is supported)
- **Costs API** — `GET https://api.openai.com/v1/organization/costs`
  - Returns dollars spent in time buckets (currently `1d` granularity only)
  - Required param: `start_time` (Unix seconds)
  - Optional: `bucket_width`, `limit`, `group_by`
  - Reconciles to your invoice — this is the authoritative number
- **Usage API** — `GET /v1/organization/usage/{completions, images, audio, embeddings, …}`
  - Token / request counts, not dollars. Less useful for our purpose. Skip.

### Auth — important
- Both APIs require an **Admin API key** (`sk-admin-…`), separate from your regular API key
- Created at https://platform.openai.com/settings/organization/admin-keys
- Admin keys have more privileges than regular keys — **keep server-side only, never send to the browser**

### What to skip
- `/v1/dashboard/billing/credit_grants` and `/v1/dashboard/billing/subscription` — legacy, never officially supported as a public API, bearer auth has been flaky. Multiple forum threads from frustrated devs. Don't bother.
- HiTem3D usage tracking — no public balance/usage API I'm aware of as of 2026-05-08; would need separate research before implementing.

## What we need from John before code is written

**REQUIRED — please action before next session:**

1. **Create an OpenAI Admin API key**
   - https://platform.openai.com/settings/organization/admin-keys
   - Click "Create new admin key", give it a name like `3d-model-creator-cost-tracking`
   - Copy the value (starts with `sk-admin-…`)
   - Store it somewhere safe; we'll add it to Railway env vars + local `.env` together
   - **Don't paste it in chat** — just confirm it's been created

**DECISIONS to make next session — recommendations included:**

2. **Display location** — where in the UI does the cost chip live?
   - (a) Small chip in the header, next to the step indicator dots — *always visible*
   - (b) Inside the collapsible Settings panel on Step 2 — *visible when relevant*
   - (c) Footer of the page — *least intrusive*
   
   **Recommendation: (a)** — header chip, always visible, colour-shifts when nearing cap. Most useful right when about to spend more.

3. **Cap source** — where does the monthly cap value come from?
   - (a) An env var: `OPENAI_MONTHLY_CAP=10.00` — simplest, your-eyes-only
   - (b) A field in a per-user settings UI — better fit but requires Stage 2 (auth + per-user data)
   - (c) Just show raw spend, no cap reference — minimal scope
   
   **Recommendation: (a)** for now. Revisit during Stage 2 BYO keys, when each user might supply both an admin key and a cap.

4. **Refresh cadence** — when do we hit the Costs API?
   - (a) Once on page load — cheap, can go stale
   - (b) On page load + after every successful generate-view / generate-model — fresh at the moments that move the needle
   - (c) Periodic poll every N minutes — predictable load
   
   **Recommendation: (b)** + a 60-second server-side cache so rapid-fire calls don't slam OpenAI. Combine: frontend asks freely, backend coalesces.

5. **Scope** — what does "spent this month" cover?
   - (a) All OpenAI usage across the entire account
   - (b) Filtered to a specific OpenAI project_id (more precise, more setup)
   
   **Recommendation: (a)** — only one project on the account, simpler, same number for now.

## Implementation plan (no code yet)

### Schema
None. This feature has no DB persistence.

### Env vars (new)
| Var | Where | Purpose |
|---|---|---|
| `OPENAI_ADMIN_KEY` | Railway + local `.env` | Auth for Costs API. NEVER expose to browser. |
| `OPENAI_MONTHLY_CAP` | Railway (optional locally) | Number, e.g. `10.00`. If unset, UI shows raw spend without "X of Y" framing. |

`OPENAI_API_KEY` stays as-is for image generation; admin key is a separate value.

### Backend
A small new module `openai-costs.js`, plus one new Express route. Sketch:

- **`fetchMonthSpend()` function**
  - Compute `start_time` = first day of current month UTC, in Unix seconds
  - `GET /v1/organization/costs?start_time=…&limit=31` with `Authorization: Bearer ${ADMIN_KEY}`
  - Sum the dollar amounts across returned buckets
  - Returns `{ spent: 3.42, since: ISOString, asOf: ISOString }`
  - Handle 401 (bad/missing admin key — log a one-line warning, return null), 429 (rate-limited — return last cached value)
- **`GET /api/usage/openai-month` route**
  - Wraps `fetchMonthSpend()`
  - 60-second in-memory cache so the frontend can call freely
  - Response shape: `{ spent: 3.42, cap: 10.00 | null, currency: "USD", asOf: "2026-05-08T13:42:11Z" }`
  - If `OPENAI_ADMIN_KEY` not configured → 503 with `{ error: "cost tracking not configured" }`. Frontend hides the chip silently.

### Frontend
- A small `<div class="cost-chip">` in the header (assuming recommendation 2a is picked)
- Initial fetch on page load
- Re-fetch after `generateSingleView` and after `pollUntilModelDone` resolves (the moments money was spent)
- Display:
  - With cap: `$3.42 / $10.00` with colour green/yellow/red based on % used
  - Without cap: `$3.42 this month`
- Click chip → opens https://platform.openai.com/account/billing in new tab
- If `/api/usage/openai-month` returns 503 → chip stays hidden, no error in UI

### Build order (when we resume)
1. John confirms admin key created. Add `OPENAI_ADMIN_KEY` and (optionally) `OPENAI_MONTHLY_CAP` to Railway and local `.env`.
2. Backend: `openai-costs.js` + `/api/usage/openai-month` route + 60s cache.
3. Smoke-test backend with `curl` against local server.
4. Frontend: chip element + CSS + fetch on load + re-fetch after generation events.
5. Deploy + manual end-to-end on Railway. Confirm chip appears and updates.

### Out of scope (explicitly)
- HiTem3D usage / balance display — needs separate research on whether they expose any API
- Per-user admin keys — defer to Stage 2 BYO keys (see HISTORY-PLAN.md items #10–11)
- Cost projection / forecasting based on past 30 days
- Per-feature breakdown (e.g. how much was image-edits vs other)
- Webhook / email alert when nearing cap
- Estimating cost of an upcoming generation before running it

## Sources verified 2026-05-08

- [How to use the Usage API and Cost API to monitor your OpenAI usage — OpenAI Cookbook](https://cookbook.openai.com/examples/completions_usage_api)
- [Usage / Costs object — OpenAI API Reference](https://platform.openai.com/docs/api-reference/usage/costs_object)
- [Introducing the Usage API — OpenAI Developer Community](https://community.openai.com/t/introducing-the-usage-api-track-api-usage-and-costs-programmatically/1043058)
- [Add API endpoint to check remaining credits or balance — Feedback thread (still unresolved)](https://community.openai.com/t/add-api-endpoint-to-check-remaining-credits-or-balance-on-openai-account/1365221)

## Progress log

- **2026-05-08** — Plan written, research summarised, decisions queued. No code yet. John to create admin key before next session.
