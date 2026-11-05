import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { IconPlus, IconUsers } from "../components/Icons";
import { useApp } from "./data";

export interface TeamSummary {
  id: string;
  name: string;
  handle: string;
  owner_id: string;
  role: "owner" | "admin" | "member";
  members: number;
  invited: number;
  open_links: number;
}

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export default function Teams() {
  const { plan, accounts } = useApp();
  const [teams, setTeams] = useState<TeamSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ teams: TeamSummary[] }>("/me/teams").then((r) => setTeams(r.teams)).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="stack-lg" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1>Groups</h1>
          <p className="muted">Book clients with several colleagues at once, and find times that work for everyone inside the team.</p>
        </div>
        {plan === "premium" && (
          <button className="btn primary" onClick={() => setCreating(true)} disabled={!accounts.length}>
            <IconPlus width={16} /> New group
          </button>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}
      {!accounts.length && <div className="alert info">Connect a calendar first, then create or join a team.</div>}

      {teams === null && !error ? (
        <div className="card empty">Loading…</div>
      ) : teams && teams.length > 0 ? (
        <div className="stack">
          {teams.map((t) => (
            <Link key={t.id} to={`/app/teams/${t.id}`} className="card spread" style={{ color: "inherit", textDecoration: "none", flexWrap: "wrap" }}>
              <div className="row" style={{ gap: 14 }}>
                <div className="avatar" aria-hidden="true" style={{ width: 44, height: 44, fontSize: 16 }}>{initials(t.name)}</div>
                <div>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <h3>{t.name}</h3>
                    <span className={`badge ${t.role === "member" ? "" : "accent"}`}>{ROLE_LABEL[t.role]}</span>
                  </div>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    {window.location.host}/{t.handle} · {t.members} {t.members === 1 ? "person" : "people"}
                    {t.invited ? ` · ${t.invited} invited` : ""} · {t.open_links} open {t.open_links === 1 ? "link" : "links"}
                  </p>
                </div>
              </div>
              <span className="btn sm">Open</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card stack center" style={{ padding: 36 }}>
          <IconUsers width={34} style={{ alignSelf: "center", color: "var(--accent)" }} />
          <h2 style={{ fontSize: 18 }}>No groups yet</h2>
          <p className="muted small" style={{ maxWidth: 460, margin: "0 auto" }}>
            A group gets its own address — like <strong>{window.location.host}/acme-sales</strong> — with booking links clients use to meet
            the right people, plus “Find a time” for internal calls. Members join free with their own calendar.
          </p>
          {plan === "premium" ? (
            <button className="btn primary" style={{ alignSelf: "center" }} onClick={() => setCreating(true)} disabled={!accounts.length}>
              <IconPlus width={16} /> Create a group
            </button>
          ) : (
            <Link to="/app/settings#plan" className="btn primary" style={{ alignSelf: "center" }}>Go Premium to create a group</Link>
          )}
          <p className="small faint">Invited to a group? Open the invite email to join.</p>
        </div>
      )}

      {creating && <CreateTeam onClose={() => setCreating(false)} />}
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "T";
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);

function CreateTeam({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Give your group a name");
    if (!/^[a-z0-9][a-z0-9-]{2,30}$/.test(handle)) return setError("The address needs 3–31 lowercase letters, numbers or dashes");
    setBusy(true);
    try {
      const r = await api<{ team: { id: string } }>("/me/teams", { method: "POST", body: JSON.stringify({ name: name.trim(), handle }) });
      toast("Group created — now invite your colleagues");
      nav(`/app/teams/${r.team.id}?tab=people`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="New group" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal stack-lg" style={{ maxWidth: 480 }} onSubmit={save} noValidate>
        <div className="spread">
          <h2>New group</h2>
          <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
        <label className="field">Group name
          <input type="text" autoFocus value={name} placeholder="e.g. Acme Sales" maxLength={80} onChange={(e) => {
            setName(e.target.value);
            if (!touched) setHandle(slugify(e.target.value));
          }} />
        </label>
        <label className="field">Group address
          <div className="input-prefix"><span>{window.location.host}/</span>
            <input type="text" value={handle} maxLength={31} onChange={(e) => { setTouched(true); setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); }} />
          </div>
          <span className="hint">Your group's booking links live here, e.g. /{handle || "acme-sales"}/30min</span>
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create group"}</button>
        </div>
      </form>
    </div>
  );
}
