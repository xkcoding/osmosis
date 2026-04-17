# Add a Notifier

A notifier ships the daily summary to one IM channel. Adding one is ~30 lines.

## Step 1. Implement the notifier

Create `src/notifiers/<channel>.ts`:

```ts
import type { Notifier, NotifyPayload } from './types.js'
import { buildMessage } from './format.js'

export const myNotifier: Notifier = {
  channel: 'my-channel',

  async send(payload: NotifyPayload): Promise<void> {
    const url = process.env.MY_CHANNEL_WEBHOOK_URL
    if (!url) {
      console.log('[my-channel] MY_CHANNEL_WEBHOOK_URL not set, skipping')
      return
    }

    const text = buildMessage(payload)        // shared plain-text body
    // …or compose the channel's native rich-card payload.

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ /* channel-specific body */ }),
    })

    if (!res.ok) {
      throw new Error(`my-channel webhook failed: ${res.status} ${await res.text()}`)
    }
  },
}
```

**Rules:**
- **Skip silently when env is unset.** A missing webhook is configuration drift, not an error. Per [`spec.md`](../openspec/changes/initial-setup/specs/notifier/spec.md): "Webhook URL 未配置的渠道自动跳过（不报错）".
- **Throw on HTTP failure.** The CLI catches per-channel rejections and logs them — one bad channel does not block the others.
- **Respect channel size limits.** WeCom 4 KiB, Feishu 30 KiB. Truncate before sending.
- **Don't leak secrets in logs.** Log the channel name, never the URL or response body verbatim if it could echo the URL.

## Step 2. Register it

In `src/notifiers/registry.ts`:

```ts
import { myNotifier } from './my-channel.js'

register(myNotifier)
```

## Step 3. Wire env to the workflow

Edit `.github/workflows/daily-sync.yml`, in the `notify` step's `env:` block:

```yaml
env:
  # ... existing
  MY_CHANNEL_WEBHOOK_URL: ${{ secrets.MY_CHANNEL_WEBHOOK_URL }}
```

Add the secret in **Repo Settings → Secrets and variables → Actions**.

## Step 4. Use it from a subscription

```yaml
output:
  notify:
    enabled: true
    summary: true
    channels: [wecom, feishu, my-channel]
```

Channels listed here that don't match a registered notifier are skipped with a log line.

## Step 5. Tests

If the notifier has interesting payload-construction logic, add `src/notifiers/<channel>.test.ts`. Mock `fetch` with `vi.stubGlobal('fetch', vi.fn())`. Don't hit the real webhook in tests.

If the notifier just delegates to `buildMessage`, the existing `format.test.ts` already covers it — no new test needed.
