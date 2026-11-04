import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Landing from "./pages/Landing";
import { AuthProvider } from "./lib/auth";

const Login = lazy(() => import("./pages/Login"));
const AppShell = lazy(() => import("./app/AppShell"));
const Home = lazy(() => import("./app/Home"));
const Calendars = lazy(() => import("./app/Calendars"));
const Links = lazy(() => import("./app/Links"));
const Bookings = lazy(() => import("./app/Bookings"));
const Settings = lazy(() => import("./app/Settings"));
const Teams = lazy(() => import("./app/Teams"));
const TeamPage = lazy(() => import("./app/TeamPage"));
const PublicProfile = lazy(() => import("./pages/PublicProfile"));
const BookingPage = lazy(() => import("./pages/BookingPage"));
const Manage = lazy(() => import("./pages/Manage"));
const Legal = lazy(() => import("./pages/Legal"));
const Invite = lazy(() => import("./pages/Invite"));
const Connect = lazy(() => import("./pages/Connect"));

export function Loading() {
  return <div className="loading" role="status"><div className="spinner" /><span className="sr-only">Loading</span></div>;
}

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/privacy" element={<Legal kind="privacy" />} />
          <Route path="/terms" element={<Legal kind="terms" />} />
          <Route path="/app" element={<AppShell />}>
            <Route index element={<Home />} />
            <Route path="calendars" element={<Calendars />} />
            <Route path="links" element={<Links />} />
            <Route path="bookings" element={<Bookings />} />
            <Route path="settings" element={<Settings />} />
            <Route path="teams" element={<Teams />} />
            <Route path="teams/:id" element={<TeamPage />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Route>
          <Route path="/b/:token" element={<Manage />} />
          <Route path="/invite/:token" element={<Invite />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/:handle" element={<PublicProfile />} />
          <Route path="/:handle/:slug" element={<BookingPage />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
