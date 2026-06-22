export interface DateParts {
  date: string
  year: string
  month: string
  day: string
}

export function todayParts(now: Date = new Date()): DateParts {
  // OSMOSIS_DATE pins "today" to a specific YYYY-MM-DD, for backfilling a day
  // the hourly cron missed. It overrides only the date, not the time-zone math.
  const override = process.env.OSMOSIS_DATE?.trim()
  if (override) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(override)
    if (!m) throw new Error(`OSMOSIS_DATE must be YYYY-MM-DD, got: ${override}`)
    const [, year, month, day] = m as unknown as [string, string, string, string]
    return { date: `${year}-${month}-${day}`, year, month, day }
  }

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
