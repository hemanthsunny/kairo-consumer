// Gives each public booking page its own link preview (WhatsApp, iMessage, Slack, LinkedIn…).
// Preview bots don't run JavaScript, so we rewrite the <head> of index.html on the way out.
import type { Config, Context } from "https://edge.netlify.com";

const API = "https://aqzbnqbuxvbgwtendieh.supabase.co/functions/v1/api";
const RESERVED = new Set(["app", "b", "api", "login", "privacy", "terms", "assets", "invite"]);

type PublicLink = { slug: string; title: string; description: string | null; duration_min: number; location: string | null; people?: string[] };
type PublicProfile = { host: { name: string; handle: string }; team?: boolean; paused: boolean; links: PublicLink[] };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function duration(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} hour${h > 1 ? "s" : ""}`;
}

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || RESERVED.has(parts[0]) || parts.some((p) => p.includes("."))) return;

  const [handle, slug] = parts.map((p) => decodeURIComponent(p).toLowerCase());
  let data: PublicProfile | null = null;
  try {
    const r = await fetch(`${API}/public/${encodeURIComponent(handle)}`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) data = await r.json();
  } catch { /* fall back to the generic preview */ }

  const res = await context.next();
  if (!data || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;

  const name = data.host.name;
  let title: string, description: string, image = `${url.origin}/og-link.png`;
  if (slug) {
    const link = data.links.find((l) => l.slug === slug);
    if (!link) return res;
    const people = link.people && link.people.length > 1 ? link.people : [name];
    const names = people.length === 1 ? people[0] : `${people.slice(0, -1).join(", ")} & ${people[people.length - 1]}`;
    title = `${link.title} with ${names}`;
    const bits = [duration(link.duration_min), link.location?.replace(/\s*\(.*\)$/, "")].filter(Boolean).join(" · ");
    description = link.description
      ? clip(`${link.description} — ${bits}`, 200)
      : `${bits}. Pick a time that suits you — times show in your time zone and the invite lands straight in your calendar.`;
  } else {
    title = data.team ? `Book a call with ${name}` : `Book time with ${name}`;
    description = data.links.length
      ? clip(`Choose a meeting: ${data.links.map((l) => `${l.title} (${duration(l.duration_min)})`).join(", ")}.`, 200)
      : `See when ${name} is free and book a time.`;
  }
  if (data.paused) image = `${url.origin}/og.png`;

  const canonical = `${url.origin}${url.pathname}`;
  const tags = [
    `<title>${esc(title)} · Kairo Link</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta property="og:site_name" content="Kairo Link" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    `<link rel="canonical" href="${esc(canonical)}" />`,
  ].join("\n    ");

  let html = await res.text();
  html = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+(?:name|property)="(?:description|og:[^"]+|twitter:[^"]+)"[^>]*>\s*/gi, "")
    .replace(/<\/head>/i, `    ${tags}\n  </head>`);

  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set("cache-control", "public, max-age=0, s-maxage=300");
  return new Response(html, { status: res.status, headers });
};

export const config: Config = {
  path: "/*",
  excludedPath: ["/", "/app", "/app/*", "/b/*", "/api/*", "/assets/*", "/invite/*", "/login", "/privacy", "/terms"],
};
