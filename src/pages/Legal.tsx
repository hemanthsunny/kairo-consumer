import { Link } from "react-router-dom";

export default function Legal({ kind }: { kind: "privacy" | "terms" }) {
  return (
    <div className="section" style={{ maxWidth: 760 }}>
      <Link to="/" className="brand" style={{ padding: 0, marginBottom: 24 }}><img src="/favicon.svg" alt="" />Kairo Link</Link>
      {kind === "privacy" ? <Privacy /> : <Terms />}
    </div>
  );
}

function Privacy() {
  return (
    <div className="stack">
      <h1>Privacy policy</h1>
      <p className="muted small">Last updated 30 October 2026 · Kairo Link is operated by Sextans Ltd, United Kingdom.</p>
      <h2>What we access</h2>
      <p>When you connect a Google or Microsoft calendar we use it to: see <strong>when you are busy</strong>, so we never offer a time that clashes; <strong>show you your own events</strong> (title, time, location, join link, guests and description) in your combined calendar view; and <strong>create, update or remove the events for meetings booked through your Kairo Link pages</strong>. Event details are fetched live when you open the app and shown only to you. If you turn on reminders for all your calendar events, we keep the title, time, location and join link of your events for the next day for up to an hour at a time, and the details in each reminder for up to a day, so we can send them; otherwise event details are never stored. You can switch any calendar to busy-only in Calendars. Your event details are never shown to the people who book you.</p>
      <h2>Google user data</h2>
      <p>Kairo Link's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. We request only the free/busy scope and the scope to create and manage the events for your bookings. Google data is never sold, never used for advertising, never used to train AI models, and is only read by people at Sextans Ltd with your permission, for security, or where the law requires it.</p>
      <h2>What we store</h2>
      <p>Your account details (name, email, time zone, optional mobile number), encrypted access tokens for each connected calendar, a short-lived cache of busy times (start and end only; never titles or other event details), your booking links, and the bookings guests make (name, email, optional phone and note). Payment details are handled by Stripe; we never see your card.</p>
      <h2>Reminders</h2>
      <p>Emails are sent through Resend. If you turn on WhatsApp or SMS reminders, your mobile number and the meeting time and link are sent through Meta (WhatsApp Business) or Twilio to deliver the message.</p>
      <h2>Your choices</h2>
      <p>You can disconnect any calendar at any time, which deletes its tokens and cached busy times immediately. You can also revoke access from your Google or Microsoft account settings. To delete your account and all data, email contact@kairohr.co and we will do it within 30 days. Data is stored in the EU (Ireland).</p>
      <h2>Contact</h2>
      <p>contact@kairohr.co</p>
    </div>
  );
}

function Terms() {
  return (
    <div className="stack">
      <h1>Terms of service</h1>
      <p className="muted small">Last updated 30 October 2026 · Sextans Ltd, United Kingdom.</p>
      <p>Kairo Link lets you combine your calendars, share booking links and send reminders. By using it you agree to these terms.</p>
      <h2>Your account</h2>
      <p>Only connect calendars you are allowed to use. You are responsible for the meetings booked through your links and for keeping your sign-in secure.</p>
      <h2>Plans and billing</h2>
      <p>Kairo Link is free to use with up to 3 connected calendars and 1 active booking link. Premium costs £9 a month (or £90 a year), including VAT where applicable, and adds unlimited calendars and booking links, WhatsApp reminders (up to 300 a month) and SMS reminders (up to 50 a month). You can cancel Premium any time from Settings; it runs to the end of the period you’ve paid for and your account then returns to the free plan.</p>
      <h2>Fair use</h2>
      <p>Don't use Kairo Link to send spam or to book people who haven't asked to meet you. We may suspend accounts that do.</p>
      <h2>Availability</h2>
      <p>We work hard to keep calendars in sync, but we depend on Google, Microsoft and messaging providers. Please keep an eye on your own calendar for important meetings. To the extent the law allows, our liability is limited to the fees you've paid in the last 12 months.</p>
      <h2>Contact</h2>
      <p>contact@kairohr.co</p>
    </div>
  );
}
