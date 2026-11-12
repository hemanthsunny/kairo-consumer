import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { CHECKED, COMPETITORS } from "../data/compare";
import { Nav, SiteFooter } from "./Landing";

export default function Compare() {
  const { slug } = useParams();
  const c = COMPETITORS.find((x) => x.slug === slug);
  useEffect(() => {
    if (!c) return;
    const prev = document.title;
    document.title = c.title;
    window.scrollTo(0, 0);
    return () => { document.title = prev; };
  }, [c]);
  if (!c) return <Navigate to="/" replace />;
  return (
    <div>
      <Nav />
      <header className="section" style={{ paddingBottom: 8 }}>
        <span className="eyebrow">{c.name} alternative</span>
        <h1 style={{ fontSize: 40, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{c.h1}</h1>
        <p className="lead muted" style={{ fontSize: 18, marginTop: 12, maxWidth: 560 }}>{c.lead}</p>
        <div className="row wrap" style={{ marginTop: 22 }}>
          <Link to="/login?mode=signup" className="btn primary lg">Try Kairo Link free</Link>
        </div>
      </header>

      <section className="section" style={{ paddingTop: 24 }}>
        <div className="pricing-wrap" style={{ marginTop: 0 }}>
          <table className="pricing compare">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Feature</span></th>
                <th scope="col" className="featured"><span className="plan-name">Kairo Link</span></th>
                <th scope="col"><span className="plan-name">{c.name}</span></th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className="featured">{r.us}</td>
                  <td>{r.them}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small faint" style={{ marginTop: 10 }}>{c.name} details from its public pricing and help pages, checked {CHECKED}. Prices can change.</p>
      </section>

      <section className="section">
        <div className="grid-2">
          <div className="card flat">
            <h3>Why people switch</h3>
            <ul className="stack" style={{ margin: "12px 0 0", paddingLeft: 18, gap: 8 }}>
              {c.switch.map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>
          <div className="card flat">
            <h3>When {c.name} is the better fit</h3>
            <ul className="stack muted" style={{ margin: "12px 0 0", paddingLeft: 18, gap: 8 }}>
              {c.theyFit.map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Questions</h2>
        <div className="stack" style={{ marginTop: 16, gap: 10 }}>
          {c.faq.map((f) => (
            <details key={f.q} className="card flat">
              <summary style={{ fontWeight: 600, cursor: "pointer" }}>{f.q}</summary>
              <p className="muted" style={{ marginTop: 8 }}>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="section center">
        <h2>One link for all your calendars.</h2>
        <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
          <Link to="/login?mode=signup" className="btn primary lg">Get started free</Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
