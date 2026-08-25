// Network capture provider for FPBrowser2API extension.
// Captures fetch/XMLHttpRequest/sendBeacon traffic from the page context and keeps
// a DevTools-like in-memory log in the extension service worker.

const DEFAULT_METHODS = ["GET", "POST", "PATCH"];
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_BODY_CHARS = 60000;

let capture = {
  sessionId: "",
  running: false,
  paused: false,
  tabId: null,
  targetUrl: "",
  targetOrigin: "",
  methods: new Set(DEFAULT_METHODS),
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxBodyChars: DEFAULT_MAX_BODY_CHARS,
  events: [],
  seq: 0,
  startedAt: null,
  updatedAt: null,
  lastError: "",
  includeWebRequestMeta: true
};

let webRequestInstalled = false;
const webRequests = new Map();

let debuggerEventsInstalled = false;
let debuggerAttachedTabId = null;
const cdpRequests = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeMethods(methods) {
  const arr = Array.isArray(methods) && methods.length ? methods : DEFAULT_METHODS;
  const out = arr.map(x => String(x || "").trim().toUpperCase()).filter(Boolean);
  return new Set(out.length ? out : DEFAULT_METHODS);
}

function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch (_) {}
  return "";
}

function originOf(raw) {
  try { return new URL(raw).origin; } catch (_) { return ""; }
}

function pathOf(raw) {
  try {
    const u = new URL(raw);
    return `${u.pathname || "/"}${u.search || ""}`;
  } catch (_) {
    return String(raw || "");
  }
}

function methodAllowed(method) {
  return capture.methods.has(String(method || "GET").toUpperCase());
}

function clipString(value, maxChars = capture.maxBodyChars) {
  if (value === null || value === undefined) return "";
  let s;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch (_) {
    s = String(value);
  }
  const max = Math.max(1000, Number(maxChars || DEFAULT_MAX_BODY_CHARS));
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function headersArrayToObject(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    const name = String(h && h.name || "").trim();
    if (!name) continue;
    const value = String(h && h.value || "");
    if (Object.prototype.hasOwnProperty.call(out, name)) out[name] = `${out[name]}, ${value}`;
    else out[name] = value;
  }
  return out;
}

function trimWebRequests() {
  const cutoff = Date.now() - 2 * 60 * 1000;
  for (const [rid, meta] of webRequests.entries()) {
    if (Number(meta.last_seen_ms || meta.start_ms || 0) < cutoff) webRequests.delete(rid);
  }
  if (webRequests.size > 2000) {
    const rows = Array.from(webRequests.entries()).sort((a, b) => Number(a[1].last_seen_ms || 0) - Number(b[1].last_seen_ms || 0));
    for (const [rid] of rows.slice(0, Math.max(0, rows.length - 1500))) webRequests.delete(rid);
  }
}

function trimCdpRequests() {
  const cutoff = Date.now() - 2 * 60 * 1000;
  for (const [rid, meta] of cdpRequests.entries()) {
    if (Number(meta.last_seen_ms || meta.start_ms || 0) < cutoff) cdpRequests.delete(rid);
  }
  if (cdpRequests.size > 2000) {
    const rows = Array.from(cdpRequests.entries()).sort((a, b) => Number(a[1].last_seen_ms || 0) - Number(b[1].last_seen_ms || 0));
    for (const [rid] of rows.slice(0, Math.max(0, rows.length - 1500))) cdpRequests.delete(rid);
  }
}

const SKIP_WEB_REQUEST_TYPES = new Set(["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "media", "object", "object_subrequest"]);

function shouldTrackWebRequest(details) {
  if (!capture.running || capture.paused || !capture.includeWebRequestMeta) return false;
  if (capture.tabId !== null && Number(details.tabId) !== Number(capture.tabId)) return false;
  if (details.type && SKIP_WEB_REQUEST_TYPES.has(String(details.type).toLowerCase())) return false;
  return methodAllowed(details.method);
}

function ensureWebMeta(details) {
  let meta = webRequests.get(details.requestId);
  if (!meta) {
    meta = {
      request_id: details.requestId,
      tab_id: details.tabId,
      frame_id: details.frameId,
      type: details.type || "",
      method: String(details.method || "GET").toUpperCase(),
      url: details.url || "",
      start_ms: Number(details.timeStamp || Date.now()),
      last_seen_ms: Date.now()
    };
    webRequests.set(details.requestId, meta);
  }
  meta.last_seen_ms = Date.now();
  return meta;
}

const IMAGE_DATA_URL_RE = /\bdata:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]{1000,})/gi;
const BARE_BASE64_RE = /^[A-Za-z0-9+/]{1000,}={0,2}$/;
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]+$/i;
function isImageBase64Field(key) {
  const k = String(key || "").toLowerCase();
  return k === "b64_json" ||
    k === "image_b64" ||
    k === "image_base64" ||
    k === "base64_image" ||
    k === "image_data" ||
    k === "base64data" ||
    k === "base64_data" ||
    k === "encodedimage" ||
    k === "encoded_image" ||
    k.endsWith("_image_b64") ||
    k.endsWith("_image_base64") ||
    k.endsWith("_base64data") ||
    k.endsWith("_base64_data");
}
function redactBareImageBase64(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  return BARE_BASE64_RE.test(compact) ? `[base64 ~${compact.length} chars]` : value;
}
function redactImageBase64Value(value, key = "") {
  if (typeof value === "string") {
    const withDataUrls = value.replace(IMAGE_DATA_URL_RE, (m, b64) => m.slice(0, m.length - b64.length) + `[base64 ~${b64.replace(/\s+/g, "").length} chars]`);
    if (withDataUrls === value && isImageBase64Field(key)) return redactBareImageBase64(value);
    return withDataUrls;
  }
  if (Array.isArray(value)) {
    const out = value.map(v => redactImageBase64Value(v, key));
    for (let i = 0; i < out.length - 1; i += 1) {
      if (typeof out[i] === "string" && IMAGE_MIME_RE.test(out[i]) && typeof out[i + 1] === "string") {
        out[i + 1] = redactBareImageBase64(out[i + 1]);
      }
    }
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactImageBase64Value(v, k);
    return out;
  }
  return value;
}
function redactImageBase64(text) {
  const s = String(text || "");
  const replaced = s.replace(IMAGE_DATA_URL_RE, (m, b64) => m.slice(0, m.length - b64.length) + `[base64 ~${b64.replace(/\s+/g, "").length} chars]`);
  if (replaced !== s) return replaced;
  try {
    const parsed = JSON.parse(s);
    const redacted = redactImageBase64Value(parsed);
    return JSON.stringify(redacted);
  } catch (_) {
    return s;
  }
}

function decodeRequestBody(requestBody) {
  if (!requestBody) return "";
  try {
    if (requestBody.formData && typeof requestBody.formData === "object") {
      return clipString(redactImageBase64(JSON.stringify(requestBody.formData)));
    }
    if (Array.isArray(requestBody.raw) && requestBody.raw.length) {
      const parts = [];
      for (const item of requestBody.raw) {
        if (item && item.bytes) {
          try { parts.push(new TextDecoder("utf-8", { fatal: false }).decode(item.bytes)); }
          catch (_) { parts.push(`[binary ${item.bytes.byteLength || 0} bytes]`); }
        }
      }
      return clipString(redactImageBase64(parts.join("")));
    }
    if (requestBody.error) return `[requestBody error] ${requestBody.error}`;
  } catch (e) {
    return `[requestBody decode failed] ${String(e && e.message || e)}`;
  }
  return "";
}

function debuggerTarget(tabId = capture.tabId) {
  if (tabId === null || tabId === undefined) return null;
  return { tabId: Number(tabId) };
}

function sendDebuggerCommand(tabId, method, params = {}) {
  const target = debuggerTarget(tabId);
  if (!target || !chrome.debugger) return Promise.reject(new Error("debugger API unavailable"));
  return new Promise((resolve, reject) => {
    try {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve(result || {});
      });
    } catch (e) {
      reject(e);
    }
  });
}

function decodeCdpBody(bodyText, base64Encoded) {
  if (!base64Encoded) return String(bodyText || "");
  try {
    const bin = atob(String(bodyText || ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (_) {
    return String(bodyText || "");
  }
}

function shouldTrackCdpMeta(meta) {
  if (!capture.running || capture.paused) return false;
  if (!meta || !meta.url) return false;
  if (capture.tabId !== null && debuggerAttachedTabId !== null && Number(debuggerAttachedTabId) !== Number(capture.tabId)) return false;
  if (meta.type && SKIP_WEB_REQUEST_TYPES.has(String(meta.type).toLowerCase())) return false;
  return methodAllowed(meta.method);
}

function findBestCdpMeta(event) {
  if (!event || !event.url) return null;
  const method = String(event.method || "GET").toUpperCase();
  const startMs = Number(event.start_epoch_ms || 0) || 0;
  const endMs = Number(event.end_epoch_ms || Date.now()) || Date.now();
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const meta of cdpRequests.values()) {
    if (String(meta.method || "").toUpperCase() !== method) continue;
    if (String(meta.url || "") !== String(event.url || "")) continue;
    const ms = Number(meta.start_ms || 0);
    if (startMs && (ms < startMs - 5000 || ms > endMs + 5000)) continue;
    const score = Math.abs(ms - (startMs || endMs));
    if (score < bestScore) {
      bestScore = score;
      best = meta;
    }
  }
  return best;
}

function cdpMetaToEvent(meta, webMeta = null) {
  const startMs = Number((webMeta && webMeta.start_ms) || meta.start_ms || 0) || Date.now();
  const endMs = Number((webMeta && webMeta.completed_ms) || meta.end_ms || Date.now()) || Date.now();
  return {
    id: `debugger-${meta.request_id || Date.now()}`,
    source: "debugger",
    method: String(meta.method || (webMeta && webMeta.method) || "GET").toUpperCase(),
    url: meta.url || (webMeta && webMeta.url) || "",
    path: pathOf(meta.url || (webMeta && webMeta.url) || ""),
    status: Number(meta.status || (webMeta && webMeta.status) || 0) || 0,
    ok: Number(meta.status || (webMeta && webMeta.status) || 0) >= 200 && Number(meta.status || (webMeta && webMeta.status) || 0) < 400,
    duration_ms: Math.max(0, endMs - startMs),
    started_at: new Date(startMs).toISOString(),
    completed_at: new Date(endMs).toISOString(),
    start_epoch_ms: startMs,
    end_epoch_ms: endMs,
    request_headers: meta.request_headers || (webMeta && webMeta.request_headers) || {},
    request_payload: clipString(meta.request_body || (webMeta && webMeta.request_body) || ""),
    response_headers: meta.response_headers || (webMeta && webMeta.response_headers) || {},
    response_body: clipString(meta.response_body || ""),
    response_type: String(meta.mime_type || ""),
    error: meta.error || "",
    initiator_stack: meta.initiator_stack || "",
    web_request_id: webMeta && webMeta.request_id || "",
    tab_id: (webMeta && webMeta.tab_id) || capture.tabId,
    frame_url: "",
    session_id: capture.sessionId,
    resource_type: meta.type || (webMeta && webMeta.type) || "fetch/xhr",
  };
}

function installWebRequestListeners() {
  if (webRequestInstalled) return;
  if (!chrome.webRequest) return;
  webRequestInstalled = true;
  const filter = { urls: ["<all_urls>"] };

  try {
    chrome.webRequest.onBeforeRequest.addListener((details) => {
      if (!shouldTrackWebRequest(details)) return;
      const meta = ensureWebMeta(details);
      meta.request_body = decodeRequestBody(details.requestBody);
      trimWebRequests();
    }, filter, ["requestBody"]);
  } catch (_) {
    try {
      chrome.webRequest.onBeforeRequest.addListener((details) => {
        if (!shouldTrackWebRequest(details)) return;
        ensureWebMeta(details);
        trimWebRequests();
      }, filter);
    } catch (__) {}
  }

  const addHeaderListener = (event, fn, specs) => {
    try { event.addListener(fn, filter, specs); }
    catch (_) {
      try { event.addListener(fn, filter, specs.filter(x => x !== "extraHeaders")); } catch (__) {}
    }
  };

  addHeaderListener(chrome.webRequest.onBeforeSendHeaders, (details) => {
    if (!shouldTrackWebRequest(details)) return;
    const meta = ensureWebMeta(details);
    meta.request_headers = headersArrayToObject(details.requestHeaders || []);
  }, ["requestHeaders", "extraHeaders"]);

  addHeaderListener(chrome.webRequest.onHeadersReceived, (details) => {
    if (!shouldTrackWebRequest(details)) return;
    const meta = ensureWebMeta(details);
    meta.status = Number(details.statusCode || 0) || 0;
    meta.response_headers = headersArrayToObject(details.responseHeaders || []);
  }, ["responseHeaders", "extraHeaders"]);

  chrome.webRequest.onCompleted.addListener((details) => {
    if (!shouldTrackWebRequest(details)) return;
    const meta = ensureWebMeta(details);
    meta.status = Number(details.statusCode || 0) || meta.status || 0;
    meta.from_cache = !!details.fromCache;
    meta.ip = details.ip || "";
    meta.completed_ms = Number(details.timeStamp || Date.now());
    // Fallback: if the page-inject layer never emitted this request, synthesize it
    // after a short delay (page emit typically arrives within 200ms of completion).
    setTimeout(() => {
      if (meta.page_emitted) return;
      if (!capture.running || capture.paused) return;
      if (capture.tabId !== null && Number(meta.tab_id) !== Number(capture.tabId)) return;
      const startMs = Number(meta.start_ms || 0);
      const endMs = Number(meta.completed_ms || Date.now());
      const ev = {
        id: `webrequest-${meta.request_id}`,
        source: "webRequest",
        method: String(meta.method || "GET").toUpperCase(),
        url: meta.url || "",
        path: pathOf(meta.url || ""),
        status: meta.status || 0,
        ok: meta.status >= 200 && meta.status < 400,
        duration_ms: Math.max(0, endMs - startMs),
        started_at: new Date(startMs).toISOString(),
        completed_at: new Date(endMs).toISOString(),
        start_epoch_ms: startMs,
        end_epoch_ms: endMs,
        request_headers: meta.request_headers || {},
        request_payload: clipString(meta.request_body || ""),
        response_headers: meta.response_headers || {},
        response_body: meta.cdp_response_body || "[not available via webRequest API]",
        response_type: meta.cdp_mime_type || "",
        error: meta.error || "",
        initiator_stack: (() => {
          const cdp = findBestCdpMeta({ method: meta.method, url: meta.url, start_epoch_ms: startMs, end_epoch_ms: endMs });
          return (cdp && cdp.initiator_stack) || "";
        })(),
        web_request_id: meta.request_id || "",
        from_cache: !!meta.from_cache,
        ip: meta.ip || "",
        tab_id: meta.tab_id,
        frame_url: "",
        session_id: capture.sessionId,
        resource_type: meta.type || "fetch/xhr",
      };
      if (meta.cdp_response_body) meta.cdp_body_used_by_fallback = true;
      const pushed = pushEvent(ev, { tab: { id: meta.tab_id } });
      if (pushed && pushed.seq) meta.fallback_seq = pushed.seq;
    }, 500);
  }, filter);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    if (!shouldTrackWebRequest(details)) return;
    const meta = ensureWebMeta(details);
    meta.error = details.error || "network error";
    meta.completed_ms = Number(details.timeStamp || Date.now());
    setTimeout(() => {
      if (meta.page_emitted) return;
      if (!capture.running || capture.paused) return;
      if (capture.tabId !== null && Number(meta.tab_id) !== Number(capture.tabId)) return;
      const startMs = Number(meta.start_ms || 0);
      const endMs = Number(meta.completed_ms || Date.now());
      const ev = {
        id: `webrequest-err-${meta.request_id}`,
        source: "webRequest",
        method: String(meta.method || "GET").toUpperCase(),
        url: meta.url || "",
        path: pathOf(meta.url || ""),
        status: 0,
        ok: false,
        duration_ms: Math.max(0, endMs - startMs),
        started_at: new Date(startMs).toISOString(),
        completed_at: new Date(endMs).toISOString(),
        start_epoch_ms: startMs,
        end_epoch_ms: endMs,
        request_headers: meta.request_headers || {},
        request_payload: clipString(meta.request_body || ""),
        response_headers: {},
        response_body: "",
        response_type: "",
        error: meta.error || "network error",
        initiator_stack: (() => {
          const cdp = findBestCdpMeta({ method: meta.method, url: meta.url, start_epoch_ms: startMs, end_epoch_ms: endMs });
          return (cdp && cdp.initiator_stack) || "";
        })(),
        web_request_id: meta.request_id || "",
        from_cache: false,
        ip: "",
        tab_id: meta.tab_id,
        frame_url: "",
        session_id: capture.sessionId,
        resource_type: meta.type || "fetch/xhr",
      };
      pushEvent(ev, { tab: { id: meta.tab_id } });
    }, 500);
  }, filter);
}

function installDebuggerListeners() {
  if (debuggerEventsInstalled || !chrome.debugger) return;
  debuggerEventsInstalled = true;

  chrome.debugger.onEvent.addListener((source, method, params) => {
    handleDebuggerEvent(source, method, params || {}).catch((e) => {
      capture.lastError = `debugger event failed: ${String(e && e.message || e)}`;
    });
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (!source || Number(source.tabId) !== Number(debuggerAttachedTabId)) return;
    debuggerAttachedTabId = null;
    cdpRequests.clear();
    if (capture.running) capture.lastError = `debugger detached: ${reason || "unknown"}`;
  });
}

async function attachDebugger(tabId) {
  installDebuggerListeners();
  if (!chrome.debugger) {
    capture.lastError = "debugger API unavailable";
    return false;
  }
  if (debuggerAttachedTabId !== null && Number(debuggerAttachedTabId) === Number(tabId)) return true;
  if (debuggerAttachedTabId !== null) await detachDebugger();

  const target = debuggerTarget(tabId);
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach(target, "1.3", () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve();
      });
    });
    debuggerAttachedTabId = Number(tabId);
    await sendDebuggerCommand(tabId, "Network.enable", {
      maxTotalBufferSize: 200 * 1024 * 1024,
      maxResourceBufferSize: 20 * 1024 * 1024,
    });
    // Enable async call stack capture so V8 records cross-Promise/async initiator
    // chains even without DevTools open. Without this, new Error().stack in the
    // page context only produces a single frame.
    await sendDebuggerCommand(tabId, "Runtime.setAsyncCallStackDepth", { maxDepth: 32 }).catch(() => {});
    return true;
  } catch (e) {
    debuggerAttachedTabId = null;
    capture.lastError = `debugger attach failed: ${String(e && e.message || e)}`;
    return false;
  }
}

async function detachDebugger() {
  if (!chrome.debugger || debuggerAttachedTabId === null) return;
  const tabId = debuggerAttachedTabId;
  debuggerAttachedTabId = null;
  try {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => resolve());
    });
  } catch (_) {}
  cdpRequests.clear();
}

function upsertCdpRequest(requestId) {
  const rid = String(requestId || "");
  if (!rid) return null;
  let meta = cdpRequests.get(rid);
  if (!meta) {
    meta = {
      request_id: rid,
      method: "GET",
      url: "",
      start_ms: Date.now(),
      last_seen_ms: Date.now(),
    };
    cdpRequests.set(rid, meta);
  }
  meta.last_seen_ms = Date.now();
  return meta;
}

async function handleDebuggerEvent(source, method, params) {
  if (!source || Number(source.tabId) !== Number(debuggerAttachedTabId)) return;
  if (!capture.running || capture.paused) return;

  if (method === "Network.requestWillBeSent") {
    const req = params.request || {};
    const meta = upsertCdpRequest(params.requestId);
    if (!meta) return;
    meta.method = String(req.method || meta.method || "GET").toUpperCase();
    meta.url = String(req.url || meta.url || "");
    meta.start_ms = Number(params.wallTime ? params.wallTime * 1000 : 0) || Date.now();
    meta.request_headers = req.headers || {};
    meta.request_body = redactImageBase64(req.postData || "");
    meta.type = params.type || meta.type || "";
    // Extract JS call stack from CDP initiator
    const initiator = params.initiator || {};
    if (initiator.stack && Array.isArray(initiator.stack.callFrames)) {
      meta.initiator_stack = initiator.stack.callFrames
        .map(f => `    at ${f.functionName || "(anonymous)"} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
        .join("\n");
    } else if (initiator.url) {
      meta.initiator_stack = `    at (${initiator.url}:${initiator.lineNumber || 0})`;
    } else {
      meta.initiator_stack = "";
    }
    trimCdpRequests();
    return;
  }

  if (method === "Network.responseReceived") {
    const resp = params.response || {};
    const meta = upsertCdpRequest(params.requestId);
    if (!meta) return;
    meta.url = String(resp.url || meta.url || "");
    meta.status = Number(resp.status || 0) || 0;
    meta.response_headers = resp.headers || {};
    meta.mime_type = resp.mimeType || "";
    meta.type = params.type || meta.type || "";
    return;
  }

  if (method === "Network.loadingFailed") {
    const meta = upsertCdpRequest(params.requestId);
    if (!meta) return;
    meta.end_ms = Date.now();
    meta.error = params.errorText || "network error";
    return;
  }

  if (method !== "Network.loadingFinished") return;
  const meta = upsertCdpRequest(params.requestId);
  if (!meta || !shouldTrackCdpMeta(meta)) return;
  meta.end_ms = Date.now();

  try {
    const body = await sendDebuggerCommand(source.tabId, "Network.getResponseBody", { requestId: meta.request_id });
    meta.response_body = clipString(redactImageBase64(decodeCdpBody(body.body || "", !!body.base64Encoded)));
  } catch (e) {
    meta.response_body = "";
  }

  const webMeta = findBestWebMeta({
    method: meta.method,
    url: meta.url,
    start_epoch_ms: meta.start_ms,
    end_epoch_ms: meta.end_ms || Date.now(),
  }, source.tabId);
  if (webMeta) {
    webMeta.cdp_response_body = meta.response_body;
    webMeta.cdp_mime_type = meta.mime_type || "";
    webMeta.response_headers = Object.keys(webMeta.response_headers || {}).length ? webMeta.response_headers : (meta.response_headers || {});
  }

  setTimeout(() => {
    if (!capture.running || capture.paused) return;
    if (!shouldTrackCdpMeta(meta)) return;
    const latestWebMeta = webMeta || findBestWebMeta({
      method: meta.method,
      url: meta.url,
      start_epoch_ms: meta.start_ms,
      end_epoch_ms: meta.end_ms || Date.now(),
    }, source.tabId);
    if (latestWebMeta && latestWebMeta.page_layer_emitted) return;
    if (latestWebMeta && latestWebMeta.cdp_body_used_by_fallback) return;
    if (meta.debugger_emitted) return;
    meta.debugger_emitted = true;
    pushEvent(cdpMetaToEvent(meta, latestWebMeta), { tab: { id: source.tabId } });
  }, 800);
}

function findBestWebMeta(event, tabId) {
  if (!event || !event.url) return null;
  const method = String(event.method || "GET").toUpperCase();
  const startMs = Number(event.start_epoch_ms || 0) || 0;
  const endMs = Number(event.end_epoch_ms || Date.now()) || Date.now();
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const meta of webRequests.values()) {
    if (Number(meta.tab_id) !== Number(tabId)) continue;
    if (String(meta.method || "").toUpperCase() !== method) continue;
    if (String(meta.url || "") !== String(event.url || "")) continue;
    const ms = Number(meta.start_ms || 0);
    if (startMs && (ms < startMs - 5000 || ms > endMs + 5000)) continue;
    const score = Math.abs(ms - (startMs || endMs));
    if (score < bestScore) {
      bestScore = score;
      best = meta;
    }
  }
  return best;
}

function sanitizeEvent(raw, sender) {
  const event = raw && typeof raw === "object" ? { ...raw } : {};
  const tabId = sender && sender.tab && sender.tab.id !== undefined ? Number(sender.tab.id) : capture.tabId;
  const webMeta = findBestWebMeta(event, tabId);
  const cdpMeta = findBestCdpMeta(event);
  const method = String(event.method || (webMeta && webMeta.method) || "GET").toUpperCase();
  const url = String(event.url || (webMeta && webMeta.url) || "");
  const responseHeaders = event.response_headers && Object.keys(event.response_headers || {}).length ? event.response_headers : (webMeta && webMeta.response_headers) || (cdpMeta && cdpMeta.response_headers) || {};
  const requestHeaders = event.request_headers && Object.keys(event.request_headers || {}).length ? event.request_headers : (webMeta && webMeta.request_headers) || {};
  const requestPayload = event.request_payload || (webMeta && webMeta.request_body) || "";
  const responseBody = event.response_body || (webMeta && webMeta.cdp_response_body) || (cdpMeta && cdpMeta.response_body) || "";
  return {
    seq: ++capture.seq,
    id: String(event.id || `${Date.now()}-${capture.seq}`),
    session_id: capture.sessionId,
    tab_id: tabId,
    frame_url: clipString(event.frame_url || "", 2000),
    source: String(event.source || "page"),
    resource_type: String(event.resource_type || (webMeta && webMeta.type) || "fetch/xhr"),
    method,
    url,
    origin: originOf(url),
    path: event.path || pathOf(url),
    status: Number(event.status || (webMeta && webMeta.status) || 0) || 0,
    ok: event.ok === undefined ? undefined : !!event.ok,
    duration_ms: Number(event.duration_ms || 0) || 0,
    started_at: event.started_at || nowIso(),
    completed_at: event.completed_at || nowIso(),
    start_epoch_ms: Number(event.start_epoch_ms || 0) || undefined,
    end_epoch_ms: Number(event.end_epoch_ms || 0) || undefined,
    request_headers: requestHeaders || {},
    request_payload: clipString(requestPayload),
    response_headers: responseHeaders || {},
    response_body: clipString(responseBody),
    response_type: String(event.response_type || (webMeta && webMeta.cdp_mime_type) || (cdpMeta && cdpMeta.mime_type) || ""),
    error: clipString(event.error || (webMeta && webMeta.error) || "", 4000),
    initiator_stack: clipString(event.initiator_stack || "", 20000),
    web_request_id: webMeta && webMeta.request_id || "",
    from_cache: !!(webMeta && webMeta.from_cache),
    ip: webMeta && webMeta.ip || ""
  };
}

function pushEvent(raw, sender) {
  if (!capture.running || capture.paused) return { ok: true, ignored: true, reason: "not_running_or_paused" };
  const ev = sanitizeEvent(raw, sender);
  if (!methodAllowed(ev.method)) return { ok: true, ignored: true, reason: "method_filtered" };
  if (capture.tabId !== null && ev.tab_id !== null && Number(ev.tab_id) !== Number(capture.tabId)) {
    return { ok: true, ignored: true, reason: "tab_filtered" };
  }
  // Mark the webRequest meta as emitted so the fallback timer won't duplicate it
  if (ev.web_request_id) {
    const wm = webRequests.get(ev.web_request_id);
    if (wm) {
      wm.page_emitted = true;
      if (ev.source === "webRequest") wm.fallback_emitted = true;
      else wm.page_layer_emitted = true;
    }
  } else if (ev.url) {
    // Best-effort: mark by URL+method match for cases where web_request_id isn't set
    for (const wm of webRequests.values()) {
      if (String(wm.url || "") === ev.url && String(wm.method || "").toUpperCase() === ev.method) {
        wm.page_emitted = true;
        if (ev.source === "webRequest") wm.fallback_emitted = true;
        else wm.page_layer_emitted = true;
        break;
      }
    }
  }
  if ((raw.update_existing || raw.partial_update || raw.replace_existing) && ev.id) {
    const idx = capture.events.findIndex(x => x && x.id === ev.id && Number(x.tab_id) === Number(ev.tab_id));
    if (idx !== -1) {
      ev.seq = capture.events[idx].seq;
      capture.events[idx] = { ...capture.events[idx], ...ev };
      capture.updatedAt = nowIso();
      return { ok: true, seq: ev.seq, updated: true };
    }
  }
  capture.events.push(ev);
  const max = Math.max(100, Number(capture.maxEntries || DEFAULT_MAX_ENTRIES));
  if (capture.events.length > max) capture.events.splice(0, capture.events.length - max);
  capture.updatedAt = nowIso();
  return { ok: true, seq: ev.seq };
}

function getStatus() {
  const counts = { total: capture.events.length, GET: 0, POST: 0, PATCH: 0, errors: 0 };
  for (const ev of capture.events) {
    const m = String(ev.method || "").toUpperCase();
    if (Object.prototype.hasOwnProperty.call(counts, m)) counts[m] += 1;
    if (ev.error || (Number(ev.status || 0) >= 400)) counts.errors += 1;
  }
  return {
    success: true,
    running: capture.running,
    paused: capture.paused,
    session_id: capture.sessionId,
    tab_id: capture.tabId,
    target_url: capture.targetUrl,
    target_origin: capture.targetOrigin,
    started_at: capture.startedAt,
    updated_at: capture.updatedAt,
    last_error: capture.lastError,
    seq: capture.seq,
    count: capture.events.length,
    counts
  };
}

async function getActiveHttpTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (tab && tab.id && /^https?:\/\//i.test(tab.url || "")) return tab;
  const all = await chrome.tabs.query({});
  return all.find(t => t.id && /^https?:\/\//i.test(t.url || "")) || null;
}

async function findOrOpenTargetTab(targetUrl, { active = true, navigate = true } = {}) {
  const target = normalizeUrl(targetUrl);
  if (!target) {
    const tab = await getActiveHttpTab();
    if (!tab || !tab.id) throw new Error("没有可注入的 http/https 标签页，请先打开目标页面");
    return tab.id;
  }
  const origin = originOf(target);
  const tabs = await chrome.tabs.query({});
  let found = tabs.find(t => t.id && (t.url || "") === target);
  if (!found && origin) found = tabs.find(t => t.id && String(t.url || "").startsWith(origin + "/"));
  if (found && found.id) {
    if (navigate && found.url !== target) await chrome.tabs.update(found.id, { url: target, active });
    else if (active) await chrome.tabs.update(found.id, { active: true });
    return found.id;
  }
  const tab = await chrome.tabs.create({ url: target, active });
  if (!tab || !tab.id) throw new Error("打开目标标签页失败");
  return tab.id;
}

async function waitForTabReady(tabId, timeoutMs = 15000) {
  const end = Date.now() + Math.max(1000, Number(timeoutMs || 15000));
  while (Date.now() < end) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && /^https?:\/\//i.test(tab.url || "") && (tab.status === "complete" || tab.status === "loading")) return tab;
    } catch (_) {}
    await sleep(250);
  }
  return await chrome.tabs.get(tabId);
}

function installNetworkCaptureBridge(config) {
  try {
    window.__FPB_NETWORK_CAPTURE_BRIDGE_CONFIG__ = Object.assign({}, window.__FPB_NETWORK_CAPTURE_BRIDGE_CONFIG__ || {}, config || {});
    if (window.__FPB_NETWORK_CAPTURE_BRIDGE_INSTALLED__) return { ok: true, reused: true };
    window.__FPB_NETWORK_CAPTURE_BRIDGE_INSTALLED__ = true;
    window.addEventListener("message", (ev) => {
      try {
        if (ev.source !== window) return;
        const data = ev.data || {};
        if (!data || data.source !== "fpb-network-capture" || !data.event) return;
        chrome.runtime.sendMessage({ type: "fpb.networkCapture.event", event: data.event }, () => void chrome.runtime.lastError);
      } catch (_) {}
    }, false);
    return { ok: true, installed: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function installMainWorldCapture(config) {
  const CFG_KEY = "__FPB_NETWORK_CAPTURE_CONFIG__";
  const ORIG_KEY = "__FPB_NETWORK_CAPTURE_ORIGINALS__";
  const MARK = "__FPB_NETWORK_CAPTURE_INSTALLED__";
  const cfg = Object.assign({
    enabled: true,
    paused: false,
    sessionId: "",
    methods: ["GET", "POST", "PATCH"],
    maxBodyChars: 60000
  }, window[CFG_KEY] || {}, config || {});
  cfg.methods = (Array.isArray(cfg.methods) && cfg.methods.length ? cfg.methods : ["GET", "POST", "PATCH"]).map(x => String(x || "").toUpperCase());
  window[CFG_KEY] = cfg;

  function iso() { return new Date().toISOString(); }
  const imageDataUrlRe = /\bdata:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]{1000,})/gi;
  const bareBase64Re = /^[A-Za-z0-9+/]{1000,}={0,2}$/;
  const imageMimeRe = /^image\/[a-z0-9.+-]+$/i;
  function isImageBase64Field(key) {
    const k = String(key || "").toLowerCase();
    return k === "b64_json" ||
      k === "image_b64" ||
      k === "image_base64" ||
      k === "base64_image" ||
      k === "image_data" ||
      k === "base64data" ||
      k === "base64_data" ||
      k === "encodedimage" ||
      k === "encoded_image" ||
      k.endsWith("_image_b64") ||
      k.endsWith("_image_base64") ||
      k.endsWith("_base64data") ||
      k.endsWith("_base64_data");
  }
  function redactBareImageBase64(value) {
    const compact = String(value || "").replace(/\s+/g, "");
    return bareBase64Re.test(compact) ? "[base64 ~" + compact.length + " chars]" : value;
  }
  function redactImageBase64Value(value, key) {
    if (typeof value === "string") {
      const withDataUrls = value.replace(imageDataUrlRe, function(m, b64) {
        return m.slice(0, m.length - b64.length) + "[base64 ~" + b64.replace(/\s+/g, "").length + " chars]";
      });
      if (withDataUrls === value && isImageBase64Field(key)) return redactBareImageBase64(value);
      return withDataUrls;
    }
    if (Array.isArray(value)) {
      const out = value.map(function(v) { return redactImageBase64Value(v, key); });
      for (let i = 0; i < out.length - 1; i += 1) {
        if (typeof out[i] === "string" && imageMimeRe.test(out[i]) && typeof out[i + 1] === "string") {
          out[i + 1] = redactBareImageBase64(out[i + 1]);
        }
      }
      return out;
    }
    if (value && typeof value === "object") {
      const out = {};
      Object.keys(value).forEach(function(k) { out[k] = redactImageBase64Value(value[k], k); });
      return out;
    }
    return value;
  }
  function redactImageBase64(text) {
    const s = String(text || "");
    const replaced = s.replace(imageDataUrlRe, function(m, b64) {
      return m.slice(0, m.length - b64.length) + "[base64 ~" + b64.replace(/\s+/g, "").length + " chars]";
    });
    if (replaced !== s) return replaced;
    try {
      return JSON.stringify(redactImageBase64Value(JSON.parse(s), ""));
    } catch (_) {
      return s;
    }
  }
  function clip(value, maxChars) {
    if (value === null || value === undefined) return "";
    let s = "";
    try { s = typeof value === "string" ? value : JSON.stringify(value); } catch (_) { s = String(value); }
    const max = Math.max(1000, Number(maxChars || window[CFG_KEY].maxBodyChars || 60000));
    if (s.length <= max) return s;
    return s.slice(0, max) + "\n...[truncated " + (s.length - max) + " chars]";
  }
  function allowed(method) {
    const c = window[CFG_KEY] || {};
    if (!c.enabled || c.paused) return false;
    const ms = Array.isArray(c.methods) ? c.methods : ["GET", "POST", "PATCH"];
    return ms.includes(String(method || "GET").toUpperCase());
  }
  function pathOfLocal(url) {
    try { const u = new URL(String(url || ""), location.href); return (u.pathname || "/") + (u.search || ""); } catch (_) { return String(url || ""); }
  }
  function absUrl(url) {
    try { return new URL(String(url || ""), location.href).href; } catch (_) { return String(url || ""); }
  }
  function headersToObj(headers) {
    const out = {};
    try {
      if (!headers) return out;
      if (headers instanceof Headers) {
        headers.forEach((v, k) => { out[k] = v; });
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => { out[String(k)] = String(v); });
      } else if (typeof headers === "object") {
        Object.keys(headers).forEach(k => { out[k] = String(headers[k]); });
      }
    } catch (_) {}
    return out;
  }
  function parseRawHeaders(raw) {
    const out = {};
    try {
      String(raw || "").trim().split(/\r?\n/).forEach(line => {
        const i = line.indexOf(":");
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
    } catch (_) {}
    return out;
  }
  async function bodyPreview(body) {
    try {
      if (body === null || body === undefined) return "";
      if (typeof body === "string") return clip(redactImageBase64(body));
      if (body instanceof URLSearchParams) return clip(body.toString());
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const rows = [];
        body.forEach((v, k) => {
          if (typeof File !== "undefined" && v instanceof File) rows.push([k, `[File name=${v.name} type=${v.type} size=${v.size}]`]);
          else rows.push([k, String(v)]);
        });
        return clip(redactImageBase64(JSON.stringify(rows)));
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) {
        const txt = await body.slice(0, Number((window[CFG_KEY] || {}).maxBodyChars || 60000)).text();
        return clip(redactImageBase64(txt));
      }
      if (body instanceof ArrayBuffer) {
        if (body.byteLength > 500000) return `[ArrayBuffer ${body.byteLength} bytes, too large to preview]`;
        return clip(redactImageBase64(new TextDecoder("utf-8", { fatal: false }).decode(body)));
      }
      if (ArrayBuffer.isView(body)) {
        if (body.byteLength > 500000) return `[TypedArray ${body.byteLength} bytes, too large to preview]`;
        return clip(redactImageBase64(new TextDecoder("utf-8", { fatal: false }).decode(body)));
      }
      if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return "[ReadableStream]";
      return clip(body);
    } catch (e) {
      return `[body preview failed] ${String(e && e.message || e)}`;
    }
  }
  function emit(event) {
    try {
      const c = window[CFG_KEY] || {};
      event.session_id = c.sessionId || "";
      event.frame_url = location.href;
      window.postMessage({ source: "fpb-network-capture", event }, "*");
    } catch (_) {}
  }
  function stack() {
    try { throw new Error("FPB network initiator"); } catch (e) { return String(e && e.stack || ""); }
  }
  function mimicNativeToString(patchedFn, originalFn) {
    try {
      Object.defineProperty(patchedFn, "toString", {
        value: function toString() { return Function.prototype.toString.call(originalFn); },
        configurable: true
      });
    } catch (_) {}
  }
  function baseEvent(source, method, url, startedAtMs, startedIso, st) {
    const u = absUrl(url);
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      source,
      method: String(method || "GET").toUpperCase(),
      url: u,
      path: pathOfLocal(u),
      started_at: startedIso,
      start_epoch_ms: st || Date.now(),
      duration_ms: Math.max(0, Math.round((performance.now() - startedAtMs) * 10) / 10),
      completed_at: iso(),
      end_epoch_ms: Date.now()
    };
  }

  if (window[MARK]) return { ok: true, reused: true };
  window[MARK] = true;
  const orig = window[ORIG_KEY] || {};
  orig.fetch = orig.fetch || window.fetch;
  orig.xhrOpen = orig.xhrOpen || XMLHttpRequest.prototype.open;
  orig.xhrSend = orig.xhrSend || XMLHttpRequest.prototype.send;
  orig.xhrSetRequestHeader = orig.xhrSetRequestHeader || XMLHttpRequest.prototype.setRequestHeader;
  orig.sendBeacon = orig.sendBeacon || (navigator && navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null);
  window[ORIG_KEY] = orig;

  if (typeof orig.fetch === "function") {
    window.fetch = function fpbNetworkCaptureFetch(input, init) {
      let method = "GET";
      let url = "";
      let reqHeaders = {};
      let reqBody = null;
      try {
        if (typeof Request !== "undefined" && input instanceof Request) {
          method = (init && init.method) || input.method || "GET";
          url = input.url;
          reqHeaders = Object.assign({}, headersToObj(input.headers), headersToObj(init && init.headers));
          reqBody = init && Object.prototype.hasOwnProperty.call(init, "body") ? init.body : null;
        } else {
          method = (init && init.method) || "GET";
          url = String(input || "");
          reqHeaders = headersToObj(init && init.headers);
          reqBody = init && Object.prototype.hasOwnProperty.call(init, "body") ? init.body : null;
        }
      } catch (_) {}
      if (!allowed(method)) return orig.fetch.apply(this, arguments);

      const startedPerf = performance.now();
      const startedIso = iso();
      const startedEpoch = Date.now();
      const initiator = stack();
      const reqPayloadPromise = (async () => {
        if (reqBody !== null && reqBody !== undefined) return bodyPreview(reqBody);
        try {
          if (typeof Request !== "undefined" && input instanceof Request) return await input.clone().text();
        } catch (_) {}
        return "";
      })();
      return orig.fetch.apply(this, arguments).then((resp) => {
        Promise.resolve(reqPayloadPromise).then((requestPayload) => {
          const responseHeaders = headersToObj(resp && resp.headers);
          const eventBase = baseEvent("fetch", method, url, startedPerf, startedIso, startedEpoch);
          eventBase.status = resp && resp.status || 0;
          eventBase.ok = !!(resp && resp.ok);
          eventBase.response_type = resp && resp.type || "";
          eventBase.request_headers = reqHeaders;
          eventBase.request_payload = clip(requestPayload);
          eventBase.response_headers = responseHeaders;
          eventBase.initiator_stack = initiator;
          const ct = (responseHeaders["content-type"] || responseHeaders["Content-Type"] || "").toLowerCase();
          const isEventStream = ct.includes("text/event-stream");
          const bodyLocked = resp && resp.body && resp.body.locked;
          if (isEventStream || bodyLocked) {
            eventBase.response_body = isEventStream ? "[SSE stream]" : "[body already consumed by page]";
            emit(eventBase);
          } else {
            try {
              resp.clone().text().then((txt) => {
                eventBase.response_body = clip(redactImageBase64(txt));
                emit(eventBase);
              }).catch((e) => {
                eventBase.response_body = "";
                eventBase.error = `[response read failed] ${String(e && e.message || e)}`;
                emit(eventBase);
              });
            } catch (e) {
              eventBase.error = `[response clone failed] ${String(e && e.message || e)}`;
              emit(eventBase);
            }
          }
        });
        return resp;
      }).catch((e) => {
        Promise.resolve(reqPayloadPromise).then((requestPayload) => {
          const ev = baseEvent("fetch", method, url, startedPerf, startedIso, startedEpoch);
          ev.request_headers = reqHeaders;
          ev.request_payload = clip(requestPayload);
          ev.error = String(e && e.message || e);
          ev.initiator_stack = initiator;
          emit(ev);
        });
        throw e;
      });
    };
    try { Object.defineProperty(window.fetch, "name", { value: "fetch" }); } catch (_) {}
    mimicNativeToString(window.fetch, orig.fetch);
  }

  XMLHttpRequest.prototype.open = function fpbNetworkCaptureXhrOpen(method, url) {
    try {
      this.__fpbNetworkCapture = {
        event_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method: String(method || "GET").toUpperCase(),
        url: absUrl(url),
        request_headers: {},
        initiator_stack: stack(),
        last_stream_emit_ms: 0,
        last_stream_len: 0
      };
    } catch (_) {}
    return orig.xhrOpen.apply(this, arguments);
  };
  mimicNativeToString(XMLHttpRequest.prototype.open, orig.xhrOpen);

  XMLHttpRequest.prototype.setRequestHeader = function fpbNetworkCaptureXhrSetHeader(name, value) {
    try {
      if (this.__fpbNetworkCapture && name) this.__fpbNetworkCapture.request_headers[String(name)] = String(value);
    } catch (_) {}
    return orig.xhrSetRequestHeader.apply(this, arguments);
  };
  mimicNativeToString(XMLHttpRequest.prototype.setRequestHeader, orig.xhrSetRequestHeader);

  XMLHttpRequest.prototype.send = function fpbNetworkCaptureXhrSend(body) {
    const meta = this.__fpbNetworkCapture || { method: "GET", url: "" };
    if (!allowed(meta.method)) return orig.xhrSend.apply(this, arguments);
    const startedPerf = performance.now();
    const startedIso = iso();
    const startedEpoch = Date.now();
    const reqPayloadPromise = bodyPreview(body);
    const xhr = this;
    let emitted = false;
    function responseTextPreview() {
      try {
        if (!xhr.responseType || xhr.responseType === "text") return clip(redactImageBase64(xhr.responseText || ""));
        if (xhr.responseType === "json") return clip(xhr.response);
        return `[${xhr.responseType || "binary"} response]`;
      } catch (e) {
        return `[response read failed] ${String(e && e.message || e)}`;
      }
    }
    function fillCommonEvent(ev, requestPayload) {
      ev.id = meta.event_id || ev.id;
      ev.status = Number(xhr.status || 0) || 0;
      ev.ok = ev.status >= 200 && ev.status < 400;
      ev.request_headers = meta.request_headers || {};
      ev.request_payload = clip(requestPayload);
      try { ev.response_headers = parseRawHeaders(xhr.getAllResponseHeaders()); } catch (_) { ev.response_headers = {}; }
      ev.response_type = xhr.responseType || "";
      ev.response_body = responseTextPreview();
      ev.initiator_stack = meta.initiator_stack || "";
      return ev;
    }
    function emitStreamPartial() {
      try {
        if (xhr.readyState !== 3) return;
        if (xhr.responseType && xhr.responseType !== "text") return;
        const text = xhr.responseText || "";
        if (!text) return;
        const now = Date.now();
        const len = text.length;
        if (now - Number(meta.last_stream_emit_ms || 0) < 1000 && len - Number(meta.last_stream_len || 0) < 4096) return;
        meta.last_stream_emit_ms = now;
        meta.last_stream_len = len;
        Promise.resolve(reqPayloadPromise).then((requestPayload) => {
          const ev = fillCommonEvent(baseEvent("xhr", meta.method, meta.url, startedPerf, startedIso, startedEpoch), requestPayload);
          ev.partial_update = true;
          ev.stream_state = "loading";
          emit(ev);
        });
      } catch (_) {}
    }
    function done(kind) {
      if (emitted) return;
      emitted = true;
      Promise.resolve(reqPayloadPromise).then((requestPayload) => {
        const ev = fillCommonEvent(baseEvent("xhr", meta.method, meta.url, startedPerf, startedIso, startedEpoch), requestPayload);
        ev.update_existing = true;
        ev.stream_state = "done";
        if (kind && kind !== "loadend") ev.error = kind;
        emit(ev);
      });
    }
    try {
      xhr.addEventListener("readystatechange", emitStreamPartial);
      xhr.addEventListener("loadend", () => done("loadend"), { once: true });
      xhr.addEventListener("error", () => done("error"), { once: true });
      xhr.addEventListener("timeout", () => done("timeout"), { once: true });
      xhr.addEventListener("abort", () => done("abort"), { once: true });
    } catch (_) {}
    return orig.xhrSend.apply(this, arguments);
  };
  mimicNativeToString(XMLHttpRequest.prototype.send, orig.xhrSend);

  if (orig.sendBeacon) {
    navigator.sendBeacon = function fpbNetworkCaptureSendBeacon(url, data) {
      const method = "POST";
      if (!allowed(method)) return orig.sendBeacon.apply(navigator, arguments);
      const startedPerf = performance.now();
      const startedIso = iso();
      const startedEpoch = Date.now();
      const initiator = stack();
      const result = orig.sendBeacon.apply(navigator, arguments);
      bodyPreview(data).then((requestPayload) => {
        const ev = baseEvent("sendBeacon", method, url, startedPerf, startedIso, startedEpoch);
        ev.status = 0;
        ev.ok = !!result;
        ev.request_payload = clip(requestPayload);
        ev.response_body = "[sendBeacon has no readable response body]";
        ev.initiator_stack = initiator;
        emit(ev);
      });
      return result;
    };
    mimicNativeToString(navigator.sendBeacon, orig.sendBeacon);
  }

  return { ok: true, installed: true };
}

function updateMainWorldCaptureConfig(patch) {
  const key = "__FPB_NETWORK_CAPTURE_CONFIG__";
  window[key] = Object.assign({}, window[key] || {}, patch || {});
  if (Array.isArray(window[key].methods)) window[key].methods = window[key].methods.map(x => String(x || "").toUpperCase());
  return { ok: true, config: window[key] };
}

async function injectCapture(tabId) {
  const cfg = {
    enabled: capture.running,
    paused: capture.paused,
    sessionId: capture.sessionId,
    methods: Array.from(capture.methods),
    maxBodyChars: capture.maxBodyChars
  };
  const run = async (allFrames) => {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      world: "ISOLATED",
      func: installNetworkCaptureBridge,
      args: [cfg]
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      world: "MAIN",
      func: installMainWorldCapture,
      args: [cfg]
    });
  };
  try {
    await run(true);
  } catch (e) {
    capture.lastError = `allFrames inject failed, retried main frame: ${String(e && e.message || e)}`;
    await run(false);
  }
}

async function updateInjectedConfig(patch) {
  if (capture.tabId === null) return;
  try {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: capture.tabId, allFrames: true },
        world: "MAIN",
        func: updateMainWorldCaptureConfig,
        args: [patch]
      });
    } catch (_) {
      await chrome.scripting.executeScript({
        target: { tabId: capture.tabId, allFrames: false },
        world: "MAIN",
        func: updateMainWorldCaptureConfig,
        args: [patch]
      });
    }
  } catch (e) {
    capture.lastError = String(e && e.message || e);
  }
}

async function startCapture(payload, runtime) {
  installWebRequestListeners();
  const targetUrl = normalizeUrl(payload.target_url || payload.targetUrl || "");
  let tabId = Number(payload.tab_id || payload.tabId || 0) || 0;
  let targetTab = null;
  if (tabId) {
    targetTab = await chrome.tabs.get(tabId);
    if (!targetTab || !/^https?:\/\//i.test(String(targetTab.url || ""))) {
      throw new Error("tabId does not point to an injectable http/https page");
    }
    if (payload.active !== false) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  } else {
    tabId = await findOrOpenTargetTab(targetUrl, {
      active: payload.active !== false,
      navigate: payload.navigate !== false
    });
    targetTab = await chrome.tabs.get(tabId).catch(() => null);
  }
  await waitForTabReady(tabId, Number(payload.wait_tab_ms || 15000));
  const resolvedTargetUrl = targetUrl || String(targetTab && targetTab.url || "");

  capture.sessionId = String(payload.session_id || `netcap-${Date.now()}`);
  capture.running = true;
  capture.paused = false;
  capture.tabId = tabId;
  capture.targetUrl = resolvedTargetUrl;
  capture.targetOrigin = originOf(resolvedTargetUrl);
  capture.methods = normalizeMethods(payload.methods);
  capture.maxEntries = Math.max(100, Math.min(20000, Number(payload.max_entries || DEFAULT_MAX_ENTRIES)));
  capture.maxBodyChars = Math.max(1000, Math.min(1000000, Number(payload.max_body_chars || DEFAULT_MAX_BODY_CHARS)));
  capture.includeWebRequestMeta = payload.include_web_request_meta !== false;
  capture.startedAt = nowIso();
  capture.updatedAt = capture.startedAt;
  capture.lastError = "";
  if (payload.clear !== false) {
    capture.events = [];
    capture.seq = 0;
    webRequests.clear();
    cdpRequests.clear();
  }

  await runtime?.progress(5, { stage: "network_capture_injecting", tab_id: tabId, target_url: resolvedTargetUrl });
  await attachDebugger(tabId);
  await injectCapture(tabId);
  await runtime?.progress(100, { stage: "network_capture_started", tab_id: tabId });
  return { ...getStatus(), message: "network capture started" };
}

async function pauseCapture(paused) {
  capture.paused = !!paused;
  capture.updatedAt = nowIso();
  await updateInjectedConfig({ paused: capture.paused, enabled: capture.running });
  return { ...getStatus(), message: capture.paused ? "network capture paused" : "network capture resumed" };
}

async function stopCapture() {
  capture.running = false;
  capture.paused = false;
  capture.updatedAt = nowIso();
  await updateInjectedConfig({ enabled: false, paused: false });
  await detachDebugger();
  return { ...getStatus(), message: "network capture stopped" };
}

function clearCapture() {
  capture.events = [];
  capture.seq = 0;
  capture.updatedAt = nowIso();
  webRequests.clear();
  cdpRequests.clear();
  return { ...getStatus(), message: "network capture cleared" };
}

function snapshot(payload = {}) {
  const sinceSeq = Math.max(0, Number(payload.since_seq || payload.sinceSeq || 0));
  const limit = Math.max(1, Math.min(5000, Number(payload.limit || 1000)));
  let items = capture.events.filter(ev => Number(ev.seq || 0) > sinceSeq);
  if (items.length > limit) items = items.slice(items.length - limit);
  return { ...getStatus(), events: items };
}

function updateEvent(payload = {}) {
  const seq = Number(payload.seq);
  const idx = capture.events.findIndex(e => Number(e.seq) === seq);
  if (idx === -1) return { ...getStatus(), updated: false };
  const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : {};
  const allowed = [
    "request_headers",
    "request_payload",
    "response_headers",
    "response_type",
    "response_body"
  ];
  const next = { ...capture.events[idx] };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  next.edited_at = nowIso();
  capture.events[idx] = next;
  capture.updatedAt = nowIso();
  return { ...getStatus(), updated: true, event: next };
}

export async function runDebuggerExpression(tabId, expression, options = {}) {
  const targetTabId = Number(tabId);
  if (!targetTabId) throw new Error("tabId required");
  if (debuggerAttachedTabId === null || Number(debuggerAttachedTabId) !== targetTabId) {
    throw new Error(`network debugger is not attached to tab ${targetTabId}`);
  }
  try {
    await sendDebuggerCommand(targetTabId, "Page.setBypassCSP", { enabled: true });
  } catch (_) {}
  const result = await sendDebuggerCommand(targetTabId, "Runtime.evaluate", {
    expression: String(expression || ""),
    awaitPromise: options.awaitPromise !== false,
    returnByValue: options.returnByValue !== false,
    userGesture: options.userGesture !== false,
    timeout: Number(options.timeout || 120000)
  });
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails;
    const text = details.text || (details.exception && details.exception.description) || "Runtime.evaluate exception";
    return { ok: false, error: text, exceptionDetails: details };
  }
  return (result && result.result && Object.prototype.hasOwnProperty.call(result.result, "value"))
    ? result.result.value
    : { ok: false, error: "Runtime.evaluate 没有返回可序列化结果", raw: result };
}

export async function handleNetworkRuntimeMessage(message, sender) {
  if (!message || message.type !== "fpb.networkCapture.event") return { ok: false, ignored: true };
  return pushEvent(message.event || {}, sender || {});
}

export async function runNetworkTask(msg, runtime) {
  const payload = (msg && msg.payload) || {};
  const action = String(payload.action || payload.workflow_kind || "snapshot").trim().toLowerCase();
  if (action === "start" || action === "start_capture" || action === "network_capture_start") {
    return startCapture(payload, runtime);
  }
  if (action === "pause" || action === "pause_capture") return pauseCapture(true);
  if (action === "resume" || action === "resume_capture") return pauseCapture(false);
  if (action === "stop" || action === "stop_capture") return stopCapture();
  if (action === "clear" || action === "clear_capture") return clearCapture();
  if (action === "status") return getStatus();
  if (action === "snapshot" || action === "get_snapshot") return snapshot(payload);
  if (action === "delete_event" || action === "deleteevent") {
    const seq = Number(payload.seq);
    const idx = capture.events.findIndex(e => e.seq === seq);
    const deleted = idx !== -1;
    if (deleted) {
      capture.events.splice(idx, 1);
      capture.updatedAt = nowIso();
    }
    return { ...getStatus(), deleted, seq };
  }
  if (action === "update_event" || action === "updateevent") return updateEvent(payload);
  throw new Error(`unsupported network action: ${action}`);
}

try {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!capture.running || capture.paused) return;
    if (capture.tabId === null || Number(tabId) !== Number(capture.tabId)) return;
    const url = String((tab && tab.url) || changeInfo.url || "");
    if (url && !/^https?:\/\//i.test(url)) return;
    if (changeInfo.status === "complete" || changeInfo.url) {
      setTimeout(() => {
        if (capture.running && !capture.paused && Number(capture.tabId) === Number(tabId)) {
          injectCapture(tabId).catch((e) => {
            capture.lastError = `reinjection failed: ${String(e && e.message || e)}`;
          });
        }
      }, 300);
    }
  });
} catch (_) {}
