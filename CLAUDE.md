# CLAUDE.md

Orientation for Claude / other AI agents working in this repo. Humans should read [`README.md`](README.md) and [`contributing/`](contributing/) instead.

## What this repo is

A GitHub-Actions–driven content aggregator. Hourly cron fetches each configured source, opens an independent PR to a downstream Obsidian vault, then ships an LLM-summarized digest to IM channels. **No long-running server, no database** — only TypeScript + workflows + yaml configs.

Detailed design: [`openspec/changes/initial-setup/`](openspec/changes/initial-setup/).

## Where things live

| You want to … | Touch |
|---|---|
| Add a new source | `subscriptions/<slug>.yml` (+ optional new fetcher under `src/fetchers/`) — see [`contributing/add-fetcher.md`](contributing/add-fetcher.md) |
| Add a new IM channel | `src/notifiers/<channel>.ts` + register + workflow env — see [`contributing/add-notifier.md`](contributing/add-notifier.md) |
| Tighten content validation | `src/quality.ts` + tests — see [`contributing/quality-gates.md`](contributing/quality-gates.md) |
| Rehost a source's images to your OSS/CDN | `images:` block in `subscriptions/<slug>.yml` + OSS env — see [`contributing/image-rehost.md`](contributing/image-rehost.md) |
| Edit summarization prompt | `prompts/summary.md` (hot-reloadable, no code change) |
| Change schedule, jobs, secrets | `.github/workflows/daily-sync.yml` — see [`contributing/workflow.md`](contributing/workflow.md) |
| Understand the layering | [`contributing/architecture.md`](contributing/architecture.md) |

## Non-negotiable invariants

1. **Plugin architecture stays plugin.** A new source = 1 yaml + (maybe) 1 fetcher file. Never special-case a source name in `src/index.ts` or `src/config.ts`.
2. **Quality gate is mandatory.** `src/quality.ts` runs between fetcher and write. Don't bypass it. If a source legitimately needs different thresholds, override in the subscription yaml's `quality:` block — don't disable the gate globally. Rationale and rule list in [`contributing/quality-gates.md`](contributing/quality-gates.md).
3. **Fetchers return `null` for "no content today".** Never synthesize a placeholder.
4. **Time zone via `OSMOSIS_TZ` (default `Asia/Shanghai`).** All "today" math goes through `todayParts()` in `src/template.ts`. Do not call `new Date().toISOString()` for date logic.
5. **Workflow injection hygiene.** In `.github/workflows/*.yml`, do not put `${{ ... }}` interpolations directly inside `run:` commands — move to `env:` and reference as `"$VAR"`. The pre-tool security hook will block writes that violate this.
6. **`pnpm check` must pass before any PR.** That runs typecheck + lint + test. CI (`.github/workflows/ci.yml`) enforces the same trio.
7. **No `console.log` of secrets.** Notifiers may log channel name + status, never webhook URL or response body verbatim.
8. **Native ESM.** `.js` extensions in import paths are required (e.g. `import { foo } from './foo.js'`). TypeScript compiles them as-is.

## Commands you'll actually run

```bash
pnpm install
pnpm check                                                # typecheck + lint + test — run before PR
pnpm test:watch                                           # while editing
GITHUB_TOKEN=ghp_xxx TARGET_REPO=xkcoding/second-brain \
  pnpm fetch --subscription builderpulse --output-dir /tmp/vault   # smoke a fetcher locally
gh workflow run daily-sync.yml                            # manually trigger the live pipeline
```

## Don't

- Don't add a database, queue, or persistent state. The dedup model is "ask GitHub". Keep it that way.
- Don't import across plugins (`src/fetchers/a.ts` must not import from `src/fetchers/b.ts`).
- Don't add barrel `index.ts` re-exports — import from source files directly.
- Don't introduce a new dependency without asking the maintainer; we keep the runtime footprint small.
- Don't loosen the quality gate to make a failing run pass. Fix the source/fetcher, or set `onFail: skip` for that one subscription with a comment explaining why.
- Don't commit a PR that lowers test coverage on `src/quality.ts`, `src/template.ts`, `src/formatter.ts`, or `src/notifiers/format.ts` without replacement coverage.

## Memory-style notes for the next agent

- The `peter-evans/create-pull-request` action is a no-op when the working tree has no changes — that's a deliberate belt-and-suspenders, not a bug to "fix".
- LLM access runs via `MINIMAX_API_KEY` against `https://api.minimaxi.com/v1` (default model `MiniMax-M2.7-highspeed`). Override the provider with `LLM_BASE_URL` + `LLM_API_KEY`.
- Cron fires hourly at minute 17 — deliberately off `:00`, where GitHub delays and under load drops schedule events; don't move it back. Idempotency is a **two-label** invariant on the downstream PR: `auto-sync` + `source:<slug>` (prevents duplicate PR creation) and `summary-sent` (prevents re-summarize / re-notify). `listSyncedPrs` filters out PRs with `summary-sent`; `notify` adds it after the first successful channel. Never remove the filtering or marking without replacing the idempotency mechanism.
- **One card per source, always.** `summarize` writes `summary-sections.json` (per-source records); `notify` iterates and sends one IM card per source. Each source's `summary-sent` label is set independently based on its own card's delivery. Never concatenate multiple sources into a single card — it breaks the attribution contract and the per-source idempotency.
- `gh pr list` silently overrides repeated `--state` and `--label` flags (second wins). Always use `--state all` + client-side filter, and comma-separated labels inside one `--label` arg.
- Feishu webhook always returns HTTP 200 even for logical failures (`code=19021/19022/19024/11232`). Always parse the response body and throw on non-zero `code`.
- AI HOT API is `https://aihot.news/api/v1` (OpenAPI: `https://aihot.news/openapi-v1.json`). The old host `aihot.virxact.com` and `/api/public/*` stop serving on 2026-10-31 (sunset notice 2026-07-25) — from then the old host only 301s to the same (dead) path, so never reintroduce either. Every request **must** set a custom `User-Agent` (default Node/curl UAs get 403). Errors are `application/problem+json`; only two statuses are business signals: `GET /dailies/{date}` **404** = that day's report isn't generated yet (fetcher returns `null`), and `selected/changes` **409** `snapshot_required` = cursor no longer resumable. `{date}` is the **Asia/Shanghai** calendar date; the report is generated once at UTC midnight covering the previous UTC day and does not grow. `/items` takes `mode`/`window=24h|7d`/`by`/`limit≤100`/`cursor` — **not** `since`/`take` (400 on unknown params); its `page.nextCursor` is query-bound and rejected (`invalid_cursor`) once its anchor slides out of the window. Rate limit: on 429 back off 1–2 s and retry once. Responses may carry a top-level `notice` (sunset/upgrade banner) — ignore it. Item links are `links.aihot` (`https://aihot.news/items/{id}`) + `links.original`; source name is `source.name`.
- aihot selected items come from the **`selected/changes` ledger**, not a time window: the cursor is stored in the synced markdown's frontmatter `sync_state.cursor` (generic `FetchResult.syncState` → `formatter.ts`; read back via `FetchContext.getLastSyncState()` from the newest synced PR by title date). Each run reads changes since that cursor (upsert = candidate, later `remove` in the same batch drops it, `selected:false` skipped) and writes the cursor of the **last fully-applied page** — page cap (5×100) hit → resume next day, no loss, no notice; transient error → keep the old/last-applied cursor (selected section may be empty that day, it catches up). No usable cursor (first run, PR without `sync_state`, state read failure, 409) → fallback: **first** `selected/snapshot?limit=1` for a fresh cursor, **then** `/items?mode=selected&window=7d&by=timeline` paged (id-dedup, no-new-ids stop, page cap with a *visible* truncation notice); the order matters — reversed, items selected between the two calls would be lost. Snapshot failure → render the window but write no `sync_state` (fallback again next run). A pushed-set dedup still runs on both paths (upserts include edits of already-selected items; fallback→ledger overlap; daily/selected overlap): keys are the item **id** (extracted from `/items/{id}` on **either** `aihot.news` or `aihot.virxact.com`, so pre-migration history still matches) and the original url, harvested from the latest synced PR markdowns — 3 on the ledger path, **8** on the 7d fallback (must cover the whole window, or the first post-migration run re-pushes 4–7-day-old items); read failure degrades to an empty set. Failure bias is always "duplicate beats loss". Design: `openspec/changes/migrate-aihot-v1-ledger/design.md` (archived under `openspec/changes/archive/` once done).
- `FetchContext` (`src/fetchers/types.ts`) is the generic channel for GitHub-derived state into fetchers: lazy `getLastSyncState()` + lazy `getRecentSyncedContents(n)`. It is only populated when `TARGET_REPO` is set — local smoke runs pass `undefined`, so fetchers must work without it. It exists so fetchers never shell out to `gh` themselves; keep it that way. Cross-run state goes out via `FetchResult.syncState` (→ frontmatter `sync_state`), never via a database or cache.
- "Pre-baked notify body" path: when a subscription sets `output.notify.summary: false` AND the synced markdown's frontmatter has `notify_body`, summarize emits an IM card section using that field verbatim (no LLM). If `notify_body` is absent, the source is silently skipped (back-compat). See `src/summarize-section.ts` and `contributing/add-fetcher.md`.
- 橘鸦 AI 早报 feed lives at `https://daily.juya.uk/rss.xml` (the old `imjuya.github.io/juya-ai-daily` GitHub Pages site is gone — 404). The feed retains only ~4 recent days, so a missed day older than that is unrecoverable. Each issue inlines ~2.8k escaped HTML entities, which trips `fast-xml-parser`'s default `maxTotalExpansions: 1000` ("billion laughs" guard) — `src/fetchers/rss.ts` raises that cap. No DOCTYPE means expansion is linear/harmless; don't lower it back.
- Image rehosting (`subscriptions/<slug>.yml` `images.rehost: true`): at fetch time, after the quality gate and before write, `rehostMarkdownImages` downloads each `![](url)`/`<img src>`, compresses with **sharp** (default WebP q80, `maxWidth` optional; GIFs are flattened to their **first frame** — the target CDN's OSS style rejects animated WebP and flattens animation anyway, so static keeps the URL from 400-ing), uploads to OSS via **ali-oss**, and rewrites URLs. OSS creds/bucket/CDN come from `OSS_*` env (never yaml); rehost is a no-op when `ossClientFromEnv()` returns null. Keys are organised under a fixed namespace by source+date (`<OSS_KEY_PREFIX default osmosis>/<slug>/<date>/<sha256[:16]>.<ext>`), content-addressed filename → dedups within a day, `HEAD`-skips re-upload (cross-day dups stored twice, by design). `OSS_PROCESS_STYLE` appends `?x-oss-process=style/<name>` to stored URLs — that's a CDN delivery-style convention (tag/watermark), **not** the compression step. A single image failing keeps its original URL. The CDN host is auto-added to `skipHosts` so re-runs don't re-process already-rehosted links. See `contributing/image-rehost.md`.
- `OSMOSIS_DATE=YYYY-MM-DD` pins "today" in `todayParts()` for backfilling a day the hourly cron missed (e.g. `OSMOSIS_DATE=2026-06-19 pnpm fetch ...`). `listSyncedPrs` filters PRs by `title.includes(date)` against the cron's current date, so a backfilled PR dated in the past is never picked up by notify — backfill lands in the vault only, no IM re-send. Backfilled PRs are *created* last but carry an *older* title date, so "latest synced PR" is always ordered by the title date (`newestSyncedFirst` in `src/pr-listing.ts`, used by `fetchRecentSyncedContents` and therefore `fetchLastSyncState`) — never raw `createdAt`, or a backfill would hide the real latest day's `sync_state` cursor and push it out of the pushed-set. Under `OSMOSIS_DATE` aihot renders the pinned day's daily only (`isDatePinned()` in `src/template.ts`) and writes no `sync_state`: the ledger cursor is a "now" watermark and selected items can't be rebuilt for a past day; the gap's selected items land in the first live run after recovery (the ledger resumes from the last live cursor). There is no workflow input for backfill — run it locally (`set -a; . ./.env.local; set +a` for `OSS_*` so images still get rehosted) and open the PR by hand with labels `auto-sync,source:<slug>,needs-review`.
- This repo is **public**, so GitHub auto-disables `daily-sync.yml`'s `schedule` after **60 days without repository activity** (`gh workflow list --all` → `disabled_inactivity`; happened 2026-09-10, 69 days after the last push). The in-workflow `alert` job cannot fire when the workflow doesn't run, so this failure is silent. Recover with `gh workflow enable daily-sync.yml && gh workflow run daily-sync.yml`, then backfill the gap as above.
