// Pure slot generation: weekly hours (host time zone) minus busy time across every
// connected calendar, with buffers, minimum notice, booking window and daily limit.

import { addDays, localParts, ymd, zonedToUtc } from "./tz.ts";

export type WeeklyHours = Record<string, [string, string][]>; // mon..sun -> [["09:00","17:00"], ...]

export interface Interval {
  start: number; // UTC ms
  end: number;
}

export interface LinkRules {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxDaysAhead: number;
  dailyLimit: number | null;
  slotStepMin: number;
  weeklyHours: WeeklyHours;
}

export interface SlotInput {
  now: number;
  hostTz: string;
  rules: LinkRules;
  busy: Interval[];
  /** Existing confirmed bookings made through this link (for the daily limit). */
  linkBookings: Interval[];
  /** Optional narrower range to return (UTC ms). */
  from?: number;
  to?: number;
}

export const HARD_MAX_DAYS = 60;

function hm(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Bad time ${s}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) throw new Error(`Bad time ${s}`);
  return [h, mi];
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

function overlaps(busy: Interval[], s: number, e: number): boolean {
  // busy is merged + sorted; binary search for first interval ending after s
  let lo = 0;
  let hi = busy.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (busy[mid].end <= s) lo = mid + 1;
    else hi = mid;
  }
  return lo < busy.length && busy[lo].start < e;
}

/** Last bookable instant: maxDaysAhead (never more than 60) from now. */
export function windowEnd(now: number, maxDaysAhead: number): number {
  const days = Math.min(Math.max(1, maxDaysAhead), HARD_MAX_DAYS);
  return now + days * 86400000;
}

export function generateSlots(input: SlotInput): number[] {
  const { now, hostTz, rules } = input;
  const dur = rules.durationMin * 60000;
  const step = rules.slotStepMin * 60000;
  const earliest = Math.max(now + rules.minNoticeMin * 60000, input.from ?? -Infinity);
  const latest = Math.min(windowEnd(now, rules.maxDaysAhead), input.to ?? Infinity);
  if (latest <= earliest) return [];

  const busy = mergeIntervals(input.busy);
  const before = rules.bufferBeforeMin * 60000;
  const after = rules.bufferAfterMin * 60000;

  // count existing bookings per host-local day
  const perDay = new Map<string, number>();
  for (const b of input.linkBookings) {
    const p = localParts(b.start, hostTz);
    const k = ymd(p.year, p.month, p.day);
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }

  const startLocal = localParts(Math.max(now, earliest) - 86400000, hostTz);
  const out: number[] = [];
  const totalDays = Math.min(rules.maxDaysAhead, HARD_MAX_DAYS) + 2;

  for (let i = 0; i <= totalDays; i++) {
    const d = addDays(startLocal.year, startLocal.month, startLocal.day, i);
    const noon = zonedToUtc(d.year, d.month, d.day, 12, 0, hostTz);
    const weekday = localParts(noon, hostTz).weekday;
    const windows = rules.weeklyHours[weekday] ?? [];
    const dayKey = ymd(d.year, d.month, d.day);
    if (rules.dailyLimit != null && (perDay.get(dayKey) ?? 0) >= rules.dailyLimit) continue;
    const next = addDays(d.year, d.month, d.day, 1);

    for (const [a, b] of windows) {
      const [ah, am] = hm(a);
      const [bh, bm] = hm(b);
      const wStart = zonedToUtc(d.year, d.month, d.day, ah, am, hostTz);
      const wEnd = bh === 24
        ? zonedToUtc(next.year, next.month, next.day, 0, 0, hostTz)
        : zonedToUtc(d.year, d.month, d.day, bh, bm, hostTz);
      for (let s = wStart; s + dur <= wEnd; s += step) {
        if (s < earliest || s > latest) continue;
        if (overlaps(busy, s - before, s + dur + after)) continue;
        out.push(s);
      }
    }
  }
  return Array.from(new Set(out)).sort((x, y) => x - y);
}

/** Validate a single requested start (used at booking time with live busy data). */
export function isSlotAvailable(input: SlotInput, start: number): boolean {
  const day = 86400000;
  const slots = generateSlots({ ...input, from: start - day, to: start + day });
  return slots.includes(start);
}
