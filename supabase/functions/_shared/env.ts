// Central place for configuration. Secrets are set with `supabase secrets set` (see README).

function opt(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() ? v.trim() : undefined;
}

function req(name: string): string {
  const v = opt(name);
  if (!v) throw new Error(`Missing configuration: ${name}`);
  return v;
}

export const env = {
  get supabaseUrl() { return req("SUPABASE_URL"); },
  get serviceKey() { return req("SUPABASE_SERVICE_ROLE_KEY"); },
  get anonKey() { return req("SUPABASE_ANON_KEY"); },
  /** Public site origin, e.g. https://link.kairohr.co */
  get siteUrl() { return (opt("SITE_URL") ?? "https://link.kairohr.co").replace(/\/$/, ""); },
  get productName() { return opt("PRODUCT_NAME") ?? "Kairo Link"; },

  get googleClientId() { return req("GOOGLE_CLIENT_ID"); },
  get googleClientSecret() { return req("GOOGLE_CLIENT_SECRET"); },
  get msClientId() { return req("MS_CLIENT_ID"); },
  get msClientSecret() { return req("MS_CLIENT_SECRET"); },

  get resendKey() { return opt("RESEND_API_KEY"); },
  get emailFrom() { return opt("EMAIL_FROM") ?? "Kairo Link <link@kairohr.co>"; },

  get stripeKey() { return req("STRIPE_SECRET_KEY"); },
  get stripeWebhookSecret() { return req("STRIPE_WEBHOOK_SECRET"); },
  stripePrice(plan: "basic" | "premium", interval: "month" | "year") {
    return req(`STRIPE_PRICE_${plan.toUpperCase()}_${interval === "month" ? "MONTHLY" : "YEARLY"}`);
  },

  // Add-ons (optional until enabled)
  get waToken() { return opt("WHATSAPP_TOKEN"); },
  get waPhoneNumberId() { return opt("WHATSAPP_PHONE_NUMBER_ID"); },
  get waTemplate() { return opt("WHATSAPP_TEMPLATE_REMINDER") ?? "meeting_reminder"; },
  get waTemplateLang() { return opt("WHATSAPP_TEMPLATE_LANG") ?? "en_GB"; },
  get twilioSid() { return opt("TWILIO_ACCOUNT_SID"); },
  get twilioToken() { return opt("TWILIO_AUTH_TOKEN"); },
  get twilioFrom() { return opt("TWILIO_FROM"); },
};

/** OAuth redirect URIs go through the site (Netlify proxies /api/* to this function). */
export function redirectUri(provider: "google" | "microsoft") {
  return `${env.siteUrl}/api/oauth/${provider}/callback`;
}
