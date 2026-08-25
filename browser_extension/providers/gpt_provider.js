import { simulateHumanActivity, uploadDataUrlListToAliyunOss } from "./common.js";

const CHATGPT = "https://chatgpt.com";
const WEB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const WEB_CLIENT_VERSION = "prod-81e0c5cdf6140e8c5db714d613337f4aeab94029";
const WEB_BUILD_NUMBER = "6128297";
const MASK64 = (1n << 64n) - 1n;
const SHA3_RATE_512 = 72;
const GPT_IMAGE2_PUBLIC_MODELS = {
  "gpt-image2-1k": "1k",
  "gpt-image2-2k": "2k",
  "gpt-image2-4k": "4k"
};
const GPT_IMAGE2_SIZE_TABLE = {
  "1k": {
    "1:1": "1024x1024", "3:2": "1216x832", "2:3": "832x1216", "4:3": "1152x864", "3:4": "864x1152",
    "5:4": "1120x896", "4:5": "896x1120", "16:9": "1344x768", "9:16": "768x1344", "21:9": "1536x640"
  },
  "2k": {
    "1:1": "1248x1248", "3:2": "1536x1024", "2:3": "1024x1536", "4:3": "1440x1088", "3:4": "1088x1440",
    "5:4": "1392x1120", "4:5": "1120x1392", "16:9": "1664x928", "9:16": "928x1664", "21:9": "1904x816"
  },
  "4k": {
    "1:1": "2480x2480", "3:2": "3056x2032", "2:3": "2032x3056", "4:3": "2880x2160", "3:4": "2160x2880",
    "5:4": "2784x2224", "4:5": "2224x2784", "16:9": "3312x1872", "9:16": "1872x3312", "21:9": "3808x1632"
  }
};
const GPT_IMAGE2_DEFAULT_RATIO = "1:1";
const GPT_CLOUDFLARE_VERIFY_NEEDLES = [
  "verify you are human",
  "verify that you are human",
  "验证您是真人",
  "验证你是真人",
  "请验证您是真人",
  "请验证你是真人",
  "确认您是真人",
  "确认你是真人",
  "あなたが人間であることを確認してください",
  "人間であることを確認してください",
  "사람인지 확인",
  "사람인지 확인해주세요",
  "사람인지 확인하십시오",
  "xác minh bạn là con người",
  "xác nhận bạn là con người",
  "bestätigen sie, dass sie ein mensch sind",
  "bestätigen sie dass sie ein mensch sind",
  "überprüfen sie, ob sie ein mensch sind",
  "überprüfen sie ob sie ein mensch sind"
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uuid() { const c = globalThis.crypto; return c && c.randomUUID ? c.randomUUID() : `${Date.now()}-${Math.random()}`; }
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))]; }

function isNoTabError(e) {
  return /no tab with id/i.test(String(e && e.message || e || ""));
}

function originFromTarget(raw) {
  try {
    const u = new URL(raw || CHATGPT);
    if (u.hostname === "chatgpt.com" || u.hostname === "chat.openai.com") return u.origin;
  } catch (_) {}
  return CHATGPT;
}

async function waitTabComplete(tabId, timeoutMs = 45000) {
  const end = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < end) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === "complete") return true;
    } catch (_) {}
    await sleep(250);
  }
  return false;
}

async function reloadProjectPage(progress, tabId, projectPage, runtime) {
  await runtime.progress(progress, { stage: "reload_project_page", url: projectPage });
  try {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.tabs.reload(tabId, { bypassCache: false });
    await waitTabComplete(tabId, 45000);
    await sleep(1200);
    return true;
  } catch (e) {
    await chrome.tabs.update(tabId, { url: projectPage, active: true });
    await waitTabComplete(tabId, 45000);
    await sleep(1200);
    return true;
  }
}

async function inspectGptCloudflarePage(tabId, deep = false) {
  let frameHints = [];
  try {
    const allFrames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      args: [GPT_CLOUDFLARE_VERIFY_NEEDLES],
      func: (verifyNeedles) => {
        const href = String(location.href || "");
        const title = String(document.title || "");
        const text = String(document.body && document.body.innerText || "").slice(0, 1200);
        const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
        const titleNeedles = [
          "just a moment",
          "请稍候",
          "请稍等",
          "稍候",
          "しばらくお待ちください",
          "少々お待ちください",
          "잠시만 기다려 주세요",
          "잠시만 기다려주십시오",
          "잠시만 기다려주세요",
          "vui lòng chờ",
          "vui lòng đợi",
          "einen moment bitte",
          "bitte warten"
        ];
        const titleHit = titleNeedles.some((needle) => normalize(title).includes(normalize(needle)));
        const verifyHit = verifyNeedles.some((needle) => normalize(text).includes(normalize(needle)));
        return { url: href, title, title_hit: titleHit, verify_hit: verifyHit, is_cloudflare_frame: titleHit || verifyHit, text: text.slice(0, 180) };
      }
    });
    frameHints = (allFrames || []).map((x) => ({ frame_id: x.frameId, ...(x.result || {}) })).filter((x) => x.is_cloudflare_frame);
  } catch (_) {}
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [deep === true],
    func: (deepScan) => {
      const href = String(location.href || "");
      const title = String(document.title || "");
      const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const titleNeedles = [
        "just a moment",
        "请稍候",
        "请稍等",
        "稍候",
        "しばらくお待ちください",
        "少々お待ちください",
        "잠시만 기다려 주세요",
        "잠시만 기다려주십시오",
        "잠시만 기다려주세요",
        "vui lòng chờ",
        "vui lòng đợi",
        "einen moment bitte",
        "bitte warten"
      ];
      const titleHit = titleNeedles.some((needle) => normalize(title).includes(normalize(needle)));
      return { is_cloudflare: titleHit, url: href, title, title_hit: titleHit, cf_iframes: [], cf_widgets: [], deep_scan_ignored: deepScan === true };
    }
  });
  const out = Array.isArray(frames) && frames[0] && frames[0].result ? frames[0].result : { is_cloudflare: false, cf_iframes: [] };
  out.cf_frames = frameHints.slice(0, 10);
  if (frameHints.length) out.is_cloudflare = true;
  return out;
}

async function doubleClickGptCloudflareVerifyText(tabId) {
  try {
    const frameClicks = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      args: [GPT_CLOUDFLARE_VERIFY_NEEDLES],
      func: async (verifyNeedles) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
        const visible = (el) => {
          if (!el) return false;
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
        };
        const dispatchClick = async (targetEl, x, y) => {
          for (const type of ["pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: Math.round(x), clientY: Math.round(y), button: 0, buttons: /down/i.test(type) ? 1 : 0 };
            try {
              if (type.startsWith("pointer") && window.PointerEvent) targetEl.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
              else targetEl.dispatchEvent(new MouseEvent(type, init));
            } catch (_) {}
            if (type === "mousedown") await sleep(70);
          }
        };
        const matchesVerifyText = (raw) => {
          const text = normalize(raw);
          return text && verifyNeedles.some((needle) => text.includes(normalize(needle)));
        };
        const candidates = Array.from(document.querySelectorAll("body *")).map((el) => {
          if (!visible(el)) return null;
          const text = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
          if (!text || text.length > 320 || !matchesVerifyText(text)) return null;
          const rect = el.getBoundingClientRect();
          return { el, rect, text };
        }).filter(Boolean).sort((a, b) => {
          const textDiff = a.text.length - b.text.length;
          if (textDiff) return textDiff;
          return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        });
        const target = candidates[0];
        if (!target) return { clicked: false, reason: "verify_text_not_found", frame_url: String(location.href || "") };
        const x = target.rect.left + target.rect.width / 2;
        const y = target.rect.top + target.rect.height / 2;
        await dispatchClick(target.el, x, y);
        await sleep(180);
        await dispatchClick(target.el, x, y);
        return { clicked: true, source: "verify_text", via: "frame_dom", frame_url: String(location.href || ""), x, y, text: target.text.slice(0, 160) };
      }
    });
    const hit = (frameClicks || []).map((x) => ({ frame_id: x.frameId, ...(x.result || {}) })).find((x) => x.clicked);
    if (hit) return hit;
    const miss = (frameClicks || []).map((x) => ({ frame_id: x.frameId, ...(x.result || {}) })).find((x) => x.reason);
    return miss || { clicked: false, reason: "verify_text_not_found" };
  } catch (e) {
    return { clicked: false, reason: "verify_text_click_failed", error: String(e && e.message || e) };
  }
}

async function clickGptCloudflareCheckbox(tabId) {
  try {
    const frameClicks = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      func: async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const visible = (el) => {
          if (!el) return false;
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
        };
        const lower = `${location.href}\n${document.title}\n${String(document.body && document.body.innerText || "").slice(0, 1000)}`.toLowerCase();
        const looksCf = lower.includes("challenges.cloudflare.com") || lower.includes("/cdn-cgi/") || lower.includes("turnstile") || lower.includes("verify you are human") || lower.includes("cloudflare");
        const dispatchClick = async (targetEl, x, y) => {
          for (const type of ["pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: Math.round(x), clientY: Math.round(y), button: 0, buttons: /down/i.test(type) ? 1 : 0 };
            try {
              if (type.startsWith("pointer") && window.PointerEvent) targetEl.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
              else targetEl.dispatchEvent(new MouseEvent(type, init));
            } catch (_) {}
            if (type === "mousedown") await sleep(80);
          }
        };
        if (!looksCf) return { clicked: false, reason: "frame_not_cf", frame_url: String(location.href || "") };
        const cb = Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']")).find(visible);
        if (cb) {
          const r = cb.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          await dispatchClick(cb, x, y);
          try {
            cb.click();
          } catch (_) {}
          return { clicked: true, source: "frame_checkbox_locator", via: "frame_dom", frame_url: String(location.href || ""), x, y, checkbox_width: r.width, checkbox_height: r.height };
        }
        const x = Math.max(8, Math.min(28, window.innerWidth - 8));
        const y = Math.max(8, Math.min(Math.round(window.innerHeight / 2), window.innerHeight - 8));
        const el = document.elementFromPoint(x, y) || document.body || document.documentElement;
        if (!el) return { clicked: false, reason: "frame_checkbox_not_found", frame_url: String(location.href || "") };
        await dispatchClick(el, x, y);
        return { clicked: true, source: "frame_turnstile_coordinate", via: "frame_dom_coordinate", frame_url: String(location.href || ""), x, y, iframe_width: window.innerWidth, iframe_height: window.innerHeight };
      }
    });
    const hit = (frameClicks || []).map((x) => ({ frame_id: x.frameId, ...(x.result || {}) }))
      .find((x) => x.clicked && x.source !== "frame_turnstile_coordinate");
    if (hit) return hit;
  } catch (_) {}

  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
      const visible = (el) => {
        if (!el) return false;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      };
      const candidates = Array.from(document.querySelectorAll("iframe")).map((el) => {
        const rect = el.getBoundingClientRect();
        const src = String(el.getAttribute("src") || el.src || "");
        return { el, rect, srcLower: src.toLowerCase() };
      }).filter(({ rect, srcLower }) => (
        rect.width > 8 &&
        rect.height > 8 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth &&
        (srcLower.includes("challenges.cloudflare.com") || srcLower.includes("/cdn-cgi/") || srcLower.includes("turnstile"))
      ));
      const sizedCandidates = Array.from(document.querySelectorAll("iframe")).map((el) => {
        const rect = el.getBoundingClientRect();
        const src = String(el.getAttribute("src") || el.src || "");
        return { el, rect, srcLower: src.toLowerCase() };
      }).filter(({ rect }) => (
        rect.width >= 180 &&
        rect.width <= 420 &&
        rect.height >= 40 &&
        rect.height <= 140 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      ));
      const item = candidates[0] || sizedCandidates[0];
      if (item) {
        const rect = item.rect;
        const targetX = clamp(rect.left + 26, 3, window.innerWidth - 3);
        const targetY = clamp(rect.top + rect.height / 2, 3, window.innerHeight - 3);
        return { clicked: false, ready: true, source: candidates[0] ? "cf_iframe" : "sized_iframe", x: targetX, y: targetY, iframe_src: item.srcLower.slice(0, 160), iframe_width: rect.width, iframe_height: rect.height };
      }

      const checkbox = Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']"))
        .find((el) => visible(el));
      if (checkbox) {
        const rect = checkbox.getBoundingClientRect();
        return {
          clicked: false,
          ready: true,
          source: "visible_checkbox",
          x: clamp(rect.left + rect.width / 2, 3, window.innerWidth - 3),
          y: clamp(rect.top + rect.height / 2, 3, window.innerHeight - 3),
          widget_width: rect.width,
          widget_height: rect.height
        };
      }

      const widgets = Array.from(document.querySelectorAll("body *")).map((el) => {
        if (!visible(el)) return null;
        const text = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
        if (!text || text.length > 260) return null;
        const tl = text.toLowerCase();
        if (!tl.includes("verify you are human") && !tl.includes("cloudflare") && !tl.includes("checking your browser")) return null;
        const rect = el.getBoundingClientRect();
        return { el, rect, text };
      }).filter(Boolean).sort((a, b) => {
        const ar = a.rect.width * a.rect.height;
        const br = b.rect.width * b.rect.height;
        return ar - br;
      });
      const widget = widgets.find((w) => w.rect.width >= 120 && w.rect.height >= 40) || widgets[0];
      if (!widget) return { clicked: false, reason: "cf_widget_not_found" };
      const rect = widget.rect;
      const targetX = clamp(rect.left + Math.min(30, Math.max(18, rect.width * 0.08)), 3, window.innerWidth - 3);
      const targetY = clamp(rect.top + rect.height / 2, 3, window.innerHeight - 3);
      return {
        clicked: false,
        ready: true,
        source: "visible_cf_widget",
        x: targetX,
        y: targetY,
        widget_text: widget.text.slice(0, 160),
        widget_width: rect.width,
        widget_height: rect.height
      };
    }
  });
  let target = Array.isArray(frames) && frames[0] && frames[0].result ? frames[0].result : { clicked: false, reason: "empty_execute_result" };

  const rand = (min, max) => min + Math.random() * Math.max(0, max - min);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const domFallbackClick = async (reason, error = "") => {
    try {
      const fallbackFrames = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        args: [target.x, target.y],
        func: async (targetX, targetY) => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const rand = (min, max) => min + Math.random() * Math.max(0, max - min);
          const eventTargetAt = (x, y) => {
            try { return document.elementFromPoint(x, y) || document.body || document.documentElement; }
            catch (_) { return document.body || document.documentElement; }
          };
          const dispatch = (type, x, y, extra = {}) => {
            const targetEl = eventTargetAt(x, y);
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
                targetEl.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
              } else {
                targetEl.dispatchEvent(new MouseEvent(type, init));
              }
            } catch (_) {}
          };
          const startX = targetX + rand(-80, 120);
          const startY = targetY + rand(-50, 50);
          for (let i = 0; i < 8; i++) {
            const t = (i + 1) / 8;
            const x = startX + (targetX - startX) * t + rand(-1.5, 1.5);
            const y = startY + (targetY - startY) * t + rand(-1.5, 1.5);
            dispatch("pointermove", x, y);
            dispatch("mousemove", x, y);
            await sleep(rand(18, 40));
          }
          dispatch("pointerdown", targetX, targetY);
          dispatch("mousedown", targetX, targetY);
          await sleep(rand(60, 140));
          dispatch("pointerup", targetX, targetY);
          dispatch("mouseup", targetX, targetY);
          dispatch("click", targetX, targetY);
          return { clicked: true, via: "dom_fallback" };
        }
      });
      const res = Array.isArray(fallbackFrames) && fallbackFrames[0] ? fallbackFrames[0].result : null;
      if (res && res.clicked) return { ...target, ...res, fallback_reason: reason, fallback_error: error };
    } catch (fallbackError) {
      return { ...target, clicked: false, reason: "dom_fallback_failed", error: String(fallbackError && fallbackError.message || fallbackError) };
    }
    return { ...target, clicked: false, reason, error };
  };
  const send = async (method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
    await send("Page.enable").catch(() => null);
    await send("DOM.enable").catch(() => null);
    const cdpFindCloudflareTarget = async () => {
      const attrsOf = (node) => {
        const out = {};
        const attrs = Array.isArray(node && node.attributes) ? node.attributes : [];
        for (let i = 0; i + 1 < attrs.length; i += 2) out[String(attrs[i] || "").toLowerCase()] = String(attrs[i + 1] || "");
        return out;
      };
      const quadRect = (quad) => {
        if (!Array.isArray(quad) || quad.length < 8) return null;
        const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
        const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);
        return { left, top, right, bottom, width: right - left, height: bottom - top };
      };
      const metrics = await send("Page.getLayoutMetrics").catch(() => null);
      const viewport = metrics && metrics.visualViewport || {};
      const maxX = Number(viewport.clientWidth || 1920);
      const maxY = Number(viewport.clientHeight || 1080);
      const pageX = Number(viewport.pageX || 0);
      const pageY = Number(viewport.pageY || 0);
      const doc = await send("DOM.getFlattenedDocument", { depth: -1, pierce: true }).catch(() => null);
      const nodes = Array.isArray(doc && doc.nodes) ? doc.nodes : [];
      const findBySnapshot = async () => {
        const snap = await send("DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: true }).catch(() => null);
        const strings = Array.isArray(snap && snap.strings) ? snap.strings : [];
        const documents = Array.isArray(snap && snap.documents) ? snap.documents : [];
        const hits = [];
        for (const document of documents) {
          const nodeNames = document && document.nodes && document.nodes.nodeName || [];
          const attrs = document && document.nodes && document.nodes.attributes || [];
          const layout = document && document.layout || {};
          const layoutNodeIndexes = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
          const bounds = Array.isArray(layout.bounds) ? layout.bounds : [];
          const layoutByNode = new Map();
          for (let i = 0; i < layoutNodeIndexes.length; i += 1) {
            const rect = bounds[i];
            if (Array.isArray(rect) && rect.length >= 4) layoutByNode.set(Number(layoutNodeIndexes[i]), rect);
          }
          for (let i = 0; i < nodeNames.length; i += 1) {
            const name = String(strings[Number(nodeNames[i])] || "").toLowerCase();
            if (name !== "iframe") continue;
            const pairs = Array.isArray(attrs[i]) ? attrs[i] : [];
            const attrMap = {};
            for (let j = 0; j + 1 < pairs.length; j += 2) {
              attrMap[String(strings[Number(pairs[j])] || "").toLowerCase()] = String(strings[Number(pairs[j + 1])] || "");
            }
            const hay = `${attrMap.src || ""}\n${attrMap.title || ""}\n${attrMap.name || ""}\n${attrMap.id || ""}\n${attrMap.class || ""}`.toLowerCase();
            const rect = layoutByNode.get(i);
            if (!rect) continue;
            const left = Number(rect[0]) - pageX;
            const top = Number(rect[1]) - pageY;
            const width = Number(rect[2]);
            const height = Number(rect[3]);
            const visible = left + width > 0 && top + height > 0 && top < maxY && left < maxX;
            const isCf = hay.includes("challenges.cloudflare.com") || hay.includes("/cdn-cgi/") || hay.includes("turnstile") || hay.includes("cloudflare") || hay.includes("security challenge");
            const sized = width >= 180 && width <= 420 && height >= 40 && height <= 140;
            if (!visible || (!isCf && !sized)) continue;
            hits.push({ attrMap, rect: { left, top, width, height }, isCf, sized });
          }
        }
        hits.sort((a, b) => {
          if (a.isCf !== b.isCf) return a.isCf ? -1 : 1;
          if (a.sized !== b.sized) return a.sized ? -1 : 1;
          return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        });
        const hit = hits[0];
        if (!hit) return null;
        return {
          clicked: false,
          ready: true,
          source: hit.isCf ? "cdp_snapshot_cf_iframe" : "cdp_snapshot_sized_iframe",
          x: clamp(hit.rect.left + 18, 3, maxX - 3),
          y: clamp(hit.rect.top + hit.rect.height / 2, 3, maxY - 3),
          iframe_src: String(hit.attrMap.src || "").slice(0, 160),
          iframe_title: String(hit.attrMap.title || "").slice(0, 160),
          iframe_width: hit.rect.width,
          iframe_height: hit.rect.height
        };
      };
      const iframeNodes = nodes.map((node) => {
        const nodeName = String(node && node.nodeName || "").toLowerCase();
        if (nodeName !== "iframe") return null;
        const attrs = attrsOf(node);
        const hay = `${attrs.src || ""}\n${attrs.title || ""}\n${attrs.name || ""}\n${attrs.id || ""}\n${attrs.class || ""}`.toLowerCase();
        return {
          nodeId: node.nodeId,
          backendNodeId: node.backendNodeId,
          src: attrs.src || "",
          title: attrs.title || "",
          hay,
          isCf: hay.includes("challenges.cloudflare.com") || hay.includes("/cdn-cgi/") || hay.includes("turnstile") || hay.includes("cloudflare") || hay.includes("security challenge")
        };
      }).filter(Boolean);
      const scored = [];
      for (const node of iframeNodes) {
        const params = node.nodeId ? { nodeId: node.nodeId } : { backendNodeId: node.backendNodeId };
        const model = await send("DOM.getBoxModel", params).catch(() => null);
        const rect = quadRect(model && model.model && (model.model.border || model.model.content));
        if (!rect || rect.width <= 8 || rect.height <= 8) continue;
        const viewLeft = rect.left - pageX;
        const viewTop = rect.top - pageY;
        const viewRight = rect.right - pageX;
        const viewBottom = rect.bottom - pageY;
        const visible = viewRight > 0 && viewBottom > 0 && viewTop < maxY && viewLeft < maxX;
        const sized = rect.width >= 180 && rect.width <= 420 && rect.height >= 40 && rect.height <= 140;
        if (!visible || (!node.isCf && !sized)) continue;
        scored.push({ node, rect: { left: viewLeft, top: viewTop, right: viewRight, bottom: viewBottom, width: rect.width, height: rect.height }, sized });
      }
      scored.sort((a, b) => {
        if (a.node.isCf !== b.node.isCf) return a.node.isCf ? -1 : 1;
        if (a.sized !== b.sized) return a.sized ? -1 : 1;
        return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
      });
      const hit = scored[0];
      if (!hit) return await findBySnapshot();
      const rect = hit.rect;
      return {
        clicked: false,
        ready: true,
        source: hit.node.isCf ? "cdp_shadow_cf_iframe" : "cdp_shadow_sized_iframe",
        x: clamp(rect.left + 26, 3, maxX - 3),
        y: clamp(rect.top + rect.height / 2, 3, maxY - 3),
        iframe_src: hit.node.src.slice(0, 160),
        iframe_title: hit.node.title.slice(0, 160),
        iframe_width: rect.width,
        iframe_height: rect.height
      };
    };
    if (!target || !target.ready) {
      const cdpTarget = await cdpFindCloudflareTarget();
      if (cdpTarget && cdpTarget.ready) target = cdpTarget;
    }
    if (!target || !target.ready) {
      return { ...(target || {}), clicked: false, reason: "cdp_shadow_iframe_not_found", previous_reason: target && target.reason || null };
    }
    const metrics = await send("Page.getLayoutMetrics").catch(() => null);
    const viewport = metrics && metrics.visualViewport || {};
    const maxX = Number(viewport.clientWidth || 1920);
    const maxY = Number(viewport.clientHeight || 1080);
    let startX = clamp(target.x + rand(-90, 130), 3, maxX - 3);
    let startY = clamp(target.y + rand(-60, 60), 3, maxY - 3);
    for (let i = 0; i < 10; i++) {
      const t = (i + 1) / 10;
      const x = clamp(startX + (target.x - startX) * t + rand(-1.5, 1.5), 3, maxX - 3);
      const y = clamp(startY + (target.y - startY) * t + rand(-1.5, 1.5), 3, maxY - 3);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await sleep(rand(18, 45));
    }
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(rand(60, 145));
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1 });
    return { ...target, clicked: true, via: "debugger_cdp" };
  } catch (e) {
    if (!target || !target.ready) return { ...(target || {}), clicked: false, reason: "debugger_target_lookup_failed", error: String(e && e.message || e) };
    return await domFallbackClick("debugger_click_failed", String(e && e.message || e));
  } finally {
    if (attached) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    }
  }
}

async function waitGptCloudflareAutoPass(tabId, runtime = null, options = {}) {
  const maxWaitMs = Math.max(0, Number(options.maxWaitMs ?? options.max_wait_ms ?? 18000) || 18000);
  const maxClicks = Math.max(0, Number(options.maxClicks ?? options.max_clicks ?? 2) || 2);
  const start = Date.now();
  let clickedCount = 0;
  let consecutiveClear = 0;
  let last = null;
  try {
    await sleep(Math.max(0, Number(options.initialDelayMs ?? options.initial_delay_ms ?? 1200) || 1200));
    while (Date.now() - start < maxWaitMs) {
      last = await inspectGptCloudflarePage(tabId, true);
      if (!last.is_cloudflare) {
        consecutiveClear += 1;
        if (consecutiveClear >= 2) {
          try { await runtime?.progress?.(4, { stage: "gpt_cloudflare_passed" }); } catch (_) {}
          return { is_cloudflare: false, passed: true, clicked_count: clickedCount, last };
        }
        await sleep(800);
        continue;
      }
      consecutiveClear = 0;
      if (clickedCount < maxClicks) {
        const verifyTextClickRes = await doubleClickGptCloudflareVerifyText(tabId);
        const clickRes = await clickGptCloudflareCheckbox(tabId);
        if (clickRes && clickRes.clicked) clickedCount += 1;
        try {
          await runtime?.progress?.(4, {
            stage: clickRes && clickRes.clicked ? "gpt_cloudflare_checkbox_clicked" : "gpt_cloudflare_checkbox_missing",
            clicked_count: clickedCount,
            verify_text_clicked: verifyTextClickRes && verifyTextClickRes.clicked || false,
            verify_text_reason: verifyTextClickRes && verifyTextClickRes.reason || null,
            verify_text_source: verifyTextClickRes && verifyTextClickRes.source || null,
            verify_text_frame_url: verifyTextClickRes && verifyTextClickRes.frame_url || null,
            reason: clickRes && clickRes.reason || null,
            previous_reason: clickRes && clickRes.previous_reason || null,
            source: clickRes && clickRes.source || null,
            via: clickRes && clickRes.via || null,
            error: clickRes && clickRes.error || null,
            frame_url: clickRes && clickRes.frame_url || null,
            iframe_src: clickRes && clickRes.iframe_src || null,
            x: clickRes && clickRes.x || null,
            y: clickRes && clickRes.y || null,
            iframe_title: clickRes && clickRes.iframe_title || null,
            iframe_width: clickRes && clickRes.iframe_width || null,
            iframe_height: clickRes && clickRes.iframe_height || null
          });
        } catch (_) {}
        await sleep(clickRes && clickRes.clicked ? 5000 : 3000);
      } else {
        await sleep(1000);
      }
    }
  } catch (e) {
    return { is_cloudflare: true, passed: false, clicked_count: clickedCount, error: String(e && e.message || e), last };
  }
  last = last || await inspectGptCloudflarePage(tabId, true).catch(() => null);
  return { is_cloudflare: !!(last && last.is_cloudflare), passed: false, clicked_count: clickedCount, last };
}

export async function maybeHandleGptCloudflare(tabId, runtime = null, options = {}) {
  if (!tabId || options.disabled) return { checked: false, skipped: true };
  let info = null;
  try { info = await inspectGptCloudflarePage(tabId, false); } catch (_) { return { checked: false, skipped: true, reason: "inspect_failed" }; }
  if (!info || !info.is_cloudflare) return { checked: true, is_cloudflare: false };
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (_) {}
  try { await runtime?.progress?.(3, { stage: "gpt_cloudflare_detected", title: info.title || "", url: info.url || "" }); } catch (_) {}
  return await waitGptCloudflareAutoPass(tabId, runtime, options);
}

async function closeOtherTabsInSameWindow(keepTabId) {
  let keepTab = null;
  try { keepTab = await chrome.tabs.get(keepTabId); } catch (_) {}
  if (!keepTab || !keepTab.id || !keepTab.windowId) return 0;
  const query = keepTab && keepTab.windowId ? { windowId: keepTab.windowId } : {};
  const tabs = await chrome.tabs.query(query);
  const removeIds = [];
  for (const tab of tabs || []) {
    if (!tab || !tab.id || tab.id === keepTabId) continue;
    removeIds.push(tab.id);
  }
  if (removeIds.length) {
    try { await chrome.tabs.remove(removeIds); } catch (_) {}
  }
  return removeIds.length;
}

function closeOtherTabsInSameWindowLater(keepTabId, delayMs = 5000) {
  setTimeout(() => {
    closeOtherTabsInSameWindow(keepTabId).catch(() => {});
  }, Math.max(0, Number(delayMs || 0) || 0));
}

async function ensureGptTab(targetUrl = CHATGPT, options = {}) {
  const navigateToTarget = options.navigateToTarget === true;
  const origin = originFromTarget(targetUrl);
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find(t => (t.url || "") === targetUrl);
  const found = exact || tabs.find(t => (t.url || "").startsWith(origin + "/")) || tabs.find(t => (t.url || "").startsWith("https://chatgpt.com/"));
  if (found && found.id) {
    try {
      await chrome.tabs.get(found.id);
      if (targetUrl && (navigateToTarget ? (found.url || "") !== targetUrl : !(found.url || "").startsWith(origin + "/"))) {
        await chrome.tabs.update(found.id, { url: targetUrl, active: true });
        await waitTabComplete(found.id, 45000);
        await sleep(800);
      } else {
        await chrome.tabs.update(found.id, { active: true });
      }
      await maybeHandleGptCloudflare(found.id, options.runtime || null, options.cloudflare || {});
      return found.id;
    } catch (e) {
      if (!isNoTabError(e)) throw e;
      try {
        await options.runtime?.progress?.(2, { stage: "gpt_tab_missing_recreate", old_tab_id: found.id });
      } catch (_) {}
    }
  }
  const tab = await chrome.tabs.create({ url: targetUrl || CHATGPT, active: true });
  if (tab && tab.id) {
    await waitTabComplete(tab.id, 45000);
    await sleep(1200);
    await maybeHandleGptCloudflare(tab.id, options.runtime || null, options.cloudflare || {});
  }
  return tab.id;
}

async function pageFetch(tabId, url, { method = "GET", headers = {}, body = null } = {}) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url, { method, headers, body }],
    func: async (u, opts) => {
      const init = { method: opts.method || "GET", headers: opts.headers || {}, credentials: "include" };
      if (opts.body !== null && opts.body !== undefined) init.body = JSON.stringify(opts.body);
      const r = await fetch(u, init);
      const text = await r.text();
      const hdrs = {};
      try { for (const [k, v] of r.headers.entries()) hdrs[k] = v; } catch (_) {}
      let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
      return { status: r.status, headers: hdrs, text, json, url: r.url };
    }
  });
  const res = Array.isArray(frames) && frames[0] ? frames[0].result : null;
  if (!res) throw new Error(`GPT pageFetch returned empty result for ${url}`);
  return res;
}

function gptHeaders(token, path = "/", accept = "application/json") {
  const h = {
    "Authorization": `Bearer ${token}`,
    "Accept": accept,
    "Content-Type": "application/json",
    "Origin": CHATGPT,
    "Referer": CHATGPT + "/",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Priority": "u=1, i",
    "Sec-Ch-Ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    "Sec-Ch-Ua-Arch": '"x86"',
    "Sec-Ch-Ua-Bitness": '"64"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Model": '""',
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Ch-Ua-Platform-Version": '"19.0.0"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "OAI-Language": "en-US",
    "oai-hlib": "true",
    "oai-nav-state": "1",
    "oai-chat-web-route": "ChMxMC4xMzEuMTAxLjIzNjozMDAwENjSRg==",
    "OAI-Client-Version": WEB_CLIENT_VERSION,
    "OAI-Client-Build-Number": WEB_BUILD_NUMBER,
    "OAI-Device-Id": uuid(),
    "OAI-Session-Id": uuid(),
    "X-OpenAI-Target-Path": path,
    "X-OpenAI-Target-Route": path
  };
  if (accept === "text/event-stream") h["X-Oai-Turn-Trace-Id"] = uuid();
  return h;
}

async function getAuthSession(tabId, targetUrl) {
  const origin = originFromTarget(targetUrl);
  const r = await pageFetch(tabId, `${origin}/api/auth/session`, { headers: { "Accept": "application/json" } });
  const j = r && r.json || {};
  return {
    type: "gpt_auth_session",
    access_token: j.accessToken || j.access_token || j.token || "",
    expires: j.expires || null,
    email: j.user && j.user.email || null,
    account_id: accountIdFromInit(j) || null,
    raw: j,
    source: "extension.auth_session"
  };
}

async function getAccessToken(tabId, targetUrl) {
  const auth = await getAuthSession(tabId, targetUrl);
  const j = auth.raw || {};
  const tok = j.accessToken || j.access_token || j.token;
  if (!tok) throw new Error(`GPT access token not found: ${JSON.stringify(j).slice(0, 240)}`);
  return { type: "gpt_access_token", access_token: tok, expires: auth.expires || null, email: auth.email || null, account_id: auth.account_id || null, raw: j, source: "extension.auth_session" };
}

function utf8Bytes(s) {
  return new TextEncoder().encode(String(s || ""));
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function jsonB64(v) {
  return bytesToBase64(utf8Bytes(JSON.stringify(v)));
}

function hexToBytes(s) {
  let h = String(s || "").trim();
  if (!h) return null;
  if (h.length % 2) h = "0" + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

function rotl64(x, n) {
  n = BigInt(n);
  if (n === 0n) return x & MASK64;
  return ((x << n) | (x >> (64n - n))) & MASK64;
}

function keccakF1600(a) {
  const R = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
  ];
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  for (let round = 0; round < 24; round++) {
    const c = new Array(5).fill(0n);
    const d = new Array(5).fill(0n);
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x + 5 * y] = (a[x + 5 * y] ^ d[x]) & MASK64;
    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y], R[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x + 5 * y] = (b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])) & MASK64;
      }
    }
    a[0] = (a[0] ^ RC[round]) & MASK64;
  }
}

function sha3_512(bytes) {
  const state = new Array(25).fill(0n);
  let offset = 0;
  while (offset + SHA3_RATE_512 <= bytes.length) {
    for (let i = 0; i < SHA3_RATE_512; i++) {
      state[Math.floor(i / 8)] ^= BigInt(bytes[offset + i]) << BigInt((i % 8) * 8);
    }
    keccakF1600(state);
    offset += SHA3_RATE_512;
  }
  const block = new Uint8Array(SHA3_RATE_512);
  block.set(bytes.subarray(offset));
  block[bytes.length - offset] ^= 0x06;
  block[SHA3_RATE_512 - 1] ^= 0x80;
  for (let i = 0; i < SHA3_RATE_512; i++) {
    state[Math.floor(i / 8)] ^= BigInt(block[i]) << BigInt((i % 8) * 8);
  }
  keccakF1600(state);
  const out = new Uint8Array(64);
  for (let i = 0; i < out.length; i++) out[i] = Number((state[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 0xffn);
  return out;
}

function compareBytesLE(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

function powGenerate(seed, difficulty, config) {
  const diffBytes = hexToBytes(difficulty);
  if (!diffBytes || !diffBytes.length) return { answer: jsonB64(seed), solved: false };
  const static1 = JSON.stringify(config.slice(0, 3)).replace(/\]$/, ",");
  const mid = JSON.stringify(config.slice(4, 9)).replace(/^\[/, "").replace(/\]$/, "");
  const static2 = "," + mid + ",";
  const static3 = "," + JSON.stringify(config.slice(10)).replace(/^\[/, "");
  const seedBytes = utf8Bytes(seed);
  for (let i = 0; i < 500000; i++) {
    const final = static1 + String(i) + static2 + String(i >> 1) + static3;
    const encoded = bytesToBase64(utf8Bytes(final));
    const msg = new Uint8Array(seedBytes.length + encoded.length);
    msg.set(seedBytes, 0);
    msg.set(utf8Bytes(encoded), seedBytes.length);
    const digest = sha3_512(msg);
    if (compareBytesLE(digest.subarray(0, diffBytes.length), diffBytes) <= 0) return { answer: encoded, solved: true };
  }
  return { answer: jsonB64(seed), solved: false };
}

function estTimestampString() {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT-0500 (Eastern Standard Time)`;
}

function powConfig(userAgent = WEB_USER_AGENT) {
  const nowMs = Date.now() + Math.random();
  return [
    3000 + Math.floor(Math.random() * 3) * 1000,
    estTimestampString(),
    4294705152,
    0,
    userAgent,
    "https://chatgpt.com/backend-api/sentinel/sdk.js",
    "",
    "en-US",
    "en-US,es-US,en,es",
    0,
    "webdriver≭false",
    "location",
    "window",
    nowMs,
    uuid(),
    "",
    16,
    Date.now() + Math.random(),
  ];
}

function buildLegacyRequirementsToken(userAgent = WEB_USER_AGENT) {
  const seed = Math.random().toFixed(16);
  const { answer } = powGenerate(seed, "0fffff", powConfig(userAgent));
  return "gAAAAAC" + answer;
}

function buildProofToken(seed, difficulty, userAgent = WEB_USER_AGENT) {
  const { answer, solved } = powGenerate(seed, difficulty, powConfig(userAgent));
  if (!solved) return "gAAAAAB" + jsonB64(seed);
  return "gAAAAAB" + answer;
}

async function requirements(tabId, token) {
  const path = "/backend-api/sentinel/chat-requirements";
  const r = await pageFetch(tabId, CHATGPT + path, {
    method: "POST",
    headers: gptHeaders(token, path),
    body: { p: buildLegacyRequirementsToken() }
  });
  if (!r || r.status >= 400) throw new Error(`chat-requirements failed HTTP ${r && r.status}: ${(r && r.text || "").slice(0, 500)}`);
  const j = r.json || {};
  if (j.arkose && j.arkose.required) throw new Error("GPT chat-requirements requires arkose");
  if (!j.token) throw new Error(`chat-requirements missing token: ${JSON.stringify(j).slice(0, 300)}`);
  const pow = j.proofofwork || j.proof_of_work || {};
  let proof = j.proof_token || "";
  if (!proof && pow && pow.required && pow.seed && pow.difficulty) proof = buildProofToken(pow.seed, pow.difficulty);
  return { token: j.token, proof_token: proof, so_token: j.so_token || "" };
}

function withRequirementHeaders(headers, reqs, conduit = "") {
  const h = { ...headers, "OpenAI-Sentinel-Chat-Requirements-Token": reqs.token || "" };
  if (reqs.proof_token) h["OpenAI-Sentinel-Proof-Token"] = reqs.proof_token;
  if (reqs.so_token) h["OpenAI-Sentinel-SO-Token"] = reqs.so_token;
  if (conduit) {
    h["X-Conduit-Token"] = conduit;
    h["OpenAI-Conduit-Token"] = conduit;
  }
  return h;
}

async function prepare(tabId, token, reqs, model) {
  const path = "/backend-api/f/conversation/prepare";
  const r = await pageFetch(tabId, CHATGPT + path, {
    method: "POST",
    headers: withRequirementHeaders(gptHeaders(token, path, "*/*"), reqs),
    body: {
      action: "next",
      fork_from_shared_post: false,
      parent_message_id: "client-created-root",
      model,
      client_prepare_state: "none",
      timezone: "Asia/Shanghai",
      timezone_offset_min: -480,
      conversation_mode: { kind: "primary_assistant" },
      system_hints: ["picture_v2"],
      attachment_mime_types: ["image/png", "image/jpeg", "image/webp"],
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: { app_name: "chatgpt.com" },
      thinking_effort: "standard"
    }
  });
  if (!r || r.status >= 400) throw new Error(`conversation prepare failed HTTP ${r && r.status}: ${(r && r.text || "").slice(0, 500)}`);
  return (r.json || {}).conduit_token || "";
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl || "").split(",", 2);
  const mime = ((head.match(/^data:([^;]+)/) || [])[1] || "application/octet-stream");
  const bin = atob(b64 || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function downloadRefBlob(ref) {
  if (!ref) throw new Error("empty reference image");
  if (String(ref).startsWith("data:")) return dataUrlToBlob(ref);
  const r = await fetch(ref, { credentials: "omit" });
  if (!r.ok) throw new Error(`reference image download HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return await r.blob();
}

async function imageDimensions(blob) {
  try {
    if (typeof createImageBitmap === "function") {
      const bmp = await createImageBitmap(blob);
      const out = { width: bmp.width || 1024, height: bmp.height || 1024 };
      try { bmp.close(); } catch (_) {}
      return out;
    }
  } catch (_) {}
  return { width: 1024, height: 1024 };
}

async function processUploadStream(tabId, token, fileId, fileName) {
  const path = "/backend-api/files/process_upload_stream";
  const body = {
    file_id: fileId,
    use_case: "multimodal",
    index_for_retrieval: false,
    file_name: fileName,
    library_persistence_mode: "opportunistic",
    metadata: { store_in_library: true },
    entry_surface: "chat_composer"
  };
  const r = await pageFetch(tabId, CHATGPT + path, { method: "POST", headers: gptHeaders(token, path, "text/event-stream"), body });
  if (!r || r.status >= 400) throw new Error(`process upload HTTP ${r && r.status}: ${(r && r.text || "").slice(0, 300)}`);
  let libraryFileId = "";
  for (const line of String(r.text || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || !s.startsWith("{")) continue;
    try {
      const j = JSON.parse(s);
      if (j.extra && j.extra.metadata_object_id) libraryFileId = j.extra.metadata_object_id;
    } catch (_) {}
  }
  return libraryFileId;
}

async function uploadImage(tabId, token, ref, index, runtime) {
  const blob = await downloadRefBlob(ref);
  const fileName = `image_${index + 1}.${(blob.type || "image/png").includes("jpeg") ? "jpg" : "png"}`;
  const path = "/backend-api/files";
  const dims = await imageDimensions(blob);
  await runtime.progress(8, { stage: "upload_reference", index: index + 1, size: blob.size, mime: blob.type || "application/octet-stream" });
  const meta = await pageFetch(tabId, CHATGPT + path, {
    method: "POST",
    headers: gptHeaders(token, path),
    body: { file_name: fileName, file_size: blob.size, use_case: "multimodal", width: dims.width, height: dims.height }
  });
  if (!meta || meta.status >= 400) throw new Error(`upload meta HTTP ${meta && meta.status}: ${(meta && meta.text || "").slice(0, 300)}`);
  const fileId = meta.json && meta.json.file_id;
  const uploadUrl = meta.json && meta.json.upload_url;
  if (!fileId || !uploadUrl) throw new Error(`upload meta missing file_id/upload_url: ${JSON.stringify(meta.json || {}).slice(0, 300)}`);
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "application/octet-stream", "x-ms-blob-type": "BlockBlob", "x-ms-version": "2020-04-08" },
    body: blob
  });
  if (!put.ok) throw new Error(`upload blob HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
  const donePath = `/backend-api/files/${fileId}/uploaded`;
  const done = await pageFetch(tabId, CHATGPT + donePath, { method: "POST", headers: gptHeaders(token, donePath), body: {} });
  if (!done || done.status >= 400) throw new Error(`upload confirm HTTP ${done && done.status}: ${(done && done.text || "").slice(0, 300)}`);
  const libraryFileId = await processUploadStream(tabId, token, fileId, fileName);
  return { file_id: fileId, library_file_id: libraryFileId, file_name: fileName, file_size: blob.size, mime: blob.type || "image/png", width: dims.width, height: dims.height };
}

function messageContent(prompt, refs) {
  if (!refs || !refs.length) return { content: { content_type: "text", parts: [prompt] }, metadata: { system_hints: ["picture_v2"] } };
  const parts = [];
  const attachments = [];
  for (const ref of refs) {
    parts.push({ content_type: "image_asset_pointer", asset_pointer: "sediment://file_" + String(ref.file_id || "").replace(/^file_/, ""), width: ref.width || 1024, height: ref.height || 1024, size_bytes: ref.file_size || 0 });
    const att = { id: ref.file_id, mime_type: ref.mime, name: ref.file_name, size: ref.file_size, width: ref.width || 1024, height: ref.height || 1024, source: "library", is_big_paste: false };
    if (ref.library_file_id) att.library_file_id = ref.library_file_id;
    attachments.push(att);
  }
  parts.push(prompt);
  return {
    content: { content_type: "multimodal_text", parts },
    metadata: { system_hints: ["picture_v2"], attachments, developer_mode_connector_ids: [], selected_github_repos: [], selected_all_github_repos: false, serialization_metadata: { custom_symbol_offsets: [] } }
  };
}

function normalizeImage2Resolution(p) {
  const publicModel = String((p && (p.gpt_image2_model || p.model)) || "").trim().toLowerCase();
  if (GPT_IMAGE2_PUBLIC_MODELS[publicModel]) return GPT_IMAGE2_PUBLIC_MODELS[publicModel];
  for (const k of ["resolution", "size_tier", "gpt_image2_resolution", "image_resolution"]) {
    const v = String((p && p[k]) || "").trim().toLowerCase().replace(/\s+/g, "");
    if (v === "1" || v === "1k" || v === "k1") return "1k";
    if (v === "2" || v === "2k" || v === "k2") return "2k";
    if (v === "4" || v === "4k" || v === "k4") return "4k";
  }
  const size = String((p && p.size) || "").trim();
  if (size) return image2TierFromSize(size) || "1k";
  return "1k";
}

function image2TierFromSize(size) {
  const s = String(size || "").trim();
  if (!s) return "";
  for (const [tier, byRatio] of Object.entries(GPT_IMAGE2_SIZE_TABLE)) {
    if (Object.values(byRatio).includes(s)) return tier;
  }
  return "";
}

function image2RatioFromSize(size) {
  const s = String(size || "").trim();
  if (!s) return "";
  for (const byRatio of Object.values(GPT_IMAGE2_SIZE_TABLE)) {
    for (const [ratio, candidate] of Object.entries(byRatio)) {
      if (candidate === s) return ratio;
    }
  }
  return "";
}

function image2RatioSupported(ratio, tier = "") {
  const r = String(ratio || "").trim();
  if (!r) return false;
  if (tier && GPT_IMAGE2_SIZE_TABLE[tier]) return !!GPT_IMAGE2_SIZE_TABLE[tier][r];
  return Object.values(GPT_IMAGE2_SIZE_TABLE).some(byRatio => !!byRatio[r]);
}

function image2Gcd(a, b) {
  a = Math.abs(Math.trunc(a));
  b = Math.abs(Math.trunc(b));
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

function normalizeImage2RatioValue(raw) {
  let s = String(raw || "").trim().toLowerCase().replace(/：/g, ":").replace(/\s+/g, "");
  if (!s) return "";
  const aliases = {
    square: "1:1",
    landscape: "16:9",
    horizontal: "16:9",
    wide: "16:9",
    portrait: "9:16",
    vertical: "9:16"
  };
  if (aliases[s]) return aliases[s];
  if (image2RatioSupported(s)) return s;
  const m = s.match(/^(\d+)(?:[:/x])(\d+)$/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      const g = image2Gcd(w, h);
      const reduced = `${Math.trunc(w / g)}:${Math.trunc(h / g)}`;
      return image2RatioSupported(reduced) ? reduced : s;
    }
  }
  return s;
}

function image2ExplicitRatio(p) {
  if (!p) return "";
  for (const key of ["aspect_ratio", "ratio", "size_ratio", "aspectRatio"]) {
    const explicit = normalizeImage2RatioValue(p[key]);
    if (image2RatioSupported(explicit)) return explicit;
  }
  return "";
}

function normalizeImage2Ratio(p) {
  const explicit = image2ExplicitRatio(p);
  if (image2RatioSupported(explicit)) return explicit;
  return image2RatioFromSize(p && p.size) || GPT_IMAGE2_DEFAULT_RATIO;
}

function normalizeImage2Size(p, resolution = "") {
  const explicit = String((p && p.size) || "").trim();
  const tier = resolution || normalizeImage2Resolution(p);
  const ratio = normalizeImage2Ratio(p);
  const byRatio = GPT_IMAGE2_SIZE_TABLE[tier] || GPT_IMAGE2_SIZE_TABLE["1k"];
  const computed = byRatio[ratio] || byRatio[GPT_IMAGE2_DEFAULT_RATIO] || "1024x1024";
  if (explicit) {
    const publicModel = String((p && (p.gpt_image2_model || p.model)) || "").trim().toLowerCase();
    const explicitTier = image2TierFromSize(explicit);
    const explicitRatio = image2RatioFromSize(explicit);
    const ratioHint = image2ExplicitRatio(p);
    const explicitMatchesTier = Object.values(byRatio).includes(explicit);
    if (explicitTier && explicitTier !== tier) return computed;
    if (ratioHint && explicitRatio && explicitRatio !== ratio) return computed;
    if (!GPT_IMAGE2_PUBLIC_MODELS[publicModel] || explicitMatchesTier) return explicit;
  }
  return computed;
}

function parseSize(size) {
  const m = String(size || "").trim().match(/^(\d+)x(\d+)$/i);
  return { width: m ? Number(m[1]) : 1024, height: m ? Number(m[2]) : 1024 };
}

function isImage2Payload(p) {
  const vals = [p && p.gpt_image2_model, p && p.model, p && p.model_code, p && p.image_model_name, p && p.upstream_model];
  return vals.some(v => {
    const s = String(v || "").trim().toLowerCase();
    return !!(GPT_IMAGE2_PUBLIC_MODELS[s] || s === "gpt-image-2" || s === "gpt-image2");
  });
}

function normalizeImage2Payload(p) {
  const out = { ...(p || {}) };
  const resolution = normalizeImage2Resolution(out);
  const aspectRatio = normalizeImage2Ratio(out);
  const size = normalizeImage2Size(out, resolution);
  let publicModel = String(out.gpt_image2_model || out.model || "").trim().toLowerCase();
  if (!GPT_IMAGE2_PUBLIC_MODELS[publicModel]) publicModel = `gpt-image2-${resolution}`;
  out.workflow_kind = "image";
  out.gpt_image2_model = publicModel;
  out.model_code = "gpt-image-2";
  out.image_model_name = "gpt-image-2";
  out.resolution = resolution;
  out.size_tier = resolution.toUpperCase();
  out.aspect_ratio = aspectRatio;
  out.size = size;
  return out;
}

function normalizeWebModel(p, kind) {
  const explicit = p.web_model || p.chatgpt_model || p.model_slug;
  if (explicit) return explicit;
  if (isImage2Payload(p)) return "gpt-5-5-thinking";
  return p.model || p.model_code || (kind === "image" ? "gpt-5-5-thinking" : "gpt-5-5-thinking");
}

function mainModelForImage2(p) {
  const explicit = p && (p.main_model || p.codex_model || p.responses_model);
  return String(explicit || "gpt-5.5").trim();
}

function image2Quality(p) {
  switch (String((p && p.quality) || "").trim().toLowerCase()) {
    case "draft":
    case "low":
      return "low";
    case "standard":
    case "medium":
      return "medium";
    case "hd":
    case "high":
      return "high";
    default:
      return "";
  }
}

function copyIfPresent(dst, src, key) {
  if (!src || src[key] === undefined || src[key] === null || src[key] === "") return;
  dst[key] = src[key];
}

function codexInputImageItem(ref) {
  if (!ref) return null;
  if (typeof ref === "object") {
    const fileId = String(ref.file_id || ref.fileId || ref.id || "").trim();
    if (fileId) return { type: "input_image", file_id: fileId };
    const u = String(ref.url || ref.image_url || ref.src || "").trim();
    if (u) return { type: "input_image", image_url: u };
    return null;
  }
  const u = String(ref || "").trim();
  return u ? { type: "input_image", image_url: u } : null;
}

function codexImageMaskValue(mask) {
  if (!mask) return null;
  if (typeof mask === "object") {
    const fileId = String(mask.file_id || mask.fileId || mask.id || "").trim();
    if (fileId) return { file_id: fileId };
    const u = String(mask.url || mask.image_url || mask.src || "").trim();
    if (u) return { image_url: u };
    return null;
  }
  const u = String(mask || "").trim();
  return u ? { image_url: u } : null;
}

function codexImage2RequestBody(p, size, refs, maskRef = null) {
  const content = [{ type: "input_text", text: String(p.prompt || "") }];
  for (const ref of refs || []) {
    const item = codexInputImageItem(ref);
    if (item) content.push(item);
  }
  const action = (refs && refs.length) || String(p.operation || "").toLowerCase() === "edit" || String(p.mode || "").toLowerCase() === "i2i" ? "edit" : "generate";
  const tool = {
    type: "image_generation",
    action,
    model: "gpt-image-2",
    size
  };
  const defaultOutputFormat = preferredImage2OutputFormat(p);
  if (defaultOutputFormat) {
    tool.output_format = defaultOutputFormat;
    if (p.output_compression == null && p.compression == null) tool.output_compression = 85;
  }
  const quality = image2Quality(p);
  if (quality) tool.quality = quality;
  for (const key of ["background", "output_format", "output_compression", "partial_images", "moderation", "input_fidelity"]) copyIfPresent(tool, p, key);
  const mask = codexImageMaskValue(maskRef || p.mask || p.mask_image_url);
  if (mask) tool.input_image_mask = mask;
  return {
    instructions: "You are an image generation assistant. Follow the user's prompt and return the generated image.",
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    model: mainModelForImage2(p),
    store: false,
    tool_choice: "auto",
    input: [{ type: "message", role: "user", content }],
    tools: [tool]
  };
}

function codexHeaders(token, path = "/backend-api/codex/responses") {
  const h = gptHeaders(token, path, "text/event-stream");
  h["Originator"] = "codex-tui";
  h["Connection"] = "Keep-Alive";
  return h;
}

function shouldRetryCodexWithoutToolChoice(text) {
  const s = String(text || "").toLowerCase();
  return s.includes("tool choice") && s.includes("image_generation") && s.includes("not found") && s.includes("tools");
}

async function runImage2CodexOnce(tabId, token, p, size, refs, runtime, index, count, maskRef = null) {
  const path = "/backend-api/codex/responses";
  let body = codexImage2RequestBody(p, size, refs, maskRef);
  let retriedWithoutToolChoice = false;
  for (;;) {
    await runtime.progress(10 + Math.floor((index / Math.max(1, count)) * 70), {
      stage: "codex_responses",
      index: index + 1,
      count,
      size,
      main_model: body.model,
      ref_count: refs.length,
      has_tool_choice: !!body.tool_choice
    });
    const r = await pageFetch(tabId, CHATGPT + path, {
      method: "POST",
      headers: codexHeaders(token, path),
      body
    });
    if (!r || r.status >= 400) {
      const text = (r && r.text) || "";
      throwIfTooManyRequests(r && (r.json || r.text), "gpt-image-2 codex");
      if (!retriedWithoutToolChoice && shouldRetryCodexWithoutToolChoice(text)) {
        body = { ...body };
        delete body.tool_choice;
        retriedWithoutToolChoice = true;
        continue;
      }
      throw new Error(`gpt-image-2 codex responses HTTP ${r && r.status}: ${String(text).slice(0, 800)}`);
    }
    throwIfTooManyRequests(r.json || r.text, "gpt-image-2 codex");
    const urls = [];
    const fallbackOutputFormat = preferredImage2OutputFormat(p, image2TierFromSize(size) || "");
    for (const obj of parseSseJsonObjects(r.text)) collectGeneratedPayload(obj, urls, fallbackOutputFormat);
    if (!urls.length) {
      // 兜底用正则提取，兼容不同 SSE event 包装。
      const got = extractAssets(r.text);
      urls.push(...(got.urls || []));
    }
    return { urls: uniq(urls), raw_text_tail: String(r.text || "").slice(-2000) };
  }
}

async function runImage2CodexWorkflow(tabId, token, payload, runtime) {
  const p = normalizeImage2Payload(payload);
  const resolution = normalizeImage2Resolution(p);
  const aspectRatio = normalizeImage2Ratio(p);
  const size = normalizeImage2Size(p, resolution);
  const dims = parseSize(size);
  const refUrls = collectRefUrls(p);
  // Aligns with gpt2api-main: /backend-api/codex/responses + image_generation tool.
  // 参考图不走 ChatGPT Web 文件上传；直接作为 input_image.image_url 传给
  // /backend-api/codex/responses。调用方应尽量提供上游可访问的 https URL
  //（data:image/...;base64,... 也会被原样透传）。
  const refs = refUrls.map(u => String(u || "").trim()).filter(Boolean);
  const maskUrl = p.mask || p.mask_image_url;
  const maskRef = maskUrl ? String(maskUrl || "").trim() : null;
  const count = Math.max(1, Math.min(Number(p.count || p.n || 1) || 1, 4));
  const allUrls = [];
  let rawTextTail = "";
  await runtime.progress(5, { stage: "codex_start", resolution, aspect_ratio: aspectRatio, size, count, ref_count: refs.length });
  for (let i = 0; i < count && allUrls.length < count; i++) {
    const out = await runImage2CodexOnce(tabId, token, p, size, refs, runtime, i, count, maskRef);
    rawTextTail = out.raw_text_tail || rawTextTail;
    allUrls.push(...(out.urls || []));
  }
  let outUrls = uniq(allUrls).slice(0, count);
  if (!outUrls.length) throw new Error(`gpt-image-2 ${resolution} codex returned no images; tail=${rawTextTail.slice(-500)}`);
  let ossUploads = [];
  if ((p.oss_upload || p.extension_oss_upload) && outUrls.some(u => /^data:image\//i.test(String(u || "")))) {
    await runtime.progress(93, {
      stage: "codex_asset_ready",
      route: "codex",
      resolution,
      aspect_ratio: aspectRatio,
      size,
      asset_count: outUrls.length,
      data_url_count: outUrls.filter(u => /^data:image\//i.test(String(u || ""))).length
    });
    const uploadResult = await uploadDataUrlListToAliyunOss(outUrls, p.oss_upload || p.extension_oss_upload, {
      runtime,
      stage: "oss_upload",
      progress: 94,
      objectKeyPrefix: (p.oss_upload && p.oss_upload.object_key_prefix) || `gpt_workflow/image/gpt-image-2/${resolution}`,
      taskId: p._bridge_task_id || p.task_id || "",
      resolution
    });
    outUrls = uploadResult.values || outUrls;
    ossUploads = uploadResult.uploads || [];
  }
  await runtime.progress(100, { stage: "done", route: "codex", resolution, aspect_ratio: aspectRatio, size, asset_count: outUrls.length, oss_uploads: ossUploads.length });
  const ossMimeByUrl = new Map((ossUploads || []).map(u => [u.url, u.content_type || u.contentType || ""]));
  const assets = outUrls.map((url) => ({
    url,
    width: dims.width,
    height: dims.height,
    mime: ossMimeByUrl.get(url) || (/^data:image\/webp/i.test(url) ? "image/webp" : (/^data:image\/jpe?g/i.test(url) ? "image/jpeg" : "image/png"))
  }));
  return {
    type: "gpt_workflow_image",
    workflow_kind: "image",
    provider_route: "codex",
    model: p.gpt_image2_model,
    model_code: "gpt-image-2",
    resolution,
    aspect_ratio: aspectRatio,
    size,
    width: dims.width,
    height: dims.height,
    urls: outUrls,
    result_urls: outUrls,
    assets,
    oss_uploads: ossUploads,
    data: assets.map(a => ({ url: a.url, width: a.width, height: a.height, mime: a.mime })),
    share_url: outUrls[0] || "",
    image_url: outUrls[0] || "",
    raw_text_tail: rawTextTail
  };
}

async function pageDownloadAssetAsDataUrl(tabId, url, options = {}) {
  if (/^data:(image|video)\//i.test(String(url || ""))) return String(url || "");
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || options.timeout_ms || options.downloadTimeoutMs || options.download_timeout_ms || 60000) || 60000);
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [String(url || ""), {
      contentType: String(options.contentType || "").trim(),
      jpegQuality: Number.isFinite(Number(options.jpegQuality)) ? Number(options.jpegQuality) : 0.86,
      jpegBackground: String(options.jpegBackground || "#ffffff"),
      timeoutMs
    }],
    func: async (assetUrl, convertOptions) => {
      const encodeImageBlob = async (sourceBlob, targetMime, quality, background) => {
        if (!/^image\/jpe?g$/i.test(String(targetMime || "")) || !/^image\//i.test(String(sourceBlob && sourceBlob.type || ""))) {
          return sourceBlob;
        }
        const bitmap = await createImageBitmap(sourceBlob);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d", { alpha: false });
          ctx.fillStyle = background || "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bitmap, 0, 0);
          return await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob) resolve(blob);
              else reject(new Error("JPEG encode returned empty blob"));
            }, "image/jpeg", Math.max(0.1, Math.min(1, Number(quality) || 0.86)));
          });
        } finally {
          try { bitmap.close(); } catch (_) {}
        }
      };
      const timeoutMs = Math.max(5000, Number(convertOptions && convertOptions.timeoutMs || 60000) || 60000);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        try { controller.abort(); } catch (_) {}
      }, timeoutMs);
      let resp;
      try {
        resp = await fetch(assetUrl, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          signal: controller.signal
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error(`asset download timeout after ${timeoutMs}ms`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        let text = "";
        try { text = await resp.text(); } catch (_) {}
        throw new Error(`asset download HTTP ${resp.status}: ${String(text).slice(0, 240)}`);
      }
      let blob = await resp.blob();
      let mime = blob.type || resp.headers.get("content-type") || "";
      if (!/^(image|video)\//i.test(mime)) mime = "image/png";
      if (blob.type !== mime) blob = new Blob([blob], { type: mime });
      const targetMime = String(convertOptions && convertOptions.contentType || "").trim();
      if (/^image\/jpe?g$/i.test(targetMime)) {
        blob = await encodeImageBlob(blob, targetMime, convertOptions && convertOptions.jpegQuality, convertOptions && convertOptions.jpegBackground);
        mime = "image/jpeg";
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
      return {
        dataUrl,
        mime,
        size: blob.size || 0,
        finalUrl: resp.url || assetUrl
      };
    }
  });
  const res = Array.isArray(frames) && frames[0] ? frames[0].result : null;
  if (!res || !res.dataUrl) throw new Error(`asset download returned empty data URL: ${String(url || "").slice(0, 160)}`);
  return res.dataUrl;
}

function shouldProxyAssetThroughPage(url) {
  const s = String(url || "");
  if (/^data:(image|video)\//i.test(s)) return true;
  try {
    const u = new URL(s);
    return (
      (u.hostname === "chatgpt.com" || u.hostname === "chat.openai.com") &&
      (
        u.pathname.includes("/backend-api/estuary/content") ||
        u.pathname.includes("/backend-api/files/") ||
        u.pathname.includes("/backend-api/conversation/")
      )
    );
  } catch (_) {
    return false;
  }
}

async function uploadPageAccessibleAssetsToOss(tabId, urls, payload, runtime, options = {}) {
  const cfg = payload && (payload.oss_upload || payload.extension_oss_upload);
  const input = Array.isArray(urls) ? urls : [];
  if (!cfg || !input.length) return { values: input.slice(), uploads: [], skipped: true };
  const out = input.slice();
  const uploads = [];
  const dataUrls = [];
  const mapIndex = [];
  const proxiedTotal = input.filter(x => shouldProxyAssetThroughPage(String(x || ""))).length;
  for (let i = 0; i < input.length; i++) {
    const url = String(input[i] || "");
    if (!shouldProxyAssetThroughPage(url)) continue;
    if (runtime && typeof runtime.progress === "function") {
      try {
        await runtime.progress(options.downloadProgress || 90, {
          stage: options.downloadStage || "page_asset_download",
          index: dataUrls.length + 1,
          total: proxiedTotal,
          source_url: url.slice(0, 160)
        });
      } catch (_) {}
    }
    const dataUrl = await pageDownloadAssetAsDataUrl(tabId, url, {
      contentType: options.contentType,
      jpegQuality: options.jpegQuality,
      jpegBackground: options.jpegBackground,
      timeoutMs: options.downloadTimeoutMs || options.download_timeout_ms || options.timeoutMs || options.timeout_ms
    });
    dataUrls.push(dataUrl);
    mapIndex.push(i);
    if (runtime && typeof runtime.progress === "function") {
      try {
        await runtime.progress(options.downloadDoneProgress || 91, {
          stage: options.downloadDoneStage || "page_asset_download_done",
          index: dataUrls.length,
          total: proxiedTotal,
          data_url_length: dataUrl.length
        });
      } catch (_) {}
    }
  }
  if (!dataUrls.length) return { values: out, uploads, skipped: !uploads.length };
  const uploadResult = await uploadDataUrlListToAliyunOss(dataUrls, cfg, {
    runtime,
    stage: options.stage || "oss_upload",
    progress: options.progress || 92,
    objectKeyPrefix: (payload.oss_upload && payload.oss_upload.object_key_prefix) || options.objectKeyPrefix || "gpt_workflow/image",
    taskId: payload._bridge_task_id || payload.task_id || "",
    resolution: options.resolution || ""
  });
  if (uploadResult && uploadResult.skipped) return { values: out, uploads, skipped: !uploads.length };
  const values = uploadResult.values || dataUrls;
  for (let i = 0; i < mapIndex.length; i++) out[mapIndex[i]] = values[i] || out[mapIndex[i]];
  uploads.push(...(uploadResult.uploads || []));
  return { values: out, uploads, skipped: false };
}

function appendRatioHint(prompt, p) {
  const ratio = normalizeImage2Ratio(p);
  let out = prompt;
  if (ratio && ratio !== GPT_IMAGE2_DEFAULT_RATIO) out = `${out}\n\n将宽高比设为 ${ratio}`;
  if (isImage2Payload(p)) {
    const resolution = normalizeImage2Resolution(p).toUpperCase();
    const size = normalizeImage2Size(p, resolution.toLowerCase());
    out = `${out}\n\n使用 gpt-image-2 生成 ${resolution} 图片，输出尺寸为 ${size}。`;
  }
  return out;
}

async function startConversation(tabId, token, reqs, conduit, payload, kind, refs) {
  const model = normalizeWebModel(payload, kind);
  const prompt = kind === "image" ? appendRatioHint(payload.prompt || "", payload) : (payload.prompt || "");
  const mc = messageContent(prompt, refs);
  const path = "/backend-api/f/conversation";
  const body = {
    action: "next",
    fork_from_shared_post: false,
    parent_message_id: "client-created-root",
    model,
    client_prepare_state: "success",
    timezone: "Asia/Shanghai",
    timezone_offset_min: -480,
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: true,
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: { is_dark_mode: false, time_since_loaded: 51, page_height: 1111, page_width: 1731, pixel_ratio: 1.5, screen_height: 1440, screen_width: 2560, app_name: "chatgpt.com" },
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
    thinking_effort: "standard",
    messages: [{ id: uuid(), author: { role: "user" }, create_time: Math.floor(Date.now()/1000), content: mc.content, metadata: mc.metadata }]
  };
  const headers = withRequirementHeaders(gptHeaders(token, path, "text/event-stream"), reqs, conduit);
  const r = await pageFetch(tabId, CHATGPT + path, { method: "POST", headers, body });
  if (!r || r.status >= 400) throw new Error(`conversation failed HTTP ${r && r.status}: ${(r && r.text || "").slice(0, 600)}`);
  throwIfTooManyRequests(r.json || r.text, `GPT ${kind}`);
  const got = extractAssets(r.text);
  return { ...got, raw_text_tail: String(r.text || "").slice(-2000) };
}


async function runImage2Workflow(tabId, token, payload, runtime) {
  const p = normalizeImage2Payload(payload);
  const resolution = normalizeImage2Resolution(p);
  const aspectRatio = normalizeImage2Ratio(p);
  const size = normalizeImage2Size(p, resolution);
  const dims = parseSize(size);
  // 1K keeps the ChatGPT Web conversation route; 2K/4K uses Codex responses.
  // Aligns with gpt2api-main: /backend-api/codex/responses + image_generation tool.
  if (resolution === "2k" || resolution === "4k") {
    return await runImage2CodexWorkflow(tabId, token, p, runtime);
  }
  const out = await runConversationWorkflow(tabId, token, p, "image", runtime);
  let outUrls = uniq(out.urls || []);
  if (!outUrls.length) throw new Error(`gpt-image-2 ${resolution} returned no images`);
  let ossUploads = [];
  if (p.oss_upload || p.extension_oss_upload) {
    const uploadResult = await uploadPageAccessibleAssetsToOss(tabId, outUrls, p, runtime, {
      downloadStage: "page_asset_download",
      downloadProgress: 90,
      downloadDoneStage: "page_asset_download_done",
      downloadDoneProgress: 91,
      stage: "oss_upload",
      progress: 93,
      contentType: mimeForImageFormat(preferredImage2OutputFormat(p, resolution) || p.output_format || "jpeg"),
      jpegQuality: Number.isFinite(Number(p.jpeg_quality || p.jpegQuality)) ? Number(p.jpeg_quality || p.jpegQuality) : 0.86,
      downloadTimeoutMs: p.asset_download_timeout_ms || p.assetDownloadTimeoutMs || p.download_timeout_ms || p.downloadTimeoutMs,
      objectKeyPrefix: ((p.oss_upload || p.extension_oss_upload) && (p.oss_upload || p.extension_oss_upload).object_key_prefix) || `gpt_workflow/image/gpt-image-2/${resolution}`,
      resolution
    });
    outUrls = uploadResult.values || outUrls;
    ossUploads = uploadResult.uploads || [];
  }
  const ossMimeByUrl = new Map((ossUploads || []).map(u => [u.url, u.content_type || u.contentType || ""]));
  const assets = outUrls.map((url) => ({
    url,
    width: dims.width,
    height: dims.height,
    mime: ossMimeByUrl.get(url) || (/^data:image\/webp/i.test(url) ? "image/webp" : (/^data:image\/jpe?g/i.test(url) ? "image/jpeg" : "image/png"))
  }));
  await runtime.progress(100, { stage: "done", route: "conversation", resolution, aspect_ratio: aspectRatio, size, asset_count: outUrls.length, oss_uploads: ossUploads.length });
  return {
    ...out,
    type: "gpt_workflow_image",
    workflow_kind: "image",
    model: p.gpt_image2_model,
    model_code: "gpt-image-2",
    resolution,
    aspect_ratio: aspectRatio,
    size,
    width: dims.width,
    height: dims.height,
    urls: outUrls,
    result_urls: outUrls,
    assets,
    oss_uploads: ossUploads,
    data: assets.map(a => ({ url: a.url, width: a.width, height: a.height, mime: a.mime })),
    share_url: outUrls[0] || "",
    image_url: outUrls[0] || "",
    raw_text_tail: out.raw_text_tail || ""
  };
}

function isAssetURL(u) {
  if (/^data:(image|video)\//i.test(String(u || ""))) return true;
  try {
    const x = new URL(u);
    const h = x.hostname.toLowerCase();
    const p = x.pathname.toLowerCase();
    if (p.includes("/$web/chatgpt/") || p.includes("filled-plus-icon") || p.includes("logo")) return false;
    return h.includes("files.oaiusercontent.com") || h.includes("oaidalleapiprodscus.blob.core.windows.net") || (h.endsWith(".blob.core.windows.net") && !p.includes("/$web/")) || /\.(mp4|webm|png|jpg|jpeg|webp)(\?|$)/i.test(u);
  } catch (_) {
    return false;
  }
}

function mimeForImageFormat(format) {
  switch (String(format || "").trim().toLowerCase()) {
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function imageFormatForMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpeg";
  if (m.includes("webp")) return "webp";
  if (m.includes("png")) return "png";
  return "";
}

function preferredImage2OutputFormat(p, resolution = "") {
  const explicit = String((p && (p.output_format || p.format || p.response_format)) || "").trim().toLowerCase();
  if (explicit) return explicit;
  const tier = resolution || normalizeImage2Resolution(p);
  return tier === "2k" || tier === "4k" ? "jpeg" : "";
}

function addGeneratedURL(out, raw, outputFormat = "") {
  const u = String(raw || "").trim().replace(/\\\//g, "/").replace(/\\u0026/g, "&");
  if (!u) return;
  if (/^https?:\/\//i.test(u)) {
    if (isAssetURL(u) && !out.includes(u)) out.push(u);
    return;
  }
  if (/^data:(image|video)\//i.test(u)) {
    if (!out.includes(u)) out.push(u);
    return;
  }
  // response.output_item.done / response.completed 可能直接返回裸 base64。
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(u) && u.length > 256) {
    const dataUrl = `data:${mimeForImageFormat(outputFormat)};base64,${u.replace(/\s+/g, "")}`;
    if (!out.includes(dataUrl)) out.push(dataUrl);
  }
}

function collectGeneratedPayload(v, out, fallbackOutputFormat = "") {
  if (!v) return;
  if (Array.isArray(v)) {
    for (const item of v) collectGeneratedPayload(item, out, fallbackOutputFormat);
    return;
  }
  if (typeof v !== "object") return;
  const outputFormat = v.output_format || v.format || fallbackOutputFormat || "";
  addGeneratedURL(out, v.url, outputFormat);
  addGeneratedURL(out, v.download_url, outputFormat);
  addGeneratedURL(out, v.result, outputFormat);
  addGeneratedURL(out, v.b64_json, outputFormat);
  addGeneratedURL(out, v.image_b64, outputFormat);
  addGeneratedURL(out, v.partial_image_b64, outputFormat);
  for (const value of Object.values(v)) collectGeneratedPayload(value, out, outputFormat);
}

function parseSseJsonObjects(text) {
  const objects = [];
  const raw = String(text || "").trim();
  if (raw && (raw.startsWith("{") || raw.startsWith("["))) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) objects.push(...parsed);
      else objects.push(parsed);
      return objects;
    } catch (_) {}
  }
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try { objects.push(JSON.parse(data)); } catch (_) {}
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  flush();
  return objects;
}

function extractAssets(text) {
  const s = String(text || "");
  const conversation_id = ((s.match(/"conversation_id"\s*:\s*"([^"]+)"/) || [])[1] || "");
  const file_ids = [];
  const sediment_ids = [];
  const urls = [];
  for (const m of s.matchAll(/file[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}/g)) if (!file_ids.includes(m[0])) file_ids.push(m[0]);
  for (const m of s.matchAll(/sediment:\/\/([A-Za-z0-9_-]+)/g)) if (!sediment_ids.includes(m[1])) sediment_ids.push(m[1]);
  for (const m of s.matchAll(/https:\\?\/\\?\/[^\s"'\\]+/g)) {
    let u = m[0].replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    if (isAssetURL(u) && !urls.includes(u)) urls.push(u);
  }
  for (const obj of parseSseJsonObjects(s)) collectGeneratedPayload(obj, urls);
  return { conversation_id, file_ids, sediment_ids, urls };
}

function detectTooManyRequests(raw) {
  const text = typeof raw === "string" ? raw : (() => { try { return JSON.stringify(raw || ""); } catch (_) { return String(raw || ""); } })();
  const check = (obj) => {
    if (!obj || typeof obj !== "object") return "";
    const detail = obj.detail || (obj.error && obj.error.detail) || (obj.error && obj.error.message) || obj.message || "";
    return /too many requests/i.test(String(detail || "")) ? String(detail || "Too many requests") : "";
  };
  const direct = check(raw);
  if (direct) return direct;
  for (const obj of parseSseJsonObjects(text)) {
    const msg = check(obj);
    if (msg) return msg;
  }
  return /"detail"\s*:\s*"Too many requests"/i.test(text) || /Too many requests/i.test(text) ? "Too many requests" : "";
}

function throwIfTooManyRequests(raw, where = "GPT") {
  const msg = detectTooManyRequests(raw);
  if (msg) throw new Error(`${where}: ${msg}`);
}

function validateConversationMappingResponse(raw, where = "GPT conversation") {
  throwIfTooManyRequests(raw, where);
  const j = raw && typeof raw === "object" ? raw : null;
  const mapping = j && j.mapping && typeof j.mapping === "object" && !Array.isArray(j.mapping) ? j.mapping : null;
  if (!mapping) throw new Error(`${where}: invalid response missing mapping`);
  for (const node of Object.values(mapping)) {
    const msg = node && node.message;
    if (!msg || typeof msg !== "object") continue;
    if (msg.end_turn !== true) continue;
    if (String(msg.author && msg.author.role || msg.role || "").toLowerCase() !== "assistant") continue;
    const parts = msg.content && Array.isArray(msg.content.parts) ? msg.content.parts : [];
    const text = parts.filter(x => typeof x === "string" && x.trim()).join("\n").trim();
    if (text) throw new Error(`${where}: ${text.slice(0, 1000)}`);
  }
}

function filterGenerated(ids, refs) {
  const exclude = new Set();
  for (const r of refs || []) {
    if (r.file_id) exclude.add(r.file_id);
    if (r.library_file_id) exclude.add(r.library_file_id);
  }
  return uniq(ids).filter(x => !exclude.has(x));
}

async function downloadURL(tabId, token, path) {
  const r = await pageFetch(tabId, CHATGPT + path, { headers: gptHeaders(token, path) });
  if (!r || r.status >= 400) return "";
  return (r.json && (r.json.download_url || r.json.url)) || "";
}

async function resolveURLs(tabId, token, cid, fileIds, sedimentIds, refs) {
  const out = [];
  const files = filterGenerated(fileIds, refs);
  const seds = filterGenerated(sedimentIds, refs);
  for (const id of files) {
    if (!id || id === "file_upload") continue;
    let path = `/backend-api/files/download/${encodeURIComponent(id)}`;
    if (cid) path += `?conversation_id=${encodeURIComponent(cid)}&inline=false`;
    const u = await downloadURL(tabId, token, path);
    if (u && !out.includes(u)) out.push(u);
  }
  for (const id of seds) {
    if (!cid || !id) continue;
    const u = await downloadURL(tabId, token, `/backend-api/conversation/${encodeURIComponent(cid)}/attachment/${encodeURIComponent(id)}/download`);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

async function libraryAssetIDs(tabId, token, cid, refs, kind = "image") {
  if (!cid) return [];
  const path = "/backend-api/files/library";
  const r = await pageFetch(tabId, CHATGPT + path, {
    method: "POST",
    headers: gptHeaders(token, path),
    body: { limit: 20, cursor: null }
  });
  if (!r || r.status >= 400) return [];
  const items = (r.json && Array.isArray(r.json.items)) ? r.json.items : [];
  const ids = [];
  const wantVideo = String(kind || "").toLowerCase().includes("video");
  for (const item of items) {
    if (!item || !item.file_id || item.origination_thread_id !== cid) continue;
    if (item.state && String(item.state).toLowerCase() !== "ready") continue;
    const category = String(item.library_file_category || "").toLowerCase();
    const mime = String(item.mime_type || "").toLowerCase();
    if (wantVideo) {
      if (category && !category.includes("video") && !category.includes("image")) continue;
      if (mime && !mime.startsWith("video/") && !mime.startsWith("image/")) continue;
    } else {
      if (category && !category.includes("image")) continue;
      if (mime && !mime.startsWith("image/")) continue;
    }
    if (!ids.includes(item.file_id)) ids.push(item.file_id);
  }
  return filterGenerated(ids, refs);
}

async function pollConversation(tabId, token, cid, refs, maxWaitMs, intervalMs, runtime, kind = "image") {
  const end = Date.now() + maxWaitMs;
  let last = { conversation_id: cid, urls: [], file_ids: [], sediment_ids: [] };
  let attempt = 0;
  while (cid && Date.now() < end) {
    attempt++;
    const path = `/backend-api/conversation/${encodeURIComponent(cid)}`;
    const r = await pageFetch(tabId, CHATGPT + path, { headers: gptHeaders(token, path) });
    if (r && r.status < 400) {
      validateConversationMappingResponse(r.json, `GPT ${kind}`);
      const got = extractAssets(r.text);
      last.file_ids = uniq([...(last.file_ids || []), ...(got.file_ids || [])]);
      last.sediment_ids = uniq([...(last.sediment_ids || []), ...(got.sediment_ids || [])]);
      last.urls = uniq([...(last.urls || []), ...(got.urls || [])]);
      if (attempt === 1 || attempt % 6 === 0) {
        try {
          const libIds = await libraryAssetIDs(tabId, token, cid, refs, kind);
          last.file_ids = uniq([...(last.file_ids || []), ...libIds]);
        } catch (_) {}
      }
      const resolved = await resolveURLs(tabId, token, cid, last.file_ids, last.sediment_ids, refs);
      last.urls = uniq([...(last.urls || []), ...resolved]);
      if (last.urls.length) return last;
    }
    const pct = 20 + Math.min(75, Math.floor((1 - (end - Date.now()) / maxWaitMs) * 75));
    await runtime.progress(pct, { stage: "poll", attempt, conversation_id: cid, urls: last.urls.length, file_ids: last.file_ids.length, sediment_ids: last.sediment_ids.length });
    await sleep(intervalMs);
  }
  return last;
}

function collectRefUrls(p) {
  const out = [];
  const add = (v) => {
    let s = "";
    if (typeof v === "string") {
      s = v.trim();
    } else if (v && typeof v === "object") {
      let nestedImageURL = v.image_url;
      if (nestedImageURL && typeof nestedImageURL === "object") nestedImageURL = nestedImageURL.url;
      s = String(v.url || nestedImageURL || v.src || "").trim();
    }
    if (s && !out.includes(s)) out.push(s);
  };
  for (const k of ["image", "image_url", "imageUrl", "first_image_url", "firstImageUrl", "last_image_url", "lastImageUrl", "end_image_url", "endImageUrl", "mask_image_url", "mask", "reference_image"]) add(p[k]);
  for (const k of ["reference_urls", "reference_image_urls", "images", "image_urls", "imageUrls", "ref_assets", "reference_images", "input_images", "Ingredients_images", "ingredients_images"]) if (Array.isArray(p[k])) p[k].forEach(add);
  return out;
}

async function runConversationWorkflow(tabId, token, payload, kind, runtime) {
  await runtime.progress(5, { stage: "requirements", workflow_kind: kind });
  const reqs = await requirements(tabId, token);
  const refs = [];
  const refUrls = collectRefUrls(payload);
  for (let i = 0; i < refUrls.length; i++) refs.push(await uploadImage(tabId, token, refUrls[i], i, runtime));

  const count = Math.max(1, Math.min(Number(payload.count || payload.n || 1) || 1, 4));
  const maxWaitMs = Math.max(60, Number(payload.max_wait_seconds || payload.timeout_seconds || 600)) * 1000;
  const intervalMs = Math.max(500, Number(payload.poll_interval_seconds || 5) * 1000);
  const allUrls = [];
  const allFileIds = [];
  const allSedIds = [];
  const cids = [];
  let lastTail = "";

  for (let i = 0; i < count; i++) {
    const model = normalizeWebModel(payload, kind);
    const conduit = await prepare(tabId, token, reqs, model);
    await runtime.progress(15, { stage: "submit_conversation", index: i + 1, count });
    const started = await startConversation(tabId, token, reqs, conduit, payload, kind, refs);
    if (started.conversation_id) cids.push(started.conversation_id);
    lastTail = started.raw_text_tail || lastTail;
    let urls = uniq(started.urls || []);
    let fileIds = filterGenerated(started.file_ids || [], refs);
    let sedIds = filterGenerated(started.sediment_ids || [], refs);
    if (started.conversation_id && !urls.length) {
      const polled = await pollConversation(tabId, token, started.conversation_id, refs, maxWaitMs, intervalMs, runtime, kind);
      urls = uniq([...urls, ...(polled.urls || [])]);
      fileIds = uniq([...fileIds, ...(polled.file_ids || [])]);
      sedIds = uniq([...sedIds, ...(polled.sediment_ids || [])]);
    }
    allUrls.push(...urls);
    allFileIds.push(...fileIds);
    allSedIds.push(...sedIds);
    if (kind === "video" && urls.length) break;
  }

  const urls = uniq(allUrls);
  const file_ids = uniq(allFileIds);
  const sediment_ids = uniq(allSedIds);
  if (!urls.length) throw new Error(`GPT ${kind} returned no asset urls; conversation_id=${cids[0] || ""} file_ids=${file_ids.length} sediment_ids=${sediment_ids.length}`);
  await runtime.progress(88, { stage: "done", asset_count: urls.length, file_ids: file_ids.length, sediment_ids: sediment_ids.length });
  return {
    type: kind === "video" ? "gpt_workflow_video" : "gpt_workflow_image",
    workflow_kind: kind,
    conversation_id: cids[0] || "",
    conversation_ids: cids,
    urls,
    file_ids,
    sediment_ids,
    share_url: urls[0] || "",
    image_url: kind === "image" ? (urls[0] || "") : undefined,
    video_url: kind === "video" ? (urls[0] || "") : undefined,
    raw_text_tail: lastTail
  };
}

function isImageQuotaFeature(name) {
  const n = String(name || "").toLowerCase();
  return ["image_gen", "image_generation", "image_edit", "img_gen"].includes(n) || n.includes("image_gen") || n.includes("img_gen");
}

function parseResetAfter(raw) {
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = raw > 10000000000 ? raw / 1000 : raw;
    return Math.floor(n);
  }
  const s = String(raw || "").trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n > 10000000000 ? n / 1000 : n);
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

function formatLocalDateTime(rawTs) {
  const ts = parseResetAfter(rawTs);
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBeijingDateTime(raw) {
  const ts = parseResetAfter(raw);
  if (!ts) return "";
  // active_until 返回 UTC/Z 时间；会员到期时间固定按北京时间（UTC+8）展示/入库。
  const d = new Date((ts + 8 * 3600) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function accountIdFromInit(data) {
  const d = data && typeof data === "object" ? data : {};
  const account = d.account && typeof d.account === "object" ? d.account : null;
  const direct = d.account_id || d.accountId || d.current_account_id || d.currentAccountId || (account && (account.id || account.account_id || account.accountId));
  if (direct) return String(direct).trim();
  const accounts = Array.isArray(d.accounts) ? d.accounts : [];
  for (const item of accounts) {
    if (item && typeof item === "object" && (item.id || item.account_id || item.accountId)) {
      return String(item.id || item.account_id || item.accountId).trim();
    }
  }
  return "";
}

async function fetchSubscriptionInfo(tabId, token, initData) {
  const accountId = accountIdFromInit(initData);
  if (!accountId) return { account_id: null, subscription_end: null, subscription_error: "account_id_missing" };
  const path = `/backend-api/subscriptions?account_id=${encodeURIComponent(accountId)}`;
  const r = await pageFetch(tabId, CHATGPT + path, {
    method: "GET",
    headers: token
      ? gptHeaders(token, path)
      : { "Accept": "application/json", "Content-Type": "application/json", "OAI-Language": "en-US" }
  });
  if (!r || r.status >= 400) {
    return {
      account_id: accountId,
      subscription_end: null,
      subscription_error: `subscriptions HTTP ${r && r.status}: ${(r && r.text || "").slice(0, 300)}`
    };
  }
  const sub = r.json && typeof r.json === "object" ? r.json : {};
  const activeUntil = sub.active_until || sub.activeUntil || sub.current_period_end || sub.expires_at || null;
  const activeStart = sub.active_start || sub.activeStart || null;
  const subscriptionEnd = formatBeijingDateTime(activeUntil);
  return {
    account_id: accountId,
    subscription_end: subscriptionEnd || null,
    active_until: activeUntil,
    active_start: activeStart,
    plan_type: sub.plan_type || sub.planType || null,
    membership: sub.plan_type || sub.planType || null,
    billing_period: sub.billing_period || sub.billingPeriod || null,
    will_renew: sub.will_renew,
    is_delinquent: sub.is_delinquent,
    subscription_raw: sub
  };
}

function normalizeBalance(data) {
  const d = data && typeof data === "object" ? data : {};
  let remaining = -1, total = -1, resetAt = 0;
  const limits = Array.isArray(d.limits_progress) ? d.limits_progress : [];
  for (const item of limits) {
    if (!item || !isImageQuotaFeature(item.feature_name)) continue;
    if (item.remaining != null && (remaining < 0 || Number(item.remaining) < remaining)) remaining = Number(item.remaining) || 0;
    const maxV = item.max_value ?? item.cap ?? item.total ?? item.limit;
    if (maxV != null && Number(maxV) > total) total = Number(maxV) || 0;
    if (total < 0 && item.remaining != null) {
      const used = item.used ?? item.used_value ?? item.consumed;
      if (used != null) total = (Number(item.remaining) || 0) + (Number(used) || 0);
    }
    if (item.reset_after) {
      const ts = parseResetAfter(item.reset_after);
      if (Number.isFinite(ts) && ts > 0 && (!resetAt || ts < resetAt)) resetAt = ts;
    }
  }
  if (remaining < 0) remaining = Number(d.image_quota_remaining ?? d.remaining ?? d.remaining_quota ?? d.credits ?? 0) || 0;
  if (total < 0) total = Number(d.image_quota_total ?? d.quota_total ?? d.total ?? d.limit ?? 0) || 0;
  if (!resetAt) resetAt = parseResetAfter(d.image_quota_reset_at ?? d.reset_at ?? d.reset_after);
  const cooldownUntil = formatLocalDateTime(resetAt);
  return { remaining: Math.max(0, remaining), image_quota_remaining: Math.max(0, remaining), image_quota_total: Math.max(0, total), image_quota_reset_at: resetAt, cooldown_until: cooldownUntil || null, default_model_slug: d.default_model_slug || null, blocked_features: Array.isArray(d.blocked_features) ? d.blocked_features : [], raw: d };
}

function jwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - parts[1].length % 4) % 4);
    const json = decodeURIComponent(Array.from(atob(b64)).map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) {
    return {};
  }
}

function planFromToken(token) {
  const p = jwtPayload(token);
  const auth = p && p["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    for (const k of ["chatgpt_plan_type", "plan_type", "account_plan_type"]) {
      const v = String(auth[k] || "").trim();
      if (v) return v;
    }
  }
  for (const k of ["chatgpt_plan_type", "plan_type", "account_plan", "account_plan_type"]) {
    const v = String(p[k] || "").trim();
    if (v) return v;
  }
  return "";
}

async function refreshBalanceTask(tabId, token, runtime) {
  const path = "/backend-api/conversation/init";
  await runtime.progress(15, { stage: "conversation_init" });
  const h = gptHeaders(token, path);
  h["x-oai-is"] = "ois1";
  const r = await pageFetch(tabId, CHATGPT + path, {
    method: "POST",
    headers: h,
    body: {
      gizmo_id: null,
      requested_default_model: null,
      conversation_id: null,
      timezone_offset_min: -480,
      system_hints: ["picture_v2"]
    }
  });
  if (!r || r.status >= 400) throw new Error(`GPT balance conversation/init HTTP ${r && r.status}: ${(r && r.text || "").slice(0, 500)}`);
  const initData = r.json || {};
  const info = normalizeBalance(initData);
  await runtime.progress(100, { stage: "done", remaining: info.remaining, total: info.image_quota_total, cooldown_until: info.cooldown_until || null });
  return { type: "gpt_balance", ...info, source: "conversation_init" };
}

async function membershipTask(tabId, token, runtime, target = CHATGPT) {
  await runtime.progress(10, { stage: "auth_session" });
  let auth = {};
  let authRaw = {};
  let useToken = token;
  let authError = null;
  try {
    auth = await getAuthSession(tabId, target);
    authRaw = auth.raw || {};
    if (auth.access_token) useToken = auth.access_token;
  } catch (e) {
    authError = String(e && e.message || e || "auth_session_failed");
  }

  const account = authRaw && typeof authRaw === "object" && authRaw.account && typeof authRaw.account === "object" ? authRaw.account : null;
  const accountPlan = account && (account.planType || account.plan_type);
  await runtime.progress(45, { stage: "subscriptions", account_id: accountIdFromInit(authRaw) || null });
  const sub = await fetchSubscriptionInfo(tabId, useToken, authRaw);
  const membership = String(accountPlan || planFromToken(useToken) || sub.membership || sub.plan_type || "").trim();
  await runtime.progress(100, { stage: "done", account_id: sub.account_id || accountIdFromInit(authRaw) || null, subscription_end: sub.subscription_end || null, membership: membership || null });
  return {
    type: "gpt_membership",
    membership: membership || null,
    plan_type: membership || null,
    plan_title: membership || null,
    subscription_end: sub.subscription_end || null,
    active_until: sub.active_until || null,
    active_start: sub.active_start || null,
    account_id: sub.account_id || accountIdFromInit(authRaw) || null,
    billing_period: sub.billing_period || null,
    will_renew: sub.will_renew,
    is_delinquent: sub.is_delinquent,
    access_token: auth.access_token || null,
    expires: auth.expires || null,
    raw: { auth_session: authRaw || null, subscription: sub.subscription_raw || null, subscription_error: sub.subscription_error || null, auth_error: authError }
  };
}

async function queryProgressTask(tabId, token, p, runtime) {
  const cid = p.conversation_id || p.conversationId || "";
  if (!cid) throw new Error("query_progress missing conversation_id");
  const kind = p.workflow_kind || "image";
  const got = await pollConversation(tabId, token, cid, [], Math.max(5, Number(p.max_wait_seconds || 20)) * 1000, Math.max(500, Number(p.poll_interval_seconds || 2) * 1000), runtime, kind);
  const file_ids = uniq([...(Array.isArray(p.file_ids) ? p.file_ids : []), ...(got.file_ids || [])]);
  const sediment_ids = uniq([...(Array.isArray(p.sediment_ids) ? p.sediment_ids : []), ...(got.sediment_ids || [])]);
  const resolved = await resolveURLs(tabId, token, cid, file_ids, sediment_ids, []);
  const urls = uniq([...(got.urls || []), ...resolved]);
  await runtime.progress(urls.length ? 100 : 60, { stage: urls.length ? "done" : "pending", conversation_id: cid, asset_count: urls.length });
  return { type: "gpt_progress", status: urls.length ? "completed" : "in_progress", workflow_kind: kind, conversation_id: cid, urls, image_url: kind === "image" ? (urls[0] || "") : undefined, video_url: kind === "video" ? (urls[0] || "") : undefined, file_ids, sediment_ids };
}

async function runVideoWorkflow(tabId, token, payload, runtime) {
  await runtime.progress(5, { stage: "video_reserved", workflow_kind: "video" });
  throw new Error("GPT video workflow is reserved but not implemented yet");
}

export async function runGptTask(msg, runtime) {
  const p = msg.payload || {};
  const target = p.target_url || p.gpt_url || CHATGPT;
  const action = String(p.action || p.workflow_kind || "").trim();

  if (action === "get_access_token" || action === "fetch_access_token" || action === "fetch_tokens") {
    const tabId = await ensureGptTab(target, { navigateToTarget: true, runtime });
    await reloadProjectPage(5, tabId, target, runtime);
    const cloudflareResult = await maybeHandleGptCloudflare(tabId, runtime, {
      maxWaitMs: 65000,
      maxClicks: 4,
      initialDelayMs: 1500
    });
    let tokenInfo = null;
    try {
      tokenInfo = await getAccessToken(tabId, target);
    } catch (e) {
      await reloadProjectPage(2, tabId, target, runtime);
      await maybeHandleGptCloudflare(tabId, runtime);
      tokenInfo = await getAccessToken(tabId, target);
    }
    closeOtherTabsInSameWindowLater(tabId, 5000);
    try { await runtime.progress(95, { stage: "close_other_tabs_scheduled", delay_ms: 5000 }); } catch (_) {}
    return tokenInfo;
  }

  const tabId = await ensureGptTab(target, { runtime });
  try { await runtime?.setGptBusyTab?.(tabId); } catch (_) {}
  try {

  if (action === "refresh_membership" || action === "membership_refresh" || action === "get_membership" || action === "membership" || action === "subscription_info") {
    let token = p.access_token || "";
    if (!token) {
      try { token = (await getAccessToken(tabId, target)).access_token || ""; } catch (_) {}
    }
    return await membershipTask(tabId, token, runtime, target);
  }

  const token = p.access_token || (await getAccessToken(tabId, target)).access_token;
  if (!token) throw new Error("GPT access_token missing");

  if (action === "refresh_balance" || action === "balance_refresh" || action === "get_balance" || action === "balance") {
    return await refreshBalanceTask(tabId, token, runtime);
  }
  if (action === "query_progress" || action === "poll_task" || action === "get_task") {
    return await queryProgressTask(tabId, token, p, runtime);
  }

  const kind = (p.workflow_kind || "").toLowerCase().includes("video") ? "video" : "image";
  const shouldRunPreWorkflowActivity = kind === "video" || (kind === "image" && isImage2Payload(p));
  if (shouldRunPreWorkflowActivity) {
    // runImage2Workflow / runVideoWorkflow 前刷新页面并引入拟人操作
    await reloadProjectPage(5, tabId, target, runtime);
    const cloudflareResult = await maybeHandleGptCloudflare(tabId, runtime, {
      maxWaitMs: 65000,
      maxClicks: 4,
      initialDelayMs: 1500
    });
    if (cloudflareResult && cloudflareResult.is_cloudflare && !cloudflareResult.passed) {
      throw new Error(`GPT Cloudflare auto-pass failed after 65s: ${JSON.stringify(cloudflareResult).slice(0, 500)}`);
    }
    /*
    await simulateHumanActivity(tabId, runtime, 5000, 15000, {
      stage: "gpt_pre_workflow_human_activity",
      progress: 5,
      clickInputs: true,
      scroll: true,
      moveMouse: true
    });
    */
  }
  if (kind === "video") {
    return await runVideoWorkflow(tabId, token, p, runtime);
  }
  if (kind === "image" && isImage2Payload(p)) {
    return await runImage2Workflow(tabId, token, p, runtime);
  }
  return await runConversationWorkflow(tabId, token, p, kind, runtime);
  } finally {
    try { await runtime?.clearGptBusyTab?.(tabId); } catch (_) {}
  }
}
