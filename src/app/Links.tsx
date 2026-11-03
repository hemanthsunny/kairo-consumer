import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, LinkRow, WeeklyHours } from "../lib/supabase";
import { durationLabel } from "../lib/time";
import { IconCopy, IconPlus } from "../components/Icons";
import { linkUrl, Switch } from "./shared";
import { copyText, friendlyError, useApp } from "./data";

const DAYS: [string, string][] = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const DEFAULT_HOURS: WeeklyHours = { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]], sat: [], sun: [] };

type Draft = Omit<LinkRow, "id" | "created_at"> & { id?: string };

function blank(writeCal: string | null): Draft {
  return {
    slug: "", title: "", description: "", duration_min: 30, buffer_before_min: 0, buffer_after_min: 0,
    min_notice_min: 240, max_days_ahead: 30, daily_limit: null, slot_step_min: 30, write_calendar_id: writeCal,
    location_type: "auto", location_value: null, weekly_hours: DEFAULT_HOURS, is_active: true,
  };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export default function Links() {
  const { profile, links, calendars, accounts, plan, reload, toast } = useApp();
  const freeLimitReached = plan !== "premium" && links.filter((l) => l.is_active).length >= 1;
  const [editing, setEditing] = useState<Draft | null>(null);
  const defaultWrite = calendars.find((c) => c.can_write)?.id ?? null;

  async function toggle(l: LinkRow, v: boolean) {
    const { error } = await supabase.from("links").update({ is_active: v }).eq("id", l.id);
    if (error) toast(friendlyError(error.message));
    else {
      toast(v ? "Link is live" : "Link turned off");
      reload();
    }
  }

  return (
    <div className="stack-lg" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1>Links</h1>
          <p className="muted">One link per purpose. Each one checks every calendar and books into the one you choose.</p>
        </div>
        <button className="btn primary" onClick={() => freeLimitReached ? toast("The free plan includes 1 active booking link. Go Premium for unlimited links.") : setEditing(blank(defaultWrite))} disabled={!accounts.length}>
          <IconPlus width={16} /> New link
        </button>
      </div>
      <HandleEditor />
      {!accounts.length && <div className="alert info">Connect a calendar first, then create links.</div>}
      {freeLimitReached && (
        <div className="alert info">The free plan includes 1 active booking link. <Link to="/app/settings#plan">Go Premium</Link> for unlimited links, one for each purpose.</div>
      )}

      <div className="stack">
        {links.map((l) => {
          const cal = calendars.find((c) => c.id === l.write_calendar_id);
          const acc = accounts.find((a) => a.id === cal?.account_id);
          return (
            <div className="card" key={l.id} style={{ opacity: l.is_active ? 1 : 0.65 }}>
              <div className="spread" style={{ flexWrap: "wrap" }}>
                <div className="grow" style={{ minWidth: 220 }}>
                  <div className="row wrap">
                    <h3>{l.title}</h3>
                    <span className="badge">{durationLabel(l.duration_min)}</span>
                    {!l.is_active && <span className="badge">Off</span>}
                  </div>
                  <a className="small truncate" href={linkUrl(profile, l)} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 4 }}>
                    {linkUrl(profile, l).replace(/^https?:\/\//, "")}
                  </a>
                  <p className="small muted" style={{ marginTop: 6 }}>
                    {acc ? <>Books into <i className="dot" style={{ display: "inline-block", background: acc.color, width: 8, height: 8 }} /> {acc.label} ({acc.email})</> : "Not adding events to a calendar — guests get an emailed invite"}
                  </p>
                </div>
                <div className="row">
                  <Switch checked={l.is_active} onChange={(v) => toggle(l, v)} label={`Turn ${l.title} on or off`} />
                  <button className="btn sm" onClick={async () => { if (await copyText(linkUrl(profile, l))) toast("Link copied"); }}><IconCopy width={15} />Copy</button>
                  <button className="btn sm" onClick={() => setEditing({ ...l })}>Edit</button>
                </div>
              </div>
            </div>
          );
        })}
        {!links.length && accounts.length > 0 && <div className="card empty">No links yet.</div>}
      </div>
      {editing && <LinkEditor draft={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LinkEditor({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const { profile, calendars, accounts, reload, toast } = useApp();
  const [d, setD] = useState<Draft>(draft);
  const [slugTouched, setSlugTouched] = useState(!!draft.id);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const writable = calendars.filter((c) => c.can_write);

  function setDay(day: string, ranges: [string, string][]) {
    set("weekly_hours", { ...d.weekly_hours, [day]: ranges });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const slug = d.slug || slugify(d.title);
    if (!d.title.trim()) return setError("Give your link a name");
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) return setError("The link address can only use lowercase letters, numbers and dashes");
    if ((d.location_type === "custom_url") && !/^https:\/\/\S+$/.test(d.location_value ?? "")) return setError("Enter a meeting link starting with https://");
    for (const [day, ranges] of Object.entries(d.weekly_hours)) {
      for (const [a, b] of ranges) if (a >= b) return setError(`Check the hours on ${DAYS.find((x) => x[0] === day)?.[1]}: the end must be after the start`);
    }
    if (!Object.values(d.weekly_hours).some((r) => r.length)) return setError("Add at least one day you're available");
    setSaving(true);
    const row = { ...d, slug, title: d.title.trim(), user_id: profile.id, description: d.description?.trim() || null };
    delete (row as { id?: string }).id;
    const res = draft.id
      ? await supabase.from("links").update(row).eq("id", draft.id)
      : await supabase.from("links").insert(row);
    setSaving(false);
    if (res.error) {
      setError(res.error.code === "23505" ? "You already have a link with that address. Choose another." : friendlyError(res.error.message));
      return;
    }
    toast(draft.id ? "Link saved" : "Link created");
    await reload();
    onClose();
  }

  async function del() {
    if (!draft.id || !confirm("Delete this link? Existing bookings stay in place.")) return;
    const { error } = await supabase.from("links").delete().eq("id", draft.id);
    if (error) return setError(error.message);
    toast("Link deleted");
    await reload();
    onClose();
  }

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={draft.id ? "Edit link" : "New link"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal stack-lg" onSubmit={save} noValidate>
        <div className="spread">
          <h2>{draft.id ? "Edit link" : "New link"}</h2>
          <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}

        <div className="grid-2" style={{ gap: 14 }}>
          <label className="field">Name
            <input type="text" value={d.title} placeholder="e.g. Client intro call" onChange={(e) => {
              set("title", e.target.value.slice(0, 80));
              if (!slugTouched) set("slug", slugify(e.target.value));
            }} />
          </label>
          <label className="field">Link address
            <div className="input-prefix"><span>/{profile.handle}/</span>
              <input type="text" value={d.slug} onChange={(e) => { setSlugTouched(true); set("slug", slugify(e.target.value)); }} />
            </div>
            <span className="hint">
              “{profile.handle}” is your personal address, shared by all your links. Change it at the top of the Links page or in <Link to="/app/settings" onClick={onClose}>Settings</Link>.
            </span>
          </label>
        </div>

        <div className="field" role="group" aria-label="Duration">
          <span>Length</span>
          <div className="row wrap">
            {[15, 30, 45, 60, 90].map((m) => (
              <button type="button" key={m} className={`btn sm ${d.duration_min === m ? "primary" : ""}`} onClick={() => set("duration_min", m)}>{durationLabel(m)}</button>
            ))}
            <input type="number" aria-label="Custom minutes" min={5} max={480} value={d.duration_min} onChange={(e) => set("duration_min", Math.min(480, Math.max(5, Number(e.target.value) || 30)))} style={{ width: 90, height: 32 }} />
          </div>
        </div>

        <div className="grid-2" style={{ gap: 14 }}>
          <label className="field">Add bookings to
            <select value={d.write_calendar_id ?? ""} onChange={(e) => set("write_calendar_id", e.target.value || null)}>
              {writable.map((c) => {
                const a = accounts.find((x) => x.id === c.account_id);
                return <option key={c.id} value={c.id}>{a?.label} · {a?.email}</option>;
              })}
              <option value="">Don't add to a calendar (email invite only)</option>
            </select>
            <span className="hint">All calendars are still checked for clashes.</span>
          </label>
          <label className="field">Where
            <select value={d.location_type} onChange={(e) => set("location_type", e.target.value as Draft["location_type"])}>
              <option value="auto">Video call (Google Meet / Teams, created automatically)</option>
              <option value="custom_url">My own video link (Zoom, etc.)</option>
              <option value="phone">Phone call (I'll call them)</option>
              <option value="in_person">In person</option>
              <option value="none">Decide later</option>
            </select>
          </label>
        </div>
        {(d.location_type === "custom_url" || d.location_type === "in_person") && (
          <label className="field">{d.location_type === "custom_url" ? "Your meeting link" : "Address"}
            <input type={d.location_type === "custom_url" ? "url" : "text"} value={d.location_value ?? ""} onChange={(e) => set("location_value", e.target.value)}
              placeholder={d.location_type === "custom_url" ? "https://zoom.us/j/…" : "Office address"} />
          </label>
        )}

        <div className="field">
          <span>When you're available <span className="hint">(your time zone: {profile.timezone})</span></span>
          <div className="card flat" style={{ padding: "6px 14px" }}>
            {DAYS.map(([key, name]) => {
              const ranges = d.weekly_hours[key] ?? [];
              return (
                <div className="hours-row" key={key}>
                  <label className="row small" style={{ color: "var(--text)", fontWeight: 500, paddingTop: 6 }}>
                    <input type="checkbox" checked={ranges.length > 0} onChange={(e) => setDay(key, e.target.checked ? [["09:00", "17:00"]] : [])} />
                    {name.slice(0, 3)}
                  </label>
                  <div className="stack" style={{ gap: 6 }}>
                    {ranges.length === 0 && <span className="small faint" style={{ paddingTop: 7 }}>Unavailable</span>}
                    {ranges.map((r, i) => (
                      <div className="row" key={i} style={{ gap: 6 }}>
                        <input type="time" aria-label={`${name} start`} value={r[0]} onChange={(e) => setDay(key, ranges.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                        <span className="faint">–</span>
                        <input type="time" aria-label={`${name} end`} value={r[1]} onChange={(e) => setDay(key, ranges.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                        <button type="button" className="btn ghost sm" aria-label="Remove hours" onClick={() => setDay(key, ranges.filter((_, j) => j !== i))}>✕</button>
                        {i === ranges.length - 1 && ranges.length < 3 && (
                          <button type="button" className="btn ghost sm" onClick={() => setDay(key, [...ranges, ["13:00", "17:00"]])}>+ split</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => {
            const mon = d.weekly_hours.mon ?? [];
            set("weekly_hours", { ...d.weekly_hours, tue: mon, wed: mon, thu: mon, fri: mon });
          }}>Copy Monday to all weekdays</button>
        </div>

        <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? "Hide" : "Show"} booking rules
        </button>
        {showAdvanced && (
          <div className="grid-2" style={{ gap: 14 }}>
            <label className="field">Minimum notice
              <select value={d.min_notice_min} onChange={(e) => set("min_notice_min", Number(e.target.value))}>
                {[[0, "None"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [720, "12 hours"], [1440, "1 day"], [2880, "2 days"]].map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
            <label className="field">How far ahead
              <select value={d.max_days_ahead} onChange={(e) => set("max_days_ahead", Number(e.target.value))}>
                {[7, 14, 21, 30, 45, 60].map((v) => <option key={v} value={v}>{v} days</option>)}
              </select>
            </label>
            <label className="field">Break before
              <select value={d.buffer_before_min} onChange={(e) => set("buffer_before_min", Number(e.target.value))}>
                {[0, 5, 10, 15, 30, 60].map((v) => <option key={v} value={v}>{v ? `${v} min` : "None"}</option>)}
              </select>
            </label>
            <label className="field">Break after
              <select value={d.buffer_after_min} onChange={(e) => set("buffer_after_min", Number(e.target.value))}>
                {[0, 5, 10, 15, 30, 60].map((v) => <option key={v} value={v}>{v ? `${v} min` : "None"}</option>)}
              </select>
            </label>
            <label className="field">Start times every
              <select value={d.slot_step_min} onChange={(e) => set("slot_step_min", Number(e.target.value))}>
                {[15, 30, 60].map((v) => <option key={v} value={v}>{v} min</option>)}
              </select>
            </label>
            <label className="field">Max bookings per day
              <select value={d.daily_limit ?? ""} onChange={(e) => set("daily_limit", e.target.value ? Number(e.target.value) : null)}>
                <option value="">No limit</option>
                {[1, 2, 3, 4, 5, 6, 8, 10].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>Description shown to guests
              <textarea value={d.description ?? ""} maxLength={500} onChange={(e) => set("description", e.target.value)} placeholder="Optional: what the call is for, what to prepare" />
            </label>
          </div>
        )}

        <div className="spread">
          {draft.id ? <button type="button" className="btn ghost danger" onClick={del}>Delete</button> : <span />}
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={saving}>{saving ? "Saving…" : "Save link"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function HandleEditor() {
  const { profile, reload, toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(profile.handle);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const host = window.location.host;

  async function save(e: FormEvent) {
    e.preventDefault();
    const h = value.trim().toLowerCase();
    if (h === profile.handle) return setEditing(false);
    if (!/^[a-z0-9][a-z0-9-]{2,30}$/.test(h)) return setError("Use 3–31 lowercase letters, numbers or dashes");
    setSaving(true);
    setError(null);
    const { error } = await supabase.from("profiles").update({ handle: h }).eq("id", profile.id);
    setSaving(false);
    if (error) {
      setError(error.code === "23505" ? "That address is taken. Try another." : /reserved/.test(error.message) ? "That address is reserved. Try another." : error.message);
      return;
    }
    toast("Address updated. All your links now use it.");
    setEditing(false);
    reload();
  }

  return (
    <div className="card flat">
      {editing ? (
        <form className="stack" style={{ gap: 8 }} onSubmit={save} noValidate>
          <label className="field">Your personal address
            <div className="input-prefix"><span>{host}/</span>
              <input type="text" autoFocus value={value} maxLength={31}
                onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
            </div>
            <span className="hint">Links you've already shared with the old address will stop working.</span>
          </label>
          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="row">
            <button className="btn primary sm" disabled={saving}>{saving ? "Saving…" : "Save address"}</button>
            <button type="button" className="btn ghost sm" onClick={() => { setEditing(false); setValue(profile.handle); setError(null); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="spread" style={{ flexWrap: "wrap" }}>
          <div>
            <p className="small muted">Your personal address</p>
            <p style={{ fontWeight: 600 }}>{host}/<span style={{ color: "var(--accent)" }}>{profile.handle}</span></p>
          </div>
          <button className="btn sm" onClick={() => setEditing(true)}>Change</button>
        </div>
      )}
    </div>
  );
}
