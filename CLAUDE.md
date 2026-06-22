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
- Cron fires hourly. Idempotency is a **two-label** invariant on the downstream PR: `auto-sync` + `source:<slug>` (prevents duplicate PR creation) and `summary-sent` (prevents re-summarize / re-notify). `listSyncedPrs` filters out PRs with `summary-sent`; `notify` adds it after the first successful channel. Never remove the filtering or marking without replacing the idempotency mechanism.
- **One card per source, always.** `summarize` writes `summary-sections.json` (per-source records); `notify` iterates and sends one IM card per source. Each source's `summary-sent` label is set independently based on its own card's delivery. Never concatenate multiple sources into a single card — it breaks the attribution contract and the per-source idempotency.
- `gh pr list` silently overrides repeated `--state` and `--label` flags (second wins). Always use `--state all` + client-side filter, and comma-separated labels inside one `--label` arg.
- Feishu webhook always returns HTTP 200 even for logical failures (`code=19021/19022/19024/11232`). Always parse the response body and throw on non-zero `code`.
- AI HOT (`aihot.virxact.com`) public API: every request **must** set a custom `User-Agent` (default Node/curl UAs hit nginx blacklist → 403). `/api/public/items` time window is 7 days only — older content lives in `/api/public/dailies` (≤ 180 days). Pagination `cursor` is opaque — never parse, never increment, never reuse across endpoints. Rate limit 600 req/min per IP. `/api/public/daily/{date}` returns 404 (not 200 with empty body) when the day's report hasn't been generated yet — `aihot` fetcher treats that as `null` and skips.
- "Pre-baked notify body" path: when a subscription sets `output.notify.summary: false` AND the synced markdown's frontmatter has `notify_body`, summarize emits an IM card section using that field verbatim (no LLM). If `notify_body` is absent, the source is silently skipped (back-compat). See `src/summarize-section.ts` and `contributing/add-fetcher.md`.
- 橘鸦 AI 早报 feed lives at `https://daily.juya.uk/rss.xml` (the old `imjuya.github.io/juya-ai-daily` GitHub Pages site is gone — 404). The feed retains only ~4 recent days, so a missed day older than that is unrecoverable. Each issue inlines ~2.8k escaped HTML entities, which trips `fast-xml-parser`'s default `maxTotalExpansions: 1000` ("billion laughs" guard) — `src/fetchers/rss.ts` raises that cap. No DOCTYPE means expansion is linear/harmless; don't lower it back.
- `OSMOSIS_DATE=YYYY-MM-DD` pins "today" in `todayParts()` for backfilling a day the hourly cron missed (e.g. `OSMOSIS_DATE=2026-06-19 pnpm fetch ...`). `listSyncedPrs` filters PRs by `title.includes(date)` against the cron's current date, so a backfilled PR dated in the past is never picked up by notify — backfill lands in the vault only, no IM re-send.
