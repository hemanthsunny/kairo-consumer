// Competitor facts for the comparison pages. Keep these accurate and dated:
// sources are the competitors' public pricing pages and help docs, checked November 2026.
export type Row = { label: string; us: string; them: string };
export type Competitor = {
  slug: string;
  name: string;
  title: string; // <title>
  description: string; // meta description
  h1: string;
  lead: string;
  rows: Row[];
  switch: string[];
  theyFit: string[];
  faq: { q: string; a: string }[];
};

export const CHECKED = "November 2026";

export const COMPETITORS: Competitor[] = [
  {
    slug: "calendly",
    name: "Calendly",
    title: "Calendly alternative for multiple calendars, with WhatsApp reminders | Kairo Link",
    description: "Kairo Link vs Calendly: connect 3 calendars free (Calendly Free allows 1), see every event in one view, and get WhatsApp and SMS reminders for £9 a month.",
    h1: "Kairo Link vs Calendly",
    lead: "A Calendly alternative for people who live in more than one calendar.",
    rows: [
      { label: "Calendars on the free plan", us: "3", them: "1" },
      { label: "Booking links on the free plan", us: "1", them: "1 event type" },
      { label: "Paid plan", us: "£9 / month", them: "From $10 / seat / month, billed yearly" },
      { label: "Calendars on the paid plan", us: "Unlimited", them: "Up to 6" },
      { label: "WhatsApp reminders", us: "Built in (Premium)", them: "Through third-party add-ons" },
      { label: "SMS reminders", us: "Built in (Premium)", them: "Paid plans" },
      { label: "Reminders cover", us: "Bookings, or every event in your calendars", them: "Calendly bookings" },
    ],
    switch: [
      "Connect your work, client and personal calendars on the free plan.",
      "Get a WhatsApp message before any meeting, not just ones booked through your link.",
      "One simple price in pounds.",
    ],
    theyFit: [
      "You need CRM integrations like Salesforce or HubSpot.",
      "You run a large sales team with routing and round-robin rules.",
    ],
    faq: [
      { q: "Is Kairo Link a free Calendly alternative?", a: "Yes. The free plan connects up to 3 Google or Outlook calendars and gives you a booking link, with email reminders. Premium is £9 a month for unlimited calendars and links, WhatsApp and SMS reminders, and groups." },
      { q: "Can I check several calendars before people book me?", a: "Yes. Every calendar you connect is checked for clashes, so guests only see times when you're free in all of them." },
      { q: "Does Kairo Link send WhatsApp reminders?", a: "Yes, on Premium. Choose 10 minutes, 30 minutes or a day before, for bookings or for every event in your calendars." },
    ],
  },
  {
    slug: "cal-com",
    name: "Cal.com",
    title: "Cal.com alternative with WhatsApp reminders for every meeting | Kairo Link",
    description: "Kairo Link vs Cal.com: one view of every event across your Google and Outlook calendars, plus WhatsApp and SMS reminders for £9 a month.",
    h1: "Kairo Link vs Cal.com",
    lead: "A simpler Cal.com alternative focused on your whole day, not just bookings.",
    rows: [
      { label: "Calendars on the free plan", us: "3", them: "Unlimited" },
      { label: "Booking links on the free plan", us: "1", them: "Unlimited" },
      { label: "Paid plan", us: "£9 / month", them: "Teams from $12 / user / month, billed yearly" },
      { label: "WhatsApp and SMS reminders", us: "Included in Premium (300 WhatsApp, 50 SMS a month)", them: "Teams plan, using message credits" },
      { label: "Reminders cover", us: "Bookings, or every event in your calendars", them: "Cal.com bookings" },
      { label: "Group links and Find a time", us: "Premium, up to 10 people", them: "Teams plan" },
    ],
    switch: [
      "See every meeting from every account in one week view.",
      "WhatsApp and SMS reminders for all your meetings, in one flat price.",
      "Set up in two minutes, with nothing to configure.",
    ],
    theyFit: [
      "You want unlimited booking links for free.",
      "You need an API, self-hosting or advanced routing forms.",
    ],
    faq: [
      { q: "How is Kairo Link different from Cal.com?", a: "Cal.com is a full scheduling platform. Kairo Link focuses on people with several calendars: one link that checks them all, one view of every event, and reminders on WhatsApp or SMS for any meeting." },
      { q: "Does Kairo Link work with Google and Outlook together?", a: "Yes. Connect any mix of Google and Microsoft 365 / Outlook accounts." },
      { q: "How much does Kairo Link cost?", a: "Free for up to 3 calendars and 1 booking link. Premium is £9 a month or £90 a year." },
    ],
  },
];
