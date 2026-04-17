import type { Notifier, NotifyPayload } from './types.js'

export const feishuNotifier: Notifier = {
  channel: 'feishu',

  async send(payload: NotifyPayload): Promise<void> {
    const url = process.env.FEISHU_WEBHOOK_URL
    if (!url) {
      console.log('[feishu] FEISHU_WEBHOOK_URL not set, skipping')
      return
    }

    const card = buildCard(payload)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'interactive',
        card,
      }),
    })

    if (!res.ok) {
      throw new Error(`feishu webhook failed: ${res.status} ${await res.text()}`)
    }
  },
}

function buildCard(payload: NotifyPayload): unknown {
  const prList = payload.prUrls.length > 0
    ? payload.prUrls.map((url) => `- ${url}`).join('\n')
    : '- (无新 PR)'

  const sourceNames = payload.sources.join(', ') || '(none)'

  const elements = [
    {
      tag: 'markdown',
      content: payload.summary,
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `**📎 全文 PR**\n${prList}`,
    },
    {
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: `osmosis · 来源: ${sourceNames}` },
      ],
    },
  ]

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `📡 每日情报摘要 — ${payload.date}` },
    },
    elements,
  }
}
