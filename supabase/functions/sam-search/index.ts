// Supabase Edge Function: proxies SAM.gov Contract Opportunities searches so
// the SAM.gov API key never reaches the browser.
//
// Secrets (supabase secrets set ...):
//   SAM_API_KEY      - your SAM.gov public API key
//   ALLOWED_ORIGINS  - optional, comma-separated (defaults below)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
// automatically by Supabase.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, isAdminRequest, json } from "../_shared/admin.ts";

const SAM_SEARCH_URL = "https://api.sam.gov/opportunities/v2/search";
const CACHE_TTL_MINUTES = 60;
const PAGE_LIMIT = 1000; // SAM.gov maximum per request
const CONCURRENCY = 4;

// Carrigon's focus NAICS codes. The browser may request a subset, never others.
const FOCUS_NAICS = [
  "541511", "541512", "541513", "541519", "541611", "541612", "541613",
  "541614", "541618", "541690", "541715", "541810", "541910", "541990",
  "518210", "513210", "517810", "561320", "561330", "561621", "611430",
  "611710",
];

// Notice types, keyed by SAM.gov ptype code, matched against each record's `type`.
const NOTICE_TYPES: Record<string, string> = {
  o: "solicitation",
  k: "combined synopsis/solicitation",
  p: "presolicitation",
  r: "sources sought",
  s: "special notice",
  i: "intent to bundle requirements (dod-funded)",
};

function samDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

// deno-lint-ignore no-explicit-any
function trimRecord(r: any) {
  const poc = Array.isArray(r.pointOfContact) ? r.pointOfContact[0] : null;
  const pop = r.placeOfPerformance ?? {};
  return {
    noticeId: r.noticeId,
    title: r.title,
    solicitationNumber: r.solicitationNumber ?? null,
    agency: r.fullParentPathName ?? null,
    type: r.type ?? r.baseType ?? null,
    postedDate: r.postedDate ?? null,
    responseDeadline: r.responseDeadLine ?? r.reponseDeadLine ?? null,
    naicsCode: r.naicsCode ?? null,
    setAside: r.typeOfSetAsideDescription ?? null,
    setAsideCode: r.typeOfSetAside ?? null,
    state: pop.state?.code ?? null,
    city: pop.city?.name ?? null,
    active: r.active ?? null,
    pocName: poc?.fullName ?? null,
    pocEmail: poc?.email ?? null,
    hasDescription: typeof r.description === "string" && r.description.startsWith("http"),
    samUrl: `https://sam.gov/opp/${r.noticeId}/view`,
  };
}

type Trimmed = ReturnType<typeof trimRecord>;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// deno-lint-ignore no-explicit-any
async function fetchNaics(admin: any, apiKey: string, params: Record<string, string>) {
  const cacheKey = await sha256(JSON.stringify(params));
  const { data: cached } = await admin
    .from("sam_cache").select("payload, fetched_at").eq("cache_key", cacheKey).maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_TTL_MINUTES * 60_000) {
    return { ...(cached.payload as { records: Trimmed[]; total: number }), cached: true };
  }

  const url = new URL(SAM_SEARCH_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("offset", "0");
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAM.gov ${res.status} for NAICS ${params.ncode}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const payload = {
    records: (body.opportunitiesData ?? []).map(trimRecord) as Trimmed[],
    total: Number(body.totalRecords ?? 0),
  };
  await admin.from("sam_cache").upsert({
    cache_key: cacheKey, payload, fetched_at: new Date().toISOString(),
  });
  return { ...payload, cached: false };
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>) {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.allSettled(items.slice(i, i + size).map(fn)));
  }
  return out;
}

// deno-lint-ignore no-explicit-any
async function search(req: Request, admin: any, apiKey: string, body: any) {
  const naics: string[] = (Array.isArray(body.naics) && body.naics.length ? body.naics : FOCUS_NAICS)
    .map(String).filter((c: string) => FOCUS_NAICS.includes(c));
  if (!naics.length) return json(req, { error: "Pick at least one NAICS code." }, 400);

  const types: string[] = (Array.isArray(body.types) && body.types.length ? body.types : ["o", "k", "p", "r"])
    .filter((t: string) => t in NOTICE_TYPES);
  const wanted = new Set(types.map((t) => NOTICE_TYPES[t]));

  const days = Math.min(Math.max(Number(body.postedDays) || 30, 1), 364);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const base: Record<string, string> = { postedFrom: samDate(from), postedTo: samDate(to) };
  if (body.activeOnly !== false) {
    // Response deadline today or later.
    base.rdlfrom = samDate(to);
    base.rdlto = samDate(new Date(to.getTime() + 364 * 86_400_000));
  }
  if (body.keyword) base.title = String(body.keyword).slice(0, 200);
  if (body.setAside) base.typeOfSetAside = String(body.setAside).slice(0, 20);
  if (body.state) base.state = String(body.state).slice(0, 2).toUpperCase();

  const results = await inBatches(naics, CONCURRENCY, (ncode) =>
    fetchNaics(admin, apiKey, { ...base, ncode }));

  const seen = new Map<string, Trimmed>();
  const errors: string[] = [];
  const truncated: string[] = [];
  let cachedCount = 0;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push(String(r.reason?.message ?? r.reason));
      return;
    }
    if (r.value.cached) cachedCount++;
    if (r.value.total > r.value.records.length) truncated.push(naics[i]);
    for (const rec of r.value.records) {
      if (!rec.type || !wanted.has(String(rec.type).toLowerCase())) continue;
      seen.set(rec.noticeId, rec);
    }
  });

  const opportunities = [...seen.values()].sort((a, b) =>
    String(b.postedDate ?? "").localeCompare(String(a.postedDate ?? "")));

  return json(req, {
    opportunities,
    meta: {
      naicsSearched: naics.length,
      samRequests: naics.length - cachedCount - errors.length,
      fromCache: cachedCount,
      postedFrom: base.postedFrom,
      postedTo: base.postedTo,
      truncated,
      errors,
    },
  });
}

// deno-lint-ignore no-explicit-any
async function description(req: Request, apiKey: string, body: any) {
  const noticeId = String(body.noticeId ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(noticeId)) return json(req, { error: "Bad notice id." }, 400);
  const url = new URL("https://api.sam.gov/prod/opportunities/v1/noticedesc");
  url.searchParams.set("noticeid", noticeId);
  url.searchParams.set("api_key", apiKey);
  const res = await fetch(url);
  if (!res.ok) return json(req, { error: `SAM.gov returned ${res.status}` }, 502);
  const data = await res.json().catch(() => ({}));
  return json(req, { description: data.description ?? "" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  const apiKey = Deno.env.get("SAM_API_KEY");
  if (!apiKey) return json(req, { error: "SAM_API_KEY secret is not set." }, 500);

  if (!(await isAdminRequest(req))) return json(req, { error: "Not authorized." }, 403);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "description") return await description(req, apiKey, body);
    return await search(req, admin, apiKey, body);
  } catch (e) {
    return json(req, { error: String((e as Error).message ?? e) }, 500);
  }
});
