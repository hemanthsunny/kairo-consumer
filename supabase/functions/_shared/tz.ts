// Time-zone helpers built on Intl only (works in Deno and browsers).

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string; // mon..sun
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const parts = dtf(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday").slice(0, 3).toLowerCase(),
  };
}

/** Offset of tz from UTC at the given instant, in minutes (London summer = +60). */
export function offsetMinutes(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/**
 * Convert a wall-clock time in tz to a UTC instant.
 * For times skipped by a DST jump, returns the instant just after the gap.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - offsetMinutes(naive, tz) * 60000;
  const off2 = offsetMinutes(guess, tz);
  guess = naive - off2 * 60000;
  return guess;
}

/** Add whole calendar days to a y/m/d (no time zone involved). */
export function addDays(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
