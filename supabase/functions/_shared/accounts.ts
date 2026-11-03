// Token lifecycle and merged busy time across every connected account.

import { admin } from "./db.ts";
import { fetchBusy, type Provider, ProviderAuthError, refresh } from "./providers.ts";
import type { Interval } from "./slots.ts";

export interface AccountRow {
  id: string;
  user_id: string;
  provider: Provider;
  email: string;
  label: string;
  color: string;
  status: string;
}

export async function markAccountError(accountId: string, message: string, revoked = false) {
  await admin().from("connected_accounts").update({
    status: revoked ? "revoked" : "error",
    last_error: message.slice(0, 300),
  }).eq("id", accountId);
}

export async function getAccessToken(account: AccountRow): Promise<string> {
  const db = admin();
  const { data: tok } = await db.from("account_tokens").select("*").eq("account_id", account.id).maybeSingle();
  if (!tok) throw new ProviderAuthError("No token stored");
  if (tok.access_token && tok.access_expires_at && new Date(tok.access_expires_at).getTime() > Date.now() + 30000) {
    return tok.access_token;
  }
  const { data: rt } = await db.rpc("read_refresh_token", { p_secret_id: tok.refresh_token_secret_id });
  if (!rt) throw new ProviderAuthError("Refresh token missing");
  try {
    const t = await refresh(account.provider, rt as string);
    if (t.refreshToken && t.refreshToken !== rt) {
      await db.rpc("store_refresh_token", {
        p_account_id: account.id,
        p_token: t.refreshToken,
        p_existing: tok.refresh_token_secret_id,
      });
    }
    await db.from("account_tokens").update({
      access_token: t.accessToken,
      access_expires_at: new Date(t.expiresAt).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("account_id", account.id);
    if (account.status !== "active") {
      await db.from("connected_accounts").update({ status: "active", last_error: null }).eq("id", account.id);
    }
    return t.accessToken;
  } catch (e) {
    if (e instanceof ProviderAuthError) await markAccountError(account.id, "Please reconnect this calendar", true);
    throw e;
  }
}

const CACHE_MS = 2 * 60 * 1000;

export interface AccountBusy {
  account: AccountRow;
  busy: Interval[];
  error?: string;
}

/**
 * Busy time for every account where conflict checking is on.
 * `live` skips the 2-minute cache (always used when confirming a booking).
 */
export async function busyForUser(userId: string, from: number, to: number, live = false): Promise<AccountBusy[]> {
  const db = admin();
  const { data: accounts } = await db.from("connected_accounts").select("id,user_id,provider,email,label,color,status")
    .eq("user_id", userId);
  const { data: cals } = await db.from("calendars").select("account_id,check_conflicts").eq("user_id", userId);
  const checking = new Set((cals ?? []).filter((c) => c.check_conflicts).map((c) => c.account_id));

  const results = await Promise.all((accounts ?? []).filter((a) => checking.has(a.id)).map(async (a): Promise<AccountBusy> => {
    const account = a as AccountRow;
    if (!live) {
      const { data: c } = await db.from("busy_cache").select("*").eq("account_id", a.id).maybeSingle();
      if (
        c && Date.now() - new Date(c.fetched_at).getTime() < CACHE_MS &&
        new Date(c.range_start).getTime() <= from && new Date(c.range_end).getTime() >= to
      ) {
        return { account, busy: c.busy as Interval[] };
      }
    }
    try {
      const token = await getAccessToken(account);
      // fetch a wider range so the cache serves the whole booking window
      const rangeFrom = Math.min(from, Date.now() - 86400000);
      const rangeTo = Math.max(to, Date.now() + 62 * 86400000);
      const busy = await fetchBusy(account.provider, token, rangeFrom, rangeTo);
      await db.from("busy_cache").upsert({
        account_id: a.id,
        range_start: new Date(rangeFrom).toISOString(),
        range_end: new Date(rangeTo).toISOString(),
        busy,
        fetched_at: new Date().toISOString(),
      });
      return { account, busy: busy.filter((b) => b.end > from && b.start < to) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof ProviderAuthError)) await markAccountError(a.id, msg);
      return { account, busy: [], error: msg };
    }
  }));
  return results;
}

export async function clearBusyCache(userId: string) {
  const db = admin();
  const { data } = await db.from("connected_accounts").select("id").eq("user_id", userId);
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length) await db.from("busy_cache").delete().in("account_id", ids);
}
