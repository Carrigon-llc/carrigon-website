// Shared CORS + admin-check helpers for the admin portal's Edge Functions.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_ORIGINS = [
  "https://carrigon.com",
  "https://www.carrigon.com",
  "http://localhost:3000",
];

export function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origins = allowed.length ? allowed : DEFAULT_ORIGINS;
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": origins.includes(origin) ? origin : origins[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

// True when the caller's JWT belongs to an email in public.admin_users.
export async function isAdminRequest(req: Request): Promise<boolean> {
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data, error } = await userClient.rpc("is_admin");
  return !error && data === true;
}
