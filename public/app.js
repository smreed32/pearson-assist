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

/** @type {Map<string, { el: HTMLElement, text: string }>} */
const openTurns = new Map();

/** Pending function calls keyed by call_id within a delegation */
/** @type {Map<string, Set<string>>} */
const pendingCallsByDelegation = new Map();

const STATE_LABELS = {
  idle: "ready",
  listening: "listening",
  thinking: "thinking",
  researching: "researching",
  speaking: "speaking",
  error: "error",
};

function setState(state, detail) {
  statusChip.dataset.state = state;
  statusChip.textContent = STATE_LABELS[state] || state;
  if (typeof detail === "string") {
    statusDetail.textContent = detail;
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

function setResearching(active, label = "Checking pearsonpkg.com…") {
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
    setState("thinking", "Ending after a minute of quiet…");
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
        title: item.title || item.headline || "Untitled",
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
    emptyTitle.textContent = "No pearsonpkg.com sources";
    const emptyCopy = document.createElement("p");
    emptyCopy.className = "empty-copy";
    emptyCopy.textContent =
      "No on-site sources came back for that question. Try another topic, browse pearsonpkg.com, or call +1 (509) 838-6226.";
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
      setResearching(true, "Checking pearsonpkg.com…");
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
      setState(
        "listening",
        "Connected. Ask PearsonAssist about Pearson Packaging Systems."
      );
      clearError();
      armIdleTimer();
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
      setState("speaking");
      clearIdleTimer();
      break;

    case "session.output_transcript.done":
      finalizeTurn(`assistant:${event.item_id || "live"}`);
      setState("listening", "Listening… ask about Pearson products, service, or parts.");
      armIdleTimer();
      break;

    case "session.delegation.created":
      setResearching(true, "Checking pearsonpkg.com…");
      clearIdleTimer();
      break;

    case "session.commentary.append":
    case "session.commentary.appended":
      setResearching(true, "Gathering pages from pearsonpkg.com…");
      clearIdleTimer();
      break;

    case "session.thinking.append":
    case "session.thinking.appended":
      setResearching(true, "Reviewing site results…");
      setState("thinking");
      clearIdleTimer();
      break;

    case "response.event":
      handleNestedResponseEvent(event);
      break;

    case "error":
      showError(event.error?.message || event.message || "Session error");
      break;

    default: {
      const type = String(event.type || "");
      if (type.startsWith("session.delegation.")) {
        setResearching(true, "Still checking pearsonpkg.com…");
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
      reject(new Error("Timed out while gathering ICE candidates"));
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
  setState("thinking", "Connecting PearsonAssist…");

  try {
    const connection = new RTCPeerConnection();
    peer = connection;

    connection.addEventListener("track", (event) => {
      remoteAudio.srcObject = new MediaStream([event.track]);
      remoteAudio.classList.add("visible");
      remoteAudio.play().catch(() => {
        statusDetail.textContent =
          "Select play on the audio controls to hear PearsonAssist.";
      });
    });

    try {
      microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err && typeof err === "object" ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new Error(
          "Microphone permission denied. Allow mic access and try Start again."
        );
      }
      if (name === "NotFoundError") {
        throw new Error("No microphone found on this device.");
      }
      throw new Error(
        err instanceof Error ? err.message : "Could not access the microphone."
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
        setState("idle", "Disconnected. Tap Ask PearsonAssist to begin again.");
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
      throw new Error("Network failure talking to the local session server.");
    }

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.error || JSON.stringify(body);
      } catch {
        detail = await response.text();
      }
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
    const message = error instanceof Error ? error.message : String(error);
    showError(message);
    cleanup();
  }
}

function endSession() {
  if (!ready || !events || events.readyState !== "open") return;
  clearIdleTimer();
  endBtn.disabled = true;
  if (!endedForIdle) {
    setState("thinking", "Ending session…");
  }
  sendEvent({ type: "session.close" });
  closeTimeout = setTimeout(() => {
    setState(
      "idle",
      endedForIdle
        ? "Ended after a minute of quiet. Tap Ask PearsonAssist anytime."
        : "Session closed. You can start again anytime."
    );
    endedForIdle = false;
    cleanup();
  }, 15_000);
}

startBtn.addEventListener("click", () => {
  void startSession();
});

endBtn.addEventListener("click", () => {
  endSession();
});

clearTranscriptBtn.addEventListener("click", () => {
  openTurns.clear();
  transcriptEl.innerHTML = "";
});
