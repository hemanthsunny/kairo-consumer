import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { ReactNode } from "react";
import { IconBell, IconLink, IconShield, IconCalendar, IconUsers } from "../components/Icons";

export function Nav() {
  const { session } = useAuth();
  return (
    <nav className="site-nav" aria-label="Main">
      <Link to="/" className="brand"><img src="/favicon.svg" alt="" />Kairo Link</Link>
      <div className="row">
        <a href="/#features" className="btn ghost sm hide-sm">Features</a>
        <a href="/#groups" className="btn ghost sm hide-sm">Groups</a>
        <a href="/#pricing" className="btn ghost sm hide-sm">Pricing</a>
        {session ? (
          <Link to="/app" className="btn primary sm">Open app</Link>
        ) : (
          <>
            <Link to="/login" className="btn ghost sm">Sign in</Link>
            <Link to="/login?mode=signup" className="btn primary sm">Get started free</Link>
          </>
        )}
      </div>
    </nav>
  );
}

function HeroMock() {
  const accounts = [
    { label: "Client A · work", color: "#6366f1" },
    { label: "Client B · work", color: "#0ea5e9" },
    { label: "Personal", color: "#f59e0b" },
  ];
  const blocks = [
    [0, 9.5, 1, 0], [0, 13, 1.5, 2], [1, 10, 2, 1], [1, 15, 1, 0], [2, 9, 1, 2], [2, 12, 1, 1], [3, 11, 1, 0], [3, 14, 2, 1], [4, 9.5, 1, 1], [4, 16, 1, 2],
  ];
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  return (
    <div className="mock" aria-hidden="true">
      <div className="spread" style={{ marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>This week, all calendars</strong>
        <span className="badge green">No clashes</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 6 }}>
        {days.map((d, i) => (
          <div key={d}>
            <div className="small faint center" style={{ marginBottom: 6 }}>{d}</div>
            <div style={{ position: "relative", height: 200, background: "var(--surface-2)", borderRadius: 8 }}>
              {blocks.filter((b) => b[0] === i).map((b, j) => (
                <div key={j} style={{ position: "absolute", left: 4, right: 4, top: `${((b[1] - 8) / 10) * 100}%`, height: `${(b[2] / 10) * 100}%`, background: accounts[b[3]].color, borderRadius: 6, opacity: 0.9 }} />
              ))}
              {i === 2 && <div style={{ position: "absolute", left: 4, right: 4, top: "62%", height: "10%", borderRadius: 6, border: "2px dashed var(--accent)", background: "var(--accent-50)" }} />}
            </div>
          </div>
        ))}
      </div>
      <div className="legend" style={{ marginTop: 12 }}>
        {accounts.map((a) => <span key={a.label}><i className="dot" style={{ background: a.color }} />{a.label}</span>)}
      </div>
      <div className="row" style={{ marginTop: 14, padding: 10, borderRadius: 10, background: "#ecfdf5", fontSize: 13 }}>
        <span style={{ fontSize: 18 }}>💬</span>
        <span><strong>WhatsApp</strong> · In 1 hour: Intro call with Sam — 14:00 · Join on Meet</span>
      </div>
    </div>
  );
}

function GroupMock() {
  const people = [["AM", "#6366f1"], ["JL", "#0ea5e9"], ["SR", "#f59e0b"]];
  const times = ["09:30", "11:00", "14:30"];
  return (
    <div className="mock" aria-hidden="true">
      <div className="spread" style={{ marginBottom: 14 }}>
        <div>
          <strong style={{ fontSize: 15 }}>Northwind Studio</strong>
          <div className="small faint">link.kairohr.co/northwind/intro</div>
        </div>
        <div className="avatar-stack">
          {people.map(([i, c]) => (
            <span key={i} className="avatar" style={{ width: 32, height: 32, fontSize: 12, background: c, color: "#fff" }}>{i}</span>
          ))}
        </div>
      </div>
      <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>Thu 19 Nov · everyone's free</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
        {times.map((t, i) => (
          <span key={t} className="center small" style={{ padding: "9px 0", borderRadius: 8, fontWeight: 600, border: "1px solid var(--accent)", color: i === 1 ? "#fff" : "var(--accent)", background: i === 1 ? "var(--accent)" : "var(--surface)" }}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function Check({ children }: { children: ReactNode }) {
  return (
    <li className="row" style={{ alignItems: "flex-start", gap: 10 }}>
      <span className="tick" style={{ flex: "none", marginTop: 1 }}>✓</span>
      <span>{children}</span>
    </li>
  );
}

export default function Landing() {
  return (
    <div>
      <Nav />
      <header className="hero">
        <div>
          <h1>One link for all your calendars.</h1>
          <p className="lead">Work, clients, personal. People only see times you're actually free.</p>
          <div className="row wrap" style={{ marginTop: 28 }}>
            <Link to="/login?mode=signup" className="btn primary lg">Get started free</Link>
            <a href="#how" className="btn lg">How it works</a>
          </div>
          <p className="small faint" style={{ marginTop: 12 }}>Free forever · Google and Outlook</p>
        </div>
        <HeroMock />
      </header>

      <section className="section" id="how">
        <h2>Ready in two minutes</h2>
        <div className="grid-3" style={{ marginTop: 24 }}>
          {[
            { n: "1", t: "Connect your calendars", d: "Add every Google or Outlook account." },
            { n: "2", t: "Share your link", d: "Guests pick a time that suits everyone." },
            { n: "3", t: "Get reminded", d: "On WhatsApp, SMS or email." },
          ].map((s) => (
            <div className="card flat" key={s.n}>
              <span className="avatar" style={{ width: 34, height: 34, fontSize: 15 }}>{s.n}</span>
              <h3 style={{ marginTop: 12 }}>{s.t}</h3>
              <p className="muted small" style={{ marginTop: 4 }}>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="features">
        <h2>Small things that save your day</h2>
        <div className="grid-2" style={{ marginTop: 24 }}>
          {[
            { icon: <IconShield />, t: "Your whole week, one view", d: "Every event from every account, with one-tap join links." },
            { icon: <IconLink />, t: "A link for each purpose", d: "Client calls, interviews, friends. Each with its own rules." },
            { icon: <IconBell />, t: "Reminders when you want them", d: "10 minutes, 30 minutes or a day before." },
            { icon: <IconCalendar />, t: "Share free times as text", d: "Paste them into any email or chat." },
          ].map((f) => (
            <div className="card flat feature row" key={f.t} style={{ alignItems: "flex-start", gap: 14 }}>
              <div className="icon" style={{ margin: 0, flex: "none" }}>{f.icon}</div>
              <div>
                <h3>{f.t}</h3>
                <p className="muted small" style={{ marginTop: 4 }}>{f.d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="groups">
        <div className="grid-2" style={{ alignItems: "center", gap: 40 }}>
          <div>
            <span className="eyebrow"><IconUsers width={14} /> New · Groups</span>
            <h2>Book a whole group at once</h2>
            <p className="muted" style={{ marginTop: 10 }}>One link for your team. Only times when everyone's free.</p>
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: "18px 0 0", gap: 10 }}>
              <Check>Pick everyone, or just a few people</Check>
              <Check>Find a time for internal calls</Check>
              <Check>Members join free</Check>
            </ul>
          </div>
          <GroupMock />
        </div>
      </section>

      <section className="section center" id="pricing">
        <h2>Simple pricing</h2>
        <PricingTable />
      </section>

      <section className="section center">
        <h2>Stop sending times back and forth.</h2>
        <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
          <Link to="/login?mode=signup" className="btn primary lg">Get started free</Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

const PRICING_ROWS: [string, string | boolean, string | boolean][] = [
  ["Calendars", "3", "Unlimited"],
  ["Booking links", "1", "Unlimited"],
  ["Email reminders", true, true],
  ["WhatsApp reminders", false, "300 / month"],
  ["SMS reminders", false, "50 / month"],
  ["Groups", false, "Up to 10 people"],
];

function Cell({ v }: { v: string | boolean }) {
  if (v === true) return <span className="tick" aria-label="Included">✓</span>;
  if (v === false) return <span className="faint" aria-label="Not included">—</span>;
  return <span>{v}</span>;
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="row wrap" style={{ justifyContent: "center", gap: 18 }}>
        <Link to="/vs/calendly">Kairo Link vs Calendly</Link>
        <Link to="/vs/cal-com">Kairo Link vs Cal.com</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
        <a href="mailto:contact@kairohr.co">Contact</a>
      </div>
      <p style={{ marginTop: 10 }}>© {new Date().getFullYear()} Sextans Ltd · Kairo Link</p>
    </footer>
  );
}

export function PricingTable() {
  return (
    <div className="pricing-wrap">
      <table className="pricing">
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Feature</span></th>
            <th scope="col">
              <span className="plan-name">Free</span>
              <span className="plan-price">£0</span>
              <span className="plan-note">Free forever</span>
            </th>
            <th scope="col" className="featured">
              <span className="plan-name">Premium <span className="badge accent">Popular</span></span>
              <span className="plan-price">£9<small> / month</small></span>
              <span className="plan-note">or £90 a year</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {PRICING_ROWS.map(([label, free, prem]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td><Cell v={free} /></td>
              <td className="featured"><Cell v={prem} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" />
            <td><Link to="/login?mode=signup" className="btn block">Get started free</Link></td>
            <td className="featured"><Link to="/login?mode=signup&plan=premium" className="btn primary block">Go Premium</Link></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
