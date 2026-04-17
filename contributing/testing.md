# Testing Guide

## Running

```bash
pnpm test            # vitest run (one-shot, what CI does)
pnpm test:watch      # vitest watch
pnpm check           # typecheck + lint + test (run this before opening a PR)
```

## What to Test

Test **logic**, not wiring. Good targets:

- Pure functions in `src/quality.ts`, `src/template.ts`, `src/formatter.ts`, `src/notifiers/format.ts`
- Branching code in fetchers (404 → null, success → FetchResult shape, template resolution)
- Anything where regression would silently corrupt output

Skip:

- The CLI subcommand glue (covered by manual + CI smoke + the daily run itself)
- `gh` CLI / `fetch` invocations beyond a single mock-it-and-assert-the-call test
- Re-exports, type-only files

## File Placement

Co-locate `*.test.ts` next to the source:

```
src/quality.ts
src/quality.test.ts
src/notifiers/feishu.ts
src/notifiers/feishu.test.ts
```

`vitest.config.ts` already includes `src/**/*.test.ts`.

## Patterns

### Pure functions

Import and assert. See `src/quality.test.ts`.

### Module env / network

Use `vi.stubEnv` for env, `vi.stubGlobal('fetch', vi.fn())` for `fetch`, `vi.mock('node:child_process', ...)` for `gh` subprocess calls. Always `vi.restoreAllMocks()` (or rely on vitest auto-reset) so tests don't leak.

```ts
import { vi, beforeEach } from 'vitest'

beforeEach(() => {
  vi.stubEnv('WECOM_WEBHOOK_URL', 'https://fake')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
})
```

### Time-dependent code

Pass an explicit `Date` instead of relying on the system clock — `todayParts(new Date('2026-04-17T01:00:00Z'))`. Don't `vi.useFakeTimers` unless you have to; the explicit-arg approach is clearer.

## Architecture Alignment

Tests follow the same dependency rules as source (see [architecture.md](architecture.md)):

- L1 utility tests don't import from `src/fetchers/` or `src/notifiers/`.
- Plugin tests don't import from other plugins.
- The CLI (`src/index.ts`) is exercised end-to-end by the daily-sync workflow run; we don't spin up a CLI integration test in unit tests.

## When a Test Fails in CI

The `ci.yml` workflow runs `pnpm check`. If it fails:

1. Reproduce locally with `pnpm check`.
2. Fix the implementation, **not the test**, unless the test asserts incorrect behavior.
3. If the test needs to change, the diff should make the new expected behavior obvious in the test name.
