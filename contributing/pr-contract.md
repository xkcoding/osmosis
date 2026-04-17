# PR Contract — What Downstream Vaults See

This is the handshake between osmosis (the producer) and the downstream repo that receives sync PRs (currently `xkcoding/second-brain`). If you are building SessionStart hooks, review commands, or CI rules in the downstream repo, read this first — it is the only stable surface osmosis promises.

## Who Opens the PR

- **Producer**: `osmosis/.github/workflows/daily-sync.yml`, job `sync`, step `Create PR` (uses `peter-evans/create-pull-request@v7`).
- **Author identity**: the PAT stored in the downstream repo's `TARGET_REPO_PAT` secret (commits appear under that account).
- **Target branch**: `main` (merge direction: `auto-sync/<slug>-<date>` → `main`).
- **Cadence**: hourly cron; PRs are created only when the upstream source actually has new content and all quality gates pass.

## Branch Naming

```
auto-sync/<slug>-<YYYY-MM-DD>
```

- `<slug>` is the subscription yaml filename without extension (e.g. `builderpulse`).
- `<YYYY-MM-DD>` is the date in `Asia/Shanghai` (`OSMOSIS_TZ` overridable).
- One branch per source per day. Re-runs reuse the branch; peter-evans treats a second call as a no-op.

## Title, Body, Files

- **Title**: `📡 <slug> <date>` — the date appears verbatim in the title so clients can filter without relying on GitHub search indexing.
- **Body**: lists the subscription name, date, target path, and source URL (markdown).
- **File changes**: exactly one Markdown file written to the path configured by the subscription's `output.obsidian.path` (e.g. `00_Inbox/Clippings/<date> - BuilderPulse Daily.md`). Content includes a YAML frontmatter block written by the formatter and the upstream body.

## Label Contract

| Label | Who sets it | When | Expected downstream behavior |
|---|---|---|---|
| `auto-sync` | osmosis `sync` job at PR creation | Every auto-PR | Reliable filter for "produced by osmosis". Do not remove. |
| `source:<slug>` | osmosis `sync` job at PR creation | Every auto-PR | Machine-readable attribution. Do not remove. |
| `needs-review` | osmosis `sync` job at PR creation | Every auto-PR | **Human action flag.** Remove after the human reviews the PR. |
| `summary-sent` | osmosis `notify` job after at least one IM channel delivered | After the day's digest is pushed once | **Idempotency marker — do not remove by hand.** Removing it causes the next cron tick to re-summarize and re-push the PR. Only remove if you explicitly want a re-send (e.g., tweaking the prompt). |

If the downstream repo introduces its own labels (`reviewed`, `archived`, `promoted`, etc.), prefix them so they don't collide with osmosis labels. osmosis does not read any label outside the four above.

## Idempotency Guarantees

- **Dedup**: before creating a PR, osmosis queries `gh pr list --label auto-sync,source:<slug>` and matches the date substring in titles. An existing open/merged PR for the same source-date triggers a no-op — **you can safely merge, close, or edit the PR** without triggering duplicates.
- **Once-per-PR notify**: the `summary-sent` label guarantees the daily digest is pushed to IM channels at most once per PR. Closed or merged PRs stay labeled and stay excluded.

## Safe Downstream Operations

- ✅ Merge the PR (`gh pr merge --squash`).
- ✅ Edit the file before merge (e.g., add personal tags in frontmatter, append notes).
- ✅ Close the PR (osmosis will not re-create for the same source-date).
- ✅ Remove `needs-review` after you've reviewed.
- ✅ Add your own labels (`promoted`, `kept`, etc.).

## Unsafe Operations

- ❌ Remove `auto-sync` or `source:<slug>` — breaks dedup and downstream filtering.
- ❌ Remove `summary-sent` casually — causes duplicate IM notifications.
- ❌ Rename the branch — the next cron run will create a second branch for the same date.
- ❌ Modify the upstream markdown file's generated frontmatter field `source` — downstream tooling may depend on it for provenance.

## Query Recipes

From the downstream repo (human or Claude Code hook), these are the only calls you need:

```bash
# Number of PRs awaiting human review
gh pr list --label auto-sync,needs-review --state open --json number --jq length

# List awaiting-review PRs with key fields
gh pr list \
  --label auto-sync,needs-review \
  --state open \
  --json number,title,url,labels,files,createdAt

# Per-source breakdown of today's inbound
gh pr list \
  --label auto-sync \
  --state all \
  --search "created:$(TZ=Asia/Shanghai date +%Y-%m-%d)" \
  --json number,title,labels

# Mark a PR as reviewed (the conventional downstream action)
gh pr edit <n> --remove-label needs-review
```

Note: the recipes above use `--search created:<date>` safely because by the time a downstream session opens, GitHub's search index has caught up. osmosis internals avoid `--search` only because `notify` runs seconds after `sync` within the same workflow.

## Versioning

This contract is stable; breaking changes (new required label, renamed label, changed branch pattern, new required body field) will be announced in a dedicated openspec change under `osmosis/openspec/changes/`.
