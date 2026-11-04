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

function displayName(p: { full_name: string | null; handle?: string; email: string | null }) {
  return p.full_name || p.email?.split("@")[0] || p.handle || "Someone";
}

type Person = { user_id: string; name: string; email: string };

async function peopleFor(userIds: string[]): Promise<Person[]> {
  if (!userIds.length) return [];
  const db = admin();
  const [{ data: profs }, { data: accs }] = await Promise.all([
    db.from("profiles").select("id,full_name,email,handle").in("id", userIds),
    db.from("connected_accounts").select("user_id,email,created_at").in("user_id", userIds).order("created_at"),
  ]);
  return userIds.map((uid) => {
    const p = (profs ?? []).find((x) => x.id === uid);
    const mine = (accs ?? []).filter((a) => a.user_id === uid);
    const email = mine.find((a) => a.email === p?.email)?.email ?? mine[0]?.email ?? p?.email ?? "";
    return { user_id: uid, name: p ? displayName(p) : "Someone", email };
  });
}

async function activeTeamUserIds(teamId: string): Promise<string[]> {
  const { data } = await admin().from("team_members").select("user_id").eq("team_id", teamId).eq("status", "active");
  return (data ?? []).map((m) => m.user_id).filter(Boolean) as string[];
}

/** Everyone on a team link apart from its creator (the host). Empty for personal links. */
async function activeMembers(linkId: string): Promise<(Person & { id: string })[]> {
  const { data: link } = await admin().from("links").select("user_id,team_id,attendee_ids").eq("id", linkId).maybeSingle();
  if (!link?.team_id) return [];
  const active = await activeTeamUserIds(link.team_id);
  const ids = link.attendee_ids as string[] | null;
  const chosen = ids?.length ? active.filter((u) => ids.includes(u)) : active;
  const others = chosen.filter((u) => u !== link.user_id);
  return (await peopleFor(others)).map((x) => ({ ...x, id: x.user_id }));
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
    const { count: linkCount } = await db.from("links").select("id", { count: "exact", head: true }).eq("user_id", st.user_id).is("team_id", null);
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

async function resolveHandle(handle: string) {
  const db = admin();
  const h = handle.toLowerCase();
  const { data: profile } = await db.from("profiles").select("*").eq("handle", h).maybeSingle();
  if (profile) return { profile: profile as Profile, team: null };
  const { data: team } = await db.from("teams").select("*").eq("handle", h).maybeSingle();
  if (!team) return null;
  const { data: owner } = await db.from("profiles").select("*").eq("id", team.owner_id).single();
  return { profile: owner as Profile, team: team as { id: string; name: string; handle: string } };
}

async function loadPublic(handle: string, slug: string) {
  const db = admin();
  const r = await resolveHandle(handle);
  if (!r) throw new HttpError(404, "This booking page doesn't exist");
  let q = db.from("links").select("*").eq("slug", slug.toLowerCase());
  q = r.team ? q.eq("team_id", r.team.id) : q.eq("user_id", r.profile.id).is("team_id", null);
  const { data: link } = await q.maybeSingle();
  if (!link || !link.is_active) throw new HttpError(404, "This booking link isn't open right now");
  if (r.team && effectivePlan(r.profile) !== "premium") throw new HttpError(403, "This team's booking links are paused");
  const host = r.team ? await loadProfile(link.user_id) : r.profile;
  return { profile: host, link, team: r.team };
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
  const r = await resolveHandle(p.handle);
  if (!r) throw new HttpError(404, "This page doesn't exist");
  let q = db.from("links").select("id,user_id,slug,title,description,duration_min,location_type,location_value")
    .eq("is_active", true).order("created_at");
  q = r.team ? q.eq("team_id", r.team.id) : q.eq("user_id", r.profile.id).is("team_id", null);
  const { data: links } = await q;
  const pageName = r.team ? r.team.name : (r.profile.full_name || r.profile.handle);
  const withPeople = await Promise.all((links ?? []).map(async (l) => {
    const members = await activeMembers(l.id);
    const host = r.team ? (await peopleFor([l.user_id]))[0]?.name ?? pageName : pageName;
    return {
      slug: l.slug, title: l.title, description: l.description, duration_min: l.duration_min,
      location: locationLabel(l),
      people: members.length ? [host, ...members.map((m) => m.name)] : [],
    };
  }));
  return json({
    host: { name: pageName, handle: r.team ? r.team.handle : r.profile.handle, timezone: r.profile.timezone },
    team: !!r.team,
    paused: !!r.team && effectivePlan(r.profile) !== "premium",
    links: withPeople,
  });
});

route("GET", "/public/:handle/:slug", async (_req, p, url) => {
  const { profile, link, team } = await loadPublic(p.handle, p.slug);
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
    host: { name: team ? team.name : hostName, handle: team ? team.handle : profile.handle, timezone: profile.timezone },
    team: !!team,
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
    team_id: link.team_id ?? null,
    attendee_user_ids: link.team_id ? [profile.id, ...members.map((m) => m.user_id)] : null,
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
  const extra = b as unknown as { attendee_user_ids: string[] | null; internal: boolean };
  const others = (extra.attendee_user_ids ?? []).filter((u) => u !== b.user_id);
  await enqueueCancellation(profile, b, by, others, extra.internal);
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
// ===================================================================================
// Teams: members with roles, shared booking links, internal "find a time" calls

type Role = "owner" | "admin" | "member";
const TEAM_MAX_MEMBERS = 10; // people besides the owner
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,30}$/;

async function teamFor(userId: string, teamId: string, need: Role = "member") {
  const db = admin();
  const { data: team } = await db.from("teams").select("*").eq("id", teamId).maybeSingle();
  if (!team) throw new HttpError(404, "Team not found");
  const { data: me } = await db.from("team_members").select("*").eq("team_id", teamId).eq("user_id", userId).eq("status", "active").maybeSingle();
  if (!me) throw new HttpError(403, "You're not in this team");
  const rank: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
  if (rank[me.role as Role] < rank[need]) throw new HttpError(403, need === "owner" ? "Only the team owner can do that" : "Only team admins can do that");
  return { team, me: me as { id: string; role: Role } };
}

function dbError(e: { code?: string; message?: string } | null, fallback = "Couldn't save") {
  if (!e) return null;
  if (e.code === "23505") return new HttpError(409, /handle|address/i.test(e.message ?? "") || /teams_handle/.test(e.message ?? "") ? "That address is taken. Try another." : "That address is already used in this team. Choose another.");
  if (e.code === "23514") return new HttpError(400, "That address isn't available. Use 3–31 lowercase letters, numbers or dashes.");
  return new HttpError(400, e.message ?? fallback);
}

async function teamMembersView(teamId: string) {
  const db = admin();
  const { data } = await db.from("team_members").select("id,email,user_id,role,status,invited_at,joined_at").eq("team_id", teamId).order("invited_at");
  const ids = (data ?? []).map((m) => m.user_id).filter(Boolean) as string[];
  const people = await peopleFor(ids);
  const order: Record<string, number> = { owner: 0, admin: 1, member: 2 };
  return (data ?? []).map((m) => ({
    id: m.id,
    email: m.email,
    user_id: m.user_id,
    role: m.role,
    status: m.status,
    name: people.find((p) => p.user_id === m.user_id)?.name ?? null,
  })).sort((a, b) => order[a.role] - order[b.role] || (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));
}

async function sendTeamInvite(inviter: Profile, team: { name: string }, email: string, token: string) {
  const mail = renderInviteEmail(inviter.full_name || inviter.handle, team.name, `${env.siteUrl}/invite/${token}`);
  await sendEmail(email, mail.subject, mail.html, mail.text);
}

route("GET", "/me/teams", async (req) => {
  const user = await requireUser(req);
  const db = admin();
  const { data: mine } = await db.from("team_members").select("team_id,role").eq("user_id", user.id).eq("status", "active");
  const ids = (mine ?? []).map((m) => m.team_id);
  if (!ids.length) return json({ teams: [] });
  const [{ data: teams }, { data: members }, { data: links }] = await Promise.all([
    db.from("teams").select("id,name,handle,owner_id,created_at").in("id", ids).order("created_at"),
    db.from("team_members").select("team_id,status").in("team_id", ids).neq("status", "declined"),
    db.from("links").select("team_id,is_active").in("team_id", ids),
  ]);
  return json({
    teams: (teams ?? []).map((t) => ({
      ...t,
      role: mine?.find((m) => m.team_id === t.id)?.role,
      members: (members ?? []).filter((m) => m.team_id === t.id && m.status === "active").length,
      invited: (members ?? []).filter((m) => m.team_id === t.id && m.status === "invited").length,
      open_links: (links ?? []).filter((l) => l.team_id === t.id && l.is_active).length,
    })),
  });
});

route("POST", "/me/teams", async (req) => {
  const user = await requireUser(req);
  const owner = await loadProfile(user.id);
  if (effectivePlan(owner) !== "premium") throw new HttpError(403, "Teams are part of Premium. Go Premium to create a team.");
  const b = await body<{ name?: string; handle?: string; description?: string }>(req);
  const name = str(b.name, "Team name", 80);
  const handle = str(b.handle, "Team address", 31).toLowerCase();
  if (!HANDLE_RE.test(handle)) throw new HttpError(400, "Use 3–31 lowercase letters, numbers or dashes for the address");
  const db = admin();
  const { data: team, error } = await db.from("teams").insert({ owner_id: user.id, name, handle, description: optStr(b.description, 500) }).select("*").single();
  const err = dbError(error);
  if (err) throw err;
  await db.from("team_members").insert({ team_id: team.id, email: (owner.email ?? `owner-${user.id}`).toLowerCase(), user_id: user.id, role: "owner", status: "active", joined_at: new Date().toISOString() });
  return json({ team });
});

route("GET", "/me/teams/:id", async (req, p) => {
  const user = await requireUser(req);
  const { team, me } = await teamFor(user.id, p.id);
  const db = admin();
  const members = await teamMembersView(team.id);
  const { data: links } = await db.from("links").select("*").eq("team_id", team.id).order("created_at");
  const active = members.filter((m) => m.status === "active" && m.user_id).map((m) => m.user_id as string);
  const { data: owner } = await db.from("profiles").select("plan,trial_ends_at").eq("id", team.owner_id).single();
  return json({
    team: { ...team, url: `${env.siteUrl}/${team.handle}` },
    my_role: me.role,
    owner_premium: owner ? effectivePlan(owner as Profile) === "premium" : false,
    members,
    links: (links ?? []).map((l) => {
      const attending = (l.attendee_ids as string[] | null)?.length
        ? active.filter((u) => (l.attendee_ids as string[]).includes(u) || u === l.user_id)
        : active;
      return { ...l, url: `${env.siteUrl}/${team.handle}/${l.slug}`, attending, mine: l.user_id === user.id };
    }),
  });
});

route("PATCH", "/me/teams/:id", async (req, p) => {
  const user = await requireUser(req);
  const b = await body<{ name?: string; handle?: string; description?: string | null }>(req);
  const { team } = await teamFor(user.id, p.id, b.handle !== undefined ? "owner" : "admin");
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = str(b.name, "Team name", 80);
  if (b.description !== undefined) patch.description = optStr(b.description, 500);
  if (b.handle !== undefined) {
    const h = str(b.handle, "Team address", 31).toLowerCase();
    if (!HANDLE_RE.test(h)) throw new HttpError(400, "Use 3–31 lowercase letters, numbers or dashes for the address");
    patch.handle = h;
  }
  const { error } = await admin().from("teams").update(patch).eq("id", team.id);
  const err = dbError(error);
  if (err) throw err;
  return json({ ok: true });
});

route("DELETE", "/me/teams/:id", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id, "owner");
  await admin().from("teams").delete().eq("id", team.id);
  return json({ ok: true });
});

route("POST", "/me/teams/:id/members", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id, "admin");
  const inviter = await loadProfile(user.id);
  const owner = await loadProfile(team.owner_id);
  if (effectivePlan(owner) !== "premium") throw new HttpError(403, "The team owner needs Premium to add people.");
  const b = await body<{ emails?: unknown; role?: string }>(req);
  const role = b.role === "admin" ? "admin" : "member";
  const raw = Array.isArray(b.emails) ? b.emails : [];
  const emails = Array.from(new Set(raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean)));
  const bad = emails.find((e) => !isEmail(e));
  if (bad) throw new HttpError(400, `“${bad}” doesn't look like an email address`);
  const db = admin();
  const { data: existing } = await db.from("team_members").select("id,email,status,user_id").eq("team_id", team.id);
  const current = (existing ?? []).filter((m) => m.status !== "declined" && m.user_id !== team.owner_id);
  const fresh = emails.filter((e) => !(existing ?? []).some((m) => m.email === e && m.status !== "declined"));
  if (current.length + fresh.length > TEAM_MAX_MEMBERS) throw new HttpError(400, `A team can have up to ${TEAM_MAX_MEMBERS} people besides the owner.`);
  for (const email of fresh) {
    const prev = (existing ?? []).find((m) => m.email === email);
    const { data: row, error } = prev
      ? await db.from("team_members").update({ status: "invited", user_id: null, role, invited_by: user.id, invited_at: new Date().toISOString(), joined_at: null })
        .eq("id", prev.id).select("invite_token").single()
      : await db.from("team_members").insert({ team_id: team.id, email, role, invited_by: user.id }).select("invite_token").single();
    if (error) throw error;
    try {
      await sendTeamInvite(inviter, team, email, row.invite_token);
    } catch (e) {
      console.error("team invite email", e);
    }
  }
  return json({ members: await teamMembersView(team.id), added: fresh.length });
});

route("PATCH", "/me/teams/:id/members/:mid", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id, "owner");
  const b = await body<{ role?: string }>(req);
  const role = b.role === "admin" ? "admin" : "member";
  const { data: m } = await admin().from("team_members").select("id,role").eq("id", p.mid).eq("team_id", team.id).maybeSingle();
  if (!m) throw new HttpError(404, "Person not found");
  if (m.role === "owner") throw new HttpError(400, "The owner's role can't be changed");
  await admin().from("team_members").update({ role }).eq("id", m.id);
  return json({ members: await teamMembersView(team.id) });
});

route("DELETE", "/me/teams/:id/members/:mid", async (req, p) => {
  const user = await requireUser(req);
  const db = admin();
  const { team, me } = await teamFor(user.id, p.id);
  const { data: m } = await db.from("team_members").select("id,role,user_id").eq("id", p.mid).eq("team_id", team.id).maybeSingle();
  if (!m) throw new HttpError(404, "Person not found");
  if (m.role === "owner") throw new HttpError(400, "The owner can't leave the team. Delete the team instead.");
  const self = m.user_id === user.id;
  const allowed = self || me.role === "owner" || (me.role === "admin" && m.role === "member");
  if (!allowed) throw new HttpError(403, "You can't remove this person");
  await db.from("team_members").delete().eq("id", m.id);
  return json({ ok: true });
});

route("POST", "/me/teams/:id/members/:mid/resend", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id, "admin");
  const { data: m } = await admin().from("team_members").select("*").eq("id", p.mid).eq("team_id", team.id).maybeSingle();
  if (!m) throw new HttpError(404, "Person not found");
  if (m.status === "active") return json({ ok: true });
  await admin().from("team_members").update({ status: "invited" }).eq("id", m.id);
  await sendTeamInvite(await loadProfile(user.id), team, m.email, m.invite_token);
  return json({ ok: true });
});

// team booking links (admins and owner)
const LINK_FIELDS = ["slug", "title", "description", "duration_min", "buffer_before_min", "buffer_after_min", "min_notice_min",
  "max_days_ahead", "daily_limit", "slot_step_min", "location_type", "location_value", "weekly_hours", "is_active", "expires_at", "attendee_ids"] as const;

function pickLinkFields(b: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of LINK_FIELDS) if (k in b) out[k] = b[k];
  if (typeof out.slug === "string") out.slug = (out.slug as string).toLowerCase();
  if (out.attendee_ids !== undefined && out.attendee_ids !== null && !Array.isArray(out.attendee_ids)) throw new HttpError(400, "Invalid attendees");
  return out;
}

async function checkWriteCalendar(ownerId: string, calId: unknown) {
  if (calId === null || calId === undefined || calId === "") return null;
  const { data } = await admin().from("calendars").select("id").eq("id", String(calId)).eq("user_id", ownerId).maybeSingle();
  if (!data) throw new HttpError(400, "Choose one of your own calendars to add bookings to");
  return data.id as string;
}

route("POST", "/me/teams/:id/links", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id, "admin");
  const b = await body<Record<string, unknown>>(req);
  const row = pickLinkFields(b);
  row.write_calendar_id = await checkWriteCalendar(user.id, b.write_calendar_id);
  const { data, error } = await admin().from("links").insert({ ...row, user_id: user.id, team_id: team.id }).select("id").single();
  const err = dbError(error);
  if (err) throw err;
  return json({ id: data?.id });
});

route("PATCH", "/me/teams/:id/links/:lid", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id, "admin");
  const db = admin();
  const { data: link } = await db.from("links").select("id,user_id").eq("id", p.lid).eq("team_id", team.id).maybeSingle();
  if (!link) throw new HttpError(404, "Link not found");
  const b = await body<Record<string, unknown>>(req);
  const row = pickLinkFields(b);
  if ("write_calendar_id" in b) row.write_calendar_id = await checkWriteCalendar(link.user_id, b.write_calendar_id);
  const { error } = await db.from("links").update(row).eq("id", link.id);
  const err = dbError(error);
  if (err) throw err;
  return json({ ok: true });
});

route("DELETE", "/me/teams/:id/links/:lid", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id, "admin");
  await admin().from("links").delete().eq("id", p.lid).eq("team_id", team.id);
  return json({ ok: true });
});

// find a time among team members (any member)
const FIND_HOURS: LinkRules["weeklyHours"] = {
  mon: [["08:00", "18:00"]], tue: [["08:00", "18:00"]], wed: [["08:00", "18:00"]], thu: [["08:00", "18:00"]], fri: [["08:00", "18:00"]], sat: [], sun: [],
};

async function teamCallPeople(userId: string, teamId: string, memberIds: unknown) {
  const active = await activeTeamUserIds(teamId);
  const chosen = Array.isArray(memberIds) ? memberIds.map(String).filter((u) => active.includes(u) && u !== userId) : [];
  if (!chosen.length) throw new HttpError(400, "Pick at least one teammate");
  return chosen;
}

route("POST", "/me/teams/:id/availability", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id);
  const me = await loadProfile(user.id);
  const b = await body<{ member_ids?: unknown; duration_min?: number; days?: number }>(req);
  const others = await teamCallPeople(user.id, team.id, b.member_ids);
  const duration = Math.min(240, Math.max(15, Number(b.duration_min) || 30));
  const days = Math.min(21, Math.max(1, Number(b.days) || 10));
  const now = Date.now();
  const to = now + days * 86400000;
  const g = await groupBusy(user.id, others, now - 86400000, to + 86400000, true);
  const slots = generateSlots({
    now,
    hostTz: me.timezone,
    rules: { durationMin: duration, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 30, maxDaysAhead: days, dailyLimit: null, slotStepMin: 30, weeklyHours: FIND_HOURS },
    busy: g.busy,
    linkBookings: [],
    from: now,
    to,
  });
  return json({ slots: slots.map((s) => new Date(s).toISOString()), timezone: me.timezone, degraded: g.degraded });
});

route("POST", "/me/teams/:id/schedule", async (req, p) => {
  const user = await requireUser(req);
  const { team } = await teamFor(user.id, p.id);
  const me = await loadProfile(user.id);
  const b = await body<{ member_ids?: unknown; start?: string; duration_min?: number; title?: string; description?: string; video?: boolean }>(req);
  const others = await teamCallPeople(user.id, team.id, b.member_ids);
  const start = Date.parse(str(b.start, "Time", 40));
  if (!Number.isFinite(start) || start < Date.now()) throw new HttpError(400, "Pick a time in the future");
  const duration = Math.min(240, Math.max(15, Number(b.duration_min) || 30));
  const end = start + duration * 60000;
  const title = str(b.title, "Title", 120);
  const description = optStr(b.description, 2000);

  const g = await groupBusy(user.id, others, start - 3600000, end + 3600000, true);
  if (g.busy.some((x) => x.start < end && x.end > start)) throw new HttpError(409, "Someone just got busy at that time. Please pick another.");

  const db = admin();
  const { data: cal } = await db.from("calendars").select("id, connected_accounts(id,user_id,provider,email,label,color,status)")
    .eq("user_id", user.id).eq("can_write", true).order("created_at").limit(1).maybeSingle();
  const acc = cal?.connected_accounts as unknown as AccountRow | undefined;
  if (!acc) throw new HttpError(400, "Connect a calendar first so the invite can be sent from it");
  const people = await peopleFor(others);
  const [first, ...rest] = people;

  const { data: booking, error } = await db.from("bookings").insert({
    user_id: user.id,
    team_id: team.id,
    internal: true,
    title,
    guest_name: team.name,
    guest_email: (me.email ?? acc.email).toLowerCase(),
    guest_note: description,
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString(),
    attendee_user_ids: [user.id, ...others],
  }).select("*").single();
  if (error) {
    if (error.code === "23P01") throw new HttpError(409, "You already have a booking at that time");
    throw error;
  }
  try {
    const token = await getAccessToken(acc);
    const ev = await createEvent(acc.provider, token, {
      title,
      description: [description ?? "", `${team.name} · scheduled with ${env.productName}`].filter(Boolean).join("\n\n"),
      start,
      end,
      hostTz: me.timezone,
      guestName: first.name,
      guestEmail: first.email,
      extraAttendees: rest.filter((x) => x.email).map((x) => ({ email: x.email, name: x.name })),
      wantVideo: b.video !== false,
      location: null,
      requestId: booking.id,
    });
    await db.from("bookings").update({ provider_event_id: ev.eventId, meeting_url: ev.meetingUrl, write_account_id: acc.id, write_calendar_provider_id: "primary" })
      .eq("id", booking.id);
    for (const u of [user.id, ...others]) await clearBusyCache(u);
    return json({ ok: true, meeting_url: ev.meetingUrl, when: fmtWhen(booking.start_at, me.timezone).full });
  } catch (e) {
    await db.from("bookings").delete().eq("id", booking.id);
    throw new HttpError(502, `Couldn't add the call to your calendar: ${e instanceof Error ? e.message : "unknown error"}`);
  }
});

// invites
route("GET", "/invites/:token", async (_req, p) => {
  const db = admin();
  const { data: m } = await db.from("team_members").select("*").eq("invite_token", p.token).maybeSingle();
  if (!m) throw new HttpError(404, "This invite isn't valid any more. Ask for a new one.");
  const { data: team } = await db.from("teams").select("*").eq("id", m.team_id).maybeSingle();
  if (!team) throw new HttpError(404, "This team has been deleted.");
  const { data: inviter } = await db.from("profiles").select("full_name,handle,email").eq("id", m.invited_by ?? team.owner_id).maybeSingle();
  const active = await activeTeamUserIds(team.id);
  return json({
    email: m.email,
    status: m.status,
    role: m.role,
    joined_user_id: m.user_id,
    inviter: inviter ? displayName(inviter) : "Someone",
    team: { id: team.id, name: team.name, handle: team.handle, description: team.description },
    people: (await peopleFor(active)).map((x) => x.name),
    member_user_ids: active,
  });
});

route("POST", "/invites/:token/accept", async (req, p) => {
  const user = await requireUser(req);
  const db = admin();
  const { data: m } = await db.from("team_members").select("*").eq("invite_token", p.token).maybeSingle();
  if (!m) throw new HttpError(404, "This invite isn't valid any more. Ask for a new one.");
  if (m.status === "active" && m.user_id && m.user_id !== user.id) throw new HttpError(409, "Someone has already joined with this invite.");
  const { count } = await db.from("connected_accounts").select("id", { count: "exact", head: true }).eq("user_id", user.id);
  if (!count) throw new HttpError(400, "Connect a calendar first, so your team only books you when you're free.");
  const { data: dup } = await db.from("team_members").select("id").eq("team_id", m.team_id).eq("user_id", user.id).neq("id", m.id).maybeSingle();
  if (dup) await db.from("team_members").delete().eq("id", m.id);
  else await db.from("team_members").update({ user_id: user.id, status: "active", joined_at: new Date().toISOString() }).eq("id", m.id);
  return json({ ok: true, team_id: m.team_id });
});

route("POST", "/invites/:token/decline", async (_req, p) => {
  const { data: m } = await admin().from("team_members").select("id,role").eq("invite_token", p.token).maybeSingle();
  if (!m) throw new HttpError(404, "This invite isn't valid any more.");
  if (m.role === "owner") throw new HttpError(400, "The owner can't decline their own team.");
  await admin().from("team_members").update({ status: "declined", user_id: null, joined_at: null }).eq("id", m.id);
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
      // team bookings (booking links and internal calls) this person attends
      const { data: teamBookings } = await db.from("bookings").select("id,start_at,provider_event_id")
        .contains("attendee_user_ids", [profile.id]).neq("user_id", profile.id).eq("status", "confirmed")
        .gt("start_at", new Date(from).toISOString()).lte("start_at", new Date(to).toISOString());
      for (const b of teamBookings ?? []) {
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
