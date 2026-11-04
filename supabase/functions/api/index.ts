// Kairo Link API — one Edge Function, routed by path.
// Public site proxies https://<site>/api/* to this function (see netlify.toml).

import { admin, effectivePlan, type Profile, requireUser } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { body, HttpError, isEmail, json, optStr, preflight, randomToken, redirect, str } from "../_shared/http.ts";
import { authUrl, type CalEvent, createEvent, deleteEvent, exchangeCode, fetchEvents, type Provider, ProviderAuthError } from "../_shared/providers.ts";
import { type AccountRow, busyForUser, clearBusyCache, getAccessToken } from "../_shared/accounts.ts";
import { generateSlots, type Interval, isSlotAvailable, type LinkRules, windowEnd } from "../_shared/slots.ts";
import { isValidTimeZone, zonedToUtc } from "../_shared/tz.ts";
import {
  addonAllowed,
  type BookingRow,
  buildIcs,
  enqueueCancellation,
  enqueueForBooking,
  type EventSnapshot,
  fmtWhen,
  type Kind,
  normalizePrefs,
  renderEmail,
  renderEventEmail,
  renderEventShort,
  renderInviteEmail,
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

// ---- group links ----

const MAX_MEMBERS = 10;

function displayName(p: { full_name: string | null; handle?: string; email: string | null }) {
  return p.full_name || p.email?.split("@")[0] || p.handle || "Someone";
}

async function activeMembers(linkId: string): Promise<{ id: string; user_id: string; name: string; email: string }[]> {
  const db = admin();
  const { data } = await db.from("link_members").select("id,user_id").eq("link_id", linkId).eq("status", "active");
  const ids = (data ?? []).map((m) => m.user_id).filter(Boolean) as string[];
  if (!ids.length) return [];
  const [{ data: profs }, { data: accs }] = await Promise.all([
    db.from("profiles").select("id,full_name,email,handle").in("id", ids),
    db.from("connected_accounts").select("user_id,email,created_at").in("user_id", ids).order("created_at"),
  ]);
  return (data ?? []).filter((m) => m.user_id).map((m) => {
    const p = (profs ?? []).find((x) => x.id === m.user_id);
    const mine = (accs ?? []).filter((a) => a.user_id === m.user_id);
    // invite goes to the calendar they sign in with, else their first connected calendar
    const email = mine.find((a) => a.email === p?.email)?.email ?? mine[0]?.email ?? p?.email ?? "";
    return { id: m.id, user_id: m.user_id as string, name: p ? displayName(p) : "Someone", email };
  });
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/** Busy times + bookings across the owner and every active member. */
async function groupBusy(ownerId: string, memberIds: string[], from: number, to: number, live = false) {
  const users = [ownerId, ...memberIds];
  const [busyLists, bookingLists] = await Promise.all([
    Promise.all(users.map((u) => busyForUser(u, from, to, live))),
    Promise.all(users.map((u) => confirmedBookings(u, from, to))),
  ]);
  const ownerBookings = bookingLists[0];
  return {
    busy: [...busyLists.flat().flatMap((b) => b.busy), ...bookingLists.flat()],
    ownerBookings,
    degraded: busyLists.flat().some((b) => b.error),
  };
}

route("GET", "/health", async () => json({ ok: true, product: env.productName }));

// ===================================================================================
// Connecting calendars

route("POST", "/me/connect", async (req) => {
  const user = await requireUser(req);
  const b = await body<{ provider?: string; loginHint?: string; returnTo?: string }>(req);
  const provider = b.provider === "microsoft" ? "microsoft" : b.provider === "google" ? "google" : null;
  if (!provider) throw new HttpError(400, "Choose Google or Microsoft");
  const state = randomToken(24);
  const returnTo = typeof b.returnTo === "string" && /^\/(app|invite\/)/.test(b.returnTo) ? b.returnTo : "/app/calendars";
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
    const msg = (e as { message?: string })?.message ?? "Connection failed";
    return back(returnTo, { error: msg.replace(/^FREE_LIMIT_[A-Z]+:\s*/, "").slice(0, 200) });
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
    admin().from("bookings").select("id,title,guest_name,guest_email,start_at,end_at,status,meeting_url,location_text,link_id,write_account_id")
      .eq("user_id", user.id).gte("end_at", new Date(from).toISOString()).lte("start_at", new Date(to).toISOString())
      .order("start_at"),
    admin().from("connected_accounts").select("id,provider,email,label,color,status,last_error,show_details").eq("user_id", user.id).order("created_at"),
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

// Event details for the signed-in owner (Google Calendar-style view). Fetched live, never stored.
route("GET", "/me/events", async (req, _p, url) => {
  const user = await requireUser(req);
  const profile = await loadProfile(user.id);
  const from = Number(url.searchParams.get("from")) || Date.now();
  const to = Math.min(Number(url.searchParams.get("to")) || from + 7 * 86400000, from + 35 * 86400000);
  const { data: accounts } = await admin().from("connected_accounts")
    .select("id,user_id,provider,email,label,color,status,show_details").eq("user_id", user.id);
  const results = await Promise.all((accounts ?? []).filter((a) => a.show_details).map(async (a) => {
    try {
      const token = await getAccessToken(a as AccountRow);
      const events: CalEvent[] = await fetchEvents(a.provider as Provider, token, from, to, profile.timezone, zonedToUtc);
      return { account_id: a.id, events };
    } catch (e) {
      return { account_id: a.id, events: [] as CalEvent[], error: e instanceof Error ? e.message : "Could not load events" };
    }
  }));
  return json({ accounts: results }, 200, { "cache-control": "no-store" });
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
  const { data: links } = await db.from("links").select("id,slug,title,description,duration_min,location_type,location_value")
    .eq("user_id", profile.id).eq("is_active", true).order("created_at");
  const hostName = profile.full_name || profile.handle;
  const withPeople = await Promise.all((links ?? []).map(async (l) => {
    const members = await activeMembers(l.id);
    return {
      ...l,
      id: undefined,
      location: locationLabel(l),
      location_value: undefined,
      people: members.length ? [hostName, ...members.map((m) => m.name)] : [],
    };
  }));
  return json({
    host: { name: hostName, handle: profile.handle, timezone: profile.timezone },
    paused: effectivePlan(profile as Profile) === "inactive",
    links: withPeople,
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
  const members = await activeMembers(link.id);
  if (to > from) {
    const pad = 86400000;
    const g = await groupBusy(profile.id, members.map((m) => m.user_id), from - pad, to + pad);
    degraded = g.degraded;
    slots = generateSlots({
      now,
      hostTz: profile.timezone,
      rules,
      busy: g.busy,
      linkBookings: g.ownerBookings.filter((b) => b.link_id === link.id),
      from,
      to,
    });
  }
  const hostName = profile.full_name || profile.handle;
  return json({
    host: { name: hostName, handle: profile.handle, timezone: profile.timezone },
    people: members.length ? [hostName, ...members.map((m) => m.name)] : [],
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
  const members = await activeMembers(link.id);
  const g = await groupBusy(profile.id, members.map((m) => m.user_id), start - pad, end + pad, true);
  const ok = isSlotAvailable({
    now,
    hostTz: profile.timezone,
    rules: rulesFromLink(link),
    busy: g.busy,
    linkBookings: g.ownerBookings.filter((x) => x.link_id === link.id),
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
            members.length ? `With ${joinNames([profile.full_name || profile.handle, ...members.map((m) => m.name)])}.` : "",
            note ? `Note from ${name}: ${note}` : "",
            phone ? `Phone: ${phone}` : "",
            `Manage: ${env.siteUrl}/b/${booking.manage_token}`,
          ].filter(Boolean).join("\n\n"),
          start,
          end,
          hostTz: profile.timezone,
          guestName: name,
          guestEmail: email,
          extraAttendees: members.filter((m) => m.email).map((m) => ({ email: m.email, name: m.name })),
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
  for (const m of members) await clearBusyCache(m.user_id);
  await enqueueForBooking(profile, booking as BookingRow, members.map((m) => m.user_id));
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
      host: joinNames([profile.full_name || profile.handle, ...members.map((m) => m.name)]),
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
  const linkId = (b as unknown as { link_id: string | null }).link_id;
  const members = linkId ? await activeMembers(linkId) : [];
  await enqueueCancellation(profile, b, by, members.map((m) => m.user_id));
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
async function ownLink(userId: string, linkId: string) {
  const { data: link } = await admin().from("links").select("*").eq("id", linkId).eq("user_id", userId).maybeSingle();
  if (!link) throw new HttpError(404, "Link not found");
  return link;
}

async function membersFor(linkId: string) {
  const db = admin();
  const { data } = await db.from("link_members").select("id,email,status,user_id,invited_at,joined_at").eq("link_id", linkId).order("invited_at");
  const ids = (data ?? []).map((m) => m.user_id).filter(Boolean) as string[];
  const { data: profs } = ids.length ? await db.from("profiles").select("id,full_name,email,handle").in("id", ids) : { data: [] };
  return (data ?? []).map((m) => {
    const p = (profs ?? []).find((x) => x.id === m.user_id);
    return { id: m.id, email: m.email, status: m.status, name: p ? displayName(p) : null, joined_at: m.joined_at };
  });
}

async function sendInvite(owner: Profile, link: Record<string, unknown>, email: string, token: string) {
  const mail = renderInviteEmail(owner.full_name || owner.handle, link.title as string, link.duration_min as number, `${env.siteUrl}/invite/${token}`);
  await sendEmail(email, mail.subject, mail.html, mail.text);
}

route("GET", "/me/links/:id/members", async (req, p) => {
  const user = await requireUser(req);
  await ownLink(user.id, p.id);
  return json({ members: await membersFor(p.id) });
});

route("POST", "/me/links/:id/members", async (req, p) => {
  const user = await requireUser(req);
  const owner = await loadProfile(user.id);
  const link = await ownLink(user.id, p.id);
  if (effectivePlan(owner) !== "premium") throw new HttpError(403, "Group links are part of Premium. Go Premium to add people to a link.");
  const b = await body<{ emails?: unknown }>(req);
  const raw = Array.isArray(b.emails) ? b.emails : [];
  const emails = Array.from(new Set(raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean)));
  const bad = emails.find((e) => !isEmail(e));
  if (bad) throw new HttpError(400, `“${bad}” doesn't look like an email address`);
  const { data: myAccounts } = await admin().from("connected_accounts").select("email").eq("user_id", user.id);
  const mine = new Set([owner.email, ...(myAccounts ?? []).map((a) => a.email)].filter(Boolean));
  const add = emails.filter((e) => !mine.has(e));
  const db = admin();
  const { data: existing } = await db.from("link_members").select("id,email,status,invite_token").eq("link_id", link.id);
  const current = (existing ?? []).filter((m) => m.status !== "declined");
  const fresh = add.filter((e) => !current.some((m) => m.email === e));
  if (current.length + fresh.length > MAX_MEMBERS) throw new HttpError(400, `A link can include up to ${MAX_MEMBERS} other people.`);
  for (const email of fresh) {
    const prev = (existing ?? []).find((m) => m.email === email);
    const { data: row, error } = prev
      ? await db.from("link_members").update({ status: "invited", user_id: null, invited_at: new Date().toISOString(), joined_at: null })
        .eq("id", prev.id).select("invite_token").single()
      : await db.from("link_members").insert({ link_id: link.id, email }).select("invite_token").single();
    if (error) throw error;
    try {
      await sendInvite(owner, link, email, row.invite_token);
    } catch (e) {
      console.error("invite email", e);
    }
  }
  return json({ members: await membersFor(link.id), added: fresh.length });
});

route("POST", "/me/links/:id/members/:mid/resend", async (req, p) => {
  const user = await requireUser(req);
  const owner = await loadProfile(user.id);
  const link = await ownLink(user.id, p.id);
  const { data: m } = await admin().from("link_members").select("*").eq("id", p.mid).eq("link_id", link.id).maybeSingle();
  if (!m) throw new HttpError(404, "Person not found");
  if (m.status === "active") return json({ ok: true });
  await admin().from("link_members").update({ status: "invited" }).eq("id", m.id);
  await sendInvite(owner, link, m.email, m.invite_token);
  return json({ ok: true });
});

route("DELETE", "/me/members/:mid", async (req, p) => {
  const user = await requireUser(req);
  const db = admin();
  const { data: m } = await db.from("link_members").select("id,user_id,link_id").eq("id", p.mid).maybeSingle();
  if (!m) throw new HttpError(404, "Not found");
  const { data: link } = await db.from("links").select("user_id").eq("id", m.link_id).maybeSingle();
  if (m.user_id !== user.id && link?.user_id !== user.id) throw new HttpError(403, "You can't change this link");
  await db.from("link_members").delete().eq("id", m.id);
  return json({ ok: true });
});

route("GET", "/me/shared-links", async (req) => {
  const user = await requireUser(req);
  const db = admin();
  const { data: rows } = await db.from("link_members").select("id,link_id,joined_at").eq("user_id", user.id).eq("status", "active");
  const out = [];
  for (const r of rows ?? []) {
    const { data: link } = await db.from("links").select("id,user_id,slug,title,description,duration_min,is_active").eq("id", r.link_id).maybeSingle();
    if (!link) continue;
    const { data: owner } = await db.from("profiles").select("full_name,handle,email").eq("id", link.user_id).single();
    const members = await activeMembers(link.id);
    const ownerName = owner ? displayName(owner) : "Someone";
    out.push({
      member_id: r.id,
      title: link.title,
      description: link.description,
      duration_min: link.duration_min,
      is_active: link.is_active,
      owner: ownerName,
      url: `${env.siteUrl}/${owner?.handle}/${link.slug}`,
      people: [ownerName, ...members.map((m) => m.name)],
    });
  }
  return json({ links: out });
});

route("GET", "/invites/:token", async (_req, p) => {
  const db = admin();
  const { data: m } = await db.from("link_members").select("*").eq("invite_token", p.token).maybeSingle();
  if (!m) throw new HttpError(404, "This invite link isn't valid any more. Ask for a new one.");
  const { data: link } = await db.from("links").select("id,user_id,title,description,duration_min").eq("id", m.link_id).maybeSingle();
  if (!link) throw new HttpError(404, "This call link has been deleted.");
  const { data: owner } = await db.from("profiles").select("full_name,handle,email").eq("id", link.user_id).single();
  const members = await activeMembers(link.id);
  return json({
    email: m.email,
    status: m.status,
    joined_user_id: m.user_id,
    owner: owner ? displayName(owner) : "Someone",
    owner_user_id: link.user_id,
    link: { title: link.title, description: link.description, duration_min: link.duration_min },
    people: members.map((x) => x.name),
  });
});

route("POST", "/invites/:token/accept", async (req, p) => {
  const user = await requireUser(req);
  const db = admin();
  const { data: m } = await db.from("link_members").select("*").eq("invite_token", p.token).maybeSingle();
  if (!m) throw new HttpError(404, "This invite link isn't valid any more. Ask for a new one.");
  const { data: link } = await db.from("links").select("user_id").eq("id", m.link_id).maybeSingle();
  if (!link) throw new HttpError(404, "This call link has been deleted.");
  if (link.user_id === user.id) throw new HttpError(400, "This is your own link.");
  if (m.status === "active" && m.user_id && m.user_id !== user.id) throw new HttpError(409, "Someone has already joined with this invite.");
  const { count } = await db.from("connected_accounts").select("id", { count: "exact", head: true }).eq("user_id", user.id);
  if (!count) throw new HttpError(400, "Connect a calendar first, so people only see times when you're free.");
  const { data: dup } = await db.from("link_members").select("id").eq("link_id", m.link_id).eq("user_id", user.id).neq("id", m.id).maybeSingle();
  if (dup) await db.from("link_members").delete().eq("id", m.id);
  else await db.from("link_members").update({ user_id: user.id, status: "active", joined_at: new Date().toISOString() }).eq("id", m.id);
  return json({ ok: true });
});

route("POST", "/invites/:token/decline", async (_req, p) => {
  const { data: m } = await admin().from("link_members").select("id,status").eq("invite_token", p.token).maybeSingle();
  if (!m) throw new HttpError(404, "This invite link isn't valid any more.");
  await admin().from("link_members").update({ status: "declined", user_id: null, joined_at: null }).eq("id", m.id);
  return json({ ok: true });
});

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
    start_at: new Date(Date.now() + 1800000).toISOString(),
    end_at: new Date(Date.now() + 3600000).toISOString(),
    status: "confirmed",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    location_text: null,
    manage_token: "test",
    provider_event_id: null,
  };
  if (channel === "email") {
    if (!profile.email) throw new HttpError(400, "No email on your profile");
    const m = renderEmail(profile, fake, "host", "reminder", 30);
    await sendEmail(profile.email, m.subject, m.html, m.text);
  } else {
    if (!profile.phone_e164) throw new HttpError(400, "Add your mobile number first");
    if (!(await addonAllowed(profile, channel))) {
      throw new HttpError(403, channel === "whatsapp" ? "WhatsApp reminders aren't available on your plan yet" : "SMS reminders aren't available on your plan yet");
    }
    if (channel === "whatsapp") await sendWhatsApp(profile.phone_e164, waParams(renderShort(profile, fake, "host", "reminder", 30)));
    else await sendSms(profile.phone_e164, renderShort(profile, fake, "host", "reminder", 30));
  }
  return json({ ok: true });
});

// ===================================================================================
// Outbox processing (cron every few minutes + immediately after booking)

function waParams(short: string): string[] {
  const s = short.split("\n");
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
      if (job.kind === "event_reminder") {
        const profile = await loadProfile(job.user_id);
        const ev = job.event as EventSnapshot | null;
        if (!ev) { await finish("skipped", { last_error: "No event" }); skipped++; continue; }
        let providerId: string | undefined;
        if (job.channel === "email") {
          if (!profile.email) { await finish("skipped", { last_error: "No email", event: null }); skipped++; continue; }
          const m = renderEventEmail(profile, ev, job.offset_min ?? 30);
          providerId = await sendEmail(profile.email, m.subject, m.html, m.text);
        } else {
          if (!profile.phone_e164 || !(await addonAllowed(profile, job.channel))) {
            await finish("skipped", { last_error: profile.phone_e164 ? "Add-on not active or monthly cap reached" : "No phone number", event: null });
            skipped++;
            continue;
          }
          const short = renderEventShort(profile, ev, job.offset_min ?? 30);
          providerId = job.channel === "whatsapp" ? await sendWhatsApp(profile.phone_e164, waParams(short)) : await sendSms(profile.phone_e164, short);
        }
        await finish("sent", { sent_at: new Date().toISOString(), provider_message_id: providerId ?? null, last_error: null, event: null });
        sent++;
        continue;
      }
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
        const m = renderEmail(profile, booking, recipient, kind, job.offset_min);
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
        const short = renderShort(profile, booking, recipient, kind, job.offset_min);
        providerId = job.channel === "whatsapp" ? await sendWhatsApp(e164, waParams(short)) : await sendSms(e164, short);
      }
      await finish("sent", { sent_at: new Date().toISOString(), provider_message_id: providerId ?? null, last_error: null });
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retry = job.attempts + 1 < 3;
      await finish(retry ? "pending" : "failed", {
        ...(retry ? {} : { event: null }),
        last_error: msg.slice(0, 300),
        send_at: new Date(Date.now() + 5 * 60000).toISOString(),
      });
      failed++;
    }
  }
  return { sent, failed, skipped };
}


// ---- host reminders: created from current settings just before they are due ----

const EVENT_CACHE_MS = 10 * 60000;

async function upcomingEvents(userId: string, from: number, to: number): Promise<(EventSnapshot & { account_id: string })[]> {
  const db = admin();
  const { data: accounts } = await db.from("connected_accounts")
    .select("id,user_id,provider,email,label,color,status,show_details").eq("user_id", userId).eq("show_details", true);
  const out: (EventSnapshot & { account_id: string })[] = [];
  for (const a of accounts ?? []) {
    if (a.status === "revoked") continue;
    const { data: c } = await db.from("event_cache").select("*").eq("account_id", a.id).maybeSingle();
    let events: EventSnapshot[];
    if (c && Date.now() - Date.parse(c.fetched_at) < EVENT_CACHE_MS && Date.parse(c.range_start) <= from && Date.parse(c.range_end) >= to) {
      events = c.events as EventSnapshot[];
    } else {
      try {
        const rangeFrom = Date.now() - 3600000;
        const rangeTo = Date.now() + 26 * 3600000;
        const token = await getAccessToken(a as AccountRow);
        const { data: prof } = await db.from("profiles").select("timezone").eq("id", userId).single();
        const raw = await fetchEvents(a.provider as Provider, token, rangeFrom, rangeTo, prof?.timezone ?? "Europe/London", zonedToUtc);
        events = raw.filter((e) => !e.allDay && !e.declined && !e.free).map((e) => ({
          id: e.id,
          title: e.title.slice(0, 150),
          start: e.start,
          end: e.end,
          join_url: e.joinUrl,
          location: e.location ? e.location.slice(0, 200) : null,
          account_label: a.label,
        }));
        await db.from("event_cache").upsert({
          account_id: a.id,
          range_start: new Date(rangeFrom).toISOString(),
          range_end: new Date(rangeTo).toISOString(),
          events,
          fetched_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error("event scan", a.id, e);
        continue;
      }
    }
    for (const e of events) if (e.start >= from && e.start <= to) out.push({ ...e, account_id: a.id });
  }
  return out;
}

async function scanReminders() {
  const db = admin();
  const now = Date.now();
  const LEAD = 60000; // create up to a minute early
  const LATE = 5 * 60000; // still send if we are up to 5 minutes late
  const { data: profiles } = await db.from("profiles").select("*");
  let queued = 0;
  for (const raw of profiles ?? []) {
    const profile = raw as Profile;
    try {
      const prefs = normalizePrefs(profile.reminder_prefs);
      const premium = effectivePlan(profile) === "premium" || effectivePlan(profile) === "trial";
      const channels = (["email", "whatsapp", "sms"] as const)
        .filter((ch) => prefs[ch].length && (ch === "email" || (premium && profile.phone_e164)));
      if (!channels.length) continue;
      const maxOff = Math.max(...channels.flatMap((ch) => prefs[ch]));
      const from = now;
      const to = now + maxOff * 60000 + LEAD;
      const rows: Record<string, unknown>[] = [];
      const due = (start: number, off: number) => {
        const at = start - off * 60000;
        return at <= now + LEAD && at > now - LATE && start > now;
      };

      const { data: bookings } = await db.from("bookings").select("id,start_at,provider_event_id")
        .eq("user_id", profile.id).eq("status", "confirmed")
        .gt("start_at", new Date(from).toISOString()).lte("start_at", new Date(to).toISOString());
      for (const b of bookings ?? []) {
        const start = Date.parse(b.start_at);
        for (const ch of channels) for (const off of prefs[ch]) {
          if (!due(start, off)) continue;
          rows.push({
            user_id: profile.id, booking_id: b.id, recipient: "host", channel: ch, kind: "reminder", offset_min: off,
            send_at: new Date(start - off * 60000).toISOString(),
            dedupe_key: `r:${b.id}:${ch}:${off}`,
          });
        }
      }
      // bookings on group links this person has joined
      const { data: memberOf } = await db.from("link_members").select("link_id").eq("user_id", profile.id).eq("status", "active");
      if (memberOf?.length) {
        const { data: groupBookings } = await db.from("bookings").select("id,start_at,provider_event_id")
          .in("link_id", memberOf.map((m) => m.link_id)).eq("status", "confirmed")
          .gt("start_at", new Date(from).toISOString()).lte("start_at", new Date(to).toISOString());
        for (const b of groupBookings ?? []) {
          (bookings ?? []).push(b);
          const start = Date.parse(b.start_at);
          for (const ch of channels) for (const off of prefs[ch]) {
            if (!due(start, off)) continue;
            rows.push({
              user_id: profile.id, booking_id: b.id, recipient: "host", channel: ch, kind: "reminder", offset_min: off,
              send_at: new Date(start - off * 60000).toISOString(),
              dedupe_key: `r:${b.id}:${profile.id}:${ch}:${off}`,
            });
          }
        }
      }

      if (prefs.scope === "all" && premium) {
        const evChannels = channels.filter((ch) => ch !== "sms");
        if (evChannels.length) {
          const ownEvents = new Set((bookings ?? []).map((b) => b.provider_event_id).filter(Boolean));
          const { data: moreBookings } = await db.from("bookings").select("provider_event_id")
            .eq("user_id", profile.id).gt("start_at", new Date(now).toISOString()).not("provider_event_id", "is", null);
          for (const b of moreBookings ?? []) ownEvents.add(b.provider_event_id);
          const events = await upcomingEvents(profile.id, from, to);
          const seen = new Set<string>();
          for (const ev of events) {
            if (ownEvents.has(ev.id)) continue;
            const key = `${ev.title}|${ev.start}`; // same meeting in two calendars → one reminder
            if (seen.has(key)) continue;
            seen.add(key);
            for (const ch of evChannels) for (const off of prefs[ch]) {
              if (!due(ev.start, off)) continue;
              const { account_id, ...snap } = ev;
              rows.push({
                user_id: profile.id, booking_id: null, recipient: "host", channel: ch, kind: "event_reminder", offset_min: off,
                event: snap,
                send_at: new Date(ev.start - off * 60000).toISOString(),
                dedupe_key: `e:${account_id}:${ev.id}:${ev.start}:${ch}:${off}`,
              });
            }
          }
        }
      }
      if (rows.length) {
        await db.from("notification_outbox").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });
        queued += rows.length;
      }
    } catch (e) {
      console.error("reminder scan", profile.id, e);
    }
  }
  return queued;
}

route("POST", "/cron/reminders", async (req) => {
  const { data: secret } = await admin().rpc("read_cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) throw new HttpError(401, "Unauthorised");
  const { data: on } = await admin().from("app_settings").select("value").eq("key", "reminders_enabled").maybeSingle();
  if (on?.value === false) return json({ paused: true });
  // stale oauth states
  const minute = new Date().getUTCMinutes();
  if (minute % 15 === 0) {
    await admin().from("oauth_states").delete().lt("created_at", new Date(Date.now() - 3600000).toISOString());
    await admin().from("busy_cache").delete().lt("fetched_at", new Date(Date.now() - 86400000).toISOString());
    await admin().from("event_cache").delete().lt("fetched_at", new Date(Date.now() - 3600000).toISOString());
    await admin().from("notification_outbox").update({ event: null })
      .not("event", "is", null).lt("send_at", new Date(Date.now() - 86400000).toISOString());
  }
  const queued = await scanReminders();
  return json({ queued, ...(await processOutbox()) });
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
  else plan = prof && prof.plan === "trial" && new Date(prof.trial_ends_at).getTime() > Date.now() ? "trial" : "basic";
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
    if (e instanceof Error && e.message.startsWith("Missing configuration")) {
      return json({ error: `Setup incomplete: ${e.message}` }, 500);
    }
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
