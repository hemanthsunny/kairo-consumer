import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Account, Booking, CalAttendee, CalEvent } from "../lib/supabase";
import { dayKey, fmt, fmtLongDay, fmtTime, minutesOfDay } from "../lib/time";
import { IconClock, IconPin, IconVideo } from "../components/Icons";

const PX_PER_H = 48;
const DAY_PX = 24 * PX_PER_H;

export interface AccountEvents {
  account_id: string;
  events: CalEvent[];
  error?: string;
}

/** One thing drawn on the grid. */
export interface Item {
  key: string;
  start: number;
  end: number;
  allDay: boolean;
  title: string;
  color: string;
  account?: Pick<Account, "id" | "label" | "email" | "provider">;
  event?: CalEvent;
  booking?: Booking;
  busyOnly?: boolean;
}

export function buildItems(accounts: Account[], events: AccountEvents[] | null, bookings: Booking[]): Item[] {
  const items: Item[] = [];
  const detailed = new Set<string>();
  for (const ae of events ?? []) {
    if (ae.error) continue;
    const acc = accounts.find((a) => a.id === ae.account_id);
    if (!acc) continue;
    detailed.add(acc.id);
    for (const e of ae.events) {
      items.push({ key: `${acc.id}:${e.id}`, start: e.start, end: e.end, allDay: e.allDay, title: e.title, color: acc.color, account: acc, event: e });
    }
  }
  for (const a of accounts) {
    if (detailed.has(a.id)) continue;
    for (const b of a.busy) {
      items.push({ key: `${a.id}:busy:${b.start}`, start: b.start, end: b.end, allDay: false, title: "Busy", color: a.color, account: a, busyOnly: true });
    }
  }
  for (const b of bookings) {
    if (b.status !== "confirmed") continue;
    if (b.write_account_id && detailed.has(b.write_account_id)) continue; // already shown as a real event
    items.push({ key: `booking:${b.id}`, start: Date.parse(b.start_at), end: Date.parse(b.end_at), allDay: false, title: `${b.guest_name} (booked)`, color: "#0f172a", booking: b });
  }
  return items;
}

interface Placed extends Item {
  top: number;
  height: number;
  col: number;
  cols: number;
}

/** Google Calendar-style layout: overlapping items share the width side by side. */
function layoutDay(items: Item[], dayStart: number, tz: string): Placed[] {
  const dayEnd = dayStart + 86400000;
  const clipped = items
    .map((it) => ({ it, s: Math.max(it.start, dayStart), e: Math.min(it.end, dayEnd) }))
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const placed: Placed[] = [];
  let cluster: { p: Placed; e: number }[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.p.col + 1));
    for (const c of cluster) c.p.cols = cols;
    cluster = [];
  };
  const colEnds: number[] = [];
  for (const { it, s, e } of clipped) {
    if (s >= clusterEnd) {
      flush();
      colEnds.length = 0;
    }
    let col = colEnds.findIndex((end) => end <= s);
    if (col === -1) { col = colEnds.length; colEnds.push(e); } else colEnds[col] = e;
    const sm = minutesOfDay(s, tz);
    const em = e >= dayEnd ? 24 * 60 : minutesOfDay(e, tz);
    const p: Placed = { ...it, top: (sm / 60) * PX_PER_H, height: Math.max(((Math.max(em, sm + 15) - sm) / 60) * PX_PER_H, 18), col, cols: 1 };
    placed.push(p);
    cluster.push({ p, e });
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();
  return placed;
}

export function WeekCalendar({ from, tz, items, onSelect }: { from: number; tz: string; items: Item[]; onSelect: (it: Item) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const days = Array.from({ length: 7 }, (_, i) => from + i * 86400000);
  const today = dayKey(Date.now(), tz);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7.5 * PX_PER_H;
  }, [from]);

  const perDay = useMemo(() => days.map((d) => {
    const dk = dayKey(d + 3 * 3600000, tz);
    const timed = items.filter((i) => !i.allDay && i.end > d && i.start < d + 86400000);
    const allDay = items.filter((i) => i.allDay && i.end > d + 3600000 && i.start < d + 86400000 - 3600000);
    return { d, dk, placed: layoutDay(timed, d, tz), allDay };
  }), [items, from, tz]); // eslint-disable-line react-hooks/exhaustive-deps

  const anyAllDay = perDay.some((p) => p.allDay.length);
  const nowM = minutesOfDay(Date.now(), tz);

  return (
    <div className="week-scroll">
      <div style={{ minWidth: 760 }}>
        <div className="week week-head">
          <div className="head" />
          {perDay.map(({ d, dk }) => (
            <div key={dk} className={`head ${dk === today ? "today" : ""}`}>
              {fmt(d + 3 * 3600000, tz, { weekday: "short" })}
              <span className="num">{fmt(d + 3 * 3600000, tz, { day: "numeric" })}</span>
            </div>
          ))}
          {anyAllDay && (
            <>
              <div className="allday-label">All day</div>
              {perDay.map(({ dk, allDay }) => (
                <div key={dk} className="allday">
                  {allDay.map((it) => (
                    <button key={it.key} className="chip" style={{ background: it.color }} onClick={() => onSelect(it)} title={it.title}>{it.title}</button>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="week-body" ref={scroller}>
          <div className="week">
            <div className="gutter" style={{ height: DAY_PX }}>
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} style={{ top: h * PX_PER_H }}>{h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}</span>
              ))}
            </div>
            {perDay.map(({ d, dk, placed }) => {
              const wd = fmt(d + 3 * 3600000, tz, { weekday: "short" });
              return (
                <div key={dk} className={`col ${wd === "Sat" || wd === "Sun" ? "weekend" : ""}`} style={{ height: DAY_PX }}>
                  {placed.map((p) => {
                    const dim = p.event?.declined || p.event?.free;
                    return (
                      <button
                        key={p.key}
                        className={`block ${p.booking ? "booking" : ""} ${p.busyOnly ? "busy" : ""} ${dim ? "dim" : ""}`}
                        style={{
                          top: p.top,
                          height: p.height,
                          left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                          width: `calc(${100 / p.cols}% - 4px)`,
                          background: dim ? "#fff" : p.color,
                          color: dim ? p.color : undefined,
                          borderColor: p.color,
                        }}
                        onClick={() => onSelect(p)}
                        title={`${p.title} · ${fmtTime(p.start, tz)}–${fmtTime(p.end, tz)}`}
                      >
                        <span className={`block-title ${p.event?.declined ? "strike" : ""}`}>{p.title}</span>
                        {p.height >= 34 && <span className="block-time">{fmtTime(p.start, tz)} – {fmtTime(p.end, tz)}</span>}
                      </button>
                    );
                  })}
                  {dk === today && <div className="now" style={{ top: (nowM / 60) * PX_PER_H }} aria-label="Now" />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const RESPONSE_LABEL: Record<CalAttendee["response"], string> = {
  organizer: "Organiser",
  accepted: "Going",
  declined: "Declined",
  tentative: "Maybe",
  needsAction: "Awaiting reply",
};

function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p)
          ? <a key={i} href={p} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>{p}</a>
          : <span key={i}>{p}</span>
      )}
    </>
  );
}

function joinLabel(url: string) {
  if (/meet\.google/.test(url)) return "Join with Google Meet";
  if (/teams\.(microsoft|live)/.test(url)) return "Join Microsoft Teams";
  if (/zoom\.us/.test(url)) return "Join Zoom";
  if (/webex/.test(url)) return "Join Webex";
  return "Join call";
}

export function EventDetails({ item, tz, onClose }: { item: Item; tz: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ev = item.event;
  const sameDay = dayKey(item.start, tz) === dayKey(item.end - 1, tz);
  const when = item.allDay
    ? sameDay || item.end - item.start <= 86400000
      ? `${fmtLongDay(item.start + 3600000, tz)} · All day`
      : `${fmtLongDay(item.start + 3600000, tz)} – ${fmtLongDay(item.end - 3600000, tz)}`
    : sameDay
    ? `${fmtLongDay(item.start, tz)} · ${fmtTime(item.start, tz)} – ${fmtTime(item.end, tz)}`
    : `${fmtLongDay(item.start, tz)} ${fmtTime(item.start, tz)} – ${fmtLongDay(item.end, tz)} ${fmtTime(item.end, tz)}`;
  const join = ev?.joinUrl ?? item.booking?.meeting_url ?? null;
  const live = Date.now() >= item.start - 15 * 60000 && Date.now() <= item.end;

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={item.title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal event-modal stack">
        <div className="spread" style={{ alignItems: "flex-start" }}>
          <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <span className="dot" style={{ background: item.color, width: 14, height: 14, marginTop: 6, borderRadius: 4 }} />
            <div>
              <h2 style={{ fontSize: 20 }}>{item.title}</h2>
              <p className="muted small" style={{ marginTop: 2 }}>{when}</p>
            </div>
          </div>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {item.busyOnly ? (
          <p className="muted small">
            This calendar is set to show busy times only, so details are hidden.{" "}
            <Link to="/app/calendars" onClick={onClose}>Change in Calendars</Link>
          </p>
        ) : (
          <>
            {join && (
              <a className={`btn ${live ? "primary" : ""}`} href={join} target="_blank" rel="noreferrer" style={{ alignSelf: "flex-start" }}>
                <IconVideo width={16} />{joinLabel(join)}
              </a>
            )}
            {join && <p className="small faint" style={{ marginTop: -4, wordBreak: "break-all" }}>{join}</p>}
            {ev?.location && ev.location !== join && (
              <div className="meta"><IconPin />{/^https?:\/\//.test(ev.location) ? <a href={ev.location} target="_blank" rel="noreferrer">{ev.location}</a> : ev.location}</div>
            )}
            {item.booking && (
              <div className="meta"><IconClock />Booked via your link by {item.booking.guest_name} ({item.booking.guest_email})</div>
            )}
            {ev?.organizer && <p className="small muted">Organised by {ev.organizer}</p>}
            {ev?.declined && <span className="badge red" style={{ alignSelf: "flex-start" }}>You declined</span>}
            {ev && ev.attendees.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <p className="small" style={{ fontWeight: 600 }}>{ev.attendees.length} guest{ev.attendees.length === 1 ? "" : "s"}</p>
                <div className="stack" style={{ gap: 4, maxHeight: 160, overflowY: "auto" }}>
                  {ev.attendees.map((a) => (
                    <div key={a.email} className="spread small">
                      <span className="truncate">{a.name ?? a.email}{a.name && <span className="faint"> · {a.email}</span>}</span>
                      <span className={`badge ${a.response === "accepted" || a.response === "organizer" ? "green" : a.response === "declined" ? "red" : ""}`}>{RESPONSE_LABEL[a.response]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {ev?.description && (
              <div className="small event-desc"><Linkified text={ev.description} /></div>
            )}
          </>
        )}

        <div className="spread" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          {item.account ? (
            <span className="small muted row" style={{ gap: 6 }}>
              <i className="dot" style={{ background: item.color }} />{item.account.label} · {item.account.email}
            </span>
          ) : <span className="small muted">Kairo Link booking</span>}
          {ev?.openUrl && (
            <a className="small" href={ev.openUrl} target="_blank" rel="noreferrer">
              Open in {item.account?.provider === "microsoft" ? "Outlook" : "Google Calendar"}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
