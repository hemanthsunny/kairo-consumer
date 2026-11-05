import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { GoogleLogo, MicrosoftLogo } from "../components/Icons";
import { Loading } from "../App";
import { AvatarStack, joinNames } from "./BookingPage";

interface InviteInfo {
  email: string;
  status: "invited" | "active" | "declined";
  role: "owner" | "admin" | "member";
  joined_user_id: string | null;
  inviter: string;
  team: { id: string; name: string; handle: string; description: string | null };
  people: string[];
  member_user_ids: string[];
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
  const [copied, setCopied] = useState(false);

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
  const alreadyIn = !!me && info.member_user_ids.includes(me);
  const isOwner = false;
  const signedInAs = session?.user.email ?? null;
  const everyone = info.people.length ? info.people : [info.team.name];

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
    if (!confirm(`Decline the invite to ${info?.team.name}?`)) return;
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
          <h1 style={{ fontSize: 22 }}>Join {info.team.name}</h1>
          <p className="muted small">
            {info.inviter} invited you{info.role === "admin" ? " as an admin" : ""}. {info.people.length ? `${joinNames(info.people)} ${info.people.length === 1 ? "is" : "are"} already in. ` : ""}
            Once you join, clients can book calls with you through the group's links, and you can find times that work for everyone — every booking lands in your calendar.
          </p>
          {info.team.description && <p className="small" style={{ whiteSpace: "pre-line" }}>{info.team.description}</p>}
          <p className="small faint">Only your busy times are shared with the group — never your event titles or details.</p>
        </div>

        {error && <div className="alert error" role="alert">{error}</div>}

        {alreadyIn && info.status !== "active" && done !== "joined" ? (
          <div className="stack">
            <div className="alert info">
              You're already in {info.team.name}. This invite is for <strong>{info.email}</strong> — they'll see a Join button when they open it.
              To test it yourself, open this link in a private window.
            </div>
            <div className="row wrap">
              <button className="btn" onClick={() => navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true), () => undefined)}>{copied ? "Copied" : "Copy invite link"}</button>
              <button className="btn ghost" onClick={() => nav(`/app/teams/${info.team.id}`)}>Open the group</button>
            </div>
          </div>
        ) : done === "joined" || alreadyIn ? (
          <div className="stack">
            <div className="alert success" role="status">You're in {info.team.name}. Group bookings will show up in your calendar.</div>
            <button className="btn primary lg block" onClick={() => nav(`/app/teams/${info.team.id}`)}>Open the group</button>
          </div>
        ) : done === "declined" ? (
          <div className="alert info" role="status">Invite declined. You won't be added unless someone invites you again.</div>
        ) : isOwner ? (
          <div className="stack">
            <div className="alert info">
              You're already in this team. This invite is for <strong>{info.email}</strong> — they'll see a Join button when they open it.
            </div>
            <div className="row wrap">
              <button className="btn" onClick={() => navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true), () => undefined)}>{copied ? "Copied" : "Copy invite link"}</button>
              <button className="btn ghost" onClick={() => nav("/app/links")}>Back to my links</button>
            </div>
          </div>
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
            {signedInAs && signedInAs.toLowerCase() !== info.email && (
              <p className="small muted">Invite sent to {info.email} — you're signed in as {signedInAs}. That's fine if it's also you.</p>
            )}
            <button className="btn primary lg block" onClick={accept} disabled={!!busy}>{busy === "accept" ? "Joining…" : `Join ${info.team.name}`}</button>
            <p className="small faint">All {calendars} of your connected calendar{calendars === 1 ? "" : "s"} will be checked for clashes. You can change this in Calendars.</p>
            <button className="btn ghost sm" onClick={decline} disabled={!!busy}>Decline invite</button>
          </div>
        )}
      </div>
    </div>
  );
}
