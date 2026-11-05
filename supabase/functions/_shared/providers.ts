// Google Calendar + Microsoft Graph. We only read busy times (never titles) and
// write events for bookings made through our links.

import { env, redirectUri } from "./env.ts";
import type { Interval } from "./slots.ts";

export type Provider = "google" | "microsoft";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events", // same scope Kairo HR submitted for review
];

export const MS_SCOPES = ["openid", "email", "profile", "offline_access", "Calendars.ReadWrite"];

export class ProviderAuthError extends Error {}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  scope?: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1] ?? "";
  const pad = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
  return JSON.parse(atob(pad));
}

export function authUrl(provider: Provider, state: string, loginHint?: string): string {
  if (provider === "google") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", env.googleClientId);
    u.searchParams.set("redirect_uri", redirectUri("google"));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent select_account");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    if (loginHint) u.searchParams.set("login_hint", loginHint);
    return u.toString();
  }
  const u = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  u.searchParams.set("client_id", env.msClientId);
  u.searchParams.set("redirect_uri", redirectUri("microsoft"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", MS_SCOPES.join(" "));
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("state", state);
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

async function tokenRequest(provider: Provider, params: Record<string, string>): Promise<TokenSet> {
  const url = provider === "google"
    ? "https://oauth2.googleapis.com/token"
    : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const base: Record<string, string> = provider === "google"
    ? { client_id: env.googleClientId, client_secret: env.googleClientSecret }
    : { client_id: env.msClientId, client_secret: env.msClientSecret, scope: MS_SCOPES.join(" ") };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...base, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data.error ?? res.status);
    const msg = String(data.error_description ?? data.error ?? "Token request failed");
    if (code === "invalid_grant" || code === "interaction_required" || code === "unauthorized_client") {
      throw new ProviderAuthError(msg);
    }
    throw new Error(`${provider} token error: ${msg}`);
  }
  let email: string | undefined;
  if (data.id_token) {
    const claims = decodeJwtPayload(data.id_token);
    email = String(claims.email ?? claims.preferred_username ?? "") || undefined;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in ?? 3600) - 60) * 1000,
    email: email?.toLowerCase(),
    scope: data.scope,
  };
}

export function exchangeCode(provider: Provider, code: string) {
  return tokenRequest(provider, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider),
  });
}

export function refresh(provider: Provider, refreshToken: string) {
  return tokenRequest(provider, { grant_type: "refresh_token", refresh_token: refreshToken });
}

async function api(url: string, token: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new ProviderAuthError("Access was revoked or expired");
  return res;
}

/** Busy intervals for the account's main calendar between from and to. */
export async function fetchBusy(provider: Provider, token: string, from: number, to: number): Promise<Interval[]> {
  if (provider === "google") {
    const res = await api("https://www.googleapis.com/calendar/v3/freeBusy", token, {
      method: "POST",
      body: JSON.stringify({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        items: [{ id: "primary" }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Google free/busy failed: ${data.error?.message ?? res.status}`);
    const cal = data.calendars?.primary;
    if (cal?.errors?.length) throw new Error(`Google free/busy: ${cal.errors[0].reason}`);
    return (cal?.busy ?? []).map((b: { start: string; end: string }) => ({
      start: Date.parse(b.start),
      end: Date.parse(b.end),
    }));
  }
  // Microsoft: calendar view with only start/end/showAs selected (no subjects requested).
  const out: Interval[] = [];
  let url: string | null = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${
    encodeURIComponent(new Date(from).toISOString())
  }&endDateTime=${encodeURIComponent(new Date(to).toISOString())}&$select=start,end,showAs,isCancelled&$top=200`;
  let pages = 0;
  while (url && pages < 10) {
    const res = await api(url, token, { headers: { Prefer: 'outlook.timezone="UTC"' } });
    const data = await res.json();
    if (!res.ok) {
      const code = data.error?.code ?? res.status;
      if (code === "MailboxNotEnabledForRESTAPI") throw new Error("This Microsoft account has no calendar (mailbox not enabled)");
      throw new Error(`Microsoft calendar read failed: ${data.error?.message ?? code}`);
    }
    for (const e of data.value ?? []) {
      if (e.isCancelled || e.showAs === "free" || e.showAs === "workingElsewhere") continue;
      out.push({ start: Date.parse(e.start.dateTime + "Z"), end: Date.parse(e.end.dateTime + "Z") });
    }
    url = data["@odata.nextLink"] ?? null;
    pages++;
  }
  return out;
}

export interface NewEvent {
  title: string;
  description: string;
  start: number;
  end: number;
  hostTz: string;
  guestName: string;
  guestEmail: string;
  extraAttendees?: { email: string; name: string | null }[];
  wantVideo: boolean;
  location?: string | null;
  requestId: string;
}

export interface CreatedEvent {
  eventId: string;
  meetingUrl: string | null;
}

export async function createEvent(provider: Provider, token: string, ev: NewEvent): Promise<CreatedEvent> {
  if (provider === "google") {
    const body: Record<string, unknown> = {
      summary: ev.title,
      description: ev.description,
      start: { dateTime: new Date(ev.start).toISOString(), timeZone: ev.hostTz },
      end: { dateTime: new Date(ev.end).toISOString(), timeZone: ev.hostTz },
      attendees: [
        { email: ev.guestEmail, displayName: ev.guestName },
        ...(ev.extraAttendees ?? []).map((a) => ({ email: a.email, displayName: a.name ?? undefined })),
      ],
      reminders: { useDefault: true },
    };
    if (ev.location) body.location = ev.location;
    if (ev.wantVideo) {
      body.conferenceData = {
        createRequest: { requestId: ev.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
      };
    }
    const res = await api(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
      token,
      { method: "POST", body: JSON.stringify(body) },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Google event create failed: ${data.error?.message ?? res.status}`);
    const meet = data.hangoutLink ??
      data.conferenceData?.entryPoints?.find((p: { entryPointType: string }) => p.entryPointType === "video")?.uri ??
      null;
    return { eventId: data.id, meetingUrl: meet };
  }

  const base: Record<string, unknown> = {
    subject: ev.title,
    body: { contentType: "text", content: ev.description },
    start: { dateTime: new Date(ev.start).toISOString().slice(0, 19), timeZone: "UTC" },
    end: { dateTime: new Date(ev.end).toISOString().slice(0, 19), timeZone: "UTC" },
    attendees: [
      { emailAddress: { address: ev.guestEmail, name: ev.guestName }, type: "required" },
      ...(ev.extraAttendees ?? []).map((a) => ({ emailAddress: { address: a.email, name: a.name ?? a.email }, type: "required" })),
    ],
    transactionId: ev.requestId,
  };
  if (ev.location) base.location = { displayName: ev.location };
  const attempt = async (withTeams: boolean) => {
    const payload = withTeams ? { ...base, isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : base;
    const res = await api("https://graph.microsoft.com/v1.0/me/events", token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { res, data: await res.json() };
  };
  let { res, data } = await attempt(ev.wantVideo);
  if (!res.ok && ev.wantVideo) ({ res, data } = await attempt(false)); // personal accounts can't create Teams links
  if (!res.ok) throw new Error(`Microsoft event create failed: ${data.error?.message ?? res.status}`);
  return { eventId: data.id, meetingUrl: data.onlineMeeting?.joinUrl ?? null };
}

export async function deleteEvent(provider: Provider, token: string, eventId: string): Promise<void> {
  const url = provider === "google"
    ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`
    : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`;
  const res = await api(url, token, { method: "DELETE" });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Could not remove calendar event (${res.status})`);
  }
}

/** One event Kairo created for a connected app (Kairo HR): times, status and attendee responses. */
export interface AppEventState {
  status: "confirmed" | "cancelled" | "gone";
  start: number | null;
  end: number | null;
  meetingUrl: string | null;
  attendees: { email: string; response: "accepted" | "declined" | "tentative" | "needsAction" }[];
}

export async function getEvent(provider: Provider, token: string, eventId: string): Promise<AppEventState> {
  if (provider === "google") {
    const res = await api(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?fields=${encodeURIComponent("status,start,end,hangoutLink,conferenceData/entryPoints,attendees(email,responseStatus)")}`,
      token,
    );
    if (res.status === 404 || res.status === 410) return { status: "gone", start: null, end: null, meetingUrl: null, attendees: [] };
    const d = await res.json();
    if (!res.ok) throw new Error(`Google event read failed: ${d.error?.message ?? res.status}`);
    return {
      status: d.status === "cancelled" ? "cancelled" : "confirmed",
      start: Date.parse(d.start?.dateTime ?? d.start?.date), end: Date.parse(d.end?.dateTime ?? d.end?.date),
      meetingUrl: d.hangoutLink ?? d.conferenceData?.entryPoints?.find((p: { entryPointType: string }) => p.entryPointType === "video")?.uri ?? null,
      attendees: (d.attendees ?? []).map((a: { email: string; responseStatus?: string }) => ({
        email: String(a.email).toLowerCase(),
        response: (["accepted", "declined", "tentative"].includes(a.responseStatus ?? "") ? a.responseStatus : "needsAction") as AppEventState["attendees"][number]["response"],
      })),
    };
  }
  const res = await api(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=start,end,isCancelled,attendees,onlineMeeting`, token, {
    headers: { Prefer: 'outlook.timezone="UTC"' },
  });
  if (res.status === 404) return { status: "gone", start: null, end: null, meetingUrl: null, attendees: [] };
  const d = await res.json();
  if (!res.ok) throw new Error(`Microsoft event read failed: ${d.error?.message ?? res.status}`);
  const utc = (x?: string) => (x ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(x) ? x : `${x}Z`) : null);
  const map: Record<string, AppEventState["attendees"][number]["response"]> = { accepted: "accepted", declined: "declined", tentativelyAccepted: "tentative" };
  return {
    status: d.isCancelled ? "cancelled" : "confirmed",
    start: utc(d.start?.dateTime), end: utc(d.end?.dateTime), meetingUrl: d.onlineMeeting?.joinUrl ?? null,
    attendees: (d.attendees ?? []).map((a: { emailAddress?: { address?: string }; status?: { response?: string } }) => ({
      email: String(a.emailAddress?.address ?? "").toLowerCase(), response: map[a.status?.response ?? ""] ?? "needsAction",
    })),
  };
}

export interface EventChange {
  title?: string;
  description?: string;
  start?: number;
  end?: number;
  hostTz: string;
  attendees?: { email: string; name: string | null }[];
}

/** Moves or edits an event in place; attendees get an update, not a cancellation. */
export async function updateEvent(provider: Provider, token: string, eventId: string, ch: EventChange): Promise<{ meetingUrl: string | null }> {
  if (provider === "google") {
    const body: Record<string, unknown> = {};
    if (ch.title !== undefined) body.summary = ch.title;
    if (ch.description !== undefined) body.description = ch.description;
    if (ch.start !== undefined) body.start = { dateTime: new Date(ch.start).toISOString(), timeZone: ch.hostTz };
    if (ch.end !== undefined) body.end = { dateTime: new Date(ch.end).toISOString(), timeZone: ch.hostTz };
    if (ch.attendees) body.attendees = ch.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined }));
    const res = await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all&conferenceDataVersion=1`, token, {
      method: "PATCH", body: JSON.stringify(body),
    });
    const d = await res.json();
    if (res.status === 404 || res.status === 410) throw new Error("gone");
    if (!res.ok) throw new Error(`Google event update failed: ${d.error?.message ?? res.status}`);
    return { meetingUrl: d.hangoutLink ?? d.conferenceData?.entryPoints?.find((p: { entryPointType: string }) => p.entryPointType === "video")?.uri ?? null };
  }
  const body: Record<string, unknown> = {};
  if (ch.title !== undefined) body.subject = ch.title;
  if (ch.description !== undefined) body.body = { contentType: "text", content: ch.description };
  if (ch.start !== undefined) body.start = { dateTime: new Date(ch.start).toISOString().slice(0, 19), timeZone: "UTC" };
  if (ch.end !== undefined) body.end = { dateTime: new Date(ch.end).toISOString().slice(0, 19), timeZone: "UTC" };
  if (ch.attendees) body.attendees = ch.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name ?? a.email }, type: "required" }));
  const res = await api(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, token, { method: "PATCH", body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error("gone");
  if (!res.ok) throw new Error(`Microsoft event update failed: ${d.error?.message ?? res.status}`);
  return { meetingUrl: d.onlineMeeting?.joinUrl ?? null };
}

// ---------------------------------------------------------------------------------
// Event details (shown to the signed-in owner only; fetched live, never stored)

export interface CalAttendee {
  name: string | null;
  email: string;
  response: "accepted" | "declined" | "tentative" | "needsAction" | "organizer";
}

export interface CalEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string | null;
  joinUrl: string | null;
  openUrl: string | null;
  description: string | null;
  organizer: string | null;
  attendees: CalAttendee[];
  free: boolean;
  declined: boolean;
}

const JOIN_RE =
  /https?:\/\/(?:[\w-]+\.)?(?:zoom\.us\/(?:j|my|w|s)\/[^\s"'<>)\]]+|meet\.google\.com\/[a-z0-9-]+|teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)\]]+|teams\.live\.com\/meet\/[^\s"'<>)\]]+|[\w-]+\.webex\.com\/[^\s"'<>)\]]+|whereby\.com\/[^\s"'<>)\]]+)/i;

export function findJoinUrl(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const m = t ? JOIN_RE.exec(t) : null;
    if (m) return m[0].replace(/[.,;]+$/, "");
  }
  return null;
}

function htmlToText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, href, text) => (text && text !== href ? `${text} (${href})` : href))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function dateOnlyToUtc(date: string, tz: string, zonedToUtc: (y: number, m: number, d: number, h: number, mi: number, tz: string) => number) {
  const [y, m, d] = date.split("-").map(Number);
  return zonedToUtc(y, m, d, 0, 0, tz);
}

export async function fetchEvents(
  provider: Provider,
  token: string,
  from: number,
  to: number,
  tz: string,
  zonedToUtc: (y: number, m: number, d: number, h: number, mi: number, tz: string) => number,
): Promise<CalEvent[]> {
  const out: CalEvent[] = [];
  if (provider === "google") {
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const u = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      u.searchParams.set("timeMin", new Date(from).toISOString());
      u.searchParams.set("timeMax", new Date(to).toISOString());
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("orderBy", "startTime");
      u.searchParams.set("maxResults", "250");
      u.searchParams.set(
        "fields",
        "nextPageToken,items(id,status,summary,description,location,start,end,hangoutLink,conferenceData/entryPoints,htmlLink,attendees(email,displayName,responseStatus,self,organizer,resource),organizer(email,displayName,self),transparency,eventType,visibility)",
      );
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const res = await api(u.toString(), token);
      const data = await res.json();
      if (!res.ok) throw new Error(`Google events read failed: ${data.error?.message ?? res.status}`);
      for (const e of data.items ?? []) {
        if (e.status === "cancelled" || e.eventType === "workingLocation") continue;
        const allDay = !!e.start?.date;
        const start = allDay ? dateOnlyToUtc(e.start.date, tz, zonedToUtc) : Date.parse(e.start?.dateTime);
        const end = allDay ? dateOnlyToUtc(e.end.date, tz, zonedToUtc) : Date.parse(e.end?.dateTime);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const video = e.hangoutLink ??
          e.conferenceData?.entryPoints?.find((p: { entryPointType: string }) => p.entryPointType === "video")?.uri ?? null;
        const attendees: CalAttendee[] = (e.attendees ?? [])
          .filter((a: { resource?: boolean }) => !a.resource)
          .slice(0, 50)
          .map((a: { email: string; displayName?: string; responseStatus?: string; organizer?: boolean }) => ({
            name: a.displayName ?? null,
            email: a.email,
            response: a.organizer ? "organizer" : (a.responseStatus as CalAttendee["response"]) ?? "needsAction",
          }));
        const self = (e.attendees ?? []).find((a: { self?: boolean }) => a.self);
        const description = e.description ? htmlToText(String(e.description)).slice(0, 4000) : null;
        out.push({
          id: e.id,
          title: e.summary || (e.visibility === "private" ? "Private event" : "(No title)"),
          start,
          end,
          allDay,
          location: e.location ?? null,
          joinUrl: video ?? findJoinUrl(e.location, description),
          openUrl: e.htmlLink ?? null,
          description,
          organizer: e.organizer?.self ? null : (e.organizer?.displayName ?? e.organizer?.email ?? null),
          attendees,
          free: e.transparency === "transparent",
          declined: self?.responseStatus === "declined",
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  let url: string | null = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${
    encodeURIComponent(new Date(from).toISOString())
  }&endDateTime=${encodeURIComponent(new Date(to).toISOString())}` +
    `&$select=id,subject,start,end,isAllDay,location,onlineMeeting,isOnlineMeeting,webLink,body,attendees,organizer,showAs,isCancelled,responseStatus,isOrganizer,sensitivity` +
    `&$orderby=start/dateTime&$top=200`;
  let pages = 0;
  while (url && pages < 5) {
    const res = await api(url, token, { headers: { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' } });
    const data = await res.json();
    if (!res.ok) throw new Error(`Microsoft events read failed: ${data.error?.message ?? res.status}`);
    for (const e of data.value ?? []) {
      if (e.isCancelled) continue;
      const allDay = !!e.isAllDay;
      const start = allDay ? dateOnlyToUtc(String(e.start.dateTime).slice(0, 10), tz, zonedToUtc) : Date.parse(e.start.dateTime + "Z");
      const end = allDay ? dateOnlyToUtc(String(e.end.dateTime).slice(0, 10), tz, zonedToUtc) : Date.parse(e.end.dateTime + "Z");
      const description = e.body?.content ? String(e.body.content).replace(/\r/g, "").replace(/_{10,}/g, "").trim().slice(0, 4000) || null : null;
      const loc = e.location?.displayName || null;
      out.push({
        id: e.id,
        title: e.subject || (e.sensitivity === "private" ? "Private event" : "(No title)"),
        start,
        end,
        allDay,
        location: loc,
        joinUrl: e.onlineMeeting?.joinUrl ?? findJoinUrl(loc, description),
        openUrl: e.webLink ?? null,
        description,
        organizer: e.isOrganizer ? null : (e.organizer?.emailAddress?.name ?? e.organizer?.emailAddress?.address ?? null),
        attendees: (e.attendees ?? []).slice(0, 50).map((a: { emailAddress: { name?: string; address: string }; status?: { response?: string } }) => ({
          name: a.emailAddress?.name ?? null,
          email: a.emailAddress?.address,
          response: ({ accepted: "accepted", declined: "declined", tentativelyAccepted: "tentative", organizer: "organizer" } as Record<string, CalAttendee["response"]>)[a.status?.response ?? ""] ?? "needsAction",
        })),
        free: e.showAs === "free",
        declined: e.responseStatus?.response === "declined",
      });
    }
    url = data["@odata.nextLink"] ?? null;
    pages++;
  }
  return out;
}
