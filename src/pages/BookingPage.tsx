import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { allTimeZones, browserTz, dayKey, durationLabel, fmt, fmtLongDay, fmtTime } from "../lib/time";
import { IconArrowLeft, IconCheck, IconChevron, IconClock, IconGlobe, IconPhone, IconPin, IconVideo } from "../components/Icons";
import { Loading } from "../App";

interface PublicLink {
  host: { name: string; handle: string; timezone: string };
  people?: string[];
  link: { slug: string; title: string; description: string | null; duration_min: number; location: string | null; ask_phone: boolean };
  window_end: string;
  slots: string[];
  degraded: boolean;
}

interface Confirmed {
  title: string;
  when: string;
  start_at: string;
  end_at: string;
  meeting_url: string | null;
  location: string | null;
  manage_url: string;
  host: string;
}

export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

export function AvatarStack({ names }: { names: string[] }) {
  return (
    <div className="avatar-stack" aria-hidden="true">
      {names.slice(0, 4).map((n, i) => <Initials key={i} name={n} />)}
      {names.length > 4 && <div className="avatar more">+{names.length - 4}</div>}
    </div>
  );
}

export function Initials({ name }: { name: string }) {
  const i = name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return <div className="avatar" aria-hidden="true">{i || "?"}</div>;
}

export default function BookingPage() {
  const { handle = "", slug = "" } = useParams();
  const [data, setData] = useState<PublicLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tz, setTz] = useState(browserTz());
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null);

  async function load() {
    try {
      const now = Date.now();
      const d = await api<PublicLink>(`/public/${handle}/${slug}?from=${now}&to=${now + 62 * 86400000}`, { auth: false });
      setData(d);
      document.title = `${d.link.title} · ${d.people?.length ? joinNames(d.people) : d.host.name}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, slug]);

  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of data?.slots ?? []) {
      const k = dayKey(s, tz);
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [data, tz]);

  // jump to the first available day
  useEffect(() => {
    if (!data || day) return;
    const first = data.slots[0];
    if (first) {
      const k = dayKey(first, tz);
      setDay(k);
      const [y, m] = k.split("-").map(Number);
      setMonth({ y, m: m - 1 });
    }
  }, [data, day, tz]);

  if (error) {
    return (
      <div className="booking-wrap">
        <div className="card center stack" style={{ maxWidth: 420, alignSelf: "center" }}>
          <h2>{error}</h2>
          <p className="muted small">Please check the link with the person who sent it.</p>
          <Link to="/" className="small">What is Kairo Link?</Link>
        </div>
      </div>
    );
  }
  if (!data) return <Loading />;

  if (confirmed) return <ConfirmedView c={confirmed} tz={tz} />;

  const loc = data.link.location ?? "";
  const LocIcon = data.link.ask_phone ? IconPhone : /person|address/i.test(loc) || (!/video/i.test(loc) && loc) ? IconPin : IconVideo;

  return (
    <div className="booking-wrap">
      <div className="booking-card">
        <aside className="booking-info">
          {data.people?.length ? <AvatarStack names={data.people} /> : <Initials name={data.host.name} />}
          <div>
            <p className="muted small">{data.people?.length ? `With ${joinNames(data.people)}` : data.host.name}</p>
            <h1 style={{ fontSize: 22, marginTop: 2 }}>{data.link.title}</h1>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <span className="meta"><IconClock />{durationLabel(data.link.duration_min)}</span>
            {data.link.location && <span className="meta"><LocIcon />{data.link.location}</span>}
            {slot && <span className="meta" style={{ color: "var(--accent)", fontWeight: 500 }}><IconCheck />{fmtLongDay(slot, tz)}, {fmtTime(slot, tz)}</span>}
          </div>
          {data.link.description && <p className="small muted" style={{ whiteSpace: "pre-line" }}>{data.link.description}</p>}
          <div style={{ marginTop: "auto" }}>
            <Link to="/" className="small faint">Powered by Kairo Link</Link>
          </div>
        </aside>

        <section className="booking-main">
          {slot ? (
            <BookForm data={data} slot={slot} tz={tz} onBack={() => setSlot(null)} onDone={setConfirmed} onTaken={() => { setSlot(null); load(); }} />
          ) : (
            <div className="stack-lg">
              <h2>Pick a time</h2>
              {data.slots.length === 0 ? (
                <div className="empty">
                  <p>No times are free right now.</p>
                  <p className="small" style={{ marginTop: 6 }}>Try again later or contact {data.host.name} directly.</p>
                </div>
              ) : (
                <div className="cal-grid">
                  <MonthView month={month} setMonth={setMonth} byDay={byDay} selected={day} onSelect={setDay} tz={tz} windowEnd={data.window_end} />
                  <div className="stack">
                    <p style={{ fontWeight: 600 }}>{day ? fmtLongDay(`${day}T12:00:00Z`, "UTC") : "Choose a day"}</p>
                    <div className="slots">
                      {(day ? byDay.get(day) ?? [] : []).map((s) => (
                        <button key={s} className="slot" onClick={() => setSlot(s)}>{fmtTime(s, tz)}</button>
                      ))}
                      {day && !(byDay.get(day) ?? []).length && <p className="small muted">No times on this day.</p>}
                    </div>
                  </div>
                </div>
              )}
              <label className="row small muted" style={{ gap: 8 }}>
                <IconGlobe width={16} />
                <select aria-label="Your time zone" value={tz} onChange={(e) => { setTz(e.target.value); setDay(null); }} style={{ maxWidth: 280, height: 34 }}>
                  {allTimeZones().map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
                </select>
              </label>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function MonthView({ month, setMonth, byDay, selected, onSelect, tz, windowEnd }: {
  month: { y: number; m: number };
  setMonth: (v: { y: number; m: number }) => void;
  byDay: Map<string, string[]>;
  selected: string | null;
  onSelect: (k: string) => void;
  tz: string;
  windowEnd: string;
}) {
  const first = new Date(Date.UTC(month.y, month.m, 1));
  const daysIn = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const today = dayKey(Date.now(), tz);
  const nowM = new Date();
  const canPrev = month.y > nowM.getFullYear() || (month.y === nowM.getFullYear() && month.m > nowM.getMonth());
  const end = new Date(windowEnd);
  const canNext = month.y < end.getUTCFullYear() || (month.y === end.getUTCFullYear() && month.m < end.getUTCMonth());
  const shift = (n: number) => {
    const d = new Date(Date.UTC(month.y, month.m + n, 1));
    setMonth({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
  };
  return (
    <div className="month">
      <div className="spread">
        <strong>{fmt(first, "UTC", { month: "long", year: "numeric" })}</strong>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn ghost sm" aria-label="Previous month" disabled={!canPrev} onClick={() => shift(-1)}><IconChevron dir="left" width={16} /></button>
          <button className="btn ghost sm" aria-label="Next month" disabled={!canNext} onClick={() => shift(1)}><IconChevron width={16} /></button>
        </div>
      </div>
      <div className="month-grid">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => <div key={d} className="dow">{d}</div>)}
        {Array.from({ length: lead }, (_, i) => <div key={`l${i}`} />)}
        {Array.from({ length: daysIn }, (_, i) => {
          const k = `${month.y}-${String(month.m + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
          const avail = byDay.has(k);
          return (
            <button key={k} className={`day ${avail ? "available" : ""} ${selected === k ? "selected" : ""} ${today === k ? "today" : ""}`}
              disabled={!avail} onClick={() => onSelect(k)} aria-label={`${i + 1}${avail ? ", times available" : ""}`} aria-pressed={selected === k}>
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BookForm({ data, slot, tz, onBack, onDone, onTaken }: {
  data: PublicLink;
  slot: string;
  tz: string;
  onBack: () => void;
  onDone: (c: Confirmed) => void;
  onTaken: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Please enter your name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Please enter a valid email");
    if (data.link.ask_phone && !phone.trim()) return setError("Please add a phone number for the call");
    setBusy(true);
    try {
      const r = await api<{ booking: Confirmed }>(`/public/${data.host.handle}/${data.link.slug}/book`, {
        method: "POST",
        auth: false,
        body: JSON.stringify({ start: slot, name: name.trim(), email: email.trim(), phone: phone.trim() || null, note: note.trim() || null, timezone: tz }),
      });
      onDone(r.booking);
    } catch (err) {
      const e2 = err as Error & { status?: number };
      setError(e2.message);
      setBusy(false);
      if (e2.status === 409) setTimeout(onTaken, 1800);
    }
  }

  return (
    <form className="stack-lg" onSubmit={submit} noValidate style={{ maxWidth: 440 }}>
      <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={onBack}><IconArrowLeft width={16} />Back</button>
      <div>
        <h2>Your details</h2>
        <p className="muted small" style={{ marginTop: 4 }}>{fmtLongDay(slot, tz)}, {fmtTime(slot, tz)} · {durationLabel(data.link.duration_min)}</p>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <label className="field">Name
        <input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <label className="field">Email
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
      </label>
      <label className="field">{data.link.ask_phone ? "Phone number" : "Mobile for a WhatsApp reminder (optional)"}
        <input type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 7700 900123" maxLength={30} />
      </label>
      <label className="field">Anything to share beforehand? (optional)
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </label>
      <button className="btn primary lg" disabled={busy}>{busy ? "Booking…" : "Confirm booking"}</button>
    </form>
  );
}

function ConfirmedView({ c, tz }: { c: Confirmed; tz: string }) {
  const ics = () => {
    const f = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kairo Link//EN", "BEGIN:VEVENT", `UID:${f(c.start_at)}-${Math.random().toString(36).slice(2)}@kairolink`,
      `DTSTAMP:${f(new Date().toISOString())}`, `DTSTART:${f(c.start_at)}`, `DTEND:${f(c.end_at)}`, `SUMMARY:${c.title} with ${c.host}`,
      c.meeting_url ? `LOCATION:${c.meeting_url}` : c.location ? `LOCATION:${c.location}` : "", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "meeting.ics";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="booking-wrap">
      <div className="card stack-lg" style={{ maxWidth: 520, width: "100%", alignSelf: "flex-start", padding: 32 }}>
        <div className="row"><span className="badge green"><IconCheck width={14} />Booked</span></div>
        <div>
          <h1 style={{ fontSize: 24 }}>You're all set</h1>
          <p className="muted" style={{ marginTop: 6 }}>A calendar invite and confirmation are on their way to your inbox.</p>
        </div>
        <div className="card flat stack" style={{ gap: 8 }}>
          <p style={{ fontWeight: 600 }}>{c.title} with {c.host}</p>
          <span className="meta"><IconClock />{fmtLongDay(c.start_at, tz)}, {fmtTime(c.start_at, tz)} – {fmtTime(c.end_at, tz)}</span>
          {c.meeting_url && <span className="meta"><IconVideo /><a href={c.meeting_url} target="_blank" rel="noreferrer">Join link</a></span>}
          {!c.meeting_url && c.location && <span className="meta"><IconPin />{c.location}</span>}
        </div>
        <div className="row wrap">
          <button className="btn" onClick={ics}>Add to my calendar</button>
          <a className="btn ghost" href={c.manage_url}>Need to cancel?</a>
        </div>
        <p className="small faint">Juggling several calendars yourself? <Link to="/">Get your own link</Link></p>
      </div>
    </div>
  );
}
