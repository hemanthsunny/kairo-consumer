import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { supabase } from "../lib/supabase";
import { allTimeZones, browserTz } from "../lib/time";
import { useApp } from "./data";

export default function Settings() {
  const { profile, plan, reload, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [name, setName] = useState(profile.full_name ?? "");
  const [handle, setHandle] = useState(profile.handle);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [phone, setPhone] = useState(profile.phone_e164 ?? "");
  const [channels, setChannels] = useState<string[]>(profile.reminder_channels ?? ["email"]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingBusy, setBillingBusy] = useState<string | null>(null);
  const zones = useMemo(allTimeZones, []);
  const premiumish = plan === "premium" || plan === "trial";

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
    if (!p && channels.some((c) => c !== "email")) return setError("Add your mobile number to get WhatsApp or SMS reminders");
    setSaving(true);
    const { error } = await supabase.from("profiles").update({
      full_name: name.trim() || null,
      handle: h,
      timezone,
      phone_e164: p || null,
      reminder_channels: channels.length ? channels : ["email"],
    }).eq("id", profile.id);
    setSaving(false);
    if (error) {
      setError(error.code === "23505" ? "That address is taken. Try another." : error.message.includes("reserved") ? "That address is reserved. Try another." : error.message);
      return;
    }
    toast("Saved");
    reload();
  }

  function toggleChannel(c: string, on: boolean) {
    setChannels((prev) => (on ? Array.from(new Set([...prev, c])) : prev.filter((x) => x !== c)));
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

  const trialDays = Math.max(0, Math.ceil((new Date(profile.trial_ends_at).getTime() - Date.now()) / 86400000));

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
          <p className="small muted">You'll get a reminder 24 hours and 1 hour before each meeting booked through your links. Guests always get email reminders.</p>
          <label className="field" style={{ maxWidth: 320 }}>Mobile number
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 7700 900123" autoComplete="tel" />
          </label>
          <div className="list">
            {[
              ["email", "Email", "Included"],
              ["whatsapp", "WhatsApp", premiumish ? "Premium · 150 a month" : "Premium"],
              ["sms", "SMS", premiumish ? "Premium · 30 a month" : "Premium"],
            ].map(([key, label, note]) => (
              <div className="list-item" key={key}>
                <label className="row grow" style={{ gap: 10 }}>
                  <input type="checkbox" checked={channels.includes(key)} disabled={key !== "email" && !premiumish}
                    onChange={(e) => toggleChannel(key, e.target.checked)} />
                  <span style={{ fontWeight: 500 }}>{label}</span>
                  <span className="small faint">{note}</span>
                </label>
                <button type="button" className="btn ghost sm" onClick={() => test(key)} disabled={key !== "email" && (!premiumish || !profile.phone_e164)}>Send test</button>
              </div>
            ))}
          </div>
          {plan === "trial" && <p className="small faint">Your trial includes 20 WhatsApp and 5 SMS reminders so you can try them.</p>}
        </div>

        <div><button className="btn primary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button></div>
      </form>

      <div className="card stack" id="plan">
        <div className="spread">
          <h2>Plan</h2>
          <span className={`badge ${plan === "inactive" ? "red" : plan === "trial" ? "accent" : "green"}`}>
            {plan === "trial" ? `Free trial · ${trialDays} day${trialDays === 1 ? "" : "s"} left` : plan === "inactive" ? "No active plan" : plan === "premium" ? "Premium" : "Basic"}
          </span>
        </div>
        {plan === "basic" || plan === "premium" ? (
          <div className="row wrap">
            <button className="btn" onClick={portal} disabled={!!billingBusy}>Manage billing, invoices or cancel</button>
            {plan === "basic" && <button className="btn primary" onClick={portal} disabled={!!billingBusy}>Upgrade to Premium</button>}
          </div>
        ) : (
          <div className="grid-2" style={{ gap: 14 }}>
            <div className="card flat stack" style={{ gap: 8 }}>
              <h3>Basic</h3>
              <p className="small muted">All calendars, unlimited links, email reminders.</p>
              <button className="btn" onClick={() => checkout("basic", "month")} disabled={!!billingBusy}>£3 / month</button>
              <button className="btn ghost sm" onClick={() => checkout("basic", "year")} disabled={!!billingBusy}>or £30 / year</button>
            </div>
            <div className="card flat stack plan featured" style={{ gap: 8 }}>
              <h3>Premium</h3>
              <p className="small muted">Everything in Basic plus WhatsApp and SMS reminders, daily limits.</p>
              <button className="btn primary" onClick={() => checkout("premium", "month")} disabled={!!billingBusy}>£9 / month</button>
              <button className="btn ghost sm" onClick={() => checkout("premium", "year")} disabled={!!billingBusy}>or £90 / year</button>
            </div>
          </div>
        )}
        <p className="small faint">Payments are handled securely by Stripe. Questions? <a href="mailto:contact@kairohr.co">contact@kairohr.co</a></p>
      </div>
    </div>
  );
}
