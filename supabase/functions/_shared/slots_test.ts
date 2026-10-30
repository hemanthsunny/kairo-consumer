import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";
import { generateSlots, isSlotAvailable, LinkRules, mergeIntervals } from "./slots.ts";
import { localParts, offsetMinutes, zonedToUtc } from "./tz.ts";

const weekdays9to5 = {
  mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]], sat: [], sun: [],
} as LinkRules["weeklyHours"];

const rules: LinkRules = {
  durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0,
  maxDaysAhead: 30, dailyLimit: null, slotStepMin: 30, weeklyHours: weekdays9to5,
};

const LON = "Europe/London";
// Monday 2 Nov 2026, 08:00 London (GMT, UTC+0)
const MON_8AM = Date.UTC(2026, 10, 2, 8, 0);

Deno.test("tz: London offsets winter/summer", () => {
  assertEquals(offsetMinutes(Date.UTC(2026, 0, 10, 12), LON), 0);
  assertEquals(offsetMinutes(Date.UTC(2026, 6, 10, 12), LON), 60);
  assertEquals(zonedToUtc(2026, 7, 10, 9, 0, LON), Date.UTC(2026, 6, 10, 8, 0));
  assertEquals(zonedToUtc(2026, 1, 10, 9, 0, "Asia/Kolkata"), Date.UTC(2026, 0, 10, 3, 30));
});

Deno.test("first slot is 09:00 and none on weekend", () => {
  const s = generateSlots({ now: MON_8AM, hostTz: LON, rules, busy: [], linkBookings: [] });
  assertEquals(s[0], Date.UTC(2026, 10, 2, 9, 0));
  for (const t of s) {
    const p = localParts(t, LON);
    assert(p.weekday !== "sat" && p.weekday !== "sun");
    assert(p.hour >= 9 && (p.hour < 17));
  }
  // 16 half-hour slots per weekday
  assertEquals(s.filter((t) => t < Date.UTC(2026, 10, 3)).length, 16);
});

Deno.test("never offers the past or inside minimum notice", () => {
  const now = Date.UTC(2026, 10, 2, 11, 10);
  const s = generateSlots({ now, hostTz: LON, rules: { ...rules, minNoticeMin: 240 }, busy: [], linkBookings: [] });
  assert(s[0] >= now + 240 * 60000);
  assertEquals(s[0], Date.UTC(2026, 10, 2, 15, 30));
});

Deno.test("never beyond max days ahead (30)", () => {
  const s = generateSlots({ now: MON_8AM, hostTz: LON, rules, busy: [], linkBookings: [] });
  const last = s[s.length - 1];
  assert(last <= MON_8AM + 30 * 86400000);
});

Deno.test("busy from any calendar blocks the slot, with buffers", () => {
  const busy = [
    { start: Date.UTC(2026, 10, 2, 10, 0), end: Date.UTC(2026, 10, 2, 11, 0) }, // work calendar
    { start: Date.UTC(2026, 10, 2, 10, 30), end: Date.UTC(2026, 10, 2, 11, 30) }, // personal overlaps
  ];
  const s = generateSlots({ now: MON_8AM, hostTz: LON, rules: { ...rules, bufferAfterMin: 15 }, busy, linkBookings: [] });
  const day = s.filter((t) => t < Date.UTC(2026, 10, 3)).map((t) => new Date(t).toISOString().slice(11, 16));
  assert(!day.includes("10:00"));
  assert(!day.includes("11:00"));
  assert(!day.includes("09:30")); // 09:30-10:00 + 15m buffer hits 10:00 busy
  assert(day.includes("09:00"));
  assert(day.includes("11:30"));
});

Deno.test("daily limit removes days that are full", () => {
  const booked = [{ start: Date.UTC(2026, 10, 2, 9, 0), end: Date.UTC(2026, 10, 2, 9, 30) }];
  const s = generateSlots({ now: MON_8AM, hostTz: LON, rules: { ...rules, dailyLimit: 1 }, busy: booked, linkBookings: booked });
  assertEquals(s.filter((t) => t < Date.UTC(2026, 10, 3)).length, 0);
  assert(s.some((t) => t >= Date.UTC(2026, 10, 3, 9)));
});

Deno.test("DST: London hours stay 09:00 local across clock change", () => {
  // Clocks go back Sun 25 Oct 2026. Fri 23 Oct (BST) vs Mon 26 Oct (GMT)
  const now = Date.UTC(2026, 9, 22, 12, 0);
  const s = generateSlots({ now, hostTz: LON, rules, busy: [], linkBookings: [] });
  assert(s.includes(Date.UTC(2026, 9, 23, 8, 0))); // 09:00 BST
  assert(s.includes(Date.UTC(2026, 9, 26, 9, 0))); // 09:00 GMT
});

Deno.test("isSlotAvailable checks a specific start", () => {
  const input = { now: MON_8AM, hostTz: LON, rules, busy: [], linkBookings: [] };
  assert(isSlotAvailable(input, Date.UTC(2026, 10, 2, 9, 0)));
  assert(!isSlotAvailable(input, Date.UTC(2026, 10, 2, 9, 10))); // off-grid
  assert(!isSlotAvailable(input, Date.UTC(2026, 10, 1, 9, 0))); // Sunday
  assert(!isSlotAvailable(input, MON_8AM - 86400000)); // past
});

Deno.test("mergeIntervals", () => {
  assertEquals(mergeIntervals([{ start: 5, end: 10 }, { start: 1, end: 6 }, { start: 12, end: 13 }]), [
    { start: 1, end: 10 },
    { start: 12, end: 13 },
  ]);
});
