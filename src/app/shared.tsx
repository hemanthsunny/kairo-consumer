import { useState } from "react";
import { api } from "../lib/api";
import { GoogleLogo, MicrosoftLogo } from "../components/Icons";
import { LinkRow, Profile } from "../lib/supabase";
import { fmt, fmtTime } from "../lib/time";
import { cleanAuthUrl } from "../lib/authUrl";

export function ConnectButtons({ returnTo = "/app/calendars", compact = false }: { returnTo?: string; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function go(provider: "google" | "microsoft") {
    setBusy(provider);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/me/connect", { method: "POST", body: JSON.stringify({ provider, returnTo }) });
      window.location.href = cleanAuthUrl(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row wrap">
        <button className={`btn ${compact ? "" : "lg"}`} onClick={() => go("google")} disabled={!!busy}>
          <GoogleLogo /> {busy === "google" ? "Opening Google…" : "Add Google calendar"}
        </button>
        <button className={`btn ${compact ? "" : "lg"}`} onClick={() => go("microsoft")} disabled={!!busy}>
          <MicrosoftLogo /> {busy === "microsoft" ? "Opening Microsoft…" : "Add Outlook / Microsoft 365"}
        </button>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
    </div>
  );
}

export function linkUrl(profile: Profile, link: Pick<LinkRow, "slug">) {
  return `${window.location.origin}/${profile.handle}/${link.slug}`;
}

/** Plain-text list of the next free times, ready to paste into an email or chat. */
export async function buildShareText(profile: Profile, link: LinkRow, viewerTz: string) {
  const now = Date.now();
  const data = await api<{ slots: string[] }>(
    `/public/${profile.handle}/${link.slug}?from=${now}&to=${now + 10 * 86400000}`,
    { auth: false },
  );
  const byDay = new Map<string, string[]>();
  for (const s of data.slots) {
    const day = fmt(s, viewerTz, { weekday: "short", day: "numeric", month: "short" });
    const list = byDay.get(day) ?? [];
    // spread suggestions: up to 3 per day, at least 90 minutes apart
    const last = list.length ? Date.parse(list[list.length - 1]) : -Infinity;
    if (list.length < 3 && Date.parse(s) - last >= 90 * 60000) list.push(s);
    byDay.set(day, list);
    if (byDay.size > 4) break;
  }
  const days = Array.from(byDay.entries()).slice(0, 4).filter(([, l]) => l.length);
  if (!days.length) return null;
  const zone = new Intl.DateTimeFormat("en-GB", { timeZone: viewerTz, timeZoneName: "short" }).formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? viewerTz;
  const lines = days.map(([day, l]) => `• ${day}: ${l.map((s) => fmtTime(s, viewerTz)).join(", ")}`);
  return `Here are a few times that work for me (${zone}, ${link.duration_min} min):\n${lines.join("\n")}\n\nOr pick any time that suits you: ${linkUrl(profile, link)}`;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}
