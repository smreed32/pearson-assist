/**
 * PearsonAssist Vercel serverless: create GPT-Live WebRTC session.
 * Keep OPENAI_API_KEY in Vercel env (never in the browser).
 * Docs: https://developers.openai.com/api/docs/guides/voice-webrtc
 *
 * Abuse controls: strict Origin allowlist (no Host fallback), Sec-Fetch-Site
 * cross-site refusal, POST only, a Vercel Firewall per-IP rate-limit rule on
 * /api/session, and a best-effort in-memory per-IP limiter below as backup.
 */
import OpenAI from "openai";
import {
  buildLiveCreateBody,
  checkRateLimit,
  clientIp,
  isAllowedRequest,
} from "../lib/live-config.mjs";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  if (!isAllowedRequest(request.headers)) {
    return response.status(403).json({ error: "Not allowed" });
  }

  const limit = checkRateLimit(clientIp(request.headers));
  if (!limit.ok) {
    response.setHeader("Retry-After", String(limit.retryAfter));
    return response.status(429).json({ error: "Too many requests" });
  }

  const sdp = request.body?.sdp;
  if (typeof sdp !== "string" || !sdp.trim()) {
    return response.status(400).json({ error: "Bad request" });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set");
    return response.status(503).json({ error: "Service unavailable" });
  }

  const client = new OpenAI({ maxRetries: 0 });

  try {
    // Live session creation via client.live.create (POST /v1/live/sessions)
    const result = await client.live.create(buildLiveCreateBody(sdp));
    return response.status(201).json(result);
  } catch (error) {
    if (!(error instanceof OpenAI.APIError)) {
      console.error("Unexpected session error", error);
      return response.status(500).json({ error: "Live session creation failed" });
    }
    console.error("Live session creation failed", error.status, error.message);
    return response
      .status(error.status ?? 502)
      .json({ error: "Live session creation failed" });
  }
}
