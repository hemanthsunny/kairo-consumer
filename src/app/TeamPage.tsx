import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { LinkRow } from "../lib/supabase";
import { dayKey, durationLabel, fmtLongDay, fmtTime, tzLabel } from "../lib/time";
import { IconArrowLeft, IconCopy, IconPlus } from "../components/Icons";
import { Loading } from "../App";
import { MonthView } from "../pages/BookingPage";
import { blank, Draft, LinkCard, LinkEditor } from "./Links";
import { copyText, useApp } from "./data";

type Role = "owner" | "admin" | "member";
interface Member { id: string; email: string; user_id: string | null; role: Role; status: "invited" | "active" | "declined"; name: string | null }
interface TeamLink extends LinkRow { url: string; attending: string[]; mine: boolean }
interface TeamData {
  team: { id: string; name: string; handle: string; description: string | null; owner_id: string; url: string };
  my_role: Role;
  owner_premium: boolean;
  members: Member[];
  links: TeamLink[];
}

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const DAY_MS = 86400000;
type Tab = "links" | "people" | "find" | "settings";

export default function TeamPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { profile, calendars, toast } = useApp();
  const [data, setData] = useState<TeamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const tab = (params.get("tab") as Tab) || "links";
  const setTab = (t: Tab) => setParams(t === "links" ? {} : { tab: t }, { replace: true });

  const load = useCallback(async () => {
    try {
      setData(await api<TeamData>(`/me/teams/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="stack" style={{ maxWidth: 820 }}><Link to="/app/teams" className="small"><IconArrowLeft width={14} /> Teams</Link><div className="alert error">{error}</div></div>;
  if (!data) return <Loading />;

  const admin = data.my_role !== "member";
  const active = data.members.filter((m) => m.status === "active" && m.user_id);
  const nameOf = (uid: string) => active.find((m) => m.user_id === uid)?.name ?? "Someone";
  const defaultWrite = calendars.find((c) => c.can_write)?.id ?? null;

  async function patchLink(l: TeamLink, patch: Partial<LinkRow>, msg: string) {
    try {
      await api(`/me/teams/${data!.team.id}/links/${l.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      toast(msg);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="stack-lg" style={{ maxWidth: 860 }}>
      <Link to="/app/teams" className="small row" style={{ gap: 4 }}><IconArrowLeft width={14} /> Teams</Link>
      <div className="page-head">
        <div>
          <div className="row wrap" style={{ gap: 8 }}>
            <h1>{data.team.name}</h1>
            <span className={`badge ${admin ? "accent" : ""}`}>{ROLE_LABEL[data.my_role]}</span>
          </div>
          <p className="muted row wrap" style={{ gap: 8 }}>
            <a href={data.team.url} target="_blank" rel="noreferrer">{data.team.url.replace(/^https?:\/\//, "")}</a>
            <button className="btn ghost sm" onClick={async () => { if (await copyText(data.team.url)) toast("Team page copied"); }}><IconCopy width={14} />Copy</button>
          </p>
        </div>
      </div>
      {!data.owner_premium && <div className="alert info">The team owner's Premium has ended, so booking links are paused until it's renewed.</div>}

      <div className="tabs" role="tablist">
        {([["links", "Booking links"], ["find", "Find a time"], ["people", `People (${active.length})`], ["settings", "Settings"]] as [Tab, string][]).map(([k, t]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{t}</button>
        ))}
      </div>

      {tab === "links" && (
        <div className="stack">
          <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
            <p className="small muted" style={{ margin: 0 }}>Share these with clients. They only see times when everyone on the call is free.</p>
            {admin && (
              <button className="btn primary" onClick={() => setEditing({ ...blank(defaultWrite), expires_at: null })} disabled={!defaultWrite}>
                <IconPlus width={16} /> New team link
              </button>
            )}
          </div>
          {data.links.map((l) => (
            <LinkCard key={l.id} link={l} url={l.url} canManage={admin}
              extra={<p className="small" style={{ marginTop: 4 }}>With {l.attending.length === active.length ? `everyone (${active.length})` : l.attending.map(nameOf).join(", ")}<span className="faint"> · host {nameOf(l.user_id ?? "")}</span></p>}
              onEdit={() => setEditing({ ...l })}
              onToggle={(v) => patchLink(l, v && l.expires_at && Date.parse(l.expires_at) <= Date.now()
                ? { is_active: true, expires_at: new Date(Date.now() + 7 * DAY_MS).toISOString() } : { is_active: v }, v ? "Link is live" : "Link turned off")}
              onClose={() => { if (confirm(`Close “${l.title}”? Nobody new can book it.`)) patchLink(l, { is_active: false, expires_at: new Date().toISOString() }, "Link closed"); }}
              onExtend={() => {
                const base = Math.max(Date.now(), l.expires_at ? Date.parse(l.expires_at) : Date.now());
                patchLink(l, { is_active: true, expires_at: new Date(base + 7 * DAY_MS).toISOString() }, "Open for 7 more days");
              }} />
          ))}
          {!data.links.length && (
            <div className="card empty small">
              {admin ? "No booking links yet. Create one for each kind of call — e.g. “Intro call” with sales, “Kickoff” with the whole team." : "No booking links yet. Team admins can create them."}
            </div>
          )}
        </div>
      )}

      {tab === "find" && <FindATime data={data} myId={profile.id} />}
      {tab === "people" && <People data={data} reload={load} />}
      {tab === "settings" && <TeamSettings data={data} reload={load} />}

      {editing && (
        <LinkEditor draft={editing} onClose={() => setEditing(null)}
          team={{ id: data.team.id, handle: data.team.handle, myUserId: profile.id, onSaved: load, members: active.map((m) => ({ user_id: m.user_id!, name: m.name ?? m.email })) }} />
      )}
    </div>
  );
}

function People({ data, reload }: { data: TeamData; reload: () => void }) {
  const { profile, toast } = useApp();
  const [input, setInput] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const admin = data.my_role !== "member";
  const owner = data.my_role === "owner";
  const base = `/me/teams/${data.team.id}/members`;

  async function invite(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const emails = input.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return;
    const bad = emails.find((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (bad) return setErr(`“${bad}” doesn't look like an email address`);
    setBusy(true);
    try {
      const r = await api<{ added: number }>(base, { method: "POST", body: JSON.stringify({ emails, role }) });
      toast(r.added ? `Invite sent to ${r.added} ${r.added === 1 ? "person" : "people"}` : "Already invited");
      setInput("");
      reload();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
    setBusy(false);
  }

  async function act(fn: () => Promise<unknown>, msg: string) {
    try { await fn(); toast(msg); reload(); } catch (e) { toast((e as Error).message); }
  }

  const visible = data.members.filter((m) => m.status !== "declined" || admin);
  return (
    <div className="stack">
      {admin && (
        <form className="card stack" style={{ gap: 10 }} onSubmit={invite} noValidate>
          <h3>Invite people</h3>
          <p className="small muted" style={{ margin: 0 }}>They get an email, join free with their calendar, and only their busy times are shared with the team.</p>
          <div className="row wrap" style={{ gap: 8 }}>
            <input type="email" className="grow" style={{ minWidth: 220 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="colleague@company.com, another@company.com" />
            <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")} style={{ width: "auto" }} aria-label="Role">
              <option value="member">as Member</option>
              {owner && <option value="admin">as Admin</option>}
            </select>
            <button className="btn primary" disabled={busy || !input.trim()}>{busy ? "Sending…" : "Send invites"}</button>
          </div>
          {err && <div className="alert error" role="alert">{err}</div>}
          <p className="small faint" style={{ margin: 0 }}>Admins can create booking links and invite people. Members can share links and use Find a time.</p>
        </form>
      )}
      <div className="card" style={{ padding: "6px 18px" }}>
        {visible.map((m) => {
          const me = m.user_id === profile.id;
          return (
            <div className="person-row" key={m.id} style={{ flexWrap: "wrap" }}>
              <div className="grow" style={{ minWidth: 180 }}>
                <div style={{ fontWeight: 500 }}>{m.name ?? m.email}{me ? " (you)" : ""}</div>
                {m.name && <div className="small faint truncate">{m.email}</div>}
              </div>
              {m.status !== "active" && <span className="badge">{m.status === "invited" ? "Invited" : "Declined"}</span>}
              {owner && m.role !== "owner" && m.status === "active" ? (
                <select value={m.role} style={{ width: "auto", height: 32 }} aria-label={`Role for ${m.email}`}
                  onChange={(e) => act(() => api(`${base}/${m.id}`, { method: "PATCH", body: JSON.stringify({ role: e.target.value }) }), "Role updated")}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              ) : (
                <span className={`badge ${m.role === "member" ? "" : "accent"}`}>{ROLE_LABEL[m.role]}</span>
              )}
              {admin && m.status !== "active" && <button className="btn ghost sm" onClick={() => act(() => api(`${base}/${m.id}/resend`, { method: "POST" }), `Invite re-sent to ${m.email}`)}>Resend</button>}
              {m.role !== "owner" && !me && (owner || (admin && m.role === "member")) && (
                <button className="btn ghost sm" aria-label={`Remove ${m.email}`} onClick={() => { if (confirm(`Remove ${m.name ?? m.email} from the team?`)) act(() => api(`${base}/${m.id}`, { method: "DELETE" }), "Removed"); }}>Remove</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FindATime({ data, myId }: { data: TeamData; myId: string }) {
  const { profile, toast } = useApp();
  const others = data.members.filter((m) => m.status === "active" && m.user_id && m.user_id !== myId);
  const [picked, setPicked] = useState<string[]>(others.map((m) => m.user_id!));
  const [duration, setDuration] = useState(30);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [title, setTitle] = useState(`${data.team.name} call`);
  const [desc, setDesc] = useState("");
  const [video, setVideo] = useState(true);
  const [done, setDone] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [month, setMonth] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }));
  const tz = profile.timezone;

  async function search() {
    setErr(null);
    setSlot(null);
    setDone(null);
    setDay(null);
    if (!picked.length) return setErr("Pick at least one teammate");
    setBusy(true);
    try {
      const r = await api<{ slots: string[]; degraded: boolean }>(`/me/teams/${data.team.id}/availability`, {
        method: "POST", body: JSON.stringify({ member_ids: picked, duration_min: duration, days: 10 }),
      });
      setSlots(r.slots);
      setDegraded(r.degraded);
      if (r.slots.length) {
        const first = dayKey(r.slots[0], tz);
        const [y, m] = first.split("-").map(Number);
        setDay(first);
        setMonth({ y, m: m - 1 });
      } else setDay(null);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  async function schedule(e: FormEvent) {
    e.preventDefault();
    if (!slot) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ when: string; meeting_url: string | null }>(`/me/teams/${data.team.id}/schedule`, {
        method: "POST", body: JSON.stringify({ member_ids: picked, start: slot, duration_min: duration, title, description: desc, video }),
      });
      setDone(`${title} · ${r.when}`);
      toast("Invite sent to everyone");
      setSlots(null);
      setSlot(null);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
    setBusy(false);
  }

  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of slots ?? []) {
      const k = dayKey(s, tz);
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [slots, tz]);
  const windowEnd = useMemo(() => new Date(Date.now() + 10 * DAY_MS).toISOString(), []);

  if (!others.length) {
    return <div className="card empty small">Once teammates join, you can find a time that works for all of you here.</div>;
  }

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 12 }}>
        <div className="field">
          <span>Who's joining</span>
          <div className="chip-list">
            {others.map((m) => {
              const on = picked.includes(m.user_id!);
              return (
                <label key={m.id} className={`chip ${on ? "on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={(e) => setPicked((p) => e.target.checked ? [...p, m.user_id!] : p.filter((x) => x !== m.user_id))} />
                  {m.name ?? m.email}
                </label>
              );
            })}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 10, alignItems: "flex-end" }}>
          <label className="field" style={{ width: 160 }}>Length
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}
            </select>
          </label>
          <button className="btn primary" onClick={search} disabled={busy || !picked.length}>{busy && !slot ? "Checking calendars…" : "Find times"}</button>
        </div>
        <p className="small faint" style={{ margin: 0 }}>Weekdays 08:00–18:00 in {tzLabel(tz)}, next 10 days. Everyone's calendars are checked live.</p>
      </div>

      {err && !slot && <div className="alert error" role="alert">{err}</div>}
      {done && <div className="alert success" role="status">Booked: {done}. Everyone has the invite in their calendar.</div>}
      {degraded && slots && <div className="alert info">One of the calendars couldn't be read just now, so some times may not be accurate.</div>}

      {slots && (slots.length === 0 ? (
        <div className="card empty small">No time works for everyone in the next 10 days. Try fewer people or a shorter call.</div>
      ) : (
        <div className="card">
          <div className="cal-grid">
            <MonthView month={month} setMonth={setMonth} byDay={byDay} selected={day} onSelect={setDay} tz={tz} windowEnd={windowEnd} />
            <div className="stack">
              <p style={{ fontWeight: 600 }}>{day ? fmtLongDay(`${day}T12:00:00Z`, "UTC") : "Choose a day"}</p>
              <p className="small muted" style={{ margin: 0 }}>{durationLabel(duration)} · everyone free · {tzLabel(tz)}</p>
              <div className="slots slots-2">
                {(day ? byDay.get(day) ?? [] : []).map((s) => (
                  <button key={s} type="button" className={`slot ${slot === s ? "picked" : ""}`} onClick={() => setSlot(s)}>{fmtTime(s, tz)}</button>
                ))}
                {day && !(byDay.get(day) ?? []).length && <p className="small muted">No times on this day.</p>}
              </div>
            </div>
          </div>
        </div>
      ))}

      {slot && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-label="Send invite" onMouseDown={(e) => e.target === e.currentTarget && !busy && setSlot(null)}>
          <form className="modal stack" style={{ maxWidth: 480 }} onSubmit={schedule} noValidate>
            <div className="spread">
              <h2 style={{ fontSize: 18 }}>New team call</h2>
              <button type="button" className="btn ghost sm" onClick={() => setSlot(null)} disabled={busy}>Close</button>
            </div>
            <div className="card flat stack" style={{ gap: 4, padding: 14 }}>
              <strong>{fmtLongDay(slot, tz)}, {fmtTime(slot, tz)}</strong>
              <span className="small muted">{durationLabel(duration)} · {tzLabel(tz)}</span>
              <span className="small muted">With {others.filter((m) => picked.includes(m.user_id!)).map((m) => m.name ?? m.email).join(", ")}</span>
            </div>
            {err && <div className="alert error" role="alert">{err}</div>}
            <label className="field">Title
              <input type="text" autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">Agenda <span className="hint">(optional)</span>
              <textarea rows={3} value={desc} maxLength={2000} onChange={(e) => setDesc(e.target.value)} />
            </label>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} /> Add a Google Meet / Teams link
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setSlot(null)} disabled={busy}>Cancel</button>
              <button className="btn primary" disabled={busy || !title.trim()}>{busy ? "Sending…" : "Send invite to everyone"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function TeamSettings({ data, reload }: { data: TeamData; reload: () => void }) {
  const { profile, toast } = useApp();
  const nav = useNavigate();
  const [name, setName] = useState(data.team.name);
  const [handle, setHandle] = useState(data.team.handle);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = data.my_role === "owner";
  const admin = data.my_role !== "member";
  const me = data.members.find((m) => m.user_id === profile.id);

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, string> = { name: name.trim() };
      if (owner && handle !== data.team.handle) body.handle = handle;
      await api(`/me/teams/${data.team.id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast("Team saved");
      reload();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="stack">
      {admin && (
        <form className="card stack" onSubmit={save} noValidate>
          <h3>Team details</h3>
          {err && <div className="alert error" role="alert">{err}</div>}
          <label className="field">Team name
            <input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">Team address
            <div className="input-prefix"><span>{window.location.host}/</span>
              <input type="text" value={handle} disabled={!owner} maxLength={31} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
            </div>
            <span className="hint">{owner ? "Changing this changes every team link you've shared." : "Only the owner can change the address."}</span>
          </label>
          <div><button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
        </form>
      )}
      <div className="card stack">
        <h3>{owner ? "Delete team" : "Leave team"}</h3>
        <p className="small muted" style={{ margin: 0 }}>
          {owner
            ? "Deletes the team and its booking links. Meetings already booked stay in everyone's calendars."
            : "You'll stop appearing on this team's links. Meetings already booked stay in your calendar."}
        </p>
        <div>
          <button className="btn danger" onClick={async () => {
            if (!confirm(owner ? `Delete ${data.team.name}? This can't be undone.` : `Leave ${data.team.name}?`)) return;
            try {
              if (owner) await api(`/me/teams/${data.team.id}`, { method: "DELETE" });
              else if (me) await api(`/me/teams/${data.team.id}/members/${me.id}`, { method: "DELETE" });
              toast(owner ? "Team deleted" : "You left the team");
              nav("/app/teams");
            } catch (e) {
              toast((e as Error).message);
            }
          }}>{owner ? "Delete team" : "Leave team"}</button>
        </div>
      </div>
    </div>
  );
}
