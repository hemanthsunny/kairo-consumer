// Kairo Link API — one Edge Function, routed by path.
// Public site proxies https://<site>/api/* to this function (see netlify.toml).

import { admin, effectivePlan, Profile, requireUser } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { body, HttpError, isEmail, json, optStr, preflight, randomToken, redirect, str } from "../_shared/http.ts";
import { authUrl, createEvent, deleteEvent, exchangeCode, Provider, ProviderAuthError } from "../_shared/providers.ts";
import { AccountRow, busyForUser, clearBusyCache, getAccessToken } from "../_shared/accounts.ts";
import { generateSlots, Interval, isSlotAvailable, LinkRules, windowEnd } from "../_shared/slots.ts";
import { isValidTimeZone } from "../_shared/tz.ts";
import {
  addonAllowed,
  BookingRow,
  buildIcs,
  enqueueCancellation,
  enqueueForBooking,
  fmtWhen,
  Kind,
  renderEmail,
  renderShort,
  sendEmail,
  sendSms,
  sendWhatsApp,
} from "../_shared/notify.ts";
import { stripe, verifyStripeSignature } from "../_shared/stripe.ts";

type Handler = (req: Request, params: Record<string, string>, url: URL) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
function route(method: string, pattern: string, h: Handler) {
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "/?$");
  routes.push([method, re, h]);
}

const ACCOUNT_COLORS = ["#6366f1", "#0ea5e9", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6"];

async function loadProfile(userId: string): Promise<Profile> {
  const { data, error } = await admin().from("profiles").select("*").eq("id", userId).single();
  if (error || !data) throw new HttpError(404, "Profile not found");
  return data as Profile;
}

function rulesFromLink(l: Record<string, unknown>): LinkRules {
  return {
    durationMin: l.duration_min as number,
    bufferBeforeMin: l.buffer_before_min as number,
    bufferAfterMin: l.buffer_after_min as number,
    minNoticeMin: l.min_notice_min as number,
    maxDaysAhead: l.max_days_ahead as number,
    dailyLimit: (l.daily_limit as number | null) ?? null,
    slotStepMin: l.slot_step_min as number,
    weeklyHours: l.weekly_hours as LinkRules["weeklyHours"],
  };
}

async function confirmedBookings(userId: string, from: number, to: number) {
  const { data } = await admin().from("bookings").select("id,link_id,start_at,end_at")
    .eq("user_id", userId).eq("status", "confirmed")
    .lt("start_at", new Date(to).toISOString()).gt("end_at", new Date(from).toISOString());
  return (data ?? []).map((b) => ({ ...b, start: Date.parse(b.start_at), end: Date.parse(b.end_at) }));
}

// ===================================================================================
// Health

route("GET", "/health", async () => json({ ok: true, product: env.productName }));

// ===================================================================================
// Connecting calendars

route("POST", "/me/connect", async (req) => {
  const user = await requireUser(req);
  const b = await body<{ provider?: string; loginHint?: string; returnTo?: string }>(req);
  const provider = b.provider === "microsoft" ? "microsoft" : b.provider === "google" ? "google" : null;
  if (!provider) throw new HttpError(400, "Choose Google or Microsoft");
  const state = randomToken(24);
  const returnTo = typeof b.returnTo === "string" && b.returnTo.startsWith("/app") ? b.returnTo : "/app/calendars";
  await admin().from("oauth_states").insert({ state, user_id: user.id, provider, return_to: returnTo });
  return json({ url: authUrl(provider, state, typeof b.loginHint === "string" ? b.loginHint : undefined) });
});

route("GET", "/oauth/:provider/callback", async (_req, p, url) => {
  const provider = p.provider as Provider;
  const db = admin();
  const back = (path: string, q: Record<string, string>) =>
    redirect(`${env.siteUrl}${path}?${new URLSearchParams(q).toString()}`);

  const state = url.searchParams.get("state") ?? "";
  const { data: st } = await db.from("oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st || st.provider !== provider || Date.now() - Date.parse(st.created_at) > 15 * 60000) {
    return back("/app/calendars", { error: "That sign-in link expired. Please try connecting again." });
  }
  await db.from("oauth_states").delete().eq("state", state);
  const returnTo = st.return_to || "/app/calendars";

  const err = url.searchParams.get("error");
  if (err) {
    const desc = url.searchParams.get("error_description") ?? err;
    const friendly = /AADSTS65001|consent/i.test(desc)
      ? "Your organisation needs an admin to approve this app first."
      : err === "access_denied"
      ? "Connection cancelled."
      : desc.slice(0, 200);
    return back(returnTo, { error: friendly });
  }
  const code = url.searchParams.get("code");
  if (!code) return back(returnTo, { error: "No authorisation code received." });

  try {
    const t = await exchangeCode(provider, code);
    if (!t.email) throw new Error("Could not read the account's email address");
    if (!t.refreshToken) throw new Error("No offline access granted. Please remove the app from your account permissions and connect again.");
    if (provider === "google" && t.scope && !t.scope.includes("calendar.freebusy")) {
      return back(returnTo, { error: "Please tick the calendar permissions on Google's screen so we can see when you're busy." });
    }

    const { count } = await db.from("connected_accounts").select("id", { count: "exact", head: true }).eq("user_id", st.user_id);
    const { data: existing } = await db.from("connected_accounts").select("id")
      .eq("user_id", st.user_id).eq("provider", provider).eq("email", t.email).maybeSingle();

    let accountId = existing?.id as string | undefined;
    if (!accountId) {
      const guessLabel = /gmail|outlook|hotmail|live|icloud|yahoo/i.test(t.email.split("@")[1] ?? "") ? "Personal" : "Work";
      const { data: acc, error } = await db.from("connected_accounts").insert({
        user_id: st.user_id,
        provider,
        email: t.email,
        label: guessLabel,
        color: ACCOUNT_COLORS[(count ?? 0) % ACCOUNT_COLORS.length],
      }).select("id").single();
      if (error) throw error;
      accountId = acc.id;
    } else {
      await db.from("connected_accounts").update({ status: "active", last_error: null }).eq("id", accountId);
    }

    const { data: tokRow } = await db.from("account_tokens").select("refresh_token_secret_id").eq("account_id", accountId).maybeSingle();
    const { data: secretId, error: vErr } = await db.rpc("store_refresh_token", {
      p_account_id: accountId,
      p_token: t.refreshToken,
      p_existing: tokRow?.refresh_token_secret_id ?? null,
    });
    if (vErr) throw vErr;
    await db.from("account_tokens").upsert({
      account_id: accountId,
      refresh_token_secret_id: secretId,
      access_token: t.accessToken,
      access_expires_at: new Date(t.expiresAt).toISOString(),
      scopes: t.scope ?? null,
      updated_at: new Date().toISOString(),
    });

    const { data: cal } = await db.from("calendars").upsert({
      user_id: st.user_id,
      account_id: accountId,
      provider_calendar_id: "primary",
      name: provider === "google" ? "Google Calendar" : "Outlook Calendar",
      is_primary: true,
      can_write: true,
    }, { onConflict: "account_id,provider_calendar_id" }).select("id").single();

    // First calendar: create a ready-to-share link so the user has something on day one.
    const { count: linkCount } = await db.from("links").select("id", { count: "exact", head: true }).eq("user_id", st.user_id);
    if (!linkCount && cal) {
      await db.from("links").insert({
        user_id: st.user_id,
        slug: "30min",
        title: "30 minute meeting",
        duration_min: 30,
        write_calendar_id: cal.id,
      });
    }
    await clearBusyCache(st.user_id);
    return back(returnTo, { connected: t.email });
  } catch (e) {
    console.error("oauth callback", e);
    return back(returnTo, { error: e instanceof Error ? e.message.slice(0, 200) : "Connection failed" });
  }
});

route("POST", "/me/accounts/:id/check", async (req, p) => {
  const user = await requireUser(req);
  const { data: acc } = await admin().from("connected_accounts").select("id,user_id,provider,email,label,color,status")
    .eq("id", p.id).eq("user_id", user.id).maybeSingle();
  if (!acc) throw new HttpError(404, "Calendar not found");
  try {
    await getAccessToken(acc as AccountRow);
    await clearBusyCache(user.id);
    const res = await busyForUser(user.id, Date.now(), Date.now() + 7 * 86400000, true);
    const mine = res.find((r) => r.account.id === acc.id);
    if (mine?.error) throw new Error(mine.error);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Check failed" }, 200);
  }
});

route("DELETE", "/me/accounts/:id", async (req, p) => {
  const user = await requireUser(req);
  const db = admin();
  const { data: acc } = await db.from("connected_accounts").select("id").eq("id", p.id).eq("user_id", user.id).maybeSingle();
  if (!acc) throw new HttpError(404, "Calendar not found");
  const { data: tok } = await db.from("account_tokens").select("refresh_token_secret_id").eq("account_id", acc.id).maybeSingle();
  const { error } = await db.from("connected_accounts").delete().eq("id", acc.id);
  if (error) throw new HttpError(400, error.message);
  if (tok?.refresh_token_secret_id) await db.rpc("delete_refresh_token", { p_secret_id: tok.refresh_token_secret_id });
  await clearBusyCache(user.id);
  return json({ ok: true });
});

// ===================================================================================
// Signed-in overview: merged week across every calendar (busy only) + bookings

route("GET", "/me/overview", async (req, _p, url) => {
  const user = await requireUser(req);
  const profile = await loadProfile(user.id);
  const from = Number(url.searchParams.get("from")) || Date.now();
  const to = Math.min(Number(url.searchParams.get("to")) || from + 7 * 86400000, from + 35 * 86400000);
  const live = url.searchParams.get("live") === "1";
  const [busy, bookingsRes, accountsRes] = await Promise.all([
    busyForUser(user.id, from, to, live),
    admin().from("bookings").select("id,title,guest_name,guest_email,start_at,end_at,status,meeting_url,location_text,link_id")
      .eq("user_id", user.id).gte("end_at", new Date(from).toISOString()).lte("start_at", new Date(to).toISOString())
      .order("start_at"),
    admin().from("connected_accounts").select("id,provider,email,label,color,status,last_error").eq("user_id", user.id).order("created_at"),
  ]);
  const busyById = new Map(busy.map((b) => [b.account.id, b]));
  return json({
    profile,
    plan: effectivePlan(profile),
    accounts: (accountsRes.data ?? []).map((a) => ({
      ...a,
      busy: busyById.get(a.id)?.busy ?? [],
      error: busyById.get(a.id)?.error ?? (a.status !== "active" ? a.last_error : null),
    })),
    bookings: bookingsRes.data ?? [],
  });
});

// ===================================================================================
// Public booking page

async function loadPublic(handle: string, slug: string) {
  const db = admin();
  const { data: profile } = await db.from("profiles").select("*").eq("handle", handle.toLowerCase()).maybeSingle();
  if (!profile) throw new HttpError(404, "This booking page doesn't exist");
  const { data: link } = await db.from("links").select("*").eq("user_id", profile.id).eq("slug", slug.toLowerCase()).maybeSingle();
  if (!link || !link.is_active) throw new HttpError(404, "This booking link isn't active");
  if (effectivePlan(profile as Profile) === "inactive") throw new HttpError(403, "This booking page is paused");
  return { profile: profile as Profile, link };
}

function locationLabel(link: Record<string, unknown>) {
  switch (link.location_type) {
    case "auto": return "Video call (link sent on booking)";
    case "custom_url": return "Video call";
    case "phone": return "Phone call";
    case "in_person": return (link.location_value as string) || "In person";
    default: return null;
  }
}

route("GET", "/public/:handle", async (_req, p) => {
  const db = admin();
  const { data: profile } = await db.from("profiles").select("id,handle,full_name,timezone,plan,trial_ends_at")
    .eq("handle", p.handle.toLowerCase()).maybeSingle();
  if (!profile) throw new HttpError(404, "This page doesn't exist");
  const { data: links } = await db.from("links").select("slug,title,description,duration_min,location_type,location_value")
    .eq("user_id", profile.id).eq("is_active", true).order("created_at");
  return json({
    host: { name: profile.full_name || profile.handle, handle: profile.handle, timezone: profile.timezone },
    paused: effectivePlan(profile as Profile) === "inactive",
    links: (links ?? []).map((l) => ({ ...l, location: locationLabel(l), location_value: undefined })),
  });
});

route("GET", "/public/:handle/:slug", async (_req, p, url) => {
  const { profile, link } = await loadPublic(p.handle, p.slug);
  const now = Date.now();
  const from = Math.max(Number(url.searchParams.get("from")) || now, now);
  const to = Math.min(Number(url.searchParams.get("to")) || from + 14 * 86400000, windowEnd(now, link.max_days_ahead));
  const rules = rulesFromLink(link);
  let slots: number[] = [];
  let degraded = false;
  if (to > from) {
    const pad = 86400000;
    const [busy, bookings] = await Promise.all([
      busyForUser(profile.id, from - pad, to + pad),
      confirmedBookings(profile.id, from - pad, to + pad),
    ]);
    degraded = busy.some((b) => b.error);
    slots = generateSlots({
      now,
      hostTz: profile.timezone,
      rules,
      busy: [...busy.flatMap((b) => b.busy), ...bookings],
      linkBookings: bookings.filter((b) => b.link_id === link.id),
      from,
      to,
    });
  }
  return json({
    host: { name: profile.full_name || profile.handle, handle: profile.handle, timezone: profile.timezone },
    link: {
      slug: link.slug,
      title: link.title,
      description: link.description,
      duration_min: link.duration_min,
      location: locationLabel(link),
      ask_phone: link.location_type === "phone",
    },
    window_end: new Date(windowEnd(now, link.max_days_ahead)).toISOString(),
    slots: slots.map((s) => new Date(s).toISOString()),
    degraded,
  });
});

route("POST", "/public/:handle/:slug/book", async (req, p) => {
  const { profile, link } = await loadPublic(p.handle, p.slug);
  const b = await body<Record<string, unknown>>(req);
  const start = Date.parse(str(b.start, "Time", 40));
  if (!Number.isFinite(start)) throw new HttpError(400, "Pick a time");
  const name = str(b.name, "Name", 120);
  const email = str(b.email, "Email", 200).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, "Enter a valid email");
  const phone = optStr(b.phone, 30);
  if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) throw new HttpError(400, "Enter a valid phone number");
  if (link.location_type === "phone" && !phone) throw new HttpError(400, "A phone number is needed for this call");
  const note = optStr(b.note, 1000);
  const guestTz = typeof b.timezone === "string" && isValidTimeZone(b.timezone) ? b.timezone : profile.timezone;

  const now = Date.now();
  const end = start + link.duration_min * 60000;
  const pad = 86400000;
  const [busy, bookings] = await Promise.all([
    busyForUser(profile.id, start - pad, end + pad, true),
    confirmedBookings(profile.id, start - pad, end + pad),
  ]);
  const ok = isSlotAvailable({
    now,
    hostTz: profile.timezone,
    rules: rulesFromLink(link),
    busy: [...busy.flatMap((x) => x.busy), ...bookings],
    linkBookings: bookings.filter((x) => x.link_id === link.id),
  }, start);
  if (!ok) throw new HttpError(409, "Sorry, that time was just taken. Please pick another.");

  const db = admin();
  const location = link.location_type === "custom_url" ? null
    : link.location_type === "phone" ? `Phone call — ${profile.full_name || "host"} will call ${phone}`
    : link.location_type === "in_person" ? link.location_value
    : null;
  const { data: booking, error } = await db.from("bookings").insert({
    user_id: profile.id,
    link_id: link.id,
    title: `${link.title} — ${name}`,
    guest_name: name,
    guest_email: email,
    guest_phone: phone,
    guest_note: note,
    guest_timezone: guestTz,
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString(),
    meeting_url: link.location_type === "custom_url" ? link.location_value : null,
    location_text: location,
  }).select("*").single();
  if (error) {
    if (error.code === "23P01") throw new HttpError(409, "Sorry, that time was just taken. Please pick another.");
    throw error;
  }

  // Write to the chosen calendar (creates Meet/Teams link and sends the guest an invite).
  let written = false;
  if (link.write_calendar_id) {
    const { data: cal } = await db.from("calendars").select("account_id, connected_accounts(id,user_id,provider,email,label,color,status)")
      .eq("id", link.write_calendar_id).maybeSingle();
    const acc = cal?.connected_accounts as unknown as AccountRow | undefined;
    if (acc) {
      try {
        const token = await getAccessToken(acc);
        const ev = await createEvent(acc.provider, token, {
          title: booking.title,
          description: [
            `Booked with ${env.productName}.`,
            note ? `Note from ${name}: ${note}` : "",
            phone ? `Phone: ${phone}` : "",
            `Manage: ${env.siteUrl}/b/${booking.manage_token}`,
          ].filter(Boolean).join("\n\n"),
          start,
          end,
          hostTz: profile.timezone,
          guestName: name,
          guestEmail: email,
          wantVideo: link.location_type === "auto",
          location: booking.meeting_url ?? location,
          requestId: booking.id,
        });
        const { data: upd } = await db.from("bookings").update({
          provider_event_id: ev.eventId,
          meeting_url: booking.meeting_url ?? ev.meetingUrl,
          write_account_id: acc.id,
          write_calendar_provider_id: "primary",
        }).eq("id", booking.id).select("*").single();
        if (upd) Object.assign(booking, upd);
        written = true;
      } catch (e) {
        console.error("event write failed", e);
      }
    }
  }

  await clearBusyCache(profile.id);
  await enqueueForBooking(profile, booking as BookingRow);
  // send confirmations now rather than waiting for the cron
  await processOutbox({ bookingId: booking.id, attachIcs: !written });

  const w = fmtWhen(booking.start_at, guestTz);
  return json({
    ok: true,
    booking: {
      title: link.title,
      when: w.full,
      start_at: booking.start_at,
      end_at: booking.end_at,
      meeting_url: booking.meeting_url,
      location: booking.location_text,
      manage_url: `${env.siteUrl}/b/${booking.manage_token}`,
      host: profile.full_name || profile.handle,
    },
  });
});

// Guest manage page
route("GET", "/manage/:token", async (_req, p) => {
  const db = admin();
  const { data: b } = await db.from("bookings").select("*").eq("manage_token", p.token).maybeSingle();
  if (!b) throw new HttpError(404, "Booking not found");
  const { data: prof } = await db.from("profiles").select("handle,full_name,timezone").eq("id", b.user_id).single();
  const { data: link } = b.link_id ? await db.from("links").select("slug,title").eq("id", b.link_id).maybeSingle() : { data: null };
  return json({
    title: link?.title ?? b.title,
    start_at: b.start_at,
    end_at: b.end_at,
    status: b.status,
    meeting_url: b.meeting_url,
    location: b.location_text,
    guest_name: b.guest_name,
    host: prof?.full_name || prof?.handle,
    rebook_url: link ? `${env.siteUrl}/${prof?.handle}/${link.slug}` : null,
    can_cancel: b.status === "confirmed" && Date.parse(b.start_at) > Date.now(),
  });
});

async function cancelBooking(b: BookingRow & { write_account_id: string | null }, by: "host" | "guest", reason: string | null) {
  const db = admin();
  if (b.provider_event_id && b.write_account_id) {
    const { data: acc } = await db.from("connected_accounts").select("id,user_id,provider,email,label,color,status")
      .eq("id", b.write_account_id).maybeSingle();
    if (acc) {
      try {
        await deleteEvent(acc.provider as Provider, await getAccessToken(acc as AccountRow), b.provider_event_id);
      } catch (e) {
        console.error("delete event failed", e);
      }
    }
  }
  await db.from("bookings").update({
    status: "cancelled",
    cancelled_by: by,
    cancel_reason: reason,
    cancelled_at: new Date().toISOString(),
  }).eq("id", b.id);
  const profile = await loadProfile(b.user_id);
  await enqueueCancellation(profile, b, by);
  await clearBusyCache(b.user_id);
  await processOutbox({ bookingId: b.id, attachIcs: !b.provider_event_id });
}

route("POST", "/manage/:token/cancel", async (req, p) => {
  const b = await body<{ reason?: string }>(req);
  const { data: booking } = await admin().from("bookings").select("*").eq("manage_token", p.token).maybeSingle();
  if (!booking) throw new HttpError(404, "Booking not found");
  if (booking.status !== "confirmed") return json({ ok: true });
  if (Date.parse(booking.start_at) <= Date.now()) throw new HttpError(400, "This meeting has already started");
  await cancelBooking(booking, "guest", optStr(b.reason, 500));
  return json({ ok: true });
});

route("POST", "/me/bookings/:id/cancel", async (req, p) => {
  const user = await requireUser(req);
  const b = await body<{ reason?: string }>(req);
  const { data: booking } = await admin().from("bookings").select("*").eq("id", p.id).eq("user_id", user.id).maybeSingle();
  if (!booking) throw new HttpError(404, "Booking not found");
  if (booking.status !== "confirmed") return json({ ok: true });
  await cancelBooking(booking, "host", optStr(b.reason, 500));
  return json({ ok: true });
});

// Send yourself a test reminder on a channel
route("POST", "/me/test-reminder", async (req) => {
  const user = await requireUser(req);
  const profile = await loadProfile(user.id);
  const b = await body<{ channel?: string }>(req);
  const channel = b.channel === "whatsapp" || b.channel === "sms" ? b.channel : "email";
  const fake: BookingRow = {
    id: "test",
    user_id: user.id,
    title: "Test meeting",
    guest_name: "Alex Example",
    guest_email: "alex@example.com",
    guest_phone: null,
    guest_note: null,
    guest_timezone: null,
    start_at: new Date(Date.now() + 3600000).toISOString(),
    end_at: new Date(Date.now() + 5400000).toISOString(),
    status: "confirmed",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    location_text: null,
    manage_token: "test",
    provider_event_id: null,
  };
  if (channel === "email") {
    if (!profile.email) throw new HttpError(400, "No email on your profile");
    const m = renderEmail(profile, fake, "host", "reminder_1h");
    await sendEmail(profile.email, m.subject, m.html, m.text);
  } else {
    if (!profile.phone_e164) throw new HttpError(400, "Add your mobile number first");
    if (!(await addonAllowed(profile, channel))) {
      throw new HttpError(403, channel === "whatsapp" ? "WhatsApp reminders aren't available on your plan yet" : "SMS reminders aren't available on your plan yet");
    }
    if (channel === "whatsapp") await sendWhatsApp(profile.phone_e164, waParams(profile, fake, "host", "reminder_1h"));
    else await sendSms(profile.phone_e164, renderShort(profile, fake, "host", "reminder_1h"));
  }
  return json({ ok: true });
});

// ===================================================================================
// Outbox processing (cron every few minutes + immediately after booking)

function waParams(profile: Profile, b: BookingRow, recipient: "host" | "guest", kind: Kind): string[] {
  const s = renderShort(profile, b, recipient, kind).split("\n");
  return [s[0] ?? "", s[1] ?? "", (s[2] ?? "").replace(/^Join: /, "") || "See your calendar invite"];
}

async function processOutbox(opts: { bookingId?: string; attachIcs?: boolean } = {}) {
  const db = admin();
  let q = db.from("notification_outbox").select("*").eq("status", "pending").lte("send_at", new Date().toISOString())
    .order("send_at").limit(50);
  if (opts.bookingId) q = q.eq("booking_id", opts.bookingId);
  const { data: due } = await q;
  let sent = 0, failed = 0, skipped = 0;

  for (const job of due ?? []) {
    // claim
    const { data: claimed } = await db.from("notification_outbox").update({ status: "sending", attempts: job.attempts + 1 })
      .eq("id", job.id).eq("status", "pending").select("id");
    if (!claimed?.length) continue;
    const finish = (status: string, extra: Record<string, unknown> = {}) =>
      db.from("notification_outbox").update({ status, ...extra }).eq("id", job.id);
    try {
      const { data: booking } = await db.from("bookings").select("*").eq("id", job.booking_id).maybeSingle();
      if (!booking) { await finish("skipped", { last_error: "Booking gone" }); skipped++; continue; }
      if (job.kind !== "cancellation" && booking.status !== "confirmed") {
        await finish("skipped", { last_error: "Booking cancelled" }); skipped++; continue;
      }
      const profile = await loadProfile(job.user_id);
      const recipient = job.recipient as "host" | "guest";
      const kind = job.kind as Kind;
      let providerId: string | undefined;

      if (job.channel === "email") {
        const to = recipient === "host" ? profile.email : booking.guest_email;
        if (!to) { await finish("skipped", { last_error: "No email" }); skipped++; continue; }
        const m = renderEmail(profile, booking, recipient, kind);
        const attach = opts.attachIcs && recipient === "guest" && (kind === "confirmation" || kind === "cancellation")
          ? [{
            filename: "invite.ics",
            content: btoa(buildIcs(booking, profile.full_name || profile.handle, profile.email ?? "no-reply@kairohr.co",
              kind === "cancellation" ? "CANCEL" : "REQUEST")),
          }]
          : undefined;
        providerId = await sendEmail(to, m.subject, m.html, m.text, attach);
      } else {
        const phone = recipient === "host" ? profile.phone_e164 : booking.guest_phone;
        if (!phone || !(await addonAllowed(profile, job.channel))) {
          await finish("skipped", { last_error: phone ? "Add-on not active or monthly cap reached" : "No phone number" });
          skipped++;
          continue;
        }
        const e164 = phone.startsWith("+") ? phone.replace(/[^\d+]/g, "") : phone.replace(/\D/g, "");
        if (!e164.startsWith("+")) { await finish("skipped", { last_error: "Phone needs a country code" }); skipped++; continue; }
        providerId = job.channel === "whatsapp"
          ? await sendWhatsApp(e164, waParams(profile, booking, recipient, kind))
          : await sendSms(e164, renderShort(profile, booking, recipient, kind));
      }
      await finish("sent", { sent_at: new Date().toISOString(), provider_message_id: providerId ?? null, last_error: null });
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retry = job.attempts + 1 < 3;
      await finish(retry ? "pending" : "failed", {
        last_error: msg.slice(0, 300),
        send_at: new Date(Date.now() + 5 * 60000).toISOString(),
      });
      failed++;
    }
  }
  return { sent, failed, skipped };
}

route("POST", "/cron/reminders", async (req) => {
  const { data: secret } = await admin().rpc("read_cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) throw new HttpError(401, "Unauthorised");
  const { data: on } = await admin().from("app_settings").select("value").eq("key", "reminders_enabled").maybeSingle();
  if (on?.value === false) return json({ paused: true });
  // stale oauth states
  await admin().from("oauth_states").delete().lt("created_at", new Date(Date.now() - 3600000).toISOString());
  await admin().from("busy_cache").delete().lt("fetched_at", new Date(Date.now() - 86400000).toISOString());
  return json(await processOutbox());
});

// ===================================================================================
// Billing (Stripe)

route("POST", "/billing/checkout", async (req) => {
  const user = await requireUser(req);
  const profile = await loadProfile(user.id);
  const b = await body<{ plan?: string; interval?: string }>(req);
  const plan = b.plan === "premium" ? "premium" : "basic";
  const interval = b.interval === "year" ? "year" : "month";
  const db = admin();
  const { data: sub } = await db.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();
  let customer = sub?.stripe_customer_id as string | undefined;
  if (!customer) {
    const c = await stripe<{ id: string }>("POST", "customers", {
      email: profile.email ?? user.email ?? undefined,
      name: profile.full_name ?? undefined,
      metadata: { user_id: user.id },
    });
    customer = c.id;
    await db.from("subscriptions").upsert({ user_id: user.id, stripe_customer_id: customer, updated_at: new Date().toISOString() });
  }
  if (sub?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(sub.status ?? "")) {
    const portal = await stripe<{ url: string }>("POST", "billing_portal/sessions", {
      customer,
      return_url: `${env.siteUrl}/app/settings`,
    });
    return json({ url: portal.url });
  }
  const session = await stripe<{ url: string }>("POST", "checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: { 0: { price: env.stripePrice(plan, interval), quantity: 1 } },
    subscription_data: { metadata: { user_id: user.id } },
    allow_promotion_codes: "true",
    success_url: `${env.siteUrl}/app/settings?billing=success`,
    cancel_url: `${env.siteUrl}/app/settings?billing=cancelled`,
  });
  return json({ url: session.url });
});

route("POST", "/billing/portal", async (req) => {
  const user = await requireUser(req);
  const { data: sub } = await admin().from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
  if (!sub?.stripe_customer_id) throw new HttpError(400, "No billing account yet");
  const portal = await stripe<{ url: string }>("POST", "billing_portal/sessions", {
    customer: sub.stripe_customer_id,
    return_url: `${env.siteUrl}/app/settings`,
  });
  return json({ url: portal.url });
});

function planForPrice(priceId: string): { plan: "basic" | "premium"; interval: "month" | "year" } | null {
  for (const plan of ["basic", "premium"] as const) {
    for (const interval of ["month", "year"] as const) {
      try {
        if (env.stripePrice(plan, interval) === priceId) return { plan, interval };
      } catch { /* not configured */ }
    }
  }
  return null;
}

async function syncSubscription(subId: string) {
  const s = await stripe<Record<string, any>>("GET", `subscriptions/${subId}`);
  const userId = s.metadata?.user_id as string | undefined;
  const db = admin();
  let uid = userId;
  if (!uid) {
    const { data } = await db.from("subscriptions").select("user_id").eq("stripe_customer_id", s.customer).maybeSingle();
    uid = data?.user_id;
  }
  if (!uid) return;
  const item = s.items?.data?.[0];
  const mapped = item ? planForPrice(item.price.id) : null;
  const periodEnd = item?.current_period_end ?? s.current_period_end;
  await db.from("subscriptions").upsert({
    user_id: uid,
    stripe_customer_id: s.customer,
    stripe_subscription_id: s.id,
    plan: mapped?.plan ?? null,
    interval: mapped?.interval ?? null,
    status: s.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  const active = ["active", "trialing", "past_due"].includes(s.status);
  const { data: prof } = await db.from("profiles").select("plan,trial_ends_at").eq("id", uid).single();
  let plan: string;
  if (active && mapped) plan = mapped.plan;
  else plan = prof && new Date(prof.trial_ends_at).getTime() > Date.now() ? "trial" : "inactive";
  await db.from("profiles").update({ plan }).eq("id", uid);
}

route("POST", "/webhooks/stripe", async (req) => {
  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), env.stripeWebhookSecret);
  if (!ok) throw new HttpError(400, "Bad signature");
  const event = JSON.parse(payload);
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed":
      if (obj.subscription) await syncSubscription(obj.subscription);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(obj.id);
      break;
  }
  return json({ received: true });
});

// ===================================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, "") || "/";
  try {
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(path);
      if (m) return await h(req, (m.groups ?? {}) as Record<string, string>, url);
    }
    throw new HttpError(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof ProviderAuthError) return json({ error: "A calendar connection needs to be refreshed" }, 409);
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
