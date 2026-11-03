import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { IconBell, IconLayers, IconLink, IconShield, IconCalendar, IconClock } from "../components/Icons";

function Nav() {
  const { session } = useAuth();
  return (
    <nav className="site-nav" aria-label="Main">
      <Link to="/" className="brand"><img src="/favicon.svg" alt="" />Kairo Link</Link>
      <div className="row">
        <a href="#pricing" className="btn ghost sm">Pricing</a>
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

export default function Landing() {
  return (
    <div>
      <Nav />
      <header className="hero">
        <div>
          <span className="eyebrow">For contractors, consultants & freelancers</span>
          <h1>One booking link for every calendar you live in.</h1>
          <p className="lead">
            Client inbox, your own company, personal life. Connect them all, share one link, and never get double-booked again.
            Reminders land on WhatsApp or SMS so nothing slips.
          </p>
          <div className="row wrap" style={{ marginTop: 28 }}>
            <Link to="/login?mode=signup" className="btn primary lg">Get started free</Link>
            <a href="#how" className="btn lg">See how it works</a>
          </div>
          <p className="small faint" style={{ marginTop: 12 }}>Free forever, no card needed. Works with Google and Microsoft 365 / Outlook.</p>
        </div>
        <HeroMock />
      </header>

      <section className="section" id="how">
        <h2>Set up in two minutes. Use it every day.</h2>
        <p className="muted" style={{ marginTop: 8, maxWidth: 620 }}>Built for people who juggle several email accounts, not for big teams.</p>
        <div className="grid-3" style={{ marginTop: 28 }}>
          {[
            { icon: <IconLayers />, t: "Connect every calendar", d: "Add each Google or Microsoft account you use: client, company, personal. We check all of them before offering a time." },
            { icon: <IconLink />, t: "One link per purpose", d: "A link for client calls, one for job interviews, one for friends. Each books into the calendar you choose, with a video link." },
            { icon: <IconBell />, t: "Reminders where you look", d: "Email reminders are free. Add WhatsApp and SMS with Premium so you and your guests never miss a call." },
            { icon: <IconShield />, t: "Every meeting, one place", d: "See all your events from every account in one week, with one-click join links. Details are shown only to you and never stored, and any calendar can be set to busy-only." },
            { icon: <IconClock />, t: "Sensible rules built in", d: "No bookings in the past, minimum notice, buffers between calls, and nothing more than a month ahead unless you say so." },
            { icon: <IconCalendar />, t: "Share times in one tap", d: "Copy your next free times as text and paste them into any email, Slack or WhatsApp chat." },
          ].map((f) => (
            <div className="card flat feature" key={f.t}>
              <div className="icon">{f.icon}</div>
              <h3>{f.t}</h3>
              <p className="muted small" style={{ marginTop: 6 }}>{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="pricing">
        <h2>Simple pricing</h2>
        <p className="muted" style={{ marginTop: 8 }}>Free for everyday use. Upgrade when you want reminders on WhatsApp and SMS.</p>
        <PricingTable />
      </section>

      <footer className="footer">
        <div className="row" style={{ justifyContent: "center", gap: 18 }}>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <a href="mailto:contact@kairohr.co">Contact</a>
        </div>
        <p style={{ marginTop: 10 }}>© {new Date().getFullYear()} Sextans Ltd · Kairo Link</p>
      </footer>
    </div>
  );
}

const PRICING_ROWS: [string, string | boolean, string | boolean][] = [
  ["Connect every calendar (Google & Microsoft)", "Unlimited", "Unlimited"],
  ["Booking links", "Unlimited", "Unlimited"],
  ["Combined calendar with event details & join links", true, true],
  ["Google Meet / Teams links added automatically", true, true],
  ["Email confirmations and reminders", true, true],
  ["Share your free times in one tap", true, true],
  ["Daily booking limits and buffers", true, true],
  ["WhatsApp reminders", false, "150 a month"],
  ["SMS reminders", false, "30 a month"],
  ["WhatsApp reminders for your guests", false, true],
  ["Priority support", false, true],
];

function Cell({ v }: { v: string | boolean }) {
  if (v === true) return <span className="tick" aria-label="Included">✓</span>;
  if (v === false) return <span className="faint" aria-label="Not included">—</span>;
  return <span>{v}</span>;
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
              <span className="plan-name">Premium <span className="badge accent">Most useful</span></span>
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
