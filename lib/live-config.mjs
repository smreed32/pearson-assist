/**
 * Shared GPT-Live session config for PearsonAssist (local Express + Vercel /api/session).
 * Docs: https://developers.openai.com/api/docs/guides/voice-webrtc
 *       https://developers.openai.com/api/docs/guides/live-delegation
 *
 * HARD GUARDRAIL: answers must come only from https://pearsonpkg.com (and subdomains).
 */

export const LIVE_INSTRUCTIONS = [
  "You are PearsonAssist, the official voice guide for Pearson Packaging Systems visitors and customers.",
  "Brand framing: PearsonAssist · Pearson Packaging Systems. Automated packaging solutions voice guide.",
  "As soon as the session starts, say: Hi, I'm PearsonAssist. Ask me anything about Pearson equipment, industries, service, or parts. Say this greeting only once per session, then listen.",
  "HARD GUARDRAIL: The ONLY allowed information source is https://pearsonpkg.com and its subdomains/pages.",
  "Do not use general web knowledge for product claims, specs, pricing, capabilities, or company facts.",
  "Whenever a question needs facts about Pearson products, services, industries, case studies, careers, or contact details, you MUST delegate to the backend Responses agent so it can search pearsonpkg.com.",
  "Always show clickable source cards in the From pearsonpkg.com panel. Never answer researched questions from memory alone.",
  "After research returns, summarize aloud from those pages only, tell the visitor the live links are in their card list, and invite follow-ups.",
  "If pearsonpkg.com does not cover a question, say so clearly. Suggest contacting Pearson at +1 (509) 838-6226 or browsing https://pearsonpkg.com. Never invent specs, pricing, or capabilities.",
  "For ordinary conversational turns that truly need no site lookup (greetings, clarifying what you can help with), answer briefly and professionally.",
  "Prefer short, clear speech. Do not invent headlines, URLs, or sources. Do not use em dashes in spoken or written replies.",
  "When speaking measurements, say common fractions in words instead of decimals: 0.25 is one quarter, 0.5 is one half, 0.75 is three quarters, 0.125 is one eighth, 0.375 is three eighths, 0.0625 is one sixteenth, and so on (for example, 2.75 inches is two and three quarter inches). Only use a fraction when it matches the decimal exactly; otherwise say the number naturally.",
  "For every inch measurement you speak, follow it with the millimeter equivalent, converted at exactly 25.4 millimeters per inch and rounded to a sensible precision (for example, one quarter inch, about 6.4 millimeters). If the page already gives a metric value, use that value. Converting units is allowed; never change or invent the underlying measurement.",
].join(" ");

export const RESPONSES_INSTRUCTIONS = [
  "You are the research backend for PearsonAssist, a B2B voice guide for Pearson Packaging Systems.",
  "HARD GUARDRAIL: Search and cite ONLY https://pearsonpkg.com and its subdomains (for example onlineparts.pearsonpkg.com).",
  "Never use general web knowledge for product claims. Never invent specs, pricing, capabilities, or URLs.",
  "ALWAYS provide openable source cards for every search you run so the visitor can reopen pages anytime.",
  "For every researched answer:",
  "1) Use the web_search tool (already filtered to pearsonpkg.com) to find grounded results from that site only.",
  "2) ALWAYS call present_link_cards with 1 to 8 items drawn only from those pearsonpkg.com results before you finish.",
  "   Each item needs title, summary, source (usually Pearson Packaging Systems), url, and kind.",
  "   kind must be one of: article, podcast, website, video, other.",
  "   Include published_at when available. Never invent or guess URLs.",
  "   Prefer primary product, industry, service, about, or contact pages on pearsonpkg.com.",
  "   Every url MUST be an https URL whose hostname is pearsonpkg.com or ends with .pearsonpkg.com.",
  "3) After the UI acknowledges present_link_cards, produce a short spoken-ready summary grounded only in those pages,",
  "   with source attribution for the live voice model, and note that the visitor can open the cards anytime.",
  "If search returns nothing useful on pearsonpkg.com, still call present_link_cards with an empty items array",
  "and explain that the site does not cover that topic. Suggest contacting Pearson at +1 (509) 838-6226 or browsing https://pearsonpkg.com.",
  "Never skip present_link_cards after web_search. Keep summaries factual and compact. Do not use em dashes.",
  "In spoken-ready summaries, write inch measurements as spoken fractions where the decimal matches exactly (0.25 as one quarter, 0.75 as three quarters, 0.125 as one eighth) and follow each with its millimeter equivalent at 25.4 millimeters per inch (for example, one quarter inch, about 6.4 millimeters). Use the page's own metric value when it gives one.",
].join(" ");

export const PRESENT_LINK_CARDS_TOOL = {
  type: "function",
  name: "present_link_cards",
  description:
    "Render clickable link cards in the client UI for pearsonpkg.com pages only (products, services, industries, articles, videos, or other site pages). Call after web_search with 1 to 8 real pearsonpkg.com items (or an empty array if none).",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "Grounded links from pearsonpkg.com web search only.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Page or article title from pearsonpkg.com.",
            },
            summary: {
              type: "string",
              description: "One or two sentence factual summary from that page.",
            },
            source: {
              type: "string",
              description: "Publisher or site name (usually Pearson Packaging Systems).",
            },
            url: {
              type: "string",
              description:
                "Canonical HTTPS URL on pearsonpkg.com or a pearsonpkg.com subdomain. Never invent.",
            },
            kind: {
              type: "string",
              description: "What this link is.",
              enum: ["article", "podcast", "website", "video", "other"],
            },
            published_at: {
              type: "string",
              description: "Publication date or datetime if known (optional).",
            },
          },
          required: ["title", "summary", "source", "url", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

/** @deprecated kept only so older client builds still match if needed */
export const PRESENT_NEWS_TOOL = PRESENT_LINK_CARDS_TOOL;

export const WEB_SEARCH_TOOL = {
  type: "web_search",
  filters: {
    allowed_domains: ["pearsonpkg.com"],
  },
};

export function responsesModel() {
  return process.env.RESPONSES_MODEL || "gpt-5.6-terra";
}

export function buildLiveCreateBody(sdp) {
  return {
    session: {
      model: "gpt-live-1",
      instructions: LIVE_INSTRUCTIONS,
      delegation: {
        type: "responses",
        responses: {
          model: responsesModel(),
          instructions: RESPONSES_INSTRUCTIONS,
          tools: [WEB_SEARCH_TOOL, PRESENT_LINK_CARDS_TOOL],
          tool_choice: "auto",
        },
      },
    },
    transport: {
      type: "webrtc",
      sdp,
    },
  };
}

/** Exact browser origins allowed to create a Live session in production. */
export const PRODUCTION_ORIGINS = ["https://pearson-assist.vercel.app"];

/** Extra origins allowed only when running the local Express dev server (never on Vercel). */
export function localDevOrigins() {
  const port = Number(process.env.PORT) || 3000;
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * Strict origin check: the Origin header must be present and exactly match the allowlist.
 * There is no Host-header fallback. Requests marked Sec-Fetch-Site: cross-site are refused.
 */
export function isAllowedRequest(headers, { allowLocal = false } = {}) {
  const origin = headers?.origin;
  if (typeof origin !== "string" || !origin) return false;
  const fetchSite = headers?.["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite.toLowerCase() === "cross-site") {
    return false;
  }
  const allowed = new Set(PRODUCTION_ORIGINS);
  if (allowLocal) for (const o of localDevOrigins()) allowed.add(o);
  return allowed.has(origin);
}

/**
 * Best-effort per-IP limiter (in memory). On serverless this is per instance only,
 * so the Vercel Firewall rate-limit rule on /api/session is the primary control.
 */
const RATE_LIMITS = [
  { windowMs: 60_000, max: 5 },
  { windowMs: 60 * 60_000, max: 30 },
];
const hits = new Map();

export function clientIp(headers) {
  const real = headers?.["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const fwd = headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return "unknown";
}

/** Records a hit and returns { ok: true } or { ok: false, retryAfter } (seconds). */
export function checkRateLimit(ip, now = Date.now()) {
  const longest = RATE_LIMITS[RATE_LIMITS.length - 1].windowMs;
  const list = (hits.get(ip) || []).filter((t) => now - t < longest);
  for (const { windowMs, max } of RATE_LIMITS) {
    const inWindow = list.filter((t) => now - t < windowMs);
    if (inWindow.length >= max) {
      hits.set(ip, list);
      const retryAfter = Math.max(1, Math.ceil((inWindow[0] + windowMs - now) / 1000));
      return { ok: false, retryAfter };
    }
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.length || now - times[times.length - 1] >= longest) hits.delete(key);
    }
  }
  return { ok: true };
}
