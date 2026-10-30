export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";

export function fmt(date: Date | string | number, tz: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(new Date(date));
}

export const fmtTime = (d: Date | string | number, tz: string) =>
  fmt(d, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const fmtDay = (d: Date | string | number, tz: string) =>
  fmt(d, tz, { weekday: "short", day: "numeric", month: "short" });

export const fmtLongDay = (d: Date | string | number, tz: string) =>
  fmt(d, tz, { weekday: "long", day: "numeric", month: "long" });

/** yyyy-mm-dd of an instant in a time zone */
export function dayKey(d: Date | string | number, tz: string) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
  return p; // en-CA gives yyyy-mm-dd
}

export function tzLabel(tz: string, at = new Date()) {
  const short = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const city = tz.split("/").pop()?.replace(/_/g, " ");
  return `${city}${short ? ` (${short})` : ""}`;
}

export function minutesOfDay(d: Date | string | number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(d));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function allTimeZones(): string[] {
  const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const list = anyIntl.supportedValuesOf?.("timeZone") ?? [];
  return list.length ? list : ["Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "America/New_York", "Asia/Kolkata"];
}

export function durationLabel(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
