import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { GoogleLogo, MicrosoftLogo } from "../components/Icons";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [params] = useSearchParams();
  const signup = params.get("mode") === "signup";
  const { session, ready } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ready && session) nav("/app", { replace: true });
  }, [ready, session, nav]);

  const redirectTo = `${window.location.origin}/app`;

  async function oauth(provider: "google" | "azure") {
    setBusy(provider);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, scopes: provider === "azure" ? "email openid profile" : undefined },
    });
    if (error) {
      setError(error.message);
      setBusy(null);
    }
  }

  async function magic(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address");
      return;
    }
    setBusy("email");
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    setBusy(null);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="auth">
      <div className="card stack-lg">
        <div className="stack" style={{ gap: 6 }}>
          <Link to="/" className="brand" style={{ padding: 0 }}><img src="/favicon.svg" alt="" />Kairo Link</Link>
          <h1 style={{ fontSize: 22 }}>{signup ? "Start your free trial" : "Welcome back"}</h1>
          <p className="muted small">{signup ? "3 days, everything included. No card needed." : "Sign in to manage your calendars and links."}</p>
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
        {sent ? (
          <div className="alert success" role="status">Check <strong>{email}</strong> for a sign-in link. You can close this tab.</div>
        ) : (
          <>
            <div className="stack" style={{ gap: 10 }}>
              <button className="btn lg block" onClick={() => oauth("google")} disabled={!!busy}>
                <GoogleLogo /> Continue with Google
              </button>
              <button className="btn lg block" onClick={() => oauth("azure")} disabled={!!busy}>
                <MicrosoftLogo /> Continue with Microsoft
              </button>
            </div>
            <div className="divider">or</div>
            <form className="stack" onSubmit={magic} noValidate>
              <label className="field">Email
                <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </label>
              <button className="btn primary lg block" disabled={!!busy}>{busy === "email" ? "Sending…" : "Email me a sign-in link"}</button>
            </form>
          </>
        )}
        <p className="small faint center">
          By continuing you agree to our <Link to="/terms">terms</Link> and <Link to="/privacy">privacy policy</Link>.
        </p>
      </div>
    </div>
  );
}
