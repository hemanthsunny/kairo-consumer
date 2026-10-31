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
            <Link to="/login?mode=signup" className="btn primary sm">Start free</Link>
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
            <Link to="/login?mode=signup" className="btn primary lg">Start 14-day free trial</Link>
            <a href="#how" className="btn lg">See how it works</a>
          </div>
          <p className="small faint" style={{ marginTop: 12 }}>No card needed. Works with Google and Microsoft 365 / Outlook.</p>
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
            { icon: <IconBell />, t: "Reminders where you look", d: "Email reminders included. Add WhatsApp or SMS so you and your guests never miss a call." },
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
        <p className="muted" style={{ marginTop: 8 }}>14-day free trial with everything included. Cancel any time.</p>
        <div className="grid-2" style={{ marginTop: 28, maxWidth: 820 }}>
          <div className="card plan">
            <h3>Basic</h3>
            <p className="price" style={{ marginTop: 8 }}>£3<small> / month</small></p>
            <p className="small muted">or £30 a year</p>
            <ul className="ticks">
              <li>Unlimited calendars across all your emails</li>
              <li>Unlimited booking links</li>
              <li>Google Meet / Teams links added automatically</li>
              <li>Email confirmations and reminders</li>
              <li>Share-your-times in one tap</li>
            </ul>
            <Link to="/login?mode=signup" className="btn block" style={{ marginTop: 20 }}>Start free trial</Link>
          </div>
          <div className="card plan featured">
            <div className="spread"><h3>Premium</h3><span className="badge accent">Most useful</span></div>
            <p className="price" style={{ marginTop: 8 }}>£9<small> / month</small></p>
            <p className="small muted">or £90 a year</p>
            <ul className="ticks">
              <li>Everything in Basic</li>
              <li>WhatsApp reminders (150 a month)</li>
              <li>SMS reminders (30 a month)</li>
              <li>Reminders for your guests on WhatsApp</li>
              <li>Daily booking limits per link</li>
              <li>Priority support</li>
            </ul>
            <Link to="/login?mode=signup" className="btn primary block" style={{ marginTop: 20 }}>Start free trial</Link>
          </div>
        </div>
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
