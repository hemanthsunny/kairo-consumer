// Post-build: per-page <head> for marketing pages (title, description, canonical, social, JSON-LD) and sitemap.xml.
// Netlify serves dist/<path>/index.html for /<path> before the SPA fallback, so crawlers get the right tags without JS.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const SITE = "https://link.kairohr.co";
const dist = "dist";
const tmp = join(dist, ".compare.mjs");
await build({ entryPoints: ["src/data/compare.ts"], outfile: tmp, format: "esm", bundle: true, platform: "node", logLevel: "silent" });
const { COMPETITORS } = await import(pathToFileURL(join(process.cwd(), tmp)).href);
rmSync(tmp);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const base = readFileSync(join(dist, "index.html"), "utf8");

const HOME_TITLE = "Kairo Link — free booking link for all your Google & Outlook calendars";
const HOME_DESC =
  "Connect your work, client and personal calendars and share one booking link. No double-booking, every event in one view, and WhatsApp & SMS reminders. Free plan; Premium £9/month.";

const app = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Kairo Link",
  url: SITE + "/",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web, iOS, Android",
  description: HOME_DESC,
  offers: [
    { "@type": "Offer", name: "Free", price: "0", priceCurrency: "GBP" },
    { "@type": "Offer", name: "Premium", price: "9", priceCurrency: "GBP", description: "Per month, or £90 a year" },
  ],
};

const pages = [
  { path: "/", title: HOME_TITLE, desc: HOME_DESC, ld: [app], priority: "1.0" },
  ...COMPETITORS.map((c) => ({
    path: `/vs/${c.slug}`,
    title: c.title,
    desc: c.description,
    priority: "0.8",
    ld: [{
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: c.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    }],
  })),
  { path: "/privacy", title: "Privacy policy | Kairo Link", desc: "How Kairo Link handles your calendar data: busy times to prevent clashes, event details shown only to you.", priority: "0.3" },
  { path: "/terms", title: "Terms | Kairo Link", desc: "Terms of use for Kairo Link.", priority: "0.3" },
];

function pageHtml(p) {
  const url = SITE + p.path;
  const h = base
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(p.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(p.desc)}" />`)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${url}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${esc(p.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${esc(p.desc)}" />`);
  // dist/index.html is also the SPA fallback for every other route, so the home page gets no canonical tag.
  const extra = [...(p.path === "/" ? [] : [`<link rel="canonical" href="${url}" />`]), ...(p.ld ?? []).map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`)];
  return h.replace("</head>", `  ${extra.join("\n    ")}\n  </head>`);
}

for (const p of pages) {
  const out = p.path === "/" ? join(dist, "index.html") : join(dist, p.path.slice(1), "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, pageHtml(p));
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${SITE}${p.path}</loc><lastmod>${today}</lastmod><priority>${p.priority}</priority></url>`).join("\n")}
</urlset>
`,
);
console.log(`seo: ${pages.length} pages + sitemap.xml`);
