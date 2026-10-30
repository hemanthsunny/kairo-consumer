import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { supabase, Booking } from "../lib/supabase";
import { fmtDay, fmtTime } from "../lib/time";
import { IconVideo } from "../components/Icons";
import { useApp } from "./data";

export default function Bookings() {
  const { profile, links, toast } = useApp();
  const tz = profile.timezone;
  const [tab, setTab] = useState<"upcoming" | "past" | "cancelled">("upcoming");
  const [rows, setRows] = useState<(Booking & { guest_note?: string | null; guest_phone?: string | null })[] | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    const now = new Date().toISOString();
    let q = supabase.from("bookings").select("*");
    if (tab === "upcoming") q = q.eq("status", "confirmed").gte("end_at", now).order("start_at", { ascending: true });
    if (tab === "past") q = q.eq("status", "confirmed").lt("end_at", now).order("start_at", { ascending: false });
    if (tab === "cancelled") q = q.eq("status", "cancelled").order("start_at", { ascending: false });
    const { data } = await q.limit(100);
    setRows((data ?? []) as Booking[]);
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  async function cancel(b: Booking) {
    const reason = prompt(`Cancel with ${b.guest_name}? They'll get an email. Add a short reason (optional):`);
    if (reason === null) return;
    try {
      await api(`/me/bookings/${b.id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
      toast("Cancelled and guest notified");
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="stack-lg" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <p className="muted">Meetings booked through your links.</p>
        </div>
      </div>
      <div className="row" role="tablist">
        {(["upcoming", "past", "cancelled"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn sm ${tab === t ? "primary" : ""}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="card">
        {rows === null ? (
          <div className="loading"><div className="spinner" /></div>
        ) : rows.length === 0 ? (
          <div className="empty">{tab === "upcoming" ? "No upcoming bookings. Share your link to get some!" : "Nothing here yet."}</div>
        ) : (
          <div className="list">
            {rows.map((b) => (
              <div className="list-item" key={b.id} style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ width: 110 }}>
                  <p style={{ fontWeight: 600 }}>{fmtDay(b.start_at, tz)}</p>
                  <p className="small muted">{fmtTime(b.start_at, tz)} – {fmtTime(b.end_at, tz)}</p>
                </div>
                <div className="grow" style={{ minWidth: 200 }}>
                  <p style={{ fontWeight: 500 }}>{b.guest_name} <span className="muted small">· {b.guest_email}</span></p>
                  <p className="small muted">{links.find((l) => l.id === b.link_id)?.title ?? b.title}</p>
                  {b.guest_phone && <p className="small muted">Phone: {b.guest_phone}</p>}
                  {b.guest_note && <p className="small" style={{ marginTop: 4 }}>“{b.guest_note}”</p>}
                  {!b.meeting_url && b.location_text && <p className="small muted">{b.location_text}</p>}
                </div>
                <div className="row">
                  {b.meeting_url && tab === "upcoming" && (
                    <a className="btn sm" href={b.meeting_url} target="_blank" rel="noreferrer"><IconVideo width={15} />Join</a>
                  )}
                  {tab === "upcoming" && <button className="btn ghost sm danger" onClick={() => cancel(b)}>Cancel</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
