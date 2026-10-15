// Supabase Edge Function: scores a batch of SAM.gov opportunities (parsed from
// a Contract Opportunities CSV in the browser) against Carrigon's company
// profile using Claude. The browser sends small batches and merges the results.
//
// Secrets (supabase secrets set ...):
//   ANTHROPIC_API_KEY - Claude API key from console.anthropic.com

import Anthropic from "npm:@anthropic-ai/sdk";
import { corsHeaders, isAdminRequest, json } from "../_shared/admin.ts";

const MODEL = "claude-opus-5-5";
const MAX_OPPORTUNITIES = 40;
const MAX_INPUT_CHARS = 250_000;

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "notice_id", "fit_score", "recommendation", "eligibility",
          "matched_capabilities", "summary", "strengths", "risks", "next_step",
        ],
        properties: {
          notice_id: { type: "string" },
          fit_score: { type: "integer", description: "0-100; how good a bid this is for Carrigon." },
          recommendation: { type: "string", enum: ["Pursue", "Consider", "Pass"] },
          eligibility: { type: "string", enum: ["Eligible", "Likely eligible", "Unclear", "Not eligible"] },
          matched_capabilities: { type: "array", items: { type: "string" } },
          summary: { type: "string", description: "One or two plain sentences on what the government is buying." },
          strengths: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          next_step: { type: "string", description: "The single most useful action for Carrigon, with any date." },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a federal capture manager for a small government contractor. You review SAM.gov contract opportunities and decide which ones the company should spend its limited bid-and-proposal time on.

Score each opportunity from 0 to 100 for how good a pursuit it is for the company described in the profile, then recommend Pursue (roughly 70+), Consider (40-69) or Pass (below 40).

Weigh, in roughly this order:
1. Eligibility. A set-aside the company does not hold (for example WOSB, 8(a) or HUBZone when the company is none of those) makes it "Not eligible" to prime; say so and score low, though note subcontracting potential if it is a strong match. A sole-source notice naming another vendor, a requirement for a facility clearance or certifications the profile does not mention, or a foreign-procurement process the company is not registered for are serious barriers.
2. Capability fit. How directly the work matches the company's stated services. Product, hardware, construction or highly specialized engineering buys (radar, avionics, physical security equipment, body-worn hardware) are poor fits for a services firm unless the profile says otherwise.
3. Winnability for a small firm. Size and scope a small business can credibly prime, SDVOSB or small-business set-asides, and early-stage notices (sources sought, RFIs) where a response can shape the acquisition.
4. Timing. Days left before the response deadline, and whether the notice is cancelled, inactive or says the requirement is no longer being pursued.

Base every judgment on the notice text. Do not invent facts about the opportunity or the company; when the notice says details are in attachments you cannot see, say what is unknown rather than guessing. Keep strengths and risks to short, specific phrases (at most four each). Return exactly one result per opportunity, using its notice_id unchanged.`;

// deno-lint-ignore no-explicit-any
function formatOpportunity(o: any, i: number): string {
  const lines = [
    `### Opportunity ${i + 1}`,
    `notice_id: ${o.noticeId}`,
    `Title: ${o.title}`,
    `Notice type: ${o.type || "unknown"}`,
    `Status: ${o.active || "unknown"}`,
    `Response deadline: ${o.deadline || "none listed"}${typeof o.daysLeft === "number" ? ` (${o.daysLeft} days from today)` : ""}`,
    `Set-aside: ${o.setAside || "none listed"}`,
    `NAICS: ${o.naics || "unknown"}`,
    `PSC: ${o.psc || "unknown"}`,
    `Description:\n${o.description || "(no description in the export)"}`,
  ];
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json(req, { error: "ANTHROPIC_API_KEY secret is not set." }, 500);
  if (!(await isAdminRequest(req))) return json(req, { error: "Not authorized." }, 403);

  const body = await req.json().catch(() => ({}));
  const profile = String(body.profile ?? "").trim();
  const opportunities = Array.isArray(body.opportunities) ? body.opportunities : [];
  if (!profile) return json(req, { error: "Company profile is empty." }, 400);
  if (!opportunities.length) return json(req, { error: "No opportunities to analyze." }, 400);
  if (opportunities.length > MAX_OPPORTUNITIES) {
    return json(req, { error: `Send at most ${MAX_OPPORTUNITIES} opportunities per request.` }, 400);
  }

  const today = new Date().toISOString().slice(0, 10);
  const userContent = [
    `Today's date: ${today}`,
    `## Company profile\n${profile}`,
    `## Opportunities (${opportunities.length})`,
    ...opportunities.map(formatOpportunity),
  ].join("\n\n");
  if (userContent.length > MAX_INPUT_CHARS) {
    return json(req, { error: "This batch is too large; send fewer opportunities per request." }, 413);
  }

  const client = new Anthropic();
  try {
    const message = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: RESULT_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }).finalMessage();

    if (message.stop_reason === "refusal") {
      return json(req, { error: "Claude declined to analyze this batch." }, 502);
    }
    if (message.stop_reason === "max_tokens") {
      return json(req, { error: "The analysis was cut off; try a smaller batch." }, 502);
    }
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const parsed = JSON.parse(text);
    return json(req, { results: parsed.results ?? [], model: message.model });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      return json(req, { error: "Claude API rate limit reached; wait a minute and retry." }, 429);
    }
    if (e instanceof Anthropic.APIError) {
      return json(req, { error: `Claude API error ${e.status}: ${e.message}` }, 502);
    }
    return json(req, { error: String((e as Error).message ?? e) }, 500);
  }
});
