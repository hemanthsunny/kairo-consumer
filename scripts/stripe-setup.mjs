// Creates the Kairo Link products and prices in Stripe and prints the IDs to paste into Supabase secrets.
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs
const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error("Set STRIPE_SECRET_KEY"); process.exit(1); }

async function call(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message);
  return data;
}

const plans = [
  { key: "BASIC", name: "Kairo Link Basic", monthly: 300, yearly: 3000 },
  { key: "PREMIUM", name: "Kairo Link Premium", monthly: 1100, yearly: 11000 },
];
for (const p of plans) {
  const product = await call("products", { name: p.name, "metadata[app]": "kairo-link" });
  const m = await call("prices", { product: product.id, currency: "gbp", unit_amount: String(p.monthly), "recurring[interval]": "month", tax_behavior: "inclusive", lookup_key: `kairo_link_${p.key.toLowerCase()}_monthly` });
  const y = await call("prices", { product: product.id, currency: "gbp", unit_amount: String(p.yearly), "recurring[interval]": "year", tax_behavior: "inclusive", lookup_key: `kairo_link_${p.key.toLowerCase()}_yearly` });
  console.log(`STRIPE_PRICE_${p.key}_MONTHLY=${m.id}`);
  console.log(`STRIPE_PRICE_${p.key}_YEARLY=${y.id}`);
}
