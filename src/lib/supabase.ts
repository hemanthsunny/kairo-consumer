import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
});

export type Plan = "trial" | "basic" | "premium" | "inactive";

export interface Profile {
  id: string;
  handle: string;
  full_name: string | null;
  email: string | null;
  timezone: string;
  phone_e164: string | null;
  phone_verified: boolean;
  reminder_channels: string[];
  plan: Plan;
  trial_ends_at: string;
  onboarded: boolean;
}

export interface Account {
  id: string;
  provider: "google" | "microsoft";
  email: string;
  label: string;
  color: string;
  status: "active" | "error" | "revoked";
  last_error: string | null;
  busy: { start: number; end: number }[];
  error: string | null;
}

export interface CalendarRow {
  id: string;
  account_id: string;
  name: string;
  can_write: boolean;
  check_conflicts: boolean;
}

export type WeeklyHours = Record<string, [string, string][]>;

export interface LinkRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  max_days_ahead: number;
  daily_limit: number | null;
  slot_step_min: number;
  write_calendar_id: string | null;
  location_type: "auto" | "custom_url" | "phone" | "in_person" | "none";
  location_value: string | null;
  weekly_hours: WeeklyHours;
  is_active: boolean;
  created_at: string;
}

export interface Booking {
  id: string;
  title: string;
  guest_name: string;
  guest_email: string;
  start_at: string;
  end_at: string;
  status: "confirmed" | "cancelled";
  meeting_url: string | null;
  location_text: string | null;
  link_id: string | null;
}
