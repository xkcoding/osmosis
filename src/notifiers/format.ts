import type { NotifyPayload } from './types.js'

export function buildMessage(payload: NotifyPayload): string {
  return [
    buildHeaderTitle(payload),
    '',
    payload.summary,
    '',
    '---',
    'osmosis',
  ].join('\n')
}

export function buildHeaderTitle(payload: NotifyPayload): string {
  const titles = payload.sources.map((s) => s.title)
  if (titles.length === 0) {
    return `📡 每日情报摘要 — ${payload.date}`
  }
  if (titles.length === 1) {
    return `📡 ${titles[0]} — ${payload.date}`
  }
  const joined = titles.join(' · ')
  if (joined.length <= 30) {
    return `📡 ${joined} — ${payload.date}`
  }
  return `📡 ${titles.length} 源日报 — ${payload.date}`
}
