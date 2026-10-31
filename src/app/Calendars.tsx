import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { supabase } from "../lib/supabase";
import { GoogleLogo, MicrosoftLogo } from "../components/Icons";
import { ConnectButtons, Switch } from "./shared";
import { AccountLite, useApp } from "./data";

const LABELS = ["Work", "Personal", "Client", "Jobs", "Side project", "Family"];
const COLORS = ["#6366f1", "#0ea5e9", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6"];

export default function Calendars() {
  const { accounts, calendars, reload, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const c = params.get("connected");
    const e = params.get("error");
    if (c) setNotice({ kind: "success", text: `Connected ${c}. We'll now check it before offering any time.` });
    if (e) setNotice({ kind: "error", text: e });
    if (c || e) {
      setParams({}, { replace: true });
      reload();
    }
  }, [params, setParams, reload]);

  return (
    <div className="stack-lg" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1>Calendars</h1>
          <p className="muted">Every account you add is checked for clashes before anyone can book you.</p>
        </div>
      </div>
      {notice && <div className={`alert ${notice.kind}`} role="status">{notice.text}</div>}

      <div className="card">
        {accounts.length === 0 ? (
          <div className="empty">No calendars yet. Add your first one below.</div>
        ) : (
          <div className="list">
            {accounts.map((a) => (
              <AccountRowView key={a.id} account={a} checking={calendars.find((c) => c.account_id === a.id)?.check_conflicts ?? true}
                calendarId={calendars.find((c) => c.account_id === a.id)?.id}
                onChanged={reload} toast={toast} />
            ))}
          </div>
        )}
      </div>

      <div className="card stack">
        <h2>Add another email account</h2>
        <p className="small muted">Got a client inbox, a company account and a personal one? Add them all. You can connect several accounts from the same provider.</p>
        <ConnectButtons compact />
      </div>

      <p className="small faint">
        Privacy: event details are fetched live and shown only to you; we never store them. Turn off "Show event details" for any calendar (say, a client's) to see busy times only.
      </p>
    </div>
  );
}

function AccountRowView({ account: a, checking, calendarId, onChanged, toast }: {
  account: AccountLite;
  checking: boolean;
  calendarId?: string;
  onChanged: () => Promise<void>;
  toast: (m: string) => void;
}) {
  const [label, setLabel] = useState(a.label);
  const [busy, setBusy] = useState(false);

  async function save(patch: Partial<AccountLite>) {
    const { error } = await supabase.from("connected_accounts").update(patch).eq("id", a.id);
    if (error) toast(error.message);
    else await onChanged();
  }

  async function setChecking(v: boolean) {
    if (!calendarId) return;
    const { error } = await supabase.from("calendars").update({ check_conflicts: v }).eq("id", calendarId);
    if (error) toast(error.message);
    else {
      toast(v ? "Clashes with this calendar will be avoided" : "This calendar will be ignored for availability");
      await onChanged();
    }
  }

  async function check() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; error?: string }>(`/me/accounts/${a.id}/check`, { method: "POST" });
      toast(r.ok ? "Connection is working" : `Problem: ${r.error}`);
      await onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Disconnect ${a.email}? Links that book into this calendar will stop adding events until you pick another.`)) return;
    setBusy(true);
    try {
      await api(`/me/accounts/${a.id}`, { method: "DELETE" });
      toast("Disconnected");
      await onChanged();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  }

  async function reconnect() {
    const { url } = await api<{ url: string }>("/me/connect", {
      method: "POST",
      body: JSON.stringify({ provider: a.provider, loginHint: a.email, returnTo: "/app/calendars" }),
    });
    window.location.href = url;
  }

  return (
    <div className="list-item" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ paddingTop: 4 }}>{a.provider === "google" ? <GoogleLogo /> : <MicrosoftLogo />}</div>
      <div className="grow stack" style={{ gap: 8, minWidth: 220 }}>
        <div className="row wrap">
          <strong className="truncate">{a.email}</strong>
          {a.status === "active" ? <span className="badge green">Connected</span> : <span className="badge red">Needs reconnecting</span>}
        </div>
        {a.status !== "active" && a.last_error && <p className="small" style={{ color: "var(--red)" }}>{a.last_error}</p>}
        <div className="row wrap" style={{ gap: 8 }}>
          <input
            aria-label="Label"
            list={`labels-${a.id}`}
            value={label}
            onChange={(e) => setLabel(e.target.value.slice(0, 30))}
            onBlur={() => label.trim() && label !== a.label && save({ label: label.trim() })}
            style={{ width: 160, height: 34 }}
          />
          <datalist id={`labels-${a.id}`}>{LABELS.map((l) => <option key={l} value={l} />)}</datalist>
          <div className="row" style={{ gap: 4 }} role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={a.color === c} aria-label={`Colour ${c}`} onClick={() => save({ color: c })}
                style={{ width: 20, height: 20, borderRadius: "50%", background: c, border: a.color === c ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer", padding: 0 }} />
            ))}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 18 }}>
          <label className="row small muted" style={{ gap: 8 }}>
            <Switch checked={checking} onChange={setChecking} label="Check this calendar for clashes" />
            Check for clashes
          </label>
          <label className="row small muted" style={{ gap: 8 }}>
            <Switch checked={a.show_details} onChange={async (v) => { await save({ show_details: v }); toast(v ? "Event details will show on your Today page" : "This calendar now shows busy times only"); }} label="Show event details" />
            Show event details
          </label>
        </div>
      </div>
      <div className="row">
        {a.status !== "active" ? (
          <button className="btn primary sm" onClick={reconnect}>Reconnect</button>
        ) : (
          <button className="btn sm" onClick={check} disabled={busy}>Test</button>
        )}
        <button className="btn ghost sm danger" onClick={remove} disabled={busy}>Remove</button>
      </div>
    </div>
  );
}
