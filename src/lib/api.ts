import { supabase } from "./supabase";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.auth !== false) {
    const { data } = await supabase.auth.getSession();
    if (data.session) headers.set("authorization", `Bearer ${data.session.access_token}`);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "You seem to be offline. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data as { error?: string; message?: string; msg?: string; code?: string };
    let msg = d.error ?? d.message ?? d.msg;
    if (res.status === 404 && d.code === "NOT_FOUND") msg = "Our server isn't reachable right now (API not deployed). Please try again shortly.";
    throw new ApiError(res.status, msg ?? `Something went wrong (error ${res.status}). Please try again.`);
  }
  return data as T;
}
