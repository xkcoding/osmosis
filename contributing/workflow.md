# Workflow Reference

osmosis ships two GitHub Actions workflows.

## `.github/workflows/ci.yml` — PR gate

Runs on every PR and on `push: main`:

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test`

If any step fails, the PR cannot merge (assuming branch protection requires CI). `pnpm check` runs the same trio locally — use it before pushing.

## `.github/workflows/daily-sync.yml` — operational pipeline

Three jobs, hourly cron + manual `workflow_dispatch`:

```
prepare ──► sync (matrix per subscription, fail-fast: false) ──► notify
```

### `prepare`

- Scans `subscriptions/*.yml`
- Outputs `matrix` (JSON for `strategy.matrix`) and `count`

### `sync` — runs once per subscription, in parallel

For each subscription:

1. Checkout osmosis (this repo)
2. Checkout `xkcoding/second-brain` using `TARGET_REPO_PAT`
3. `pnpm tsx src/index.ts fetch --subscription <name> --output-dir ../second-brain`
   - Internally: dedup → fetch → quality gate → format → write file
   - Sets step outputs: `has_new_content`, `source_name`, `date`, `output_path`, `source_url`
4. If `has_new_content == 'true'`: `peter-evans/create-pull-request@v7` against second-brain
5. `fail-fast: false` so one bad source does not block the others

### `notify`

Runs after sync regardless of per-source results (`if: always() && needs.prepare.result == 'success'`):

1. `pnpm tsx src/index.ts summarize --target-repo <repo> --date <date> --output summary.md`
   - Lists today's auto-sync PRs in second-brain
   - Fetches each PR's markdown file content
   - Calls GitHub Models with `prompts/summary.md` as the prompt
2. If `has_summary == 'true'`: `pnpm tsx src/index.ts notify ...` to broadcast to channels listed by today's subscriptions

## Secrets / Variables

Set in **Repo Settings → Secrets and variables → Actions**.

| Name | Type | Used by | Scope |
|------|------|---------|-------|
| `TARGET_REPO_PAT` | Secret | `sync`, `notify` | PAT with `repo` scope on second-brain; also used by `gh` CLI for listing PRs |
| `MINIMAX_API_KEY` | Secret | `notify` | MiniMax platform API key used by `summarize` |
| `WECOM_WEBHOOK_URL` | Secret | `notify` | WeCom bot webhook |
| `FEISHU_WEBHOOK_URL` | Secret | `notify` | Feishu bot webhook |
| `SUMMARY_MODEL` | Variable (optional) | `notify` | overrides default `MiniMax-M2.7-highspeed` |
| `LLM_BASE_URL` | Variable (optional) | `notify` | overrides default `https://api.minimaxi.com/v1` for switching providers |

## Workflow Injection Hardening

Per [GitHub's guidance](https://github.blog/security/vulnerability-research/how-to-catch-github-actions-workflow-injections-before-attackers-do/):

- **Never** interpolate `${{ ... }}` directly inside `run:` commands when the value comes from anything that could be attacker-controlled. Move it to an `env:` block and reference via `"$VAR"`.
- For values that are repo-internal and trusted (e.g. `${{ matrix.name }}` derived from our own yaml files, `${{ steps.fetch.outputs.date }}` derived from our own CLI), still prefer the env-var pattern as a habit. The current `daily-sync.yml` follows this convention — keep it that way when adding steps.

## Triggering Manually

```bash
gh workflow run daily-sync.yml
gh run watch
```

Use this for debugging — it skips the cron wait while exercising the full pipeline.

## Debugging a Failed Run

1. `gh run list --workflow daily-sync.yml --limit 5`
2. `gh run view <id> --log-failed`
3. Look for `[fetch] <slug> <date>:` log lines — every code path emits one
4. Quality failures include a 500-char content preview directly in the error
5. PR creation failures usually mean `TARGET_REPO_PAT` lacks scope

When fixing, use `pnpm check` locally first; CI will gate the fix PR.
