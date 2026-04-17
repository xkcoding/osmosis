# Add a Fetcher

A fetcher pulls one source's "today's content" and returns it as `FetchResult | null`. `null` means "nothing new" (e.g. 404, no item published today, already synced) and is silently OK — no PR is created.

## Step 1. Implement the fetcher

Create `src/fetchers/<type>.ts`:

```ts
import type { Fetcher, FetchResult, SourceConfig } from './types.js'
import { resolveTemplate, todayParts } from '../template.js'

interface MyConfig extends SourceConfig {
  type: 'my-type'
  // ... other yaml-driven fields
}

export const myFetcher: Fetcher = {
  type: 'my-type',

  async fetch(config: SourceConfig): Promise<FetchResult | null> {
    const cfg = config as MyConfig
    const parts = todayParts()

    // 1. Resolve any path/url templates with parts
    // 2. Hit the upstream API
    // 3. If today's item doesn't exist → return null
    // 4. Otherwise return { title, date, content, sourceUrl }

    return {
      title: 'Display Name',
      date: parts.date,
      content: rawMarkdown,
      sourceUrl: 'https://upstream/permalink',
    }
  },
}
```

**Rules:**
- Return raw markdown — do **not** add frontmatter, that is the formatter's job.
- Throw on unexpected errors. Return `null` only on "no content for today".
- Read auth from `process.env.GITHUB_TOKEN` (or your own env) — never hardcode.
- Honor `todayParts()` — never compute "today" yourself.

## Step 2. Register it

In `src/fetchers/registry.ts`:

```ts
import { myFetcher } from './my-type.js'

register(myFetcher)
```

## Step 3. Write a subscription yaml

`subscriptions/<slug>.yml`:

```yaml
name: <slug>
source:
  type: my-type
  # ... fields your fetcher reads from cfg
output:
  obsidian:
    enabled: true
    path: "00_Inbox/Clippings/{date} - <Slug>.md"
    frontmatter:
      type: reference
      tags: [clipping/<slug>]
  notify:
    enabled: true
    summary: true
    channels: [wecom, feishu]
```

## Step 4. (Optional) Tune the quality gate

If your source has shorter content than 200 chars or a different structure, override the gate:

```yaml
quality:
  minBodyChars: 80
  minBodyLines: 2
  requireMarkdownSignal: false
  forbidPatterns: [draft, "[wip]"]
  onFail: error           # or 'skip' if you'd rather miss a day than fail loudly
```

See [quality-gates.md](quality-gates.md) for what each rule does.

## Step 5. Add tests

Co-locate `src/fetchers/<type>.test.ts`. The fetcher likely hits network (via `gh api`, `fetch`, or another client) — mock the transport rather than calling upstream in unit tests. For `gh`-based fetchers, stub the subprocess runner with vitest `vi.mock`. Verify:

- Returns `null` on the "not published" case (404 / empty list / etc.)
- Returns a `FetchResult` with the right `date`, `title`, `sourceUrl` shape
- Resolves templates correctly

## Step 6. Verify locally

```bash
pnpm check                                                # typecheck + lint + test
GITHUB_TOKEN=ghp_xxx pnpm fetch --subscription <slug> --output-dir /tmp/vault
```

Confirm:
- File appears at `/tmp/vault/<resolved path>`
- Frontmatter looks right
- Body length / formatting passes the quality gate

## Step 7. Open the PR

CI runs `pnpm check`. The next cron tick after merge picks up the new yaml automatically — no workflow edit needed.
