/**
 * PearsonAssist - local Express server
 *
 * Creates GPT-Live WebRTC sessions via client.live.create.
 * Keep OPENAI_API_KEY on this server only.
 *
 * Docs:
 *   https://developers.openai.com/api/docs/guides/voice-webrtc
 *   https://developers.openai.com/api/docs/guides/live-delegation
 *
 * For production, Vercel serves public/ + api/session.js (same Live config).
 */
import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildLiveCreateBody,
  checkRateLimit,
  clientIp,
  isAllowedRequest,
  responsesModel,
} from "./lib/live-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(__dirname, "public")));

app.all("/api/session", (request, response, next) => {
  if (request.method === "POST") return next();
  response.set("Allow", "POST");
  response.status(405).json({ error: "Method not allowed" });
});

app.post("/api/session", async (request, response) => {
  // Local dev only: allow http://localhost:<port> and http://127.0.0.1:<port>.
  if (!isAllowedRequest(request.headers, { allowLocal: true })) {
    response.status(403).json({ error: "Not allowed" });
    return;
  }
  const ip = clientIp(request.headers) !== "unknown"
    ? clientIp(request.headers)
    : request.socket.remoteAddress || "unknown";
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    response.set("Retry-After", String(limit.retryAfter));
    response.status(429).json({ error: "Too many requests" });
    return;
  }
  if (typeof request.body?.sdp !== "string" || !request.body.sdp.trim()) {
    response.status(400).json({ error: "Bad request" });
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set");
    response.status(503).json({ error: "Service unavailable" });
    return;
  }

  const client = new OpenAI({ maxRetries: 0 });

  try {
    const result = await client.live.create(
      buildLiveCreateBody(request.body.sdp),
    );
    response.status(201).json(result);
  } catch (error) {
    if (!(error instanceof OpenAI.APIError)) {
      console.error("Unexpected session error", error);
      response.status(500).json({ error: "Live session creation failed" });
      return;
    }
    console.error("Live session creation failed", error.status, error.message);
    response
      .status(error.status ?? 502)
      .json({ error: "Live session creation failed" });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Open http://localhost:${port} (or http://127.0.0.1:${port})`);
  console.log(`Responses model: ${responsesModel()}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set. POST /api/session will return 503.");
  }
});
