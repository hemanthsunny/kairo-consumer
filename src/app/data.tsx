import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase, Account, CalendarRow, LinkRow, Plan, Profile } from "../lib/supabase";

export type AccountLite = Omit<Account, "busy" | "error">;

export interface AppData {
  profile: Profile;
  plan: Plan;
  accounts: AccountLite[];
  calendars: CalendarRow[];
  links: LinkRow[];
  reload: () => Promise<void>;
  toast: (msg: string) => void;
}

export const AppCtx = createContext<AppData | null>(null);

export function useApp(): AppData {
  const v = useContext(AppCtx);
  if (!v) throw new Error("useApp outside AppShell");
  return v;
}

export function effectivePlan(p: Profile): Plan {
  if (p.plan === "trial") return new Date(p.trial_ends_at).getTime() > Date.now() ? "trial" : "inactive";
  return p.plan;
}

export function useAppLoader(userId: string | undefined) {
  const [data, setData] = useState<Omit<AppData, "reload" | "toast" | "plan"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    // profile is created by a database trigger on sign-up; retry briefly in case it's a fresh account
    let profile: Profile | null = null;
    for (let i = 0; i < 4 && !profile; i++) {
      const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
      profile = data as Profile | null;
      if (!profile) await new Promise((r) => setTimeout(r, 600));
    }
    if (!profile) {
      setError("We couldn't load your account. Please refresh the page.");
      return;
    }
    const [acc, cal, links] = await Promise.all([
      supabase.from("connected_accounts").select("id,provider,email,label,color,status,last_error").order("created_at"),
      supabase.from("calendars").select("id,account_id,name,can_write,check_conflicts"),
      supabase.from("links").select("*").order("created_at"),
    ]);
    setData({
      profile,
      accounts: (acc.data ?? []) as AccountLite[],
      calendars: (cal.data ?? []) as CalendarRow[],
      links: (links.data ?? []) as LinkRow[],
    });
  }, [userId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, reload };
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2600);
    return () => clearTimeout(t);
  }, [msg]);
  return { msg, toast: setMsg };
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
