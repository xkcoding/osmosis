import type { Notifier, NotifyPayload, NotifyResult } from './types.js'
import { buildHeaderTitle } from './format.js'

export const feishuNotifier: Notifier = {
  channel: 'feishu',

  async send(payload: NotifyPayload): Promise<NotifyResult> {
    const url = process.env.FEISHU_WEBHOOK_URL
    if (!url) {
      console.log('[feishu] FEISHU_WEBHOOK_URL not set, skipping')
      return 'skipped'
    }

    const body = {
      msg_type: 'interactive',
      card: buildCard(payload),
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const text = await res.text()
    if (!res.ok) {
      throw new Error(`feishu webhook HTTP ${res.status}: ${text}`)
    }
    try {
      const data = JSON.parse(text) as { code?: number; msg?: string }
      if (typeof data.code === 'number' && data.code !== 0) {
        throw new Error(`feishu webhook logical failure: code=${data.code} msg=${data.msg ?? ''}`)
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.log('[feishu] sent')
        return 'sent'
      }
      throw err
    }
    console.log('[feishu] sent')
    return 'sent'
  },
}

function buildCard(payload: NotifyPayload): unknown {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: buildHeaderTitle(payload) },
      padding: '12px 12px 12px 12px',
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content: payload.summary,
          text_align: 'left',
          margin: '0px 0px 0px 0px',
        },
      ],
    },
  }
}
