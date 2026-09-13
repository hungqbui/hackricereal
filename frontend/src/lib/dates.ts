/** Date helpers that stay in the browser's local timezone.
 *
 * The API speaks plain `YYYY-MM-DD` service dates. Parsing those with
 * `new Date(iso)` would read them as UTC midnight and shift the day for
 * anyone west of Greenwich, so every conversion here goes through the
 * local-time constructor instead.
 */

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export function toISODate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function fromISODate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1)
}

export function todayISO(): string {
  return toISODate(new Date())
}

export function addDays(iso: string, days: number): string {
  const date = fromISODate(iso)
  date.setDate(date.getDate() + days)
  return toISODate(date)
}

export function dayOfWeek(iso: string): number {
  return fromISODate(iso).getDay()
}

/** Next occurrence of a weekday, counting today when it already matches. */
export function nextWeekday(fromISO: string, weekday: number): string {
  const delta = (weekday - dayOfWeek(fromISO) + 7) % 7
  return addDays(fromISO, delta)
}

export function rangeFrom(startISO: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDays(startISO, index))
}

export function weekdayLabel(iso: string, style: 'short' | 'long' = 'short'): string {
  const name = WEEKDAY_NAMES[dayOfWeek(iso)]
  return style === 'long' ? name : name.slice(0, 3)
}

export function monthDayLabel(iso: string): string {
  return fromISODate(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/** "Tue Sep 15", or "Today" / "Tomorrow" when that is clearer. */
export function friendlyDate(iso: string, today = todayISO()): string {
  if (iso === today) return 'Today'
  if (iso === addDays(today, 1)) return 'Tomorrow'
  return `${weekdayLabel(iso)} ${monthDayLabel(iso)}`
}

export function describeRange(dates: string[], today = todayISO()): string {
  if (dates.length === 0) return 'no dates'
  if (dates.length === 1) return friendlyDate(dates[0], today)
  const first = dates[0]
  const last = dates[dates.length - 1]
  return `${friendlyDate(first, today)} → ${friendlyDate(last, today)} · ${dates.length} days`
}
