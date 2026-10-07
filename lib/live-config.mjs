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

function isPearsonAssistHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "pearson-assist.vercel.app") return true;
  if (host.endsWith(".vercel.app") && host.includes("pearson-assist")) return true;
  return false;
}

/** Allow local demo hosts and this project's Vercel deployments. */
export function isAllowedOrigin(originHeader, hostHeader) {
  const port = Number(process.env.PORT) || 3000;
  const local = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]);

  if (!originHeader) {
    const host = String(hostHeader || "");
    if (
      host === `localhost:${port}` ||
      host === `127.0.0.1:${port}` ||
      host === `[::1]:${port}`
    ) {
      return true;
    }
    const hostname = host.split(":")[0];
    if (isPearsonAssistHost(hostname) || host.endsWith(".vercel.app")) {
      // Prefer pearson-assist hosts; also allow bare vercel.app host header during preview probes.
      if (isPearsonAssistHost(hostname)) return true;
      if (host.includes("pearson-assist")) return true;
    }
    return false;
  }

  if (local.has(originHeader)) return true;
  try {
    const u = new URL(originHeader);
    if (u.protocol !== "https:") return false;
    if (isPearsonAssistHost(u.hostname)) return true;
  } catch {
    return false;
  }
  return false;
}
