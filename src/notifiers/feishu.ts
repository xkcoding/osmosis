import type { Notifier, NotifyPayload } from './types.js'

export const feishuNotifier: Notifier = {
  channel: 'feishu',

  async send(payload: NotifyPayload): Promise<void> {
    const url = process.env.FEISHU_WEBHOOK_URL
    if (!url) {
      console.log('[feishu] FEISHU_WEBHOOK_URL not set, skipping')
      return
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
    // Feishu always returns 200; check response.code for logical failures
    try {
      const data = JSON.parse(text) as { code?: number; msg?: string }
      if (typeof data.code === 'number' && data.code !== 0) {
        throw new Error(`feishu webhook logical failure: code=${data.code} msg=${data.msg ?? ''}`)
      }
    } catch (err) {
      if (err instanceof SyntaxError) return
      throw err
    }
  },
}

function buildCard(payload: NotifyPayload): unknown {
  const prList = payload.prUrls.length > 0
    ? payload.prUrls.map((url) => `- ${url}`).join('\n')
    : '- (无新 PR)'
  const sourceNames = payload.sources.join(', ') || '(none)'

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `📡 每日情报摘要 — ${payload.date}` },
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
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `**📎 全文 PR**\n${prList}`,
          text_align: 'left',
          margin: '0px 0px 0px 0px',
        },
        {
          tag: 'markdown',
          content: `_osmosis · 来源: ${sourceNames}_`,
          text_align: 'left',
          margin: '0px 0px 0px 0px',
        },
      ],
    },
  }
}
