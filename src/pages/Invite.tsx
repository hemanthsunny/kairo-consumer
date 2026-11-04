import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { durationLabel } from "../lib/time";
import { GoogleLogo, MicrosoftLogo } from "../components/Icons";
import { Loading } from "../App";
import { AvatarStack, joinNames } from "./BookingPage";

interface InviteInfo {
  email: string;
  status: "invited" | "active" | "declined";
  joined_user_id: string | null;
  owner: string;
  owner_user_id: string;
  link: { title: string; description: string | null; duration_min: number };
  people: string[];
}

export default function Invite() {
  const { token = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { session, ready } = useAuth();
  const nav = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [calendars, setCalendars] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(params.get("error"));
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<"joined" | "declined" | null>(null);

  useEffect(() => {
    api<InviteInfo>(`/invites/${token}`, { auth: false }).then(setInfo).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    if (!session) return;
    supabase.from("connected_accounts").select("id", { count: "exact", head: true }).then(({ count }) => setCalendars(count ?? 0));
  }, [session]);

  useEffect(() => {
    if (params.get("connected") || params.get("error")) setParams({}, { replace: true });
  }, [params, setParams]);

  if (!info && !error) return <Loading />;
  if (!info) {
    return (
      <div className="auth"><div className="card stack center"><h2>{error}</h2><Link to="/" className="small">Kairo Link</Link></div></div>
    );
  }

  const me = session?.user.id;
  const isOwner = me === info.owner_user_id;
  const alreadyIn = info.status === "active" && info.joined_user_id === me;
  const everyone = [info.owner, ...info.people];

  async function connect(provider: "google" | "microsoft") {
    setBusy(provider);
    try {
      const { url } = await api<{ url: string }>("/me/connect", {
        method: "POST",
        body: JSON.stringify({ provider, returnTo: `/invite/${token}`, loginHint: info?.email }),
      });
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function accept() {
    setBusy("accept");
    setError(null);
    try {
      await api(`/invites/${token}/accept`, { method: "POST" });
      setDone("joined");
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  async function decline() {
    if (!confirm(`Decline ${info?.owner}'s invite?`)) return;
    setBusy("decline");
    try {
      await api(`/invites/${token}/decline`, { method: "POST", auth: false });
      setDone("declined");
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  return (
    <div className="auth">
      <div className="card stack-lg" style={{ maxWidth: 460 }}>
        <Link to="/" className="brand" style={{ padding: 0 }}><img src="/favicon.svg" alt="" />Kairo Link</Link>
        <div className="stack" style={{ gap: 10 }}>
          <AvatarStack names={everyone} />
          <h1 style={{ fontSize: 22 }}>{info.owner} added you to “{info.link.title}”</h1>
          <p className="muted small">
            {durationLabel(info.link.duration_min)} call{info.people.length ? ` with ${joinNames(everyone)}` : ""}. People can only book times when you're all free, and each booking goes straight into your calendar.
          </p>
          {info.link.description && <p className="small" style={{ whiteSpace: "pre-line" }}>{info.link.description}</p>}
          <p className="small faint">Only your busy times are shared — never your event titles or details.</p>
        </div>

        {error && <div className="alert error" role="alert">{error}</div>}

        {done === "joined" || alreadyIn ? (
          <div className="stack">
            <div className="alert success" role="status">You're in. Bookings on “{info.link.title}” will show up in your calendar.</div>
            <button className="btn primary lg block" onClick={() => nav("/app/links")}>Open Kairo Link</button>
          </div>
        ) : done === "declined" ? (
          <div className="alert info" role="status">Invite declined. {info.owner} won't be able to add you unless they invite you again.</div>
        ) : isOwner ? (
          <div className="alert info">This is your own link. Share this invite with the person you added.</div>
        ) : !ready ? (
          <Loading />
        ) : !session ? (
          <div className="stack">
            <p className="small">Step 1 of 2 — sign in (free, takes a few seconds).</p>
            <Link className="btn primary lg block" to={`/login?mode=signup&next=/invite/${token}`}>Continue</Link>
            <button className="btn ghost sm" onClick={decline} disabled={!!busy}>Decline invite</button>
          </div>
        ) : calendars === null ? (
          <Loading />
        ) : calendars === 0 ? (
          <div className="stack">
            <p className="small">Step 2 of 2 — connect the calendar you'd like bookings to check and appear in.</p>
            <button className="btn lg block" onClick={() => connect("google")} disabled={!!busy}><GoogleLogo /> Connect Google Calendar</button>
            <button className="btn lg block" onClick={() => connect("microsoft")} disabled={!!busy}><MicrosoftLogo /> Connect Outlook / Microsoft 365</button>
            <button className="btn ghost sm" onClick={decline} disabled={!!busy}>Decline invite</button>
          </div>
        ) : (
          <div className="stack">
            <button className="btn primary lg block" onClick={accept} disabled={!!busy}>{busy === "accept" ? "Joining…" : `Join “${info.link.title}”`}</button>
            <p className="small faint">All {calendars} of your connected calendar{calendars === 1 ? "" : "s"} will be checked for clashes. You can change this in Calendars.</p>
            <button className="btn ghost sm" onClick={decline} disabled={!!busy}>Decline invite</button>
          </div>
        )}
      </div>
    </div>
  );
}
