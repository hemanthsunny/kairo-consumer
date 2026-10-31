import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Account, Booking, LinkRow } from "../lib/supabase";
import { AccountEvents, buildItems, EventDetails, Item, WeekCalendar } from "./WeekCalendar";
import { fmt, fmtDay, fmtTime, minutesOfDay, tzLabel } from "../lib/time";
import { IconChevron, IconCopy, IconRefresh, IconVideo } from "../components/Icons";
import { buildShareText, ConnectButtons, linkUrl } from "./shared";
import { copyText, useApp } from "./data";

function startOfWeek(tz: string, offsetWeeks: number) {
  // Monday 00:00 in tz, approximated via local day key arithmetic
  const now = Date.now();
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(now);
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd);
  const todayMid = now - minutesOfDay(now, tz) * 60000;
  return todayMid - idx * 86400000 + offsetWeeks * 7 * 86400000;
}

interface Overview {
  accounts: Account[];
  bookings: Booking[];
}

export default function Home() {
  const { profile, accounts, links, toast } = useApp();
  const tz = profile.timezone;
  const [week, setWeek] = useState(0);
  const [ov, setOv] = useState<Overview | null>(null);
  const [events, setEvents] = useState<AccountEvents[] | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const activeLinks = links.filter((l) => l.is_active);
  const [shareLinkId, setShareLinkId] = useState<string | null>(null);
  const shareLink: LinkRow | undefined = activeLinks.find((l) => l.id === shareLinkId) ?? activeLinks[0];
  const [sharing, setSharing] = useState(false);

  const from = useMemo(() => startOfWeek(tz, week), [tz, week]);
  const to = from + 7 * 86400000;

  const load = useCallback(async (live = false) => {
    if (!accounts.length) return;
    setLoading(true);
    setErr(null);
    try {
      const wantDetails = accounts.some((a) => a.show_details);
      const [o, ev] = await Promise.all([
        api<Overview>(`/me/overview?from=${from}&to=${to}${live ? "&live=1" : ""}`),
        wantDetails ? api<{ accounts: AccountEvents[] }>(`/me/events?from=${from}&to=${to}`).catch(() => null) : Promise.resolve(null),
      ]);
      setOv(o);
      setEvents(ev?.accounts ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [accounts, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  // refresh every 2 minutes while the tab is visible
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && load(), 120000);
    return () => clearInterval(t);
  }, [load]);

  if (!accounts.length) return <Onboarding />;

  async function shareTimes() {
    if (!shareLink) return;
    setSharing(true);
    try {
      const text = await buildShareText(profile, shareLink, tz);
      if (!text) toast("No free times in the next 10 days for this link");
      else if (await copyText(text)) toast("Your free times are copied. Paste them anywhere.");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSharing(false);
    }
  }

  const upcoming = (ov?.bookings ?? []).filter((b) => b.status === "confirmed" && Date.parse(b.end_at) > Date.now()).slice(0, 5);
  const problems = (ov?.accounts ?? []).filter((a) => a.error);

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Hi {profile.full_name?.split(" ")[0] ?? "there"}</h1>
          <p className="muted">{fmt(Date.now(), tz, { weekday: "long", day: "numeric", month: "long" })} · {tzLabel(tz)}</p>
        </div>
      </div>

      {problems.map((a) => (
        <div key={a.id} className="alert warn" role="alert">
          <strong>{a.email}</strong> isn't syncing: {a.error}. Slots from this calendar may be wrong.{" "}
          <Link to="/app/calendars">Reconnect</Link>
        </div>
      ))}

      {shareLink ? (
        <div className="card">
          <div className="spread wrap" style={{ flexWrap: "wrap" }}>
            <div className="grow" style={{ minWidth: 220 }}>
              <p className="small muted">Your link</p>
              <div className="row" style={{ marginTop: 4 }}>
                <a className="truncate" href={linkUrl(profile, shareLink)} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 16 }}>
                  {linkUrl(profile, shareLink).replace(/^https?:\/\//, "")}
                </a>
              </div>
              {activeLinks.length > 1 && (
                <select aria-label="Choose link" value={shareLink.id} onChange={(e) => setShareLinkId(e.target.value)} style={{ marginTop: 10, maxWidth: 320 }}>
                  {activeLinks.map((l) => <option key={l.id} value={l.id}>{l.title} · {l.duration_min} min</option>)}
                </select>
              )}
            </div>
            <div className="row wrap">
              <button className="btn primary" onClick={async () => { if (await copyText(linkUrl(profile, shareLink))) toast("Link copied"); }}>
                <IconCopy width={16} /> Copy link
              </button>
              <button className="btn" onClick={shareTimes} disabled={sharing}>
                {sharing ? "Finding times…" : "Copy my free times"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="alert info">You don't have an active link. <Link to="/app/links">Create one</Link> to start taking bookings.</div>
      )}

      <div className="card">
        <div className="card-head" style={{ flexWrap: "wrap" }}>
          <div>
            <h2>{week === 0 ? "This week" : week === 1 ? "Next week" : `Week of ${fmtDay(from + 3600000, tz)}`}</h2>
            <p className="small muted">All your calendars together. Click any event for details and the join link.</p>
          </div>
          <div className="row">
            <button className="btn sm" aria-label="Previous week" onClick={() => setWeek((w) => Math.max(0, w - 1))} disabled={week === 0}><IconChevron dir="left" width={16} /></button>
            <button className="btn sm" onClick={() => setWeek(0)} disabled={week === 0}>Today</button>
            <button className="btn sm" aria-label="Next week" onClick={() => setWeek((w) => Math.min(4, w + 1))} disabled={week >= 4}><IconChevron width={16} /></button>
            <button className="btn sm" onClick={() => load(true)} disabled={loading} title="Sync now"><IconRefresh width={16} />{loading ? "Syncing" : "Sync"}</button>
          </div>
        </div>
        {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}
        <div className="legend" style={{ marginBottom: 12 }}>
          {accounts.map((a) => <span key={a.id}><i className="dot" style={{ background: a.color }} />{a.label} · {a.email}</span>)}
          
        </div>
        <WeekCalendar from={from} tz={tz} items={ov ? buildItems(ov.accounts, events, ov.bookings) : []} onSelect={setSelected} />
        {!ov && <div className="loading" style={{ padding: 16 }}><div className="spinner" /></div>}
        {selected && <EventDetails item={selected} tz={tz} onClose={() => setSelected(null)} />}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Coming up</h2>
          <Link to="/app/bookings" className="small">All bookings</Link>
        </div>
        {upcoming.length === 0 ? (
          <p className="muted small">Nothing booked through your links this week yet.</p>
        ) : (
          <div className="list">
            {upcoming.map((b) => (
              <div className="list-item" key={b.id}>
                <div style={{ width: 92 }}>
                  <p style={{ fontWeight: 600 }}>{fmtTime(b.start_at, tz)}</p>
                  <p className="small muted">{fmtDay(b.start_at, tz)}</p>
                </div>
                <div className="grow">
                  <p className="truncate" style={{ fontWeight: 500 }}>{b.guest_name}</p>
                  <p className="small muted truncate">{b.title}</p>
                </div>
                {b.meeting_url && (
                  <a className="btn sm" href={b.meeting_url} target="_blank" rel="noreferrer"><IconVideo width={16} />Join</a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Onboarding() {
  return (
    <div className="stack-lg" style={{ maxWidth: 680 }}>
      <div>
        <h1>Let's combine your calendars</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Connect each email account you use for meetings: client, company, personal. We check all of them before anyone can book you.
        </p>
      </div>
      <div className="card stack-lg">
        <div className="steps">
          <div className="step"><span className="num">1</span><div><p style={{ fontWeight: 600 }}>Connect your first calendar</p><p className="small muted">Google or Microsoft 365 / Outlook</p></div></div>
          <div className="step"><span className="num">2</span><div><p style={{ fontWeight: 600 }}>Add your other email accounts</p><p className="small muted">As many as you like, so nothing clashes</p></div></div>
          <div className="step"><span className="num">3</span><div><p style={{ fontWeight: 600 }}>Share your link</p><p className="small muted">We create one for you straight away</p></div></div>
        </div>
        <ConnectButtons returnTo="/app" />
        <p className="small faint">Your event details are shown only to you and never stored. You can set any calendar to busy-only.</p>
      </div>
    </div>
  );
}
