# PR Content Quality Gates

osmosis publishes auto-PRs to a downstream Obsidian vault. A bad PR (empty file, HTML error page, stub placeholder, single line of "Coming soon") pollutes the knowledge base and trains its readers to ignore future PRs. The pipeline enforces multiple gates so that a PR only gets opened when content is actually worth reviewing.

## Gate Stack

```
upstream source
   │
   ▼
[fetcher]                returns null when 404 / no item today  ──→ no PR (silent OK)
   │
   ▼
[content quality check]  src/quality.ts                         ──→ on failure: workflow red OR silent skip
   │
   ▼
[dedup check]            src/dedup.ts via gh pr list             ──→ on existing PR: silent OK
   │
   ▼
[format + write]
   │
   ▼
[peter-evans/create-pull-request]                                ──→ PR opened only if all gates passed
```

## Gate 1: Fetcher returns `null`

The fetcher returns `null` when the upstream simply has nothing for today (path 404, empty feed, latest release older than today). The CLI logs `no content` and the workflow step ends successfully with `has_new_content=false` — no PR. This is the normal "no news today" path and must remain silent.

Anti-pattern: don't synthesize a placeholder when upstream is empty. Return `null`.

## Gate 2: Content quality check (`src/quality.ts`)

Runs on the raw markdown before formatter wrapping. Each rule is independent; all failures are reported together so you can fix in one pass.

| Rule | Default | Fails when |
|------|---------|------------|
| `non-empty` | always on | body (after stripping frontmatter) is empty or whitespace |
| `min-body-chars` | 200 | body length below threshold |
| `min-body-lines` | 5 | non-empty line count below threshold |
| `forbid-pattern` | `<!doctype`, `<html`, `coming soon`, `todo: write`, `占位`, `placeholder content` | body contains any forbidden substring (case-insensitive) |
| `markdown-signal` | required | no heading, list, link, image, blockquote, code fence, or bold span detected |

### Per-subscription overrides

```yaml
# subscriptions/<slug>.yml
quality:
  minBodyChars: 80
  minBodyLines: 2
  requireMarkdownSignal: false
  forbidPatterns: [draft, "[wip]"]   # appended to defaults
  onFail: error                       # 'error' (default) | 'skip'
```

- `onFail: error` — fetch CLI exits non-zero, sync job goes red, no PR. **Use this by default** — bad content is a regression you want to know about.
- `onFail: skip` — log issues, treat as "no content today", no PR. Use only for sources where occasional malformed days are expected.

### Why this matters

- Catches **upstream regression**: source published a stub or template error.
- Catches **fetcher bug**: wrong path returning HTML 404, encoding garbled, content sliced empty.
- Catches **template drift**: path template hit a date with no real content.

The cost of a false positive (one missed PR for a noisy source) is much lower than the cost of a false negative (a poisoned vault PR that someone merges).

## Gate 3: PR-level dedup (`src/dedup.ts`)

Before writing the file, the CLI calls `gh pr list` filtered by:

- `--label auto-sync`
- `--label source:<name>`
- `--search <date>` (date in title)
- state: open + merged

If any match, fetch returns "already synced" and the workflow skips PR creation. This survives workflow re-runs, manual `workflow_dispatch` triggers within the same hour, and accidental double-cron firing.

Limitation: dedup is by date + label, not by content hash. A source that changes its content within the same day will not produce a second PR. If this becomes a problem, add a content-hash check as a follow-up (record the hash in the PR body, query before opening a new one).

## Gate 4: Workflow-level guard

Inside `.github/workflows/daily-sync.yml`:

- The `Create PR` step is guarded by `if: steps.fetch.outputs.has_new_content == 'true'`. If the fetch step decided "nothing to ship" (any reason — null, dedup, quality skip), the PR step doesn't run at all.
- `peter-evans/create-pull-request@v7` itself is a no-op when the working tree has no changes — a final belt-and-suspenders.

## When a Gate Fails

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| Sync job red, error mentions `Quality check failed` | Upstream changed, or fetcher emitted bad content. The error includes a 500-char preview. | Inspect preview. If upstream is genuinely broken, add a `forbidPatterns` entry or set `onFail: skip` for that source. If the fetcher mis-parsed, fix the fetcher and add a regression test. |
| No PR but no failure | Either no content today (normal), already synced (idempotent rerun), or `onFail: skip` quality fail. Check the sync job log — every branch logs a one-line reason. | If you expected a PR, search the log for `[fetch] <slug> <date>:` to find which branch fired. |
| Duplicate PRs for the same date | `auto-sync` or `source:<name>` label missing on the prior PR (manual edit?), or PR is in a state other than open/merged (closed without merge). | Re-add the labels, or merge-then-revert the stale PR so dedup sees it. |

## Adding a New Quality Rule

Quality rules live in `src/quality.ts`. Add a new check inside `checkContentQuality` and a corresponding test in `src/quality.test.ts`. Keep rules:

- **Pure** (string in, issues out — no I/O).
- **Cheap** (runs on every fetch).
- **Specific** (one bad-state class per rule, named clearly).

Default-on rules should err toward conservative — better to fail one PR and tune the rule than let bad content land.
