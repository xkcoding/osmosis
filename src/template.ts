export interface DateParts {
  date: string
  year: string
  month: string
  day: string
}

export function todayParts(now: Date = new Date()): DateParts {
  const tz = process.env.OSMOSIS_TZ ?? 'Asia/Shanghai'
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  const year = parts.year!
  const month = parts.month!
  const day = parts.day!
  return { date: `${year}-${month}-${day}`, year, month, day }
}

export function resolveTemplate(template: string, parts: DateParts): string {
  return template
    .replaceAll('{date}', parts.date)
    .replaceAll('{year}', parts.year)
    .replaceAll('{month}', parts.month)
    .replaceAll('{day}', parts.day)
}
