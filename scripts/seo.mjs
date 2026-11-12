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
// Clean shell for the app, booking pages and every other route (netlify.toml rewrites /* to it),
// so the home page's static text below never shows there.
writeFileSync(join(dist, "app.html"), base);

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

const nav = `<nav><a href="/">Kairo Link</a> · <a href="/vs/calendly">Kairo Link vs Calendly</a> · <a href="/vs/cal-com">Kairo Link vs Cal.com</a> · <a href="/login?mode=signup">Get started free</a></nav>`;
const homeBody = `${nav}<main><h1>One link for all your calendars.</h1>
<p>Work, clients, personal. Connect every Google and Outlook calendar, share one booking link, and people only see times you're actually free.</p>
<h2>Ready in two minutes</h2><ol><li>Connect your calendars: add every Google or Outlook account.</li><li>Share your link: guests pick a time that suits everyone.</li><li>Get reminded on WhatsApp, SMS or email.</li></ol>
<h2>Small things that save your day</h2><ul><li>Your whole week, one view: every event from every account, with one-tap join links.</li><li>A link for each purpose: client calls, interviews, friends.</li><li>Reminders 10 minutes, 30 minutes or a day before.</li><li>Share free times as text in any email or chat.</li></ul>
<h2>Book a whole group at once</h2><p>One link for your team, showing only times when everyone is free. Find a time for internal calls. Members join free.</p>
<h2>Simple pricing</h2><p>Free: 3 calendars, 1 booking link, email reminders. Premium £9 a month or £90 a year: unlimited calendars and links, 300 WhatsApp and 50 SMS reminders a month, groups of up to 10 people.</p></main>`;
const esch = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const compareBody = (c) => `${nav}<main><h1>${esch(c.h1)}</h1><p>${esch(c.lead)}</p>
<table><thead><tr><th></th><th>Kairo Link</th><th>${esch(c.name)}</th></tr></thead><tbody>${c.rows.map((r) => `<tr><th>${esch(r.label)}</th><td>${esch(r.us)}</td><td>${esch(r.them)}</td></tr>`).join("")}</tbody></table>
<h2>Why people switch</h2><ul>${c.switch.map((x) => `<li>${esch(x)}</li>`).join("")}</ul>
<h2>When ${esch(c.name)} is the better fit</h2><ul>${c.theyFit.map((x) => `<li>${esch(x)}</li>`).join("")}</ul>
<h2>Questions</h2>${c.faq.map((f) => `<h3>${esch(f.q)}</h3><p>${esch(f.a)}</p>`).join("")}</main>`;

const pages = [
  { path: "/", title: HOME_TITLE, desc: HOME_DESC, ld: [app], priority: "1.0", body: homeBody },
  ...COMPETITORS.map((c) => ({
    path: `/vs/${c.slug}`,
    title: c.title,
    desc: c.description,
    priority: "0.8",
    body: compareBody(c),
    ld: [{
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: c.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    }],
  })),
  { path: "/privacy", title: "Privacy policy | Kairo Link", desc: "How Kairo Link handles your calendar data: busy times to prevent clashes, event details shown only to you.", priority: "0.3", body: `${nav}<main><h1>Privacy policy</h1><p>How Kairo Link handles your calendar data: busy times to prevent clashes, event details shown only to you.</p></main>` },
  { path: "/terms", title: "Terms | Kairo Link", desc: "Terms of use for Kairo Link.", priority: "0.3", body: `${nav}<main><h1>Terms</h1><p>Terms of use for Kairo Link.</p></main>` },
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
  const withBody = p.body ? h.replace('<div id="root"></div>', `<div id="root">${p.body}</div>`) : h;
  return withBody.replace("</head>", `  ${extra.join("\n    ")}\n  </head>`);
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
