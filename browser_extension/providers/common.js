export async function ensureTab(urlPrefix, targetUrl, options = {}) {
  const active = options.active !== false;
  const navigate = options.navigate !== false;
  const tabs = await chrome.tabs.query({});
  const exact = targetUrl ? tabs.find(t => (t.url || "") === targetUrl) : null;
  const found = exact || tabs.find(t => (t.url || "").startsWith(urlPrefix));
  if (found && found.id) {
    if (navigate && targetUrl && found.url !== targetUrl) {
      await chrome.tabs.update(found.id, { url: targetUrl, active });
    } else {
      await chrome.tabs.update(found.id, { active });
    }
    return found.id;
  }
  const tab = await chrome.tabs.create({ url: targetUrl || urlPrefix, active });
  return tab.id;
}

export async function fetchJson(url, { method = "GET", headers = {}, body = null } = {}) {
  const reqMethod = String(method || "GET").toUpperCase();
  const init = { method: reqMethod, headers: { ...headers }, credentials: "include" };
  if (body !== null && body !== undefined) init.body = JSON.stringify(body);
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    const rawMsg = String((e && e.message) || e || "unknown error");
    throw new Error(`fetchJson failed; Request Method: ${reqMethod}; url=${url}; error=${rawMsg}`);
  }
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), text, json };
}

export function compactErrorResponse(tx) {
  if (!tx) return "";
  return `${tx.status || ""} ${String(tx.text || JSON.stringify(tx.json || "")).slice(0, 500)}`;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value ?? ""));
}

function bytesToHex(bytes) {
  return Array.from(bytes || []).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const input = value instanceof Uint8Array ? value : utf8Bytes(value);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Bytes(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes instanceof Uint8Array ? keyBytes : utf8Bytes(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, utf8Bytes(value));
  return new Uint8Array(sig);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ossIso8601Now() {
  const d = new Date();
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

function ossEncode(value) {
  return encodeURIComponent(String(value ?? "")).replace(/[!'()*]/g, ch =>
    "%" + ch.charCodeAt(0).toString(16).toUpperCase()
  );
}

function ossCanonicalObjectPath(bucket, objectKey) {
  const b = String(bucket || "").trim();
  const key = String(objectKey || "").replace(/^\/+/, "");
  const raw = `/${b ? `${b}/` : ""}${key}`;
  return raw.split("/").map(ossEncode).join("/").replace(/%2F/gi, "/");
}

function ossUrlObjectPath(objectKey) {
  const key = String(objectKey || "").replace(/^\/+/, "");
  return "/" + key.split("/").map(ossEncode).join("/");
}

function normalizeOssUploadConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const timeoutMs = Number(cfg.timeout_ms || cfg.timeoutMs || cfg.upload_timeout_ms || cfg.uploadTimeoutMs || 60000);
  const attempts = Number(cfg.attempts || cfg.upload_attempts || cfg.uploadAttempts || 3);
  return {
    enabled: cfg.enabled !== false && String(cfg.provider || "aliyun_oss").toLowerCase() === "aliyun_oss",
    endpoint: String(cfg.endpoint || "").trim(),
    region: String(cfg.region || "").trim(),
    bucket: String(cfg.bucket || "").trim(),
    publicBaseUrl: String(cfg.public_base_url || cfg.publicBaseUrl || "").trim(),
    accessKeyId: String(cfg.access_key_id || cfg.accessKeyId || "").trim(),
    accessKeySecret: String(cfg.access_key_secret || cfg.accessKeySecret || "").trim(),
    securityToken: String(cfg.security_token || cfg.securityToken || "").trim(),
    objectKeyPrefix: String(cfg.object_key_prefix || cfg.objectKeyPrefix || "fpbrowser2api/uploads").trim(),
    required: cfg.required !== false,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, timeoutMs) : 60000,
    attempts: Number.isFinite(attempts) ? Math.max(1, Math.min(5, Math.floor(attempts))) : 3
  };
}

function ossEndpointForObject(cfg, objectKey) {
  let raw = String(cfg.endpoint || "").trim();
  if (!raw) throw new Error("OSS endpoint missing");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  const u = new URL(raw);
  let host = u.host;
  const bucketPrefix = `${cfg.bucket}.`;
  if (cfg.bucket && !host.toLowerCase().startsWith(bucketPrefix.toLowerCase())) {
    host = `${cfg.bucket}.${host}`;
  }
  return `${u.protocol}//${host}${ossUrlObjectPath(objectKey)}`;
}

function ossPublicUrl(cfg, objectKey, uploadUrl) {
  const base = String(cfg.publicBaseUrl || "").trim();
  if (!base) return uploadUrl;
  return `${base.replace(/\/+$/, "")}/${String(objectKey || "").replace(/^\/+/, "")}`;
}

function sanitizeOssPart(value, fallback = "item") {
  const s = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return s || fallback;
}

function dateStampLocal() {
  const d = new Date();
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

function randomHex(bytes = 4) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

function extensionForMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("webm")) return "webm";
  return "png";
}

function buildOssObjectKey(cfg, options = {}) {
  const prefix = String(options.objectKeyPrefix || cfg.objectKeyPrefix || "fpbrowser2api/uploads")
    .replace(/^\/+|\/+$/g, "");
  const ext = sanitizeOssPart(options.extension || extensionForMime(options.contentType), "bin");
  const taskId = sanitizeOssPart(options.taskId || options.task_id || "", "");
  const resolution = sanitizeOssPart(options.resolution || "", "");
  const index = Math.max(1, Number(options.index || 1) || 1);
  const pieces = [dateStampLocal(), randomHex(4)];
  if (taskId) pieces.push(taskId.slice(0, 32));
  if (resolution) pieces.push(resolution);
  pieces.push(String(index));
  return `${prefix}/${pieces.join("_")}.${ext}`;
}

function dataUrlMime(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;,]+)[;,]/i);
  return (m && m[1]) || "application/octet-stream";
}

async function dataUrlToBlob(dataUrl) {
  const s = String(dataUrl || "");
  const m = s.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/i);
  if (!m) throw new Error("invalid data URL");
  const mime = m[1] || "application/octet-stream";
  if (m[2]) {
    const b64 = (m[3] || "").replace(/\s+/g, "");
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  return new Blob([decodeURIComponent(m[3] || "")], { type: mime });
}

async function aliyunOssAuthorizationV4({ cfg, method, objectKey, headers }) {
  const date = headers["x-oss-date"];
  const shortDate = date.split("T")[0];
  const canonicalHeaders = Object.keys(headers)
    .map(k => k.toLowerCase())
    .filter(k => k === "content-type" || k === "content-md5" || k.startsWith("x-oss-"))
    .sort()
    .map(k => `${k}:${String(headers[k] ?? "").trim()}\n`)
    .join("");
  const canonicalRequest = [
    String(method || "PUT").toUpperCase(),
    ossCanonicalObjectPath(cfg.bucket, objectKey),
    "",
    canonicalHeaders,
    "",
    headers["x-oss-content-sha256"] || "UNSIGNED-PAYLOAD"
  ].join("\n");
  const scope = `${shortDate}/${cfg.region}/oss/aliyun_v4_request`;
  const stringToSign = [
    "OSS4-HMAC-SHA256",
    date,
    scope,
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const kDate = await hmacSha256Bytes(utf8Bytes(`aliyun_v4${cfg.accessKeySecret}`), shortDate);
  const kRegion = await hmacSha256Bytes(kDate, cfg.region);
  const kOss = await hmacSha256Bytes(kRegion, "oss");
  const kSigning = await hmacSha256Bytes(kOss, "aliyun_v4_request");
  const signature = bytesToHex(await hmacSha256Bytes(kSigning, stringToSign));
  return `OSS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope},Signature=${signature}`;
}

/**
 * 上传 Blob 到阿里云 OSS。
 *
 * OSS 密钥必须由 Python 在当前任务 payload 中临时传入；本函数不读写 chrome.storage，
 * 避免插件发布包或本地持久化数据中包含密钥。
 */
export async function uploadBlobToAliyunOss(rawConfig, blob, options = {}) {
  const cfg = normalizeOssUploadConfig(rawConfig);
  if (!cfg.enabled) throw new Error("OSS upload disabled");
  if (!cfg.endpoint || !cfg.region || !cfg.bucket || !cfg.accessKeyId || !cfg.accessKeySecret) {
    throw new Error("OSS upload config incomplete");
  }
  if (!blob) throw new Error("OSS upload missing blob");

  const contentType = String(options.contentType || blob.type || "application/octet-stream").trim();
  const objectKey = String(options.objectKey || buildOssObjectKey(cfg, { ...options, contentType })).replace(/^\/+/, "");
  const uploadUrl = ossEndpointForObject(cfg, objectKey);
  const headers = {
    "content-type": contentType,
    "x-oss-content-sha256": "UNSIGNED-PAYLOAD",
    "x-oss-date": ossIso8601Now()
  };
  if (cfg.securityToken) headers["x-oss-security-token"] = cfg.securityToken;
  const authorization = await aliyunOssAuthorizationV4({ cfg, method: "PUT", objectKey, headers });
  const fetchHeaders = {
    "Content-Type": headers["content-type"],
    "x-oss-content-sha256": headers["x-oss-content-sha256"],
    "x-oss-date": headers["x-oss-date"],
    "Authorization": authorization
  };
  if (cfg.securityToken) fetchHeaders["x-oss-security-token"] = cfg.securityToken;

  const timeoutMs = Math.max(5000, Number(options.timeoutMs || options.timeout_ms || cfg.timeoutMs || 60000) || 60000);
  const attempts = Math.max(1, Math.min(5, Math.floor(Number(options.attempts || cfg.attempts || 3) || 3)));
  let resp = null;
  let lastErr = null;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch (_) {}
    }, timeoutMs);
    try {
      resp = await fetch(uploadUrl, {
        method: "PUT",
        headers: fetchHeaders,
        body: blob,
        signal: controller.signal
      });
      if (resp.ok || resp.status < 500 || attempt >= attempts) break;
      const text = await resp.text().catch(() => "");
      lastErr = new Error(`OSS upload HTTP ${resp.status}: ${String(text).slice(0, 500)}`);
    } catch (e) {
      const msg = String((e && e.message) || e || "");
      lastErr = new Error((e && e.name) === "AbortError" ? `OSS upload timeout after ${timeoutMs}ms` : `OSS upload failed: ${msg}`);
      if (attempt >= attempts) throw lastErr;
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, 500 * attempt));
  }
  if (!resp) throw lastErr || new Error("OSS upload failed");
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OSS upload HTTP ${resp.status}: ${String(text).slice(0, 500)}`);
  }
  return {
    url: ossPublicUrl(cfg, objectKey, uploadUrl),
    upload_url: uploadUrl,
    object_key: objectKey,
    content_type: contentType,
    size: blob.size || 0,
    bucket: cfg.bucket,
    region: cfg.region,
    duration_ms: Date.now() - startedAt
  };
}

export async function createAliyunOssPutTarget(rawConfig, options = {}) {
  const cfg = normalizeOssUploadConfig(rawConfig);
  if (!cfg.enabled) throw new Error("OSS upload disabled");
  if (!cfg.endpoint || !cfg.region || !cfg.bucket || !cfg.accessKeyId || !cfg.accessKeySecret) {
    throw new Error("OSS upload config incomplete");
  }
  const contentType = String(options.contentType || "application/octet-stream").trim();
  const objectKey = String(options.objectKey || buildOssObjectKey(cfg, { ...options, contentType })).replace(/^\/+/, "");
  const uploadUrl = ossEndpointForObject(cfg, objectKey);
  const headers = {
    "content-type": contentType,
    "x-oss-content-sha256": "UNSIGNED-PAYLOAD",
    "x-oss-date": ossIso8601Now()
  };
  if (cfg.securityToken) headers["x-oss-security-token"] = cfg.securityToken;
  const authorization = await aliyunOssAuthorizationV4({ cfg, method: "PUT", objectKey, headers });
  const fetchHeaders = {
    "Content-Type": headers["content-type"],
    "x-oss-content-sha256": headers["x-oss-content-sha256"],
    "x-oss-date": headers["x-oss-date"],
    "Authorization": authorization
  };
  if (cfg.securityToken) fetchHeaders["x-oss-security-token"] = cfg.securityToken;
  return {
    url: ossPublicUrl(cfg, objectKey, uploadUrl),
    upload_url: uploadUrl,
    object_key: objectKey,
    content_type: contentType,
    bucket: cfg.bucket,
    region: cfg.region,
    headers: fetchHeaders
  };
}

export async function uploadDataUrlToAliyunOss(rawConfig, dataUrl, options = {}) {
  const s = String(dataUrl || "");
  if (!/^data:(image|video)\//i.test(s)) throw new Error("OSS upload only accepts image/video data URL");
  const contentType = String(options.contentType || dataUrlMime(s)).trim();
  const blob = await dataUrlToBlob(s);
  return await uploadBlobToAliyunOss(rawConfig, blob, { ...options, contentType });
}

export async function uploadDataUrlListToAliyunOss(values, rawConfig, options = {}) {
  const cfg = normalizeOssUploadConfig(rawConfig);
  const input = Array.isArray(values) ? values : [];
  if (!cfg.enabled) return { values: input.slice(), uploads: [], skipped: true };

  const out = [];
  const uploads = [];
  const seen = new Map();
  let uploadIndex = 0;
  for (let i = 0; i < input.length; i++) {
    const value = String(input[i] || "");
    if (!/^data:(image|video)\//i.test(value)) {
      out.push(input[i]);
      continue;
    }
    if (seen.has(value)) {
      out.push(seen.get(value).url);
      continue;
    }
    uploadIndex++;
    if (options.runtime && typeof options.runtime.progress === "function") {
      try {
        await options.runtime.progress(options.progress || 92, {
          stage: options.stage || "oss_upload",
          index: uploadIndex,
          total: input.filter(x => /^data:(image|video)\//i.test(String(x || ""))).length
        });
      } catch (_) {}
    }
    const uploaded = await uploadDataUrlToAliyunOss(cfg, value, {
      ...options,
      index: uploadIndex,
      contentType: dataUrlMime(value)
    });
    if (options.runtime && typeof options.runtime.progress === "function") {
      try {
        await options.runtime.progress(Math.min(99, (options.progress || 92) + 1), {
          stage: `${options.stage || "oss_upload"}_done`,
          index: uploadIndex,
          total: input.filter(x => /^data:(image|video)\//i.test(String(x || ""))).length,
          size: uploaded.size || 0,
          duration_ms: uploaded.duration_ms || 0,
          object_key: uploaded.object_key
        });
      } catch (_) {}
    }
    seen.set(value, uploaded);
    uploads.push(uploaded);
    out.push(uploaded.url);
  }
  return { values: out, uploads, skipped: false };
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function safeProgress(runtime, progress, data = {}) {
  try {
    if (runtime && typeof runtime.progress === "function") {
      await runtime.progress(progress, data);
    }
  } catch (_) {}
}

/**
 * 在目标页面执行一段短暂、随机间隔的人类行为：
 * - 平滑移动鼠标指针（通过页面事件，不改 DOM 数据）
 * - 随机滚动页面
 * - 仅点击/聚焦疑似输入区域；不会设置 value/innerText，也不会派发 input 文本
 *
 * 注意：Chrome 扩展无法在不使用 debugger/CDP 的情况下产生 isTrusted=true 的事件；
 * 这里的目标是避免直接 DOM 写入输入框，同时让页面已有事件处理器收到自然顺序的
 * pointer/mouse/wheel/click/focus 行为。
 */
export async function simulateHumanActivity(tabId, runtime = null, minMs = 3000, maxMs = 10000, options = {}) {
  if (!tabId || (options && options.disabled)) return { ok: false, skipped: true, reason: "disabled_or_missing_tab" };
  const min = Math.max(250, asNumber(minMs, 3000));
  const max = Math.max(min + 1, asNumber(maxMs, 10000));
  const duration = Math.max(250, Math.floor(min + Math.random() * Math.max(1, max - min)));
  const cfg = {
    minDelayMs: Math.max(80, asNumber(options.minDelayMs ?? options.min_delay_ms, 180)),
    maxDelayMs: Math.max(120, asNumber(options.maxDelayMs ?? options.max_delay_ms, 900)),
    clickInputs: options.clickInputs !== false && options.click_inputs !== false,
    scroll: options.scroll !== false,
    moveMouse: options.moveMouse !== false && options.move_mouse !== false,
    stage: options.stage || "human_activity",
    progress: asNumber(options.progress, 4),
    // MAIN world 在 labs.google / chatgpt 这类复杂 SPA 页面上偶发会被页面主线程、
    // 导航或扩展注入队列拖住很久；默认用 ISOLATED world 仍可访问 DOM 并派发事件，
    // 但不和页面 JS 全局环境混在一起，更稳定。需要兼容旧行为时可传 world: "MAIN"。
    world: String(options.world || options.executionWorld || options.execution_world || "ISOLATED").toUpperCase()
  };
  if (cfg.maxDelayMs < cfg.minDelayMs) cfg.maxDelayMs = cfg.minDelayMs + 50;
  if (!["ISOLATED", "MAIN"].includes(cfg.world)) cfg.world = "ISOLATED";
  const timeoutMs = Math.max(
    1000,
    asNumber(options.timeoutMs ?? options.timeout_ms, Math.min(30000, duration + 10000))
  );
  const deadlineEpoch = Date.now() + timeoutMs;

  await safeProgress(runtime, cfg.progress, { stage: cfg.stage, duration_ms: duration });
  let timeoutHandle = null;
  try {
    const execPromise = chrome.scripting.executeScript({
      target: { tabId },
      world: cfg.world,
      args: [duration, cfg, deadlineEpoch],
      func: async (durationMs, runCfg, deadlineMs) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const rand = (min, max) => min + Math.random() * Math.max(0, max - min);
        const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
        const now = () => Date.now();
        const actions = { mouse_moves: 0, scrolls: 0, input_clicks: 0 };
        const timedOut = () => Number.isFinite(Number(deadlineMs)) && now() > Number(deadlineMs);
        if (timedOut()) return { ok: false, skipped: true, reason: "human_activity_injection_started_after_timeout", duration_ms: durationMs, actions };

        const viewport = () => ({
          w: Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1024),
          h: Math.max(1, window.innerHeight || document.documentElement.clientHeight || 768)
        });

        function eventTargetAt(x, y) {
          try { return document.elementFromPoint(x, y) || document.body || document.documentElement; }
          catch (_) { return document.body || document.documentElement; }
        }

        function dispatchMouse(type, target, x, y, extra = {}) {
          if (!target) return;
          const init = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: Math.round(x),
            clientY: Math.round(y),
            screenX: Math.round((window.screenX || 0) + x),
            screenY: Math.round((window.screenY || 0) + y),
            button: 0,
            buttons: /down/i.test(type) ? 1 : 0,
            ...extra
          };
          try {
            if (type.startsWith("pointer") && window.PointerEvent) {
              target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            } else {
              target.dispatchEvent(new MouseEvent(type, init));
            }
          } catch (_) {}
        }

        async function moveMousePath(from, to, steps = 10) {
          if (!runCfg.moveMouse) return to;
          const n = Math.max(4, Math.floor(steps));
          const c1 = {
            x: from.x + (to.x - from.x) * rand(0.15, 0.45) + rand(-70, 70),
            y: from.y + (to.y - from.y) * rand(0.10, 0.35) + rand(-45, 45)
          };
          const c2 = {
            x: from.x + (to.x - from.x) * rand(0.55, 0.85) + rand(-70, 70),
            y: from.y + (to.y - from.y) * rand(0.65, 0.90) + rand(-45, 45)
          };
          const vp = viewport();
          let last = { ...from };
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            const mt = 1 - t;
            const x = clamp(mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x + rand(-2.2, 2.2), 3, vp.w - 3);
            const y = clamp(mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y + rand(-2.2, 2.2), 3, vp.h - 3);
            const target = eventTargetAt(x, y);
            dispatchMouse("pointermove", target, x, y, { movementX: Math.round(x - last.x), movementY: Math.round(y - last.y) });
            dispatchMouse("mousemove", target, x, y, { movementX: Math.round(x - last.x), movementY: Math.round(y - last.y) });
            last = { x, y };
            actions.mouse_moves++;
            await sleep(rand(14, 45));
          }
          return last;
        }

        function isElementVisible(el) {
          if (!el || el.nodeType !== 1) return false;
          let style = null;
          try { style = getComputedStyle(el); } catch (_) {}
          if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0.01)) return false;
          const rects = [];
          try { rects.push(...Array.from(el.getClientRects ? el.getClientRects() : [])); } catch (_) {}
          if (!rects.length) {
            try { rects.push(el.getBoundingClientRect()); } catch (_) {}
          }
          const vp = viewport();
          return rects.some(r => r && r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.top < vp.h && r.left < vp.w);
        }

        function attrText(el) {
          if (!el || !el.getAttribute) return "";
          const cls = (() => {
            try {
              if (typeof el.className === "string") return el.className;
              if (el.className && typeof el.className.baseVal === "string") return el.className.baseVal;
            } catch (_) {}
            return "";
          })();
          return [
            el.tagName || "",
            el.id || "",
            cls,
            el.getAttribute("role") || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("aria-placeholder") || "",
            el.getAttribute("placeholder") || "",
            el.getAttribute("data-placeholder") || "",
            el.getAttribute("data-testid") || "",
            el.getAttribute("name") || "",
            el.getAttribute("title") || ""
          ].join(" ").toLowerCase();
        }

        function isTextInputElement(el) {
          if (!el || el.nodeType !== 1) return false;
          const tag = String(el.tagName || "").toLowerCase();
          if (tag === "textarea") return !el.disabled && !el.readOnly;
          if (tag === "input") {
            const type = String(el.getAttribute("type") || "text").toLowerCase();
            return !el.disabled && !el.readOnly && [
              "text", "search", "url", "email", "password", "number", "tel", ""
            ].includes(type);
          }
          return false;
        }

        function isLikelyTextEntry(el) {
          if (!el || el.nodeType !== 1) return false;
          if (isTextInputElement(el)) return true;
          if (el.isContentEditable) return true;
          const role = String(el.getAttribute && el.getAttribute("role") || "").toLowerCase();
          if (["textbox", "searchbox", "combobox"].includes(role)) return true;
          if (el.getAttribute && String(el.getAttribute("aria-multiline") || "").toLowerCase() === "true") return true;
          const text = attrText(el);
          if (/\b(button|submit|cancel|delete|remove|close|download|upload|menuitem|option|tab)\b/.test(text)) return false;
          if (/\b(input|textarea|textbox|text-box|editor|compose|composer|prompt|search|message|query|comment|description|prosemirror|ql-editor|tiptap)\b/.test(text)) return true;
          if (/(输入|搜索|提示词|描述|编辑|消息|内容)/.test(text)) return true;
          return false;
        }

        function canClickTextEntry(el) {
          if (!isLikelyTextEntry(el) || !isElementVisible(el)) return false;
          if (el.matches && el.matches("[disabled],[aria-disabled='true'],[hidden]")) return false;
          const blocker = el.closest && el.closest("button,a[href],[role='button'],[role='menuitem'],[role='option']");
          if (blocker && blocker !== el && !isLikelyTextEntry(blocker)) return false;
          return true;
        }

        function collectTextEntryCandidates(root = document, out = [], seen = new Set()) {
          const selectors = [
            "input:not([type='hidden'])",
            "textarea",
            "[contenteditable='']",
            "[contenteditable='true']",
            "[role='textbox']",
            "[role='searchbox']",
            "[role='combobox']",
            "[aria-multiline='true']",
            "[data-placeholder]",
            ".ProseMirror",
            ".ql-editor",
            ".tiptap",
            "[class*='input' i]",
            "[class*='textarea' i]",
            "[class*='textbox' i]",
            "[class*='editor' i]",
            "[class*='prompt' i]",
            "[class*='compose' i]",
            "[class*='search' i]",
            "[id*='input' i]",
            "[id*='prompt' i]",
            "[id*='search' i]"
          ].join(",");
          let nodes = [];
          try { nodes = Array.from(root.querySelectorAll(selectors)); } catch (_) { nodes = []; }
          for (const el of nodes) {
            if (!seen.has(el)) {
              seen.add(el);
              if (canClickTextEntry(el)) out.push(el);
            }
            if (out.length >= 80) break;
          }
          // 兼容 open shadow DOM 中的自定义编辑器。
          let all = [];
          try { all = Array.from(root.querySelectorAll("*")); } catch (_) { all = []; }
          for (const el of all.slice(0, 1400)) {
            if (out.length >= 80) break;
            if (el.shadowRoot) collectTextEntryCandidates(el.shadowRoot, out, seen);
          }
          return out;
        }

        function bestRect(el) {
          const vp = viewport();
          let rects = [];
          try { rects = Array.from(el.getClientRects ? el.getClientRects() : []); } catch (_) { rects = []; }
          if (!rects.length) {
            try { rects = [el.getBoundingClientRect()]; } catch (_) { rects = []; }
          }
          const visible = rects
            .map(r => ({
              left: clamp(r.left, 0, vp.w),
              top: clamp(r.top, 0, vp.h),
              right: clamp(r.right, 0, vp.w),
              bottom: clamp(r.bottom, 0, vp.h),
              raw: r
            }))
            .map(r => ({ ...r, width: Math.max(0, r.right - r.left), height: Math.max(0, r.bottom - r.top) }))
            .filter(r => r.width >= 8 && r.height >= 8)
            .sort((a, b) => (b.width * b.height) - (a.width * a.height));
          return visible[0] || null;
        }

        async function clickAt(el, pos, currentPointer) {
          const target = eventTargetAt(pos.x, pos.y);
          const nextPointer = await moveMousePath(currentPointer, pos, Math.floor(rand(6, 17)));
          const downTarget = eventTargetAt(pos.x, pos.y) || target || el;
          dispatchMouse("pointerover", downTarget, pos.x, pos.y);
          dispatchMouse("mouseover", downTarget, pos.x, pos.y);
          dispatchMouse("pointerdown", downTarget, pos.x, pos.y, { buttons: 1 });
          dispatchMouse("mousedown", downTarget, pos.x, pos.y, { buttons: 1 });
          await sleep(rand(55, 170));
          dispatchMouse("pointerup", downTarget, pos.x, pos.y, { buttons: 0 });
          dispatchMouse("mouseup", downTarget, pos.x, pos.y, { buttons: 0 });
          dispatchMouse("click", downTarget, pos.x, pos.y, { detail: 1, buttons: 0 });
          try {
            const focusEl = isLikelyTextEntry(downTarget) ? downTarget : (isLikelyTextEntry(el) ? el : null);
            if (focusEl && typeof focusEl.focus === "function") focusEl.focus({ preventScroll: true });
          } catch (_) {}
          return nextPointer;
        }

        async function clickInputLike(currentPointer) {
          if (!runCfg.clickInputs) return { ok: false, pointer: currentPointer };
          let candidates = collectTextEntryCandidates();
          if (!candidates.length) return { ok: false, pointer: currentPointer };
          candidates = candidates
            .map(el => ({ el, rect: bestRect(el) }))
            .filter(x => x.rect)
            .sort((a, b) => {
              const ay = Math.abs(((a.rect.top + a.rect.bottom) / 2) - viewport().h * 0.52);
              const by = Math.abs(((b.rect.top + b.rect.bottom) / 2) - viewport().h * 0.52);
              return ay - by;
            });
          if (!candidates.length) return { ok: false, pointer: currentPointer };
          let picked = candidates[Math.floor(rand(0, Math.min(4, candidates.length)))];
          if (!picked || !picked.rect) picked = candidates[0];
          const el = picked.el;
          try {
            const r0 = picked.rect.raw || picked.rect;
            if (r0.top < 24 || r0.bottom > viewport().h - 24) {
              el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
              await sleep(rand(260, 760));
              const rr = bestRect(el);
              if (rr) picked.rect = rr;
            }
          } catch (_) {}
          const r = picked.rect;
          const marginX = Math.min(r.width * 0.32, 80);
          const marginY = Math.min(r.height * 0.34, 24);
          const pos = {
            x: clamp(rand(r.left + marginX, r.right - marginX), 4, viewport().w - 4),
            y: clamp(rand(r.top + marginY, r.bottom - marginY), 4, viewport().h - 4)
          };
          const pointer = await clickAt(el, pos, currentPointer);
          actions.input_clicks++;
          return { ok: true, pointer };
        }

        async function doScroll(currentPointer) {
          if (!runCfg.scroll) return currentPointer;
          const doc = document.scrollingElement || document.documentElement || document.body;
          const maxY = Math.max(0, (doc.scrollHeight || 0) - viewport().h);
          let dy = rand(160, 620) * (Math.random() < 0.72 ? 1 : -1);
          if (maxY > 0) {
            const y = window.scrollY || doc.scrollTop || 0;
            if (y < 40) dy = Math.abs(dy);
            if (y > maxY - 40) dy = -Math.abs(dy);
          } else {
            dy = rand(-120, 120);
          }
          const x = clamp(currentPointer.x + rand(-80, 80), 8, viewport().w - 8);
          const y = clamp(currentPointer.y + rand(-55, 55), 8, viewport().h - 8);
          const target = eventTargetAt(x, y);
          try {
            target.dispatchEvent(new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              clientX: Math.round(x),
              clientY: Math.round(y),
              deltaY: dy,
              deltaX: 0,
              deltaMode: 0
            }));
          } catch (_) {}
          try { window.scrollBy({ top: dy, left: 0, behavior: "smooth" }); }
          catch (_) { try { window.scrollBy(0, dy); } catch (_) {} }
          try {
            let node = target;
            while (node && node !== document.body && node !== document.documentElement) {
              if (node.scrollHeight > node.clientHeight + 8) {
                node.scrollTop = clamp((node.scrollTop || 0) + dy, 0, Math.max(0, node.scrollHeight - node.clientHeight));
                break;
              }
              node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
            }
          } catch (_) {}
          actions.scrolls++;
          await sleep(rand(220, 850));
          return { x, y };
        }

        const vp0 = viewport();
        let pointer = {
          x: clamp(rand(vp0.w * 0.18, vp0.w * 0.82), 5, vp0.w - 5),
          y: clamp(rand(vp0.h * 0.20, vp0.h * 0.78), 5, vp0.h - 5)
        };
        let clickedInput = false;
        const end = now() + Math.max(250, durationMs);
        while (now() < end && !timedOut()) {
          const op = Math.random();
          if (runCfg.clickInputs && (!clickedInput ? op < 0.42 : op < 0.16)) {
            const clicked = await clickInputLike(pointer);
            if (clicked.ok) {
              pointer = clicked.pointer || pointer;
              clickedInput = true;
              await sleep(rand(runCfg.minDelayMs + 250, runCfg.maxDelayMs + 900));
              continue;
            }
          }
          if (runCfg.scroll && op < 0.68) {
            pointer = await doScroll(pointer);
          } else if (runCfg.moveMouse) {
            const vp = viewport();
            const to = {
              x: clamp(pointer.x + rand(-220, 220), 6, vp.w - 6),
              y: clamp(pointer.y + rand(-155, 155), 6, vp.h - 6)
            };
            pointer = await moveMousePath(pointer, to, Math.floor(rand(5, 14)));
          }
          await sleep(rand(runCfg.minDelayMs, runCfg.maxDelayMs));
        }
        if (timedOut()) return { ok: false, skipped: true, reason: "human_activity_page_deadline_exceeded", duration_ms: durationMs, actions };
        if (runCfg.clickInputs && !clickedInput) {
          const clicked = await clickInputLike(pointer);
          if (clicked.ok) pointer = clicked.pointer || pointer;
        }
        return { ok: true, duration_ms: durationMs, actions };
      }
    });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`human_activity_timeout after ${timeoutMs}ms; duration_ms=${duration}; world=${cfg.world}`));
      }, timeoutMs);
    });
    const frames = await Promise.race([execPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const result = Array.isArray(frames) && frames[0] ? frames[0].result : null;
    await safeProgress(runtime, Math.min(99, cfg.progress + 1), { stage: `${cfg.stage}_done`, duration_ms: duration, result });
    return result || { ok: true, duration_ms: duration };
  } catch (e) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const error = String((e && e.message) || e || "");
    await safeProgress(runtime, Math.min(99, cfg.progress + 1), { stage: `${cfg.stage}_skipped`, duration_ms: duration, error });
    return { ok: false, skipped: true, error };
  }
}
