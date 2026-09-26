/**
 * PearsonAssist Vercel serverless: create GPT-Live WebRTC session.
 * Keep OPENAI_API_KEY in Vercel env (never in the browser).
 * Docs: https://developers.openai.com/api/docs/guides/voice-webrtc
 */
import OpenAI from "openai";
import {
  buildLiveCreateBody,
  isAllowedOrigin,
} from "../lib/live-config.mjs";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!isAllowedOrigin(origin, host)) {
    return response.status(403).json({
      error: "Unexpected request origin",
      hint: "Open the deployed site URL or http://localhost:3000",
    });
  }

  const sdp = request.body?.sdp;
  if (typeof sdp !== "string" || !sdp.trim()) {
    return response.status(400).json({ error: "An SDP offer is required" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return response
      .status(503)
      .json({ error: "Set OPENAI_API_KEY on the server" });
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
