// Email (always), WhatsApp + SMS (Premium add-ons). Everything goes through the outbox.

import { admin, effectivePlan, getSetting, type Profile } from "./db.ts";
import { env } from "./env.ts";
import { escapeHtml } from "./http.ts";

export type Channel = "email" | "whatsapp" | "sms";
export type Kind = "confirmation" | "reminder_24h" | "reminder_1h" | "reminder" | "event_reminder" | "cancellation";

export const REMINDER_OFFSETS = [10, 30, 1440];

export interface ReminderPrefs {
  scope: "bookings" | "all";
  email: number[];
  whatsapp: number[];
  sms: number[];
}

export function normalizePrefs(raw: unknown): ReminderPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) =>
    Array.isArray(v) ? Array.from(new Set(v.map(Number).filter((n) => REMINDER_OFFSETS.includes(n)))).sort((a, b) => b - a) : [];
  return {
    scope: r.scope === "all" ? "all" : "bookings",
    email: Array.isArray(r.email) ? list(r.email) : [1440, 30],
    whatsapp: list(r.whatsapp),
    sms: list(r.sms),
  };
}

export function offsetLabel(min: number) {
  if (min >= 1440) return "Tomorrow";
  if (min >= 60) return `In ${Math.round(min / 60)} hour${min >= 120 ? "s" : ""}`;
  return `In ${min} min`;
}

export interface EventSnapshot {
  id: string;
  title: string;
  start: number;
  end: number;
  join_url: string | null;
  location: string | null;
  account_label: string | null;
}

export interface BookingRow {
  id: string;
  user_id: string;
  title: string;
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  guest_note: string | null;
  guest_timezone: string | null;
  start_at: string;
  end_at: string;
  status: string;
  meeting_url: string | null;
  location_text: string | null;
  manage_token: string;
  provider_event_id: string | null;
}

export function fmtWhen(iso: string, tz: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const zone = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value ?? tz;
  return { date, time, zone, full: `${date}, ${time} (${zone})` };
}

/** Monthly add-on caps. Trial gets a small allowance so friends can try WhatsApp. */
export async function addonAllowed(profile: Profile, channel: "whatsapp" | "sms"): Promise<boolean> {
  const enabled = await getSetting<boolean>(channel === "whatsapp" ? "whatsapp_enabled" : "sms_enabled", false);
  if (!enabled) return false;
  const plan = effectivePlan(profile);
  if (plan !== "premium" && plan !== "trial") return false;
  const caps = plan === "trial"
    ? { whatsapp: 20, sms: 5 }
    : await getSetting<{ whatsapp: number; sms: number }>("premium_monthly_caps", { whatsapp: 300, sms: 50 });
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { count } = await admin().from("notification_outbox").select("id", { count: "exact", head: true })
    .eq("user_id", profile.id).eq("channel", channel).eq("status", "sent").gte("sent_at", monthStart.toISOString());
  return (count ?? 0) < caps[channel];
}

/** Queue confirmation + reminders for a new booking. */
export async function enqueueForBooking(profile: Profile, b: BookingRow, memberIds: string[] = []) {
  const start = new Date(b.start_at).getTime();
  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  const add = (recipient: "host" | "guest", channel: Channel, kind: Kind, sendAt: number) =>
    rows.push({
      user_id: profile.id,
      booking_id: b.id,
      recipient,
      channel,
      kind,
      send_at: new Date(sendAt).toISOString(),
      dedupe_key: `${b.id}:${recipient}:${channel}:${kind}`,
    });

  add("guest", "email", "confirmation", now);
  add("host", "email", "confirmation", now);
  for (const uid of memberIds) {
    rows.push({
      user_id: uid, booking_id: b.id, recipient: "host", channel: "email", kind: "confirmation",
      send_at: new Date(now).toISOString(), dedupe_key: `${b.id}:host:${uid}:email:confirmation`,
    });
  }

  // Guests get fixed reminders. The host's reminders follow their settings and are
  // created by the cron scan shortly before they are due.
  for (const [kind, before] of [["reminder_24h", 24 * 3600000], ["reminder_1h", 3600000]] as const) {
    const at = start - before;
    if (at <= now + 5 * 60000) continue;
    add("guest", "email", kind, at);
    if (b.guest_phone) add("guest", "whatsapp", kind, at);
  }
  if (rows.length) await admin().from("notification_outbox").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });
}

export async function enqueueCancellation(profile: Profile, b: BookingRow, by: "host" | "guest", memberIds: string[] = [], internal = false) {
  const db = admin();
  await db.from("notification_outbox").update({ status: "skipped", last_error: "Booking cancelled" })
    .eq("booking_id", b.id).eq("status", "pending");
  const now = new Date().toISOString();
  const rows = (internal ? [] : [
    { recipient: by === "host" ? "guest" : "host", channel: "email" },
  ]).map((r) => ({
    ...r,
    user_id: profile.id,
    booking_id: b.id,
    kind: "cancellation",
    send_at: now,
    dedupe_key: `${b.id}:${r.recipient}:${r.channel}:cancellation`,
  }));
  const memberRows = memberIds.map((uid) => ({
    recipient: "host", channel: "email", user_id: uid, booking_id: b.id, kind: "cancellation", send_at: now,
    dedupe_key: `${b.id}:host:${uid}:email:cancellation`,
  }));
  await db.from("notification_outbox").upsert([...rows, ...memberRows], { onConflict: "dedupe_key", ignoreDuplicates: true });
}

// ---------------------------------------------------------------------------------
// Rendering

export function manageUrl(b: BookingRow) {
  return `${env.siteUrl}/b/${b.manage_token}`;
}

function lines(profile: Profile, b: BookingRow, recipient: "host" | "guest", kind: Kind, offsetMin?: number | null) {
  const tz = recipient === "host" ? profile.timezone : (b.guest_timezone || profile.timezone);
  const w = fmtWhen(b.start_at, tz);
  const other = recipient === "host" ? b.guest_name : (profile.full_name || profile.handle);
  const where = b.meeting_url ?? b.location_text ?? null;
  const headline = {
    confirmation: recipient === "host" ? `New booking: ${b.guest_name}` : `Confirmed: ${b.title} with ${other}`,
    reminder_24h: `Tomorrow: ${b.title} with ${other}`,
    reminder_1h: `In 1 hour: ${b.title} with ${other}`,
    reminder: `${offsetLabel(offsetMin ?? 60)}: ${b.title} with ${other}`,
    event_reminder: `${offsetLabel(offsetMin ?? 60)}: ${b.title}`,
    cancellation: `Cancelled: ${b.title} with ${other}`,
  }[kind];
  return { tz, w, other, where, headline };
}

export function renderEmail(profile: Profile, b: BookingRow, recipient: "host" | "guest", kind: Kind, offsetMin?: number | null) {
  const { w, where, headline } = lines(profile, b, recipient, kind, offsetMin);
  const rows: [string, string][] = [["When", w.full], ["What", b.title]];
  if (recipient === "host") {
    rows.push(["Guest", `${b.guest_name} <${b.guest_email}>`]);
    if (b.guest_phone) rows.push(["Phone", b.guest_phone]);
    if (b.guest_note) rows.push(["Note", b.guest_note]);
  } else {
    rows.push(["With", profile.full_name || profile.handle]);
  }
  if (where && kind !== "cancellation") rows.push(["Where", where]);
  const action = kind === "cancellation"
    ? ""
    : recipient === "guest"
    ? `<p style="margin:24px 0 0"><a href="${manageUrl(b)}" style="color:#4f46e5">Need to cancel?</a></p>`
    : `<p style="margin:24px 0 0"><a href="${env.siteUrl}/app" style="color:#4f46e5">Open ${escapeHtml(env.productName)}</a></p>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px">
<p style="margin:0 0 4px;font-size:13px;color:#6b7280">${escapeHtml(env.productName)}</p>
<h1 style="margin:0 0 20px;font-size:20px;font-weight:600">${escapeHtml(headline)}</h1>
<table style="border-collapse:collapse;width:100%;font-size:15px">${
    rows.map(([k, v]) =>
      `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;width:70px">${k}</td><td style="padding:6px 0">${
        /^https?:\/\//.test(v) ? `<a href="${escapeHtml(v)}" style="color:#4f46e5">${escapeHtml(v)}</a>` : escapeHtml(v)
      }</td></tr>`
    ).join("")
  }</table>${action}
</div>
<p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:16px">Sent by ${escapeHtml(env.productName)} · one link for all your calendars</p>
</div></body></html>`;
  const text = `${headline}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;
  return { subject: headline, html, text };
}

export function renderShort(profile: Profile, b: BookingRow, recipient: "host" | "guest", kind: Kind, offsetMin?: number | null) {
  const { w, where, headline } = lines(profile, b, recipient, kind, offsetMin);
  return `${headline}\n${w.full}${where && kind !== "cancellation" ? `\nJoin: ${where}` : ""}`;
}

// ---------------------------------------------------------------------------------
// Senders

export function renderEventEmail(profile: Profile, ev: EventSnapshot, offsetMin: number) {
  const w = fmtWhen(new Date(ev.start).toISOString(), profile.timezone);
  const headline = `${offsetLabel(offsetMin)}: ${ev.title}`;
  const rows: [string, string][] = [["When", w.full], ["What", ev.title]];
  if (ev.account_label) rows.push(["Calendar", ev.account_label]);
  if (ev.join_url) rows.push(["Join", ev.join_url]);
  else if (ev.location) rows.push(["Where", ev.location]);
  const join = ev.join_url
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(ev.join_url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Join now</a></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px">
<p style="margin:0 0 4px;font-size:13px;color:#6b7280">${escapeHtml(env.productName)}</p>
<h1 style="margin:0 0 20px;font-size:20px;font-weight:600">${escapeHtml(headline)}</h1>
<table style="border-collapse:collapse;width:100%;font-size:15px">${
    rows.map(([k, v]) =>
      `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;width:70px">${k}</td><td style="padding:6px 0">${
        /^https?:\/\//.test(v) ? `<a href="${escapeHtml(v)}" style="color:#4f46e5">${escapeHtml(v)}</a>` : escapeHtml(v)
      }</td></tr>`
    ).join("")
  }</table>${join}
</div>
<p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:16px">Change reminder times in ${escapeHtml(env.productName)} → Settings</p>
</div></body></html>`;
  const text = `${headline}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;
  return { subject: headline, html, text };
}

export function renderEventShort(profile: Profile, ev: EventSnapshot, offsetMin: number) {
  const w = fmtWhen(new Date(ev.start).toISOString(), profile.timezone);
  const where = ev.join_url ?? ev.location;
  return `${offsetLabel(offsetMin)}: ${ev.title}\n${w.full}${where ? `\nJoin: ${where}` : ""}`;
}

export function renderInviteEmail(inviterName: string, teamName: string, url: string) {
  const subject = `${inviterName} invited you to join ${teamName} on ${env.productName}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px">
<p style="margin:0 0 4px;font-size:13px;color:#6b7280">${escapeHtml(env.productName)}</p>
<h1 style="margin:0 0 14px;font-size:20px;font-weight:600">Join ${escapeHtml(teamName)}</h1>
<p style="margin:0 0 10px;font-size:15px;line-height:1.5">${escapeHtml(inviterName)} invited you to the ${escapeHtml(teamName)} team. Join once with your calendar and you'll be able to share the team's booking links and find times that work for everyone — clients only see slots when the people on the call are free, and every booking lands in your calendar.</p>
<p style="margin:0 0 22px;font-size:14px;color:#6b7280">Only your busy times are shared with the team, never your event details.</p>
<a href="${escapeHtml(url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:500">Join ${escapeHtml(teamName)}</a>
</div>
<p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:16px">Not expecting this? You can ignore it, or decline from the link above.</p>
</div></body></html>`;
  const text = `${subject}\n\nJoin once with your calendar:\n${url}\n`;
  return { subject, html, text };
}

export async function sendEmail(to: string, subject: string, html: string, text: string, attachments?: { filename: string; content: string }[]) {
  if (!env.resendKey) throw new Error("Email is not configured (RESEND_API_KEY)");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.resendKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.emailFrom, to: [to], subject, html, text, attachments }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Email failed: ${data.message ?? res.status}`);
  return data.id as string;
}

export async function sendWhatsApp(toE164: string, params: string[]) {
  // Preferred: WhatsApp through Twilio (same account as SMS), using an approved Content Template.
  if (env.twilioSid && env.twilioToken && env.twilioWaFrom && env.twilioWaContentSid) {
    const from = env.twilioWaFrom.startsWith("whatsapp:") ? env.twilioWaFrom : `whatsapp:${env.twilioWaFrom}`;
    const vars = Object.fromEntries(params.map((p, i) => [String(i + 1), p.slice(0, 200)]));
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: "Basic " + btoa(`${env.twilioSid}:${env.twilioToken}`),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: `whatsapp:${toE164}`,
        From: from,
        ContentSid: env.twilioWaContentSid,
        ContentVariables: JSON.stringify(vars),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp failed: ${data.message ?? res.status}`);
    return data.sid as string;
  }
  // Fallback: Meta WhatsApp Cloud API directly.
  if (!env.waToken || !env.waPhoneNumberId) throw new Error("WhatsApp is not configured");
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.waPhoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.waToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toE164.replace(/^\+/, ""),
      type: "template",
      template: {
        name: env.waTemplate,
        language: { code: env.waTemplateLang },
        components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p.slice(0, 200) })) }],
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp failed: ${data.error?.message ?? res.status}`);
  return data.messages?.[0]?.id as string;
}

export async function sendSms(toE164: string, text: string) {
  if (!env.twilioSid || !env.twilioToken || !env.twilioFrom) throw new Error("SMS is not configured");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.twilioSid}:${env.twilioToken}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toE164, From: env.twilioFrom, Body: text.slice(0, 300) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`SMS failed: ${data.message ?? res.status}`);
  return data.sid as string;
}

/** A standard calendar invite, used when the booking couldn't be written to a calendar. */
export function buildIcs(b: BookingRow, organiserName: string, organiserEmail: string, method: "REQUEST" | "CANCEL") {
  const fmt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kairo Link//EN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${b.id}@kairolink`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(b.start_at)}`,
    `DTEND:${fmt(b.end_at)}`,
    `SUMMARY:${esc(b.title)}`,
    b.meeting_url ? `LOCATION:${esc(b.meeting_url)}` : b.location_text ? `LOCATION:${esc(b.location_text)}` : "",
    `ORGANIZER;CN=${esc(organiserName)}:mailto:${organiserEmail}`,
    `ATTENDEE;CN=${esc(b.guest_name)};RSVP=TRUE:mailto:${b.guest_email}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}
