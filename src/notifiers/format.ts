import type { NotifyPayload } from './types.js'

export function buildMessage(payload: NotifyPayload): string {
  return [
    `📡 每日情报摘要 — ${payload.date}`,
    '',
    payload.summary,
    '',
    '---',
    'osmosis',
  ].join('\n')
}
