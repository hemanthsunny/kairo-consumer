import { useEffect, useState } from "react";

// Suggests adding Kairo Link to the home screen on phones. Android/Chrome gets a one-tap
// Install button; iPhone/iPad get the Share → "Add to Home Screen" steps (Safari has no install API).
type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const KEY = "kl-install-dismissed";
const SNOOZE_DAYS = 14;

function standalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}
function isIOS() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
function isPhoneSized() {
  return window.matchMedia?.("(max-width: 860px)").matches && window.matchMedia?.("(pointer: coarse)").matches;
}
function snoozed() {
  try {
    const t = Number(localStorage.getItem(KEY));
    return t > 0 && Date.now() - t < SNOOZE_DAYS * 86400000;
  } catch {
    return false;
  }
}

export default function InstallPrompt() {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [show, setShow] = useState<"android" | "ios" | null>(null);

  useEffect(() => {
    if (standalone() || snoozed() || !isPhoneSized()) return;
    const onBIP = (e: Event) => {
      e.preventDefault();
      setEvt(e as BIPEvent);
      setTimeout(() => setShow("android"), 2500);
    };
    window.addEventListener("beforeinstallprompt", onBIP);
    const t = isIOS() ? setTimeout(() => setShow("ios"), 2500) : undefined;
    const onInstalled = () => setShow(null);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
      if (t) clearTimeout(t);
    };
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ }
    setShow(null);
  };
  const install = async () => {
    if (!evt) return;
    await evt.prompt();
    await evt.userChoice.catch(() => null);
    setEvt(null);
    setShow(null);
  };

  return (
    <div className="install-prompt" role="dialog" aria-label="Add Kairo Link to your home screen">
      <img src="/apple-touch-icon.png" alt="" width={40} height={40} />
      <div className="grow">
        <strong>Add Kairo Link to your home screen</strong>
        {show === "ios" ? (
          <p>
            Tap <ShareIcon /> <b>Share</b>, then <b>Add to Home Screen</b>.
          </p>
        ) : (
          <p>Open it like an app, in one tap.</p>
        )}
      </div>
      {show === "android" && <button className="btn primary sm" onClick={install}>Install</button>}
      <button className="install-close" aria-label="Not now" onClick={dismiss}>×</button>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: "-2px" }}>
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}
