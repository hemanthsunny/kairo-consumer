import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { GoogleLogo, IconCheck, IconShield, MicrosoftLogo } from "../components/Icons";
import { Loading } from "../App";

interface Info {
  app: { name: string; client_id: string };
  scopes: { id: string; label: string }[];
}

/** Consent page another app (e.g. Kairo HR) sends people to: /connect?client_id=…&redirect_uri=…&scope=…&state=…&external_ref=… */
export default function Connect() {
  const [params] = useSearchParams();
  const { session, ready } = useAuth();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(params.get("error"));
  const [calendars, setCalendars] = useState<{ email: string; provider: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const scope = params.get("scope") ?? "busy.read";
  const here = `/connect?${new URLSearchParams(
    Object.fromEntries(["client_id", "redirect_uri", "scope", "state", "external_ref"].flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : []))),
  ).toString()}`;

  useEffect(() => {
    api<Info>(`/apps/authorize-info?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope })}`, { auth: false })
      .then(setInfo).catch((e) => setError(e.message));
  }, [clientId, redirectUri, scope]);

  useEffect(() => {
    if (!session) return;
    supabase.from("connected_accounts").select("email,provider").order("created_at").then(({ data }) => setCalendars(data ?? []));
  }, [session]);

  function cancel() {
    if (!redirectUri) return;
    const u = new URL(redirectUri);
    u.searchParams.set("error", "access_denied");
    const st = params.get("state");
    if (st) u.searchParams.set("state", st);
    window.location.href = u.toString();
  }

  async function allow() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ redirect: string }>("/apps/authorize", {
        method: "POST",
        body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, scope, state: params.get("state"), external_ref: params.get("external_ref") }),
      });
      window.location.href = r.redirect;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function connect(provider: "google" | "microsoft") {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("/me/connect", { method: "POST", body: JSON.stringify({ provider, returnTo: here }) });
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!info && !error) return <Loading />;
  if (!info) {
    return <div className="auth"><div className="card stack center"><h2>Can't connect</h2><p className="muted small">{error}</p><Link to="/" className="small">Kairo Link</Link></div></div>;
  }

  return (
    <div className="auth">
      <div className="card stack-lg" style={{ maxWidth: 480 }}>
        <Link to="/" className="brand" style={{ padding: 0 }}><img src="/favicon.svg" alt="" />Kairo Link</Link>
        <div className="stack" style={{ gap: 8 }}>
          <h1 style={{ fontSize: 22 }}>Connect {info.app.name} to your calendars</h1>
          <p className="muted small">{info.app.name} will use the calendars you've combined in Kairo Link, and stay up to date automatically.</p>
        </div>

        <div className="card flat stack" style={{ gap: 10, padding: 16 }}>
          <p className="small" style={{ fontWeight: 600, margin: 0 }}>{info.app.name} will be able to:</p>
          {info.scopes.map((s) => (
            <div key={s.id} className="row small" style={{ gap: 10, alignItems: "flex-start" }}>
              <IconCheck width={16} style={{ color: "var(--green)", flex: "none", marginTop: 2 }} />
              <span>{s.label}</span>
            </div>
          ))}
          <div className="row small faint" style={{ gap: 10, alignItems: "flex-start" }}>
            <IconShield width={16} style={{ flex: "none", marginTop: 2 }} />
            <span>It never sees your event titles, guests or details. You can disconnect any time in Settings.</span>
          </div>
        </div>

        {error && <div className="alert error" role="alert">{error}</div>}

        {!ready ? <Loading /> : !session ? (
          <div className="stack">
            <Link className="btn primary lg block" to={`/login?mode=signup&next=${encodeURIComponent(here)}`}>Sign in to Kairo Link</Link>
            <p className="small faint center">Free. Takes a few seconds.</p>
            <button className="btn ghost sm" onClick={cancel}>Cancel</button>
          </div>
        ) : calendars === null ? <Loading /> : calendars.length === 0 ? (
          <div className="stack">
            <p className="small">First, connect a calendar. You can add more (work, personal…) later in Kairo Link.</p>
            <button className="btn lg block" onClick={() => connect("google")} disabled={busy}><GoogleLogo /> Connect Google Calendar</button>
            <button className="btn lg block" onClick={() => connect("microsoft")} disabled={busy}><MicrosoftLogo /> Connect Outlook / Microsoft 365</button>
            <button className="btn ghost sm" onClick={cancel}>Cancel</button>
          </div>
        ) : (
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              Signed in as {session.user.email}. Calendars included: {calendars.map((c) => c.email).join(", ")}.{" "}
              <Link to="/app/calendars" target="_blank">Add more</Link>
            </p>
            <button className="btn primary lg block" onClick={allow} disabled={busy}>{busy ? "Connecting…" : `Allow ${info.app.name}`}</button>
            <button className="btn ghost sm" onClick={cancel} disabled={busy}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
