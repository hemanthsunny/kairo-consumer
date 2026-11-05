import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { ReminderPrefs, supabase } from "../lib/supabase";
import { allTimeZones, browserTz } from "../lib/time";
import { useApp } from "./data";

const TIMING_OPTIONS: [string, string][] = [
  ["", "Off"],
  ["10", "10 min before"],
  ["30", "30 min before"],
  ["30,10", "30 min and 10 min before"],
  ["1440", "1 day before"],
  ["1440,30", "1 day and 30 min before"],
  ["1440,10", "1 day and 10 min before"],
];

type Ch = "email" | "whatsapp" | "sms";

function timingKey(list: number[] | undefined) {
  const k = [...(list ?? [])].sort((a, b) => b - a).join(",");
  return TIMING_OPTIONS.some(([v]) => v === k) ? k : k ? "30" : "";
}

function initialPrefs(p: ReminderPrefs | null, channels: string[]): Record<Ch, string> & { scope: "bookings" | "all" } {
  if (p) return { scope: p.scope === "all" ? "all" : "bookings", email: timingKey(p.email), whatsapp: timingKey(p.whatsapp), sms: timingKey(p.sms) };
  return {
    scope: "bookings",
    email: channels.includes("email") ? "1440,30" : "",
    whatsapp: channels.includes("whatsapp") ? "30" : "",
    sms: channels.includes("sms") ? "30" : "",
  };
}

const toList = (k: string) => (k ? k.split(",").map(Number) : []);

export default function Settings() {
  const { profile, plan, reload, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [name, setName] = useState(profile.full_name ?? "");
  const [handle, setHandle] = useState(profile.handle);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [phone, setPhone] = useState(profile.phone_e164 ?? "");
  const [prefs, setPrefs] = useState(() => initialPrefs(profile.reminder_prefs, profile.reminder_channels ?? ["email"]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingBusy, setBillingBusy] = useState<string | null>(null);
  const zones = useMemo(allTimeZones, []);
  const premiumish = plan === "premium" || plan === "trial";
  const isPremium = plan === "premium";

  useEffect(() => {
    const b = params.get("billing");
    if (b === "success") toast("Thanks! Your plan is active.");
    if (b) {
      setParams({}, { replace: true });
      setTimeout(reload, 1500);
    }
  }, [params, setParams, reload, toast]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const h = handle.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,30}$/.test(h)) return setError("Your address needs 3–31 lowercase letters, numbers or dashes");
    const p = phone.replace(/[\s()-]/g, "");
    if (p && !/^\+[1-9]\d{6,14}$/.test(p)) return setError("Enter your mobile with country code, e.g. +44 7700 900123");
    if (!p && (prefs.whatsapp || prefs.sms)) return setError("Add your mobile number to get WhatsApp or SMS reminders");
    setSaving(true);
    const { error } = await supabase.from("profiles").update({
      full_name: name.trim() || null,
      handle: h,
      timezone,
      phone_e164: p || null,
      reminder_prefs: { scope: prefs.scope, email: toList(prefs.email), whatsapp: toList(prefs.whatsapp), sms: toList(prefs.sms) },
      reminder_channels: (["email", "whatsapp", "sms"] as Ch[]).filter((c) => prefs[c]),
    }).eq("id", profile.id);
    setSaving(false);
    if (error) {
      setError(error.code === "23505" ? "That address is taken. Try another." : error.message.includes("reserved") ? "That address is reserved. Try another." : error.message);
      return;
    }
    toast("Saved");
    reload();
  }


  async function test(channel: string) {
    try {
      await api("/me/test-reminder", { method: "POST", body: JSON.stringify({ channel }) });
      toast(`Test ${channel === "email" ? "email" : channel === "sms" ? "SMS" : "WhatsApp"} sent`);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function checkout(p: "basic" | "premium", interval: "month" | "year") {
    setBillingBusy(`${p}-${interval}`);
    try {
      const { url } = await api<{ url: string }>("/billing/checkout", { method: "POST", body: JSON.stringify({ plan: p, interval }) });
      window.location.href = url;
    } catch (e) {
      toast((e as Error).message);
      setBillingBusy(null);
    }
  }

  async function portal() {
    setBillingBusy("portal");
    try {
      const { url } = await api<{ url: string }>("/billing/portal", { method: "POST" });
      window.location.href = url;
    } catch (e) {
      toast((e as Error).message);
      setBillingBusy(null);
    }
  }


  return (
    <div className="stack-lg" style={{ maxWidth: 760 }}>
      <div className="page-head"><h1>Settings</h1></div>

      <form className="stack-lg" onSubmit={save} noValidate>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="card stack">
          <h2>Profile</h2>
          <div className="grid-2" style={{ gap: 14 }}>
            <label className="field">Your name (shown to guests)
              <input type="text" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} autoComplete="name" />
            </label>
            <label className="field">Your address
              <div className="input-prefix"><span>{window.location.host}/</span>
                <input type="text" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
              </div>
              <span className="hint">Changing this changes all your links.</span>
            </label>
            <label className="field">Time zone
              <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
              </select>
              {timezone !== browserTz() && (
                <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setTimezone(browserTz())}>
                  Use this device's time zone ({browserTz()})
                </button>
              )}
            </label>
          </div>
        </div>

        <div className="card stack">
          <div className="spread"><h2>Reminders</h2>{!premiumish && <span className="badge accent">WhatsApp & SMS on Premium</span>}</div>
          <p className="small muted">Choose when each channel reminds you. Your guests always get an email the day before and an hour before.</p>
          <div className="grid-2" style={{ gap: 14 }}>
            <label className="field">Remind me about
              <select value={prefs.scope} onChange={(e) => setPrefs({ ...prefs, scope: e.target.value as "bookings" | "all" })}>
                <option value="bookings">Meetings booked through my links</option>
                <option value="all" disabled={!premiumish}>All events in my calendars{premiumish ? "" : " (Premium)"}</option>
              </select>
              {prefs.scope === "all" && <span className="hint">Covers calendars with “Show event details” on. SMS stays for bookings only, to save your monthly allowance.</span>}
            </label>
            <label className="field">Mobile number
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 7700 900123" autoComplete="tel" />
            </label>
          </div>
          <div className="list">
            {([
              ["email", "Email", "Included"],
              ["whatsapp", "WhatsApp", premiumish ? "300 a month" : "Premium"],
              ["sms", "SMS", premiumish ? "50 a month" : "Premium"],
            ] as [Ch, string, string][]).map(([key, label, note]) => {
              const locked = key !== "email" && !premiumish;
              return (
                <div className="list-item reminder-row" key={key}>
                  <div className="grow" style={{ minWidth: 110 }}>
                    <div style={{ fontWeight: 500 }}>{label}</div>
                    <div className="small faint">{note}</div>
                  </div>
                  <select aria-label={`${label} reminders`} value={locked ? "" : prefs[key]} disabled={locked}
                    onChange={(e) => setPrefs({ ...prefs, [key]: e.target.value })}>
                    {TIMING_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                  <button type="button" className="btn ghost sm" onClick={() => test(key)} disabled={locked || (key !== "email" && !profile.phone_e164)}>Send test</button>
                </div>
              );
            })}
          </div>
          
        </div>

        <div><button className="btn primary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button></div>
      </form>

      <ConnectedApps />

      <div className="card stack" id="plan">
        <div className="spread">
          <h2>Plan</h2>
          <span className={`badge ${isPremium ? "green" : "accent"}`}>{isPremium ? "Premium" : "Free"}</span>
        </div>
        {isPremium ? (
          <div className="row wrap">
            <button className="btn" onClick={portal} disabled={!!billingBusy}>Manage billing, invoices or cancel</button>
          </div>
        ) : (
          <div className="card flat stack plan featured" style={{ gap: 10 }}>
            <div className="spread"><h3>Premium</h3><span className="badge accent">£9 / month</span></div>
            <p className="small muted">Unlimited calendars and booking links, WhatsApp reminders (300 a month), SMS reminders (50 a month), WhatsApp reminders for your guests and priority support.</p>
            <div className="row wrap">
              <button className="btn primary" onClick={() => checkout("premium", "month")} disabled={!!billingBusy}>Go Premium · £9 / month</button>
              <button className="btn" onClick={() => checkout("premium", "year")} disabled={!!billingBusy}>£90 / year (2 months free)</button>
            </div>
          </div>
        )}
        <p className="small faint">Payments are handled securely by Stripe. Questions? <a href="mailto:contact@kairohr.co">contact@kairohr.co</a></p>
      </div>
    </div>
  );
}

type ConnectedApp = { id: string; name: string; scopes: string[]; connected_at: string; last_synced_at: string | null; sync_error: string | null };

function ConnectedApps() {
  const { toast } = useApp();
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const load = () => api<{ apps: ConnectedApp[] }>("/me/apps").then((r) => setApps(r.apps)).catch(() => setApps([]));
  useEffect(() => { load(); }, []);

  async function disconnect(a: ConnectedApp) {
    if (!confirm(`Disconnect ${a.name}? It will stop seeing when you're busy.`)) return;
    try {
      await api(`/me/apps/${a.id}`, { method: "DELETE" });
      toast(`${a.name} disconnected`);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="card stack">
      <h2>Connected apps</h2>
      <p className="small muted" style={{ margin: 0 }}>These apps use your combined calendar and get updates as soon as it changes. They only ever see busy times, never event details.</p>
      {apps === null ? (
        <p className="small faint" style={{ margin: 0 }}>Loading…</p>
      ) : apps.length === 0 ? (
        <div className="card flat stack" style={{ gap: 6 }}>
          <div style={{ fontWeight: 500 }}>No apps connected yet</div>
          <p className="small muted" style={{ margin: 0 }}>
            Interviewing with a company on Kairo HR? Open the calendar link your HR team sent you (in Kairo HR: Interviewers → <b>Connect link</b>), choose <b>Several calendars · Kairo Link</b>, and approve it here. It will then appear in this list.
          </p>
        </div>
      ) : (
      <div className="list">
        {apps.map((a) => (
          <div className="list-item" key={a.id} style={{ flexWrap: "wrap", gap: 10 }}>
            <div className="grow" style={{ minWidth: 220 }}>
              <div style={{ fontWeight: 500 }}>{a.name}</div>
              <div className="small faint">
                Connected {new Date(a.connected_at).toLocaleDateString()}
                {a.last_synced_at ? ` · last update ${new Date(a.last_synced_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}` : ""}
              </div>
              <ul className="small muted" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {a.scopes.map((s) => <li key={s}>{s}</li>)}
              </ul>
            </div>
            <button type="button" className="btn ghost sm" onClick={() => disconnect(a)}>Disconnect</button>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
