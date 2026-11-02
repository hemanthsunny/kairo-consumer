# Kairo Link

One booking link across all your calendars (Google + Microsoft), with email reminders and WhatsApp / SMS add-ons.
Consumer spin-off of Kairo HR. Pilot domain: **https://link.kairohr.co**

- **Web app**: React + TypeScript + Vite, hosted on Netlify (`/` landing, `/app` dashboard, `/:handle/:slug` booking pages)
- **API**: one Supabase Edge Function, `api` (`supabase/functions/api`), reached via `/api/*`, which Netlify proxies to Supabase so OAuth redirects stay on our domain
- **Database**: Supabase project `Kairo-Consumer` (`aqzbnqbuxvbgwtendieh`, eu-west-1). Schema in `supabase/migrations`
- **Billing**: Stripe Checkout + Customer Portal. Basic £3/mo (£30/yr), Premium £9/mo (£90/yr), 3-day trial without a card

## How it works

| Piece | Where |
|---|---|
| Free/busy across all connected accounts (busy times only, no event titles) | `_shared/providers.ts` → `fetchBusy` |
| Slot rules: weekly hours, minimum notice, ≤ 60 days ahead (default 30), buffers, daily limit, DST-safe | `_shared/slots.ts` (+ tests) |
| 2-minute busy cache; bookings always re-check live; database exclusion constraint blocks double-booking | `_shared/accounts.ts`, `bookings_no_overlap` |
| Booking writes the event into the chosen calendar with Meet/Teams link; emailed `.ics` fallback | `api/index.ts` → `/public/:handle/:slug/book` |
| Reminders: outbox table + pg_cron every 5 min → `/api/cron/reminders` (24 h and 1 h before) | `_shared/notify.ts` |
| WhatsApp / SMS add-ons: off until enabled in `app_settings`; Premium caps 150 WhatsApp / 30 SMS a month; trial 20 / 5 | `addonAllowed` |
| Refresh tokens encrypted in Supabase Vault; token tables have no client access | `account_tokens`, `store_refresh_token` |

## Local development

```bash
npm install
cp .env.example .env
npm run dev                # http://localhost:5173 (proxies /api to the deployed function)
npm run test:functions     # slot/time-zone tests (needs Deno)
```

## One-time setup checklist

### 1. Deploying the function (GitHub Actions)
Create a Supabase personal access token (Account → Access tokens) and add it as the repo secret **`SUPABASE_ACCESS_TOKEN`**.
Every push to `main` that touches `supabase/functions/**` runs the tests and deploys `api`. You can also run it by hand from the Actions tab.

### 2. Netlify
New site from this repo. The build settings come from `netlify.toml`. Add the environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (values in `.env.example`).
Custom domain `link.kairohr.co`: add a DNS `CNAME link → <site>.netlify.app`.

### 3. Google Cloud (a *new* project, separate from Kairo HR)
- OAuth consent screen: External, app name "Kairo Link", leave it in **Testing** for the pilot and add friends as test users (up to 100).
  - Testing mode expires refresh tokens after 7 days, so users reconnect weekly until you publish and pass review.
- Scopes: `openid`, `email`, `profile`, `calendar.freebusy`, `calendar.events`
- Enable the **Google Calendar API**
- OAuth client (Web). Authorised redirect URIs:
  - `https://link.kairohr.co/api/oauth/google/callback` (calendar connect)
  - `https://aqzbnqbuxvbgwtendieh.supabase.co/auth/v1/callback` (sign in with Google)

### 4. Microsoft Entra (new app registration "Kairo Link", same directory as Kairo HR)
- Supported accounts: any organisational directory + personal Microsoft accounts
- Web redirect URIs: `https://link.kairohr.co/api/oauth/microsoft/callback` and `https://aqzbnqbuxvbgwtendieh.supabase.co/auth/v1/callback`
- Delegated permissions: `Calendars.ReadWrite`, `offline_access`, `openid`, `email`, `profile`
- Branding: set the publisher domain and verify with the existing Sextans Ltd partner account
- Create a client secret and note its expiry date

### 5. Supabase Auth (dashboard → Authentication)
- URL configuration: Site URL `https://link.kairohr.co`; redirect URLs `https://link.kairohr.co/**`, `http://localhost:5173/**`
- Providers: **Google** (client from step 3), **Azure** (client from step 4, tenant URL `https://login.microsoftonline.com/common`)
- Email: set custom SMTP to Resend (`smtp.resend.com`, port 465, user `resend`, password = API key) so magic links aren't rate-limited

### 6. Function secrets (dashboard → Edge Functions → Secrets)
| Secret | Value |
|---|---|
| `SITE_URL` | `https://link.kairohr.co` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | step 3 |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | step 4 |
| `RESEND_API_KEY` | Resend (domain `kairohr.co` already verified) |
| `EMAIL_FROM` | `Kairo Link <link@kairohr.co>` |
| `STRIPE_SECRET_KEY` | test key first |
| `STRIPE_WEBHOOK_SECRET` | step 7 |
| `STRIPE_PRICE_BASIC_MONTHLY` … `STRIPE_PRICE_PREMIUM_YEARLY` | from `scripts/stripe-setup.mjs` |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_REMINDER`, `WHATSAPP_TEMPLATE_LANG` | optional, step 8 |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | optional, step 8 |

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` are provided automatically.

### 7. Stripe
```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs   # prints the 4 price IDs
```
- Webhook endpoint: `https://link.kairohr.co/api/webhooks/stripe`, with events `checkout.session.completed` and `customer.subscription.created|updated|deleted`
- Turn on the Customer Portal (cancel, switch plan, invoices)

### 8. WhatsApp and SMS add-ons (when ready)
- **WhatsApp (Meta Cloud API):** create a *utility* template called `meeting_reminder` (en_GB) with body:
  ```
  {{1}}
  {{2}}
  Join: {{3}}
  ```
- **SMS:** a Twilio number or alphanumeric sender for the UK.
- **Switch them on:**
  ```sql
  update app_settings set value = 'true' where key in ('whatsapp_enabled', 'sms_enabled');
  ```
- **Kill switch for all reminders:** set `reminders_enabled` to `false`.

## Known gaps for after the pilot
- Mobile number isn't verified with a code yet (`phone_verified` exists but isn't enforced)
- Each account's main calendar only (no secondary/shared calendars yet)
- Rescheduling = cancel + rebook
- iCloud calendars not supported
