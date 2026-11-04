// Connected apps: consent, tokens, merged busy times, live change notifications, push to apps.

import { admin } from "./db.ts";
import { env } from "./env.ts";
import { HttpError } from "./http.ts";
import { type AccountRow, busyForUser, clearBusyCache, getAccessToken } from "./accounts.ts";
import { mergeIntervals } from "./slots.ts";

export const APP_SCOPES = ["busy.read", "events.write"] as const;
export const BUSY_WINDOW_DAYS = 60;

export async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ApiClient {
  id: string;
  name: string;
  client_id: string;
  secret_hash: string;
  webhook_url: string | null;
  webhook_secret_id: string | null;
  redirect_uris: string[];
  allowed_scopes: string[];
}

export interface Connection {
  id: string;
  client_id: string;
  user_id: string;
  external_ref: string | null;
  scopes: string[];
  last_push_hash: string | null;
}

export async function clientById(clientId: string): Promise<ApiClient> {
  const { data } = await admin().from("api_clients").select("*").eq("client_id", clientId).maybeSingle();
  if (!data) throw new HttpError(400, "Unknown app");
  return data as ApiClient;
}

/** App server authentication: client_id + client_secret (body fields or HTTP Basic). */
export async function authClient(req: Request, b?: { client_id?: unknown; client_secret?: unknown }) {
  let id = typeof b?.client_id === "string" ? b.client_id : "";
  let secret = typeof b?.client_secret === "string" ? b.client_secret : "";
  const auth = req.headers.get("authorization") ?? "";
  if ((!id || !secret) && /^basic /i.test(auth)) {
    const [u, p] = atob(auth.slice(6)).split(":");
    id = u ?? "";
    secret = p ?? "";
  }
  if (!id || !secret) throw new HttpError(401, "Client credentials required");
  const c = await clientById(id).catch(() => null);
  if (!c || c.secret_hash !== await sha256Hex(secret)) throw new HttpError(401, "Invalid client credentials");
  return c;
}

/** A connected app acting for one user: Bearer access token. */
export async function authConnection(req: Request, scope?: string) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Access token required");
  const { data } = await admin().from("app_connections").select("*").eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (!data) throw new HttpError(401, "This connection was revoked or the token is invalid");
  if (scope && !(data.scopes as string[]).includes(scope)) throw new HttpError(403, `This connection doesn't include ${scope}`);
  admin().from("app_connections").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
  return data as Connection;
}

/** Combined busy times for a user across every calendar they check, plus their Kairo Link bookings. */
export async function mergedBusy(userId: string, from: number, to: number, live = false) {
  const db = admin();
  const [lists, { data: bookings }] = await Promise.all([
    busyForUser(userId, from, to, live),
    db.from("bookings").select("start_at,end_at").eq("status", "confirmed")
      .or(`user_id.eq.${userId},attendee_user_ids.cs.{${userId}}`)
      .lt("start_at", new Date(to).toISOString()).gt("end_at", new Date(from).toISOString()),
  ]);
  const all = [
    ...lists.flatMap((l) => l.busy),
    ...(bookings ?? []).map((b) => ({ start: Date.parse(b.start_at), end: Date.parse(b.end_at) })),
  ].filter((i) => i.end > from && i.start < to);
  const busy = mergeIntervals(all).map((i) => ({ start: new Date(i.start).toISOString(), end: new Date(i.end).toISOString() }));
  return { busy, errors: lists.filter((l) => l.error).map((l) => ({ calendar: l.account.email, error: l.error as string })) };
}

// ---- pushing to apps ----

async function signAndPost(client: ApiClient, payload: Record<string, unknown>) {
  if (!client.webhook_url) return { ok: false, error: "No webhook URL configured" };
  const { data: secret } = client.webhook_secret_id
    ? await admin().rpc("read_vault_secret", { p_id: client.webhook_secret_id })
    : { data: null };
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = secret ? await hmacHex(secret as string, `${t}.${body}`) : "";
  try {
    const res = await fetch(client.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json", "kairo-signature": `t=${t},v1=${sig}`, "user-agent": "KairoLink-Webhooks/1" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Webhook returned ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Webhook failed" };
  }
}

/** Recompute a user's busy times and push to every connected app whose copy is out of date. */
export async function pushBusyForUser(userId: string, opts: { force?: boolean; live?: boolean } = {}) {
  const db = admin();
  const { data: conns } = await db.from("app_connections").select("*").eq("user_id", userId);
  if (!conns?.length) return 0;
  const from = Date.now();
  const to = from + BUSY_WINDOW_DAYS * 86400000;
  const { busy } = await mergedBusy(userId, from - 3600000, to, opts.live ?? true);
  // hash ignores busy blocks that have already ended, so the passage of time alone doesn't trigger a push
  const upcoming = busy.filter((b) => Date.parse(b.end) > from);
  const hash = await sha256Hex(JSON.stringify(upcoming));
  const { data: prof } = await db.from("profiles").select("email,full_name,timezone").eq("id", userId).single();
  let pushed = 0;
  for (const c of conns as (Connection & { last_push_error: string | null })[]) {
    if (!opts.force && c.last_push_hash === hash) continue;
    const client = await db.from("api_clients").select("*").eq("id", c.client_id).single().then((r) => r.data as ApiClient);
    const r = await signAndPost(client, {
      type: "busy.updated",
      connection_id: c.id,
      external_ref: c.external_ref,
      user: { email: prof?.email ?? null, name: prof?.full_name ?? null, timezone: prof?.timezone ?? null },
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      busy: upcoming,
      sent_at: new Date().toISOString(),
    });
    await db.from("app_connections").update(r.ok
      ? { last_push_hash: hash, last_pushed_at: new Date().toISOString(), last_push_error: null }
      : { last_push_error: r.error?.slice(0, 300) ?? "failed" }).eq("id", c.id);
    if (r.ok) pushed++;
  }
  return pushed;
}

export async function notifyRevoked(conn: Connection) {
  const { data: client } = await admin().from("api_clients").select("*").eq("id", conn.client_id).single();
  if (client) await signAndPost(client as ApiClient, { type: "connection.revoked", connection_id: conn.id, external_ref: conn.external_ref, sent_at: new Date().toISOString() });
}

// ---- change notifications from Google / Microsoft ----

const GOOGLE_TTL_S = 7 * 24 * 3600;
const MS_TTL_MIN = 4000; // Graph allows just under 3 days for event subscriptions

function hookUrl(provider: "google" | "microsoft") {
  return `${env.siteUrl}/api/hooks/${provider}`;
}

async function stopWatch(w: { provider: string; channel_id: string; resource_id: string | null; account_id: string }) {
  try {
    const { data: acc } = await admin().from("connected_accounts").select("id,user_id,provider,email,label,color,status").eq("id", w.account_id).maybeSingle();
    if (!acc) return;
    const token = await getAccessToken(acc as AccountRow);
    if (w.provider === "google") {
      await fetch("https://www.googleapis.com/calendar/v3/channels/stop", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: w.channel_id, resourceId: w.resource_id }),
      });
    } else {
      await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${w.channel_id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    }
  } catch (e) {
    console.error("stop watch", e);
  }
}

/** Make sure Google/Microsoft will tell us when this calendar changes. Renews if expiring within a day. */
export async function ensureWatch(acc: AccountRow) {
  const db = admin();
  const { data: existing } = await db.from("calendar_watches").select("*").eq("account_id", acc.id).maybeSingle();
  if (existing && Date.parse(existing.expires_at) - Date.now() > 24 * 3600000) return "ok";
  const token = await getAccessToken(acc);
  const secret = randomHex(16);

  if (acc.provider === "microsoft" && existing) {
    // Graph subscriptions can be extended in place
    const exp = new Date(Date.now() + MS_TTL_MIN * 60000).toISOString();
    const r = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${existing.channel_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expirationDateTime: exp }),
    });
    if (r.ok) {
      await db.from("calendar_watches").update({ expires_at: exp }).eq("id", existing.id);
      return "renewed";
    }
  }
  if (existing) {
    await stopWatch(existing);
    await db.from("calendar_watches").delete().eq("id", existing.id);
  }

  if (acc.provider === "google") {
    const id = crypto.randomUUID();
    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events/watch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id, type: "web_hook", address: hookUrl("google"), token: secret, params: { ttl: String(GOOGLE_TTL_S) } }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google watch failed: ${d.error?.message ?? r.status}`);
    await db.from("calendar_watches").insert({
      account_id: acc.id, provider: "google", channel_id: id, resource_id: d.resourceId, token: secret,
      expires_at: new Date(Number(d.expiration) || Date.now() + GOOGLE_TTL_S * 1000).toISOString(),
    });
    return "created";
  }
  const exp = new Date(Date.now() + MS_TTL_MIN * 60000).toISOString();
  const r = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ changeType: "created,updated,deleted", notificationUrl: hookUrl("microsoft"), resource: "me/events", expirationDateTime: exp, clientState: secret }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Microsoft subscription failed: ${d.error?.message ?? r.status}`);
  await db.from("calendar_watches").insert({ account_id: acc.id, provider: "microsoft", channel_id: d.id, token: secret, expires_at: d.expirationDateTime ?? exp });
  return "created";
}

export async function ensureWatchesForUser(userId: string) {
  const { data: accs } = await admin().from("connected_accounts").select("id,user_id,provider,email,label,color,status").eq("user_id", userId);
  for (const a of accs ?? []) {
    if (a.status === "revoked") continue;
    try {
      await ensureWatch(a as AccountRow);
    } catch (e) {
      console.error("ensure watch", a.id, e);
    }
  }
}

export async function dropWatchesForUser(userId: string) {
  const db = admin();
  const { data: accs } = await db.from("connected_accounts").select("id").eq("user_id", userId);
  const ids = (accs ?? []).map((a) => a.id);
  if (!ids.length) return;
  const { data: watches } = await db.from("calendar_watches").select("*").in("account_id", ids);
  for (const w of watches ?? []) {
    await stopWatch(w);
    await db.from("calendar_watches").delete().eq("id", w.id);
  }
}

/** A calendar changed: refresh that user's busy times and push to their apps. */
export async function onCalendarChanged(accountId: string) {
  const { data: acc } = await admin().from("connected_accounts").select("user_id").eq("id", accountId).maybeSingle();
  if (!acc) return;
  await clearBusyCache(acc.user_id);
  await pushBusyForUser(acc.user_id, { live: true });
}

/** Every 15 minutes: renew expiring watches and re-check every connected user (safety net). */
export async function maintainConnections() {
  const db = admin();
  const { data: conns } = await db.from("app_connections").select("user_id");
  const users = Array.from(new Set((conns ?? []).map((c) => c.user_id)));
  for (const u of users) {
    try {
      await ensureWatchesForUser(u);
      await pushBusyForUser(u, { live: true });
    } catch (e) {
      console.error("maintain connection", u, e);
    }
  }
  // watches for users who no longer have any connected app
  const { data: watches } = await db.from("calendar_watches").select("*, connected_accounts(user_id)");
  for (const w of watches ?? []) {
    const uid = (w.connected_accounts as { user_id: string } | null)?.user_id;
    if (uid && !users.includes(uid)) {
      await stopWatch(w);
      await db.from("calendar_watches").delete().eq("id", w.id);
    }
  }
  await db.from("app_auth_codes").delete().lt("expires_at", new Date().toISOString());
  return users.length;
}
