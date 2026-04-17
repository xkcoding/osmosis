import type { NotifyPayload } from './types.js'

export function buildMessage(payload: NotifyPayload): string {
  const prList = payload.prUrls.length > 0
    ? payload.prUrls.map((url) => `- ${url}`).join('\n')
    : '- (无新 PR)'

  const sourceNames = payload.sources.join(', ') || '(none)'

  return [
    `📡 每日情报摘要 — ${payload.date}`,
    '',
    payload.summary,
    '',
    '📎 全文 PR：',
    prList,
    '',
    '---',
    `osmosis · 来源: ${sourceNames}`,
  ].join('\n')
}
