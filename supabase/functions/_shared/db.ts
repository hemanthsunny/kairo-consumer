import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { env } from "./env.ts";
import { HttpError } from "./http.ts";

let _admin: SupabaseClient | null = null;

/** Service-role client. Never expose results containing tokens to callers. */
export function admin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(env.supabaseUrl, env.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

/** Resolve the signed-in user from the Authorization header. */
export async function requireUser(req: Request): Promise<{ id: string; email: string | null }> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Please sign in");
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Your session has expired. Please sign in again.");
  return { id: data.user.id, email: data.user.email ?? null };
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await admin().from("app_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? fallback;
}

export interface Profile {
  id: string;
  handle: string;
  full_name: string | null;
  email: string | null;
  timezone: string;
  phone_e164: string | null;
  phone_verified: boolean;
  reminder_channels: string[];
  plan: "trial" | "basic" | "premium" | "inactive";
  trial_ends_at: string;
}

/** Plan the user is actually entitled to right now. Trial = premium features with small caps. */
export function effectivePlan(p: Pick<Profile, "plan" | "trial_ends_at">): "trial" | "basic" | "premium" | "inactive" {
  if (p.plan === "trial") return new Date(p.trial_ends_at).getTime() > Date.now() ? "trial" : "inactive";
  return p.plan;
}
