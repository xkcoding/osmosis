# Architecture

## Layer Model

```
L0  src/index.ts            CLI orchestrator (fetch / summarize / notify / matrix / list)
L1  src/{config,template,
        dedup,quality,
        formatter,
        summarizer,
        pr-listing}.ts      Shared utilities — owned by no plugin
L2  src/fetchers/<type>.ts  Source plugins  (interface in fetchers/types.ts)
L2  src/notifiers/<chan>.ts Channel plugins (interface in notifiers/types.ts)
L3  subscriptions/<slug>.yml  Per-source declarative config
L3  prompts/summary.md       LLM prompt template
```

**Design goal**: a new source = 1 yaml + (optional) 1 fetcher file. A new channel = 1 notifier file. The CLI never special-cases any source or channel.

## Dependency Rules

```
L3 (yaml/prompt) ──→ L0 ──→ L1
                     L0 ──→ L2 ──→ L1
                     L2 ─/─→ L0   (forbidden)
                     L2 ─/─→ L2   (forbidden — fetchers don't know about other fetchers)
```

- `src/index.ts` is the only file that imports from both `fetchers/registry` and `notifiers/registry`.
- Plugin files (`fetchers/<type>.ts`, `notifiers/<chan>.ts`) only import from L1 utilities and their own `types.ts`.
- L1 utilities are pure-ish (they may touch network/fs but never import from L2 or L0).

## File Map

| Concern | File |
|---------|------|
| CLI subcommand dispatch | `src/index.ts` |
| Subscription yaml parsing | `src/config.ts` |
| `{date}/{year}/{month}/{day}` template + TZ-aware today | `src/template.ts` |
| GitHub PR existence dedup (`gh pr list`) | `src/dedup.ts` |
| Content-quality validator (gate before write) | `src/quality.ts` |
| Obsidian frontmatter wrapping | `src/formatter.ts` |
| LLM call (Vercel AI SDK + GitHub Models) | `src/summarizer.ts` |
| Listing today's auto-sync PRs + fetching their files | `src/pr-listing.ts` |
| Fetcher interface | `src/fetchers/types.ts` |
| Fetcher registry | `src/fetchers/registry.ts` |
| `github-file` fetcher | `src/fetchers/github-file.ts` |
| Notifier interface | `src/notifiers/types.ts` |
| Notifier registry | `src/notifiers/registry.ts` |
| Notification message builder (plain text body) | `src/notifiers/format.ts` |
| WeCom / Feishu webhook clients | `src/notifiers/{wecom,feishu}.ts` |

## CLI Surface

| Command | Used by | Purpose |
|---------|---------|---------|
| `fetch --subscription <slug> --output-dir <path>` | `sync` job | resolve config → fetch → quality gate → format → write |
| `matrix` | `prepare` job | print matrix JSON for `strategy.matrix` |
| `list` | `prepare` job | print one slug per line |
| `summarize --target-repo <r> [--date <d>] [--output <f>]` | `notify` job | gather today's PRs → LLM → write summary file |
| `notify --target-repo <r> --summary-file <f> [--date <d>]` | `notify` job | broadcast summary to all channels with subscribers today |

All commands surface step outputs via `$GITHUB_OUTPUT` (e.g. `has_new_content`, `has_summary`, `pr_count`) so the workflow can branch without re-querying.

## Conventions

- **No barrel re-exports** — import from the source file directly (`./fetchers/github-file.js`, not `./fetchers/index.js`).
- **`.js` extensions in imports** — required for native ESM under Node 20.
- **One plugin file per type** — never put two fetchers in the same file.
- **Plugin registration** — fetchers and notifiers self-register in their `registry.ts`. Adding a new one means: write the file, then add one `register(...)` line.
- **Dependency injection via env** — `GITHUB_TOKEN`, `TARGET_REPO`, `WECOM_WEBHOOK_URL`, `FEISHU_WEBHOOK_URL`, `SUMMARY_MODEL`, `OSMOSIS_TZ`. The code does not read these in plugin files except where needed (e.g. notifiers reading their own webhook env).
- **Time zone** — `OSMOSIS_TZ` (default `Asia/Shanghai`) is the single source of truth for "today". Never call `new Date().toISOString()` for date math; use `todayParts()`.
