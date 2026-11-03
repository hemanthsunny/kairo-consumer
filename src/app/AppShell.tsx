import { useEffect } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { Loading } from "../App";
import { IconCalendar, IconHome, IconLink, IconList, IconSettings } from "../components/Icons";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { AppCtx, effectivePlan, useAppLoader, useToast } from "./data";

const NAV = [
  { to: "/app", label: "Today", icon: IconHome, end: true },
  { to: "/app/calendars", label: "Calendars", icon: IconCalendar },
  { to: "/app/links", label: "Links", icon: IconLink },
  { to: "/app/bookings", label: "Bookings", icon: IconList },
  { to: "/app/settings", label: "Settings", icon: IconSettings },
];

export default function AppShell() {
  const { session, ready } = useAuth();
  const { data, error, reload } = useAppLoader(session?.user.id);
  const { msg, toast } = useToast();
  const loc = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);

  if (!ready) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (error) return <div className="auth"><div className="alert error">{error}</div></div>;
  if (!data) return <Loading />;

  const plan = effectivePlan(data.profile);

  return (
    <AppCtx.Provider value={{ ...data, plan, reload, toast }}>
      <div className="shell">
        <aside className="side">
          <Link to="/app" className="brand"><img src="/favicon.svg" alt="" />Kairo Link</Link>
          <nav className="nav" aria-label="App">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}><n.icon />{n.label}</NavLink>
            ))}
          </nav>
          <div className="side-foot stack" style={{ gap: 8 }}>
            {plan === "premium" ? (
              <span className="badge green" style={{ alignSelf: "flex-start" }}>Premium</span>
            ) : (
              <Link to="/app/settings#plan" className="badge accent" style={{ alignSelf: "flex-start" }}>Free · Go Premium</Link>
            )}
            <p className="small truncate muted" title={data.profile.email ?? ""}>{data.profile.email}</p>
            <button className="btn ghost sm" style={{ justifyContent: "flex-start", padding: 0 }} onClick={() => supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        </aside>
        <main className="main">
          <Outlet />
        </main>
        <nav className="mobile-bar" aria-label="App">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}><n.icon />{n.label}</NavLink>
          ))}
        </nav>
      </div>
      {msg && <div className="toast" role="status">{msg}</div>}
    </AppCtx.Provider>
  );
}
