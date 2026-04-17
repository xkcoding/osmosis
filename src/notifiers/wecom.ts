import type { Notifier, NotifyPayload, NotifyResult } from './types.js'
import { buildMessage } from './format.js'

const MAX_BYTES = 4096

export const wecomNotifier: Notifier = {
  channel: 'wecom',

  async send(payload: NotifyPayload): Promise<NotifyResult> {
    const url = process.env.WECOM_WEBHOOK_URL
    if (!url) {
      console.log('[wecom] WECOM_WEBHOOK_URL not set, skipping')
      return 'skipped'
    }

    const content = truncate(buildMessage(payload), MAX_BYTES)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content },
      }),
    })

    if (!res.ok) {
      throw new Error(`wecom webhook failed: ${res.status} ${await res.text()}`)
    }
    console.log('[wecom] sent')
    return 'sent'
  },
}

function truncate(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  const buf = encoder.encode(text)
  if (buf.length <= maxBytes) return text
  return decoder.decode(buf.slice(0, maxBytes - 3)) + '...'
}
