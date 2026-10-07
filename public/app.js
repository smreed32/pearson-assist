/**
 * PearsonAssist - browser client
 *
 * Official GPT-Live WebRTC flow:
 *   RTCPeerConnection + getUserMedia + data channel "oai-events"
 *   ICE gather complete → POST { sdp } to /api/session
 *   setRemoteDescription(result.transport.sdp)
 *   Do NOT send session.start; wait for session.started
 *   End with session.close; wait for session.closed
 *
 * Source cards are filtered client-side to pearsonpkg.com (and subdomains) only.
 *
 * https://developers.openai.com/api/docs/guides/voice-webrtc
 * https://developers.openai.com/api/docs/guides/live-delegation
 */

const startBtn = document.getElementById("startBtn");
const endBtn = document.getElementById("endBtn");
const clearTranscriptBtn = document.getElementById("clearTranscriptBtn");
const statusChip = document.getElementById("statusChip");
const statusDetail = document.getElementById("statusDetail");
const researchBanner = document.getElementById("researchBanner");
const researchText = document.getElementById("researchText");
const errorBox = document.getElementById("errorBox");
const transcriptEl = document.getElementById("transcript");
const newsList = document.getElementById("newsList");
const emptyNews = document.getElementById("emptyNews");
const articleCount = document.getElementById("articleCount");
const remoteAudio = document.getElementById("remoteAudio");
const soundBtn = document.getElementById("soundBtn");

/** @type {RTCPeerConnection | null} */
let peer = null;
/** @type {RTCDataChannel | null} */
let events = null;
/** @type {MediaStream | null} */
let microphone = null;
let closeTimeout = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let idleTimeout = null;
const IDLE_MS = 60_000;
let endedForIdle = false;
let ready = false;
let finalized = false;
let sessionId = null;

/* Mobile audio unlock + one-time greeting state */
let audioCtx = null;
let micReadyAt = 0;
let greetingSent = false;
let greetingPending = false;
let greetingActive = false; // true from greeting kick until it finishes speaking
let greetingEventId = null;
let greetingFallbackTimer = null;
let greetingDelayTimer = null;
const GREETING_MIC_SETTLE_MS = 800;
const GREETING_FALLBACK_MS = 8000;

/** @type {Map<string, { el: HTMLElement, text: string }>} */
const openTurns = new Map();

/** Pending function calls keyed by call_id within a delegation */
/** @type {Map<string, Set<string>>} */
const pendingCallsByDelegation = new Map();

const STATE_LABELS = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  researching: "Looking it up",
  speaking: "Speaking",
  error: "Needs attention",
};

function setState(state, detail) {
  statusChip.dataset.state = state;
  statusChip.textContent = STATE_LABELS[state] || state;
  if (typeof detail === "string") {
    statusDetail.textContent = detail;
  }
}

const UNAVAILABLE_MESSAGE =
  "PearsonAssist isn't available right now. Please try again in a moment, or call our team at +1 (509) 838-6226.";
const CONNECT_FAIL_MESSAGE =
  "We couldn't connect. Check your internet connection and try again.";

/** Error whose message is safe to show customers as-is. */
class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
  setState("error", message);
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function setResearching(active, label = "Looking that up…") {
  // The greeting kick runs through the backend; keep the UI on "Saying hello" instead of a lookup banner.
  if (active && greetingActive) return;
  researchBanner.hidden = !active;
  researchText.textContent = label;
  if (active) setState("researching", label);
}

function sendEvent(payload) {
  if (!events || events.readyState !== "open") return;
  events.send(JSON.stringify(payload));
}

function eventId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Must run synchronously inside the tap handler, before any await.
 * Phones only allow audio that starts from a user gesture, so we start a
 * silent stream on the audio element and resume an AudioContext right here.
 */
function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") void audioCtx.resume();
      // Tiny silent sound so the browser treats audio as user-started.
      const buffer = audioCtx.createBuffer(1, 1, 22050);
      const blip = audioCtx.createBufferSource();
      blip.buffer = buffer;
      blip.connect(audioCtx.destination);
      blip.start(0);
      if (!remoteAudio.srcObject && audioCtx.createMediaStreamDestination) {
        const silent = audioCtx.createMediaStreamDestination();
        remoteAudio.srcObject = silent.stream;
      }
    }
  } catch (error) {
    console.warn("Audio unlock (context) failed", error);
  }
  remoteAudio.muted = false;
  const attempt = remoteAudio.play();
  if (attempt && typeof attempt.catch === "function") {
    attempt.catch(() => {
      /* The real retry happens in playRemoteAudio when the voice stream arrives. */
    });
  }
}

function hideSoundPrompt() {
  soundBtn.hidden = true;
  document.removeEventListener("pointerdown", retrySoundFromGesture, true);
  document.removeEventListener("touchend", retrySoundFromGesture, true);
}

function retrySoundFromGesture() {
  unlockAudio();
  remoteAudio
    .play()
    .then(() => hideSoundPrompt())
    .catch(() => {
      /* Keep the prompt up; the next touch tries again. */
    });
}

function showSoundPrompt() {
  soundBtn.hidden = false;
  document.addEventListener("pointerdown", retrySoundFromGesture, true);
  document.addEventListener("touchend", retrySoundFromGesture, true);
}

function playRemoteAudio() {
  remoteAudio.muted = false;
  remoteAudio
    .play()
    .then(() => hideSoundPrompt())
    .catch(() => showSoundPrompt());
}

function clearGreetingTimers() {
  clearTimeout(greetingFallbackTimer);
  greetingFallbackTimer = null;
  clearTimeout(greetingDelayTimer);
  greetingDelayTimer = null;
}

/** Greeting did not come through; quietly go back to listening. */
function greetingFallback() {
  if (!greetingPending) return;
  greetingPending = false;
  greetingActive = false;
  clearGreetingTimers();
  if (!ready || finalized) return;
  setState("listening", "Listening. Go ahead and ask your question.");
  armIdleTimer();
}

/** One plain response.create per session so PearsonAssist speaks first. */
function scheduleGreeting() {
  if (greetingSent) return;
  greetingSent = true;
  greetingPending = true;
  greetingActive = true;
  setState("speaking", "Saying hello…");
  clearIdleTimer();
  const wait = Math.max(0, GREETING_MIC_SETTLE_MS - (Date.now() - micReadyAt));
  greetingDelayTimer = setTimeout(() => {
    greetingDelayTimer = null;
    if (!ready || finalized || !greetingPending) return;
    greetingEventId = eventId("greeting");
    sendEvent({ type: "response.create", event_id: greetingEventId });
    greetingFallbackTimer = setTimeout(greetingFallback, GREETING_FALLBACK_MS);
  }, wait);
}

function clearIdleTimer() {
  clearTimeout(idleTimeout);
  idleTimeout = null;
}

/** Count down while waiting for the user to speak; pause while PearsonAssist talks or researches. */
function armIdleTimer() {
  clearIdleTimer();
  if (!ready || finalized) return;
  idleTimeout = setTimeout(() => {
    idleTimeout = null;
    if (!ready || finalized) return;
    endedForIdle = true;
    setState("thinking", "Wrapping up after a quiet minute…");
    endSession();
  }, IDLE_MS);
}

function cleanup() {
  clearIdleTimer();
  clearTimeout(closeTimeout);
  closeTimeout = null;
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
  try {
    events?.close();
  } catch {
    /* ignore */
  }
  events = null;
  try {
    peer?.close();
  } catch {
    /* ignore */
  }
  peer = null;
  remoteAudio.srcObject = null;
  remoteAudio.classList.remove("visible");
  ready = false;
  sessionId = null;
  greetingSent = false;
  greetingPending = false;
  greetingActive = false;
  greetingEventId = null;
  clearGreetingTimers();
  hideSoundPrompt();
  pendingCallsByDelegation.clear();
  setResearching(false);
  startBtn.disabled = false;
  endBtn.disabled = true;
}

function ensureTurn(role, key) {
  let turn = openTurns.get(key);
  if (turn) return turn;
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  const roleEl = document.createElement("span");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "You" : "PearsonAssist";
  const body = document.createElement("div");
  body.className = "body";
  el.append(roleEl, body);
  transcriptEl.append(el);
  turn = { el, text: "", body };
  openTurns.set(key, turn);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return turn;
}

function appendTranscript(role, delta, turnKey) {
  const turn = ensureTurn(role, turnKey);
  turn.text += delta;
  turn.body.textContent = turn.text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function finalizeTurn(turnKey) {
  openTurns.delete(turnKey);
}

function formatDate(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: undefined,
    }).format(new Date(parsed));
  } catch {
    return value;
  }
}

const KIND_LABELS = {
  article: "Article",
  podcast: "Podcast",
  website: "Website",
  video: "Video",
  other: "Link",
};

const KIND_OPEN = {
  article: "Open article",
  podcast: "Open episode",
  website: "Open site",
  video: "Open video",
  other: "Open link",
};


function isPearsonPkgUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    return host === "pearsonpkg.com" || host.endsWith(".pearsonpkg.com");
  } catch {
    return false;
  }
}


function normalizeLinkItems(payload) {
  const raw = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.articles)
      ? payload.articles
      : [];
  return raw
    .map((item) => {
      const kind = String(item.kind || "article").toLowerCase();
      const known = KIND_LABELS[kind] ? kind : "other";
      return {
        title: item.title || item.headline || "Pearson page",
        summary: item.summary || "",
        source: item.source || "Pearson Packaging Systems",
        url: item.url || "",
        kind: known,
        published_at: item.published_at || null,
      };
    })
    .filter((item) => isPearsonPkgUrl(item.url));
}

function renderLinkCards(items) {
  if (!Array.isArray(items) || items.length === 0) {
    newsList.innerHTML = "";
    emptyNews.hidden = false;
    const emptyOrb = document.createElement("div");
    emptyOrb.className = "empty-mark";
    emptyOrb.setAttribute("aria-hidden", "true");
    const emptyTitle = document.createElement("p");
    emptyTitle.className = "empty-title";
    emptyTitle.textContent = "No pages for that one";
    const emptyCopy = document.createElement("p");
    emptyCopy.className = "empty-copy";
    emptyCopy.textContent =
      "I couldn't find a page on pearsonpkg.com for that. Try asking another way, browse pearsonpkg.com, or call our team at +1 (509) 838-6226.";
    emptyNews.replaceChildren(emptyOrb, emptyTitle, emptyCopy);
    articleCount.textContent = "0 links";
    return;
  }

  emptyNews.hidden = true;
  newsList.innerHTML = "";
  articleCount.textContent = `${items.length} link${items.length === 1 ? "" : "s"}`;

  for (const item of items) {
    const url = item.url && /^https?:\/\//i.test(item.url) ? item.url : null;
    const card = document.createElement(url ? "a" : "article");
    card.className = "news-card";
    if (url) {
      card.href = url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.setAttribute("aria-label", `${KIND_OPEN[item.kind]}: ${item.title}`);
    }

    const kind = document.createElement("span");
    kind.className = `card-kind card-kind-${item.kind}`;
    kind.textContent = KIND_LABELS[item.kind];

    const title = document.createElement("h3");
    title.textContent = item.title;

    const summary = document.createElement("p");
    summary.textContent = item.summary;

    const meta = document.createElement("div");
    meta.className = "meta";

    const source = document.createElement("span");
    source.textContent = item.source;
    meta.append(source);

    const when = formatDate(item.published_at);
    if (when) {
      const date = document.createElement("span");
      date.textContent = when;
      meta.append(date);
    }

    if (url) {
      const hint = document.createElement("span");
      hint.className = "open-hint";
      hint.textContent = KIND_OPEN[item.kind];
      meta.append(hint);
    }

    card.append(kind, title, summary, meta);
    newsList.append(card);
  }
}

function handlePresentLinkCards(callId, argumentsJson, delegationId) {
  let parsed;
  try {
    parsed = JSON.parse(argumentsJson || "{}");
  } catch (error) {
    console.warn("Failed to parse present_link_cards arguments", error);
    parsed = { items: [] };
  }

  const items = normalizeLinkItems(parsed);
  renderLinkCards(items);

  sendEvent({
    type: "response.item.create",
    event_id: eventId("tool_result"),
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({
        status: "received",
        rendered: items.length,
        message:
          items.length > 0
            ? "Pearson source cards rendered in the UI with live pearsonpkg.com URLs."
            : "Empty results shown. Site may not cover that topic.",
      }),
    },
  });

  const pending = pendingCallsByDelegation.get(delegationId);
  if (pending) {
    pending.delete(callId);
    if (pending.size === 0) {
      pendingCallsByDelegation.delete(delegationId);
      sendEvent({
        type: "response.create",
        event_id: eventId("continue"),
      });
    }
  } else {
    sendEvent({
      type: "response.create",
      event_id: eventId("continue"),
    });
  }
}

function trackFunctionCall(delegationId, item) {
  if (!item || item.type !== "function_call") return;
  if (!delegationId || !item.call_id) return;

  let pending = pendingCallsByDelegation.get(delegationId);
  if (!pending) {
    pending = new Set();
    pendingCallsByDelegation.set(delegationId, pending);
  }
  pending.add(item.call_id);

  if (item.name === "present_link_cards" || item.name === "present_news_results") {
    handlePresentLinkCards(item.call_id, item.arguments, delegationId);
  }
}

function handleNestedResponseEvent(envelope) {
  const delegationId = envelope.delegation_id;
  const nested = envelope.event;
  if (!nested || typeof nested !== "object") return;

  switch (nested.type) {
    case "response.created":
    case "response.in_progress":
      setResearching(true, "Looking that up…");
      break;
    case "response.output_item.done":
      trackFunctionCall(delegationId, nested.item);
      break;
    case "response.completed":
    case "response.failed":
    case "response.incomplete":
      setResearching(false);
      if (nested.type !== "response.completed") {
        console.warn("Delegated response ended", nested.type, nested);
      }
      break;
    default:
      break;
  }
}

function handleServerEvent(event) {
  switch (event.type) {
    case "session.started":
      ready = true;
      sessionId = event.session?.id || null;
      endBtn.disabled = false;
      endedForIdle = false;
      clearError();
      scheduleGreeting();
      break;

    case "session.closed":
      finalized = true;
      console.log("Final session usage", event.usage);
      setState(
        "idle",
        endedForIdle
          ? "Ended after a minute of quiet. Tap Ask PearsonAssist anytime."
          : "Conversation ended. Ask again anytime."
      );
      endedForIdle = false;
      cleanup();
      break;

    case "session.input_transcript.delta":
      appendTranscript("user", event.delta || "", `user:${event.item_id || "live"}`);
      setState("listening");
      armIdleTimer();
      break;

    case "session.input_transcript.done":
      finalizeTurn(`user:${event.item_id || "live"}`);
      clearIdleTimer();
      break;

    case "session.output_transcript.delta":
      appendTranscript(
        "assistant",
        event.delta || "",
        `assistant:${event.item_id || "live"}`
      );
      if (greetingPending) {
        greetingPending = false;
        clearGreetingTimers();
      }
      setState("speaking");
      clearIdleTimer();
      break;

    case "session.output_transcript.done":
      finalizeTurn(`assistant:${event.item_id || "live"}`);
      greetingActive = false;
      setState("listening", "Listening. Go ahead and ask your question.");
      armIdleTimer();
      break;

    case "session.delegation.created":
      setResearching(true, "Looking that up…");
      clearIdleTimer();
      break;

    case "session.commentary.append":
    case "session.commentary.appended":
      setResearching(true, "Finding the right pages…");
      clearIdleTimer();
      break;

    case "session.thinking.append":
    case "session.thinking.appended":
      setResearching(true, "Pulling it together…");
      setState("thinking");
      clearIdleTimer();
      break;

    case "response.event":
      handleNestedResponseEvent(event);
      break;

    case "error": {
      console.warn("Live error", event.error?.message || event.message || event);
      const relatedId = event.error?.event_id || event.event_id || null;
      if (greetingPending && (!relatedId || relatedId === greetingEventId)) {
        // Voice service rejected the greeting kick: fall back to listening, no error box.
        greetingFallback();
        break;
      }
      showError(UNAVAILABLE_MESSAGE);
      break;
    }

    default: {
      const type = String(event.type || "");
      if (type.startsWith("session.delegation.")) {
        setResearching(true, "Still looking, one moment…");
        break;
      }
      // Useful while developing; keep quiet for high-frequency audio-adjacent events.
      if (type && !type.includes("audio")) {
        console.debug("Live event", type, event);
      }
      break;
    }
  }
}

async function waitForIceGathering(connection) {
  if (connection.iceGatheringState === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", onState);
      console.warn("Timed out while gathering ICE candidates");
      reject(new UserFacingError(CONNECT_FAIL_MESSAGE));
    }, 10_000);

    function onState() {
      if (connection.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onState);
      resolve(undefined);
    }

    connection.addEventListener("icegatheringstatechange", onState);
    onState();
  });
}

async function startSession() {
  startBtn.disabled = true;
  finalized = false;
  clearError();
  setState("thinking", "Getting ready…");

  try {
    const connection = new RTCPeerConnection();
    peer = connection;

    connection.addEventListener("track", (event) => {
      remoteAudio.srcObject = new MediaStream([event.track]);
      remoteAudio.classList.add("visible");
      playRemoteAudio();
    });

    try {
      microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      micReadyAt = Date.now();
    } catch (err) {
      const name = err && typeof err === "object" ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new UserFacingError(
          "PearsonAssist needs your microphone. Allow microphone access in your browser, then tap Ask PearsonAssist."
        );
      }
      if (name === "NotFoundError") {
        throw new UserFacingError("We couldn't find a microphone. Plug one in or try another device.");
      }
      console.warn("Microphone error", err);
      throw new UserFacingError(
        "We couldn't reach your microphone. Check your browser settings and try again."
      );
    }

    for (const track of microphone.getAudioTracks()) {
      connection.addTrack(track, microphone);
    }

    // Create the event channel before creating the SDP offer.
    events = connection.createDataChannel("oai-events");
    events.addEventListener("message", ({ data }) => {
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        console.warn("Non-JSON data channel message", data);
        return;
      }
      handleServerEvent(event);
    });
    events.addEventListener("close", (event) => {
      if (event.target !== events) return;
      if (!finalized) {
        setState("idle", "The conversation stopped. Tap Ask PearsonAssist to start again.");
        cleanup();
      }
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);

    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error("Missing local SDP offer");

    let response;
    try {
      response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp }),
      });
    } catch {
      throw new UserFacingError(CONNECT_FAIL_MESSAGE);
    }

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.error || JSON.stringify(body);
      } catch {
        detail = await response.text();
      }
      console.warn("Session request failed", response.status, detail);
      throw new Error(detail || `Session request failed (${response.status})`);
    }

    const result = await response.json();
    console.log("Created session", result.session?.id);
    await connection.setRemoteDescription({
      type: "answer",
      sdp: result.transport.sdp,
    });
    // The HTTP request started this session. Do not send session.start here.
    setState("thinking", "Almost ready…");
  } catch (error) {
    console.warn("Start failed", error);
    showError(error && error.userFacing ? error.message : UNAVAILABLE_MESSAGE);
    cleanup();
  }
}

function endSession() {
  if (!ready || !events || events.readyState !== "open") return;
  clearIdleTimer();
  endBtn.disabled = true;
  if (!endedForIdle) {
    setState("thinking", "Wrapping up…");
  }
  sendEvent({ type: "session.close" });
  closeTimeout = setTimeout(() => {
    setState(
      "idle",
      endedForIdle
        ? "Ended after a minute of quiet. Tap Ask PearsonAssist anytime."
        : "Conversation ended. Tap Ask PearsonAssist to start again."
    );
    endedForIdle = false;
    cleanup();
  }, 15_000);
}

startBtn.addEventListener("click", () => {
  // Unlock phone audio synchronously inside the tap, before the mic prompt or network.
  unlockAudio();
  void startSession();
});

soundBtn.addEventListener("click", () => {
  retrySoundFromGesture();
});

endBtn.addEventListener("click", () => {
  endSession();
});

clearTranscriptBtn.addEventListener("click", () => {
  openTurns.clear();
  transcriptEl.innerHTML = "";
});
