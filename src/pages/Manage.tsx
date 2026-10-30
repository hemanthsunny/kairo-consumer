import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { browserTz, fmtLongDay, fmtTime } from "../lib/time";
import { IconClock, IconPin, IconVideo } from "../components/Icons";
import { Loading } from "../App";

interface Data {
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  meeting_url: string | null;
  location: string | null;
  guest_name: string;
  host: string;
  rebook_url: string | null;
  can_cancel: boolean;
}

export default function Manage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const tz = browserTz();

  const load = () => api<Data>(`/manage/${token}`, { auth: false }).then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function cancel() {
    setBusy(true);
    try {
      await api(`/manage/${token}/cancel`, { method: "POST", auth: false, body: JSON.stringify({ reason }) });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <div className="booking-wrap"><div className="card center" style={{ maxWidth: 420 }}><h2>{error}</h2></div></div>;
  if (!data) return <Loading />;
  const cancelled = data.status === "cancelled";

  return (
    <div className="booking-wrap">
      <div className="card stack-lg" style={{ maxWidth: 520, width: "100%", alignSelf: "flex-start", padding: 32 }}>
        <div>
          {cancelled ? <span className="badge red">Cancelled</span> : <span className="badge green">Confirmed</span>}
          <h1 style={{ fontSize: 22, marginTop: 10 }}>{data.title} with {data.host}</h1>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <span className="meta"><IconClock />{fmtLongDay(data.start_at, tz)}, {fmtTime(data.start_at, tz)} – {fmtTime(data.end_at, tz)}</span>
          {!cancelled && data.meeting_url && <span className="meta"><IconVideo /><a href={data.meeting_url} target="_blank" rel="noreferrer">Join link</a></span>}
          {!cancelled && !data.meeting_url && data.location && <span className="meta"><IconPin />{data.location}</span>}
        </div>
        {error && <div className="alert error">{error}</div>}
        {cancelled ? (
          <div className="stack">
            <p className="muted">This meeting has been cancelled and {data.host} has been told.</p>
            {data.rebook_url && <a className="btn primary" href={data.rebook_url}>Book a new time</a>}
          </div>
        ) : data.can_cancel ? (
          <div className="stack">
            <label className="field">Reason (optional, shared with {data.host})
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </label>
            <div className="row wrap">
              <button className="btn danger" onClick={cancel} disabled={busy}>{busy ? "Cancelling…" : "Cancel meeting"}</button>
              {data.rebook_url && <a className="btn ghost" href={data.rebook_url}>Pick a different time instead</a>}
            </div>
            <p className="small faint">To move it, cancel and book a new time.</p>
          </div>
        ) : (
          <p className="muted small">This meeting can no longer be changed here.</p>
        )}
        <Link to="/" className="small faint">Kairo Link</Link>
      </div>
    </div>
  );
}
