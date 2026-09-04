import { dismissVeoChangelogModalIfPresent, runVeoTask } from "./providers/veo_provider.js";
import { runDreaminaTask } from "./providers/dreamina_provider.js";
import { maybeHandleGptCloudflare, runGptTask } from "./providers/gpt_provider.js";
import { runNetworkTask, handleNetworkRuntimeMessage, runDebuggerExpression } from "./providers/network_provider.js";

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let currentConnectKey = "";
let connectSeq = 0;
const HEARTBEAT_INTERVAL_MS = 15000;
const NEWAPI_CHARGE_BASE_URL = "https://www.newtoken.club";
const NEWAPI_CHARGE_MODEL = "fpbrowser-use";
const ANALYSIS_WINDOW_STATE_STORAGE_KEY = "analysis_window_state";
// 临时关闭 NewAPI 扣费。需要恢复时改为 true 即可。
const NEWAPI_CHARGE_ENABLED = false;
const VEO_HUMAN_ACTIVITY_ACTIONS = new Set(["human_activity", "simulate_human_activity"]);
const analysisAiControllers = new Map();
const analysisWindowStateTimers = new Map();
let status = {
  bridgeUrl: "",
  spaceId: "",
  windowKey: "",
  wsState: "init",
  connected: false,
  helloOk: false,
  clientId: "",
  lastError: "",
  lastEventAt: null,
  reconnectScheduled: false,
  activeTask: null
};

function isAnalysisPageUrl(url) {
  return String(url || "").startsWith(chrome.runtime.getURL("analysis.html"));
}

async function windowHasAnalysisPage(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    return (tabs || []).some(tab => isAnalysisPageUrl(tab && tab.url));
  } catch (_) {
    return false;
  }
}

async function saveAnalysisWindowState(win) {
  if (!win || !win.id) return;
  if (!await windowHasAnalysisPage(win.id)) return;
  const state = String(win.state || "normal");
  const patch = {
    state,
    updated_at: new Date().toISOString()
  };
  if (Number.isFinite(win.left)) patch.left = win.left;
  if (Number.isFinite(win.top)) patch.top = win.top;
  if (Number.isFinite(win.width)) patch.width = win.width;
  if (Number.isFinite(win.height)) patch.height = win.height;
  try { await chrome.storage.local.set({ [ANALYSIS_WINDOW_STATE_STORAGE_KEY]: patch }); } catch (_) {}
}

function queueAnalysisWindowStateSave(win) {
  if (!win || !win.id) return;
  const oldTimer = analysisWindowStateTimers.get(win.id);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    analysisWindowStateTimers.delete(win.id);
    saveAnalysisWindowState(win).catch(() => {});
  }, 250);
  analysisWindowStateTimers.set(win.id, timer);
}

function beijingTimeString(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad2 = n => String(n).padStart(2, "0");
  const pad3 = n => String(n).padStart(3, "0");
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.${pad3(d.getUTCMilliseconds())} 北京时间`;
}

async function pushLog(level, message, data = null) {
  const row = {
    ts: beijingTimeString(),
    level,
    message,
    data
  };
  try {
    const got = await chrome.storage.local.get(["debug_logs"]);
    const logs = Array.isArray(got.debug_logs) ? got.debug_logs : [];
    logs.unshift(row);
    await chrome.storage.local.set({ debug_logs: logs.slice(0, 80) });
  } catch (_) {}
}

async function setStatus(patch) {
  status = { ...status, ...patch, lastEventAt: beijingTimeString() };
  status.connected = status.wsState === "open";
  try {
    await chrome.storage.local.set({ runtime_status: status });
    const color = status.connected ? "#16a34a" : (status.wsState === "connecting" ? "#f59e0b" : "#dc2626");
    await chrome.action.setBadgeText({ text: status.connected ? "ON" : "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {}
}

async function getConfig() {
  const cfg = await chrome.storage.local.get([
    "bridge_url",
    "bridge_token",
    "space_id",
    "window_key",
    "google_account",
    "google_password",
    "google_efa",
    "google_auto_login_watch_enabled",
    "veo_archive_enabled"
  ]);
  return {
    bridgeUrl: cfg.bridge_url || "",
    bridgeToken: cfg.bridge_token || "",
    spaceId: cfg.space_id || "",
    windowKey: cfg.window_key || "",
    googleAccount: cfg.google_account || "",
    googlePassword: cfg.google_password || "",
    googleEfa: cfg.google_efa || "",
    googleAutoLoginWatchEnabled: cfg.google_auto_login_watch_enabled !== false,
    veoArchiveEnabled: cfg.veo_archive_enabled !== false
  };
}

async function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("bridge websocket is not open");
  ws.send(JSON.stringify(obj));
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(socket, seq) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try {
      if (ws !== socket || seq !== connectSeq || !socket || socket.readyState !== WebSocket.OPEN) {
        stopHeartbeat();
        return;
      }
      socket.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
    } catch (e) {
      stopHeartbeat();
      try { socket.close(); } catch (_) {}
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function chargeNewapiUsage(reason, meta = {}) {
  if (!NEWAPI_CHARGE_ENABLED) {
    await pushLog("info", "NewAPI 扣费已临时关闭，跳过", { reason, model: NEWAPI_CHARGE_MODEL, meta });
    return { ok: true, skipped: true, reason: "newapi_charge_disabled" };
  }
  const cfg = await getConfig();
  const token = String(cfg.bridgeToken || "").trim();
  if (!token) {
    throw new Error("NewAPI 扣费令牌为空：请先在 bridgeToken 中填写 fpbrowser-use 模型令牌");
  }
  const url = `${NEWAPI_CHARGE_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions`;
  const body = {
    model: NEWAPI_CHARGE_MODEL,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          action: "charge",
          reason: String(reason || "fpbrowser_use"),
          ts: Date.now(),
          ...meta
        })
      }
    ],
    max_tokens: 1,
    temperature: 0
  };
  await pushLog("info", "NewAPI charge start", { reason, model: NEWAPI_CHARGE_MODEL });
  let resp;
  let text = "";
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });
    text = await resp.text();
  } catch (e) {
    await pushLog("error", "NewAPI 扣费请求失败", { reason, error: String(e && e.message || e) });
    throw new Error(`NewAPI 扣费请求失败：${String(e && e.message || e)}`);
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!resp.ok) {
    const msg = (json && (json.error && (json.error.message || json.error.code) || json.message || json.detail)) || text || `HTTP ${resp.status}`;
    await pushLog("error", "NewAPI 扣费失败", { reason, status: resp.status, response: String(msg).slice(0, 500) });
    throw new Error(`NewAPI 扣费失败：${msg}`);
  }
  await pushLog("info", "NewAPI 扣费成功", {
    reason,
    status: resp.status,
    id: json && json.id,
    usage: json && json.usage
  });
  return json || { ok: true };
}

function normalizeRedirectUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch (_) {}
  return "";
}

async function waitForBridgeReady(timeoutMs = 5000) {
  const end = Date.now() + Math.max(0, Number(timeoutMs || 0));
  while (Date.now() < end) {
    if (status.wsState === "open" && status.helloOk) return true;
    await sleep(120);
  }
  return status.wsState === "open" && status.helloOk;
}

function buildAnalysisGeneratedTestExpression(code, config) {
  const codeText = String(code || "").trim();
  const configJson = JSON.stringify(config || {});
  const codeHead = JSON.stringify(codeText.slice(0, 500));
  return `
(async function() {
  function toPlain(value) {
    if (value == null) return value;
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    try {
      JSON.stringify(value);
      return value;
    } catch (_) {
      return String(value);
    }
  }

  try {
    var config = ${configJson};
    var module = { exports: {} };
    var exports = module.exports;
${codeText}
    var runner = (typeof runGeneratedTest === "function" ? runGeneratedTest :
      (typeof runTest === "function" ? runTest :
      (typeof module.exports === "function" ? module.exports :
      (module.exports && typeof module.exports.runGeneratedTest === "function" ? module.exports.runGeneratedTest :
      (module.exports && typeof module.exports.runTest === "function" ? module.exports.runTest :
      (exports && typeof exports.runGeneratedTest === "function" ? exports.runGeneratedTest :
      (exports && typeof exports.runTest === "function" ? exports.runTest : null)))))));

    if (typeof runner !== "function") {
      return {
        ok: false,
        error: "生成代码没有暴露 runGeneratedTest(config) 或 runTest(config) 入口",
        codeHead: ${codeHead}
      };
    }

    var value = await runner(config);
    if (value == null) {
      return { ok: false, error: "测试入口执行完成，但返回值为空", result: value };
    }
    return { ok: true, result: toPlain(value) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), detail: toPlain(err) };
  }
})()
`;
}

async function runAnalysisGeneratedTestWithDebugger(tabId, code, config) {
  const target = { tabId: Number(tabId) };
  const expression = buildAnalysisGeneratedTestExpression(code, config);
  let attached = false;
  try {
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/another debugger is already attached/i.test(msg)) {
        return await runDebuggerExpression(target.tabId, expression, {
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
          timeout: 120000
        });
      }
      throw e;
    }
    try {
      await chrome.debugger.sendCommand(target, "Page.setBypassCSP", { enabled: true });
    } catch (_) {}
    const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: 120000
    });
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = details.text || (details.exception && details.exception.description) || "Runtime.evaluate exception";
      return { ok: false, error: text, exceptionDetails: details };
    }
    return (result && result.result && Object.prototype.hasOwnProperty.call(result.result, "value"))
      ? result.result.value
      : { ok: false, error: "Runtime.evaluate 没有返回可序列化结果", raw: result };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }
}

async function runAnalysisExpressionWithDebugger(tabId, expression, options = {}) {
  const target = { tabId: Number(tabId) };
  let attached = false;
  try {
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/another debugger is already attached/i.test(msg)) {
        return await runDebuggerExpression(target.tabId, expression, {
          awaitPromise: options.awaitPromise !== false,
          returnByValue: options.returnByValue !== false,
          userGesture: options.userGesture !== false,
          timeout: Number(options.timeout || 60000)
        });
      }
      throw e;
    }
    try {
      await chrome.debugger.sendCommand(target, "Page.setBypassCSP", { enabled: true });
    } catch (_) {}
    const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: String(expression || ""),
      awaitPromise: options.awaitPromise !== false,
      returnByValue: options.returnByValue !== false,
      userGesture: options.userGesture !== false,
      timeout: Number(options.timeout || 60000)
    });
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = details.text || (details.exception && details.exception.description) || "Runtime.evaluate exception";
      return { ok: false, error: text, exceptionDetails: details };
    }
    return (result && result.result && Object.prototype.hasOwnProperty.call(result.result, "value"))
      ? result.result.value
      : { ok: false, error: "Runtime.evaluate did not return a serializable value", raw: result };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  setStatus({ wsState: "closed", helloOk: false, reconnectScheduled: true }).catch(() => {});
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    setStatus({ reconnectScheduled: false }).catch(() => {});
    connectBridge({ reason: "timer" }).catch(console.error);
  }, 3000);
}

async function ensurePersistentConnection(reason = "keepalive") {
  try {
    const cfg = await getConfig();
    const hasIdentity = !!(String(cfg.spaceId || "").trim() && String(cfg.windowKey || "").trim());
    if (!hasIdentity) {
      await setStatus({
        bridgeUrl: cfg.bridgeUrl,
        spaceId: cfg.spaceId,
        windowKey: cfg.windowKey,
        wsState: "waiting_config",
        helloOk: false,
        lastError: "waiting for fpb config from AccessToken update"
      });
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    await connectBridge({ reason });
  } catch (e) {
    await pushLog("error", "ensurePersistentConnection failed", { error: String(e && e.message || e), reason });
    scheduleReconnect();
  }
}

async function connectBridge(options = {}) {
  const force = !!options.force;
  const reason = options.reason || "auto";
  const cfg = await getConfig();
  const connectKey = JSON.stringify({
    bridgeUrl: cfg.bridgeUrl,
    bridgeToken: cfg.bridgeToken,
    spaceId: cfg.spaceId,
    windowKey: cfg.windowKey
  });

  if (!force && connectKey === currentConnectKey && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const old = ws;
  if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
    try { old.__fpb_intentional_close = true; old.close(1000, "reconnect"); } catch (_) {}
  }
  currentConnectKey = connectKey;
  const mySeq = ++connectSeq;

  let url = cfg.bridgeUrl;
  if (cfg.bridgeToken) {
    url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(cfg.bridgeToken);
  }
  await setStatus({
    bridgeUrl: cfg.bridgeUrl,
    spaceId: cfg.spaceId,
    windowKey: cfg.windowKey,
    wsState: "connecting",
    helloOk: false,
    lastError: "",
    reconnectScheduled: false
  });
  await pushLog("info", "connecting websocket", { url: cfg.bridgeUrl, space_id: cfg.spaceId, window_key: cfg.windowKey, reason });
  const socket = new WebSocket(url);
  ws = socket;
  socket.onopen = async () => {
    if (ws !== socket || mySeq !== connectSeq) return;
    await setStatus({ wsState: "open", lastError: "" });
    await pushLog("info", "websocket open");
    socket.send(JSON.stringify({
      type: "hello",
      version: chrome.runtime.getManifest().version,
      space_id: cfg.spaceId,
      window_key: cfg.windowKey,
      capabilities: ["veo", "veo_tokens", "veo_human_activity", "dreamina", "gpt", "network_capture", "transfer_data"]
    }));
    startHeartbeat(socket, mySeq);
  };
  socket.onmessage = async (ev) => {
    if (ws !== socket || mySeq !== connectSeq) return;
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === "welcome") {
      await setStatus({ clientId: msg.client_id || status.clientId });
      await pushLog("debug", "bridge welcome", msg);
    } else if (msg.type === "hello.ok") {
      await setStatus({ helloOk: true, clientId: msg.client_id || status.clientId });
      await pushLog("info", "registered with backend", msg);
    } else if (msg.type === "hello.error") {
      await setStatus({ helloOk: false, lastError: msg.message || "hello.error" });
      await pushLog("error", "registration failed", msg);
    }
    if (msg.type === "task.start") {
      await setStatus({ activeTask: { task_id: msg.task_id, provider: msg.provider, started_at: beijingTimeString() } });
      await pushLog("info", "task.start", { task_id: msg.task_id, provider: msg.provider });
      runTask(msg).catch(async (e) => {
        const failureReasons = Array.isArray(e?.failureReasons)
          ? e.failureReasons
          : (Array.isArray(e?.failure_reasons) ? e.failure_reasons : []);
        await setStatus({ activeTask: null, lastError: String(e && e.message || e) });
        await pushLog("error", "task.error", { task_id: msg.task_id, error: String(e && e.message || e), failure_reasons: failureReasons });
        await send({
          type: "task.error",
          task_id: msg.task_id,
          error: {
            message: String(e && e.message || e),
            status_code: e.status_code || 502,
            failure_reasons: failureReasons.length ? failureReasons : undefined,
            failureReasons: failureReasons.length ? failureReasons : undefined
          }
        });
      });
    } else if (msg.type === "data.transfer") {
      const payload = msg.payload || {};
      const text = String(payload.text || "");
      const lines = Array.isArray(payload.lines) ? payload.lines.map(x => String(x ?? "")) : (text ? text.split(/\r?\n/) : []);
      const data = {
        title: String(payload.title || ""),
        source: String(payload.source || "python"),
        text: lines.join("\n"),
        lines,
        raw: payload,
        received_at: beijingTimeString()
      };
      await chrome.storage.local.set({ transfer_data: data, popup_active_tab: "transfer" });
      await pushLog("info", "data transferred to popup", { lines: lines.length, title: data.title });
      try { await send({ type: "data.transfer.ok", request_id: msg.request_id || "" }); } catch (_) {}
    } else if (msg.type === "ping") {
      await send({ type: "pong" });
    } else if (msg.type === "heartbeat.ok") {
      await setStatus({ lastError: "" });
    }
  };
  socket.onclose = (ev) => {
    if (ws === socket && mySeq === connectSeq) stopHeartbeat();
    if (socket.__fpb_intentional_close || ws !== socket || mySeq !== connectSeq) {
      return;
    }
    setStatus({ wsState: "closed", helloOk: false, lastError: ev.reason || `closed ${ev.code}` }).catch(() => {});
    pushLog("warn", "websocket closed", { code: ev.code, reason: ev.reason }).catch(() => {});
    scheduleReconnect();
  };
  socket.onerror = () => {
    if (ws !== socket || mySeq !== connectSeq) return;
    stopHeartbeat();
    setStatus({ wsState: "error", helloOk: false, lastError: "websocket error" }).catch(() => {});
    pushLog("error", "websocket error").catch(() => {});
    try { socket.close(); } catch (_) {}
  };
}

async function runTask(msg) {
  const taskId = msg.task_id;
  const runtime = {
    taskId,
    progress: async (progress, data = {}) => {
      await pushLog("debug", "task.progress", { task_id: taskId, progress, data });
      await send({ type: "task.progress", task_id: taskId, progress, data });
    },
    setGptBusyTab: async (tabId) => {
      if (!tabId) return;
      gptBusyTabs.add(tabId);
      await pushLog("debug", "GPT tab marked busy", { task_id: taskId, tab_id: tabId });
    },
    clearGptBusyTab: async (tabId) => {
      if (!tabId) return;
      gptBusyTabs.delete(tabId);
      await pushLog("debug", "GPT tab released", { task_id: taskId, tab_id: tabId });
    }
  };
  let result;
  const payload = msg.payload || {};
  if (payload.action === "google_auto_login" || payload.workflow_kind === "google_auto_login" || msg.provider === "google") {
    const loginTab = await getActiveTab();
    const loginUrl = String(loginTab?.url || "");
    if (loginTab?.id && isGoogleAutoLoginProtectedUrl(loginUrl)) {
      result = { skipped: true, reason: "protected_google_page", url: loginUrl };
      await runtime.progress(100, { stage: "google_auto_login_skipped", reason: "protected_google_page" });
    } else {
      await chargeNewapiUsage("google_auto_login", { task_id: taskId, provider: msg.provider || "google" });
      await runtime.progress(5, { stage: "google_auto_login_start" });
      result = await runGoogleAutoLogin({
        googleAccount: payload.google_account || payload.googleAccount || "",
        googlePassword: payload.google_password || payload.googlePassword || "",
        googleEfa: payload.google_efa || payload.googleEfa || ""
      }, loginTab?.id ? { tabId: loginTab.id, url: loginUrl, onlyIfGoogleLoginPage: true } : { onlyIfGoogleLoginPage: true });
      const targetUrl = normalizeRedirectUrl(payload.target_url || payload.after_login_url || "");
      if (targetUrl) {
        const tabId = loginTab?.id;
        if (tabId) {
          await chrome.tabs.update(tabId, { url: targetUrl, active: true });
          result = { ...(result || {}), redirected_to: targetUrl };
        }
      }
      await runtime.progress(100, { stage: "google_auto_login_done", target_url: targetUrl || undefined });
    }
  } else if (msg.provider === "veo") {
    const action = String(payload.action || payload.workflow_kind || "").trim().toLowerCase();
    if (!VEO_HUMAN_ACTIVITY_ACTIONS.has(action) && action !== "current_page" && action !== "get_current_page" && action !== "current_url" && action !== "get_current_url" && action !== "fetch_tokens" && action !== "fetch_access_tokens" && action !== "get_access_tokens" && action !== "create_flow_project" && action !== "flow_project_create" && action !== "create_project" && action !== "delete_flow_project" && action !== "flow_project_delete" && action !== "delete_project" && action !== "balance_refresh" && action !== "refresh_balance") {
      await chargeNewapiUsage("veo_workflow", { task_id: taskId, provider: "veo", workflow_kind: payload.workflow_kind || payload.action || "" });
    }
    result = await runVeoTask(msg, runtime);
    if (["current_page", "get_current_page", "current_url", "get_current_url"].includes(action)) {
      const url = String(result && result.url || "");
      const tabId = Number(result && result.tab_id || 0);
      if (tabId && isGoogleLoginUrl(url)) {
        const trigger = await maybeRunGoogleAutoLoginForTab(tabId, url, "veo_current_page");
        result = { ...(result || {}), google_auto_login_trigger: trigger };
      }
    }
  } else if (msg.provider === "dreamina") {
    const action = String(payload.action || payload.workflow_kind || "").trim().toLowerCase();
    if (!["fetch_sessionid", "fetch_access_token", "get_sessionid"].includes(action)) {
      await chargeNewapiUsage("dreamina_workflow", { task_id: taskId, provider: "dreamina", workflow_kind: payload.workflow_kind || payload.action || "" });
    }
    result = await runDreaminaTask(msg, runtime);
  } else if (msg.provider === "gpt") {
    const action = String(payload.action || payload.workflow_kind || "").trim().toLowerCase();
    if (!["get_access_token", "fetch_access_token", "fetch_tokens", "refresh_membership", "membership_refresh", "get_membership", "membership", "subscription_info", "refresh_balance", "balance_refresh", "get_balance", "balance", "query_progress", "poll_task", "get_task"].includes(action)) {
      await chargeNewapiUsage("gpt_workflow", { task_id: taskId, provider: "gpt", workflow_kind: payload.workflow_kind || payload.action || "" });
    }
    result = await runGptTask(msg, runtime);
  } else if (msg.provider === "network") {
    result = await runNetworkTask(msg, runtime);
  } else {
    throw new Error(`unsupported provider: ${msg.provider}`);
  }
  await pushLog("info", "task.done", { task_id: taskId, result_type: result && result.type });
  await setStatus({ activeTask: null });
  await send({ type: "task.done", task_id: taskId, result });
}

async function clearCurrentPageLocalStorage() {
  await chargeNewapiUsage("clear_recaptcha", { source: "popup.clearCurrentPageLocalStorage" });
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = Array.isArray(tabs) && tabs[0] ? tabs[0] : null;
  if (!tab || !tab.id) throw new Error("no active tab found");
  const tabId = tab.id;
  try {
    const freshTab = await chrome.tabs.get(tabId);
    if (freshTab && freshTab.status !== "complete") {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const t = await chrome.tabs.get(tabId);
        if (!t || t.status === "complete") break;
        await sleep(120);
      }
    }
  } catch (_) {}
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const currentUrl = String(location.href || "");
      try {
        const before = localStorage.length;
        const existed = localStorage.getItem("_grecaptcha") !== null;
        localStorage.removeItem("_grecaptcha");
        return {
          key: "grecaptcha reset",
        };
      } catch (e) {
        return {
          cleared: false,
          url: currentUrl,
          origin: String(location.origin || ""),
          reason: String((e && e.message) || e || "unknown")
        };
      }
    }
  });
  const result = Array.isArray(frames) && frames[0] ? frames[0].result : null;
  if (!result) throw new Error("clear current page localStorage returned empty result");
  if (!result.cleared) {
    throw new Error(`clear recaptcha failed: ${result.reason || "unknown"}; url=${result.url || ""}`);
  }
  await chrome.tabs.reload(tabId);
  result.reloaded = true;
  await pushLog("info", "recaptcha reset", result);
  return result;
}

function base32ToBytes(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secret || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}

async function generateTotpCode(secret, nowMs = Date.now()) {
  const keyBytes = base32ToBytes(secret);
  if (!keyBytes.length) return "";
  const counter = Math.floor(Math.floor(nowMs / 1000) / 30);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1000000).padStart(6, "0");
}

async function waitTabComplete(tabId, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab || tab.status === "complete") return true;
    } catch (_) {
      return false;
    }
    await sleep(150);
  }
  return false;
}

function isGoogleAccountsUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && u.hostname === "accounts.google.com";
  } catch (_) {
    return false;
  }
}

function isGoogleLoginUrl(raw) {
  if (!isGoogleAccountsUrl(raw)) return false;
  try {
    const u = new URL(String(raw || ""));
    const p = u.pathname.toLowerCase();
    const s = (u.pathname + u.search + u.hash).toLowerCase();
    if (p === "/" || p.includes("/signin/") || p.includes("/v3/signin/")) return true;
    return ["identifier", "challenge", "selectaccount", "oauth", "service=", "continue="].some(x => s.includes(x));
  } catch (_) {
    return /accounts\.google\.com/i.test(String(raw || ""));
  }
}

function isGoogleAutoLoginWatchUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "labs.google" || h === "google.com" || h.endsWith(".google.com"));
  } catch (_) {
    return false;
  }
}

function isGoogleFlowProjectUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:"
      && u.hostname.toLowerCase() === "labs.google"
      && /^\/fx\/tools\/flow\/project(?:\/|$)/i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

function isGoogleOAuthStartUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:"
      && u.hostname.toLowerCase() === "labs.google"
      && /^\/fx\/api\/auth\/signin(?:\/|$)/i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

// AI Studio 页面会显示当前登录账号的邮箱，Google 自动登录不得在这里执行
// DOM 检测、点击或导航。它仍保留在 Google URL 监控范围内，由各登录入口静默跳过。
function isGoogleAutoLoginProtectedUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return (u.protocol === "https:" && u.hostname.toLowerCase() === "aistudio.google.com")
      || isGoogleFlowProjectUrl(raw);
  } catch (_) {
    return false;
  }
}

function isChatGptWatchUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "chatgpt.com" || h === "chat.openai.com");
  } catch (_) {
    return false;
  }
}

function hasGoogleSignedOutText(text) {
  return /you(?:'|’| are)?re not signed in|you are not signed in|not signed in|ログインしていません|ログインしていない|ログインが必要|ログインしてください|nicht angemeldet|sie sind nicht angemeldet|du bist nicht angemeldet/i.test(String(text || ""));
}

function shouldGoogleAutoLoginActOnPageResult(result) {
  if (!result) return false;
  if (result.hasPassword || result.hasEmail || result.hasOtp || result.hasAccountPicker) return true;
  const text = String(result.title || "") + "\n" + String(result.bodyText || "");
  if (hasGoogleSignedOutText(text)) return true;
  return /choose an account|use another account|sign in|signed out|选择帐号|选择账号|登录|konto auswählen|anderes konto verwenden|über google anmelden|abgemeldet/i.test(text);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return Array.isArray(tabs) && tabs[0] ? tabs[0] : null;
}

// clickGoogleProviderSignInButtonInTab 处理第三方 OAuth 起始页（如
// labs.google/fx/api/auth/signin）：这类页面并非 accounts.google.com，而是显示一个
// "Sign in with Google" 按钮，点击后才会把 form POST 到 .../auth/signin/google
// 并跳转到 accounts.google.com。若不点它而直接导航到 accounts.google.com，会丢失
// OAuth 的 callbackUrl 上下文。这里在页面内识别并点击该按钮。
async function clickGoogleProviderSignInButtonInTab(tabId) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const visible = (el) => {
        if (!el) return false;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      };
      const clickHuman = async (el) => {
        if (!el) return false;
        try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (_) {}
        await sleep(80);
        const r = el.getBoundingClientRect();
        const x = Math.max(1, Math.min(innerWidth - 2, r.left + r.width / 2));
        const y = Math.max(1, Math.min(innerHeight - 2, r.top + r.height / 2));
        const target = document.elementFromPoint(x, y) || el;
        for (const t of ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown"]) {
          target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: t.endsWith("down") ? 1 : 0 }));
        }
        try { if (typeof target.focus === "function") target.focus({ preventScroll: true }); } catch (_) {}
        for (const t of ["pointerup", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: 0, detail: 1 }));
        }
        return true;
      };
      const matchesGoogleText = (raw) => {
        const txt = String(raw || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!txt || txt.length > 120) return false;
        return /sign in with google|continue with google|log in with google|使用\s*google\s*登录|通过\s*google\s*登录|用\s*google\s*登录|使用\s*google\s*帐号登录|使用\s*google\s*账号登录|googleで(?:ログイン|サインイン)|google\s*で(?:ログイン|サインイン)|google(?:로|으로)\s*로그인|über\s*google\s*anmelden|mit\s*google\s*anmelden/i.test(txt);
      };

      // 1) 优先：action 指向 .../auth/signin/google 的表单里的提交按钮。
      const providerForm = Array.from(document.querySelectorAll('form[action]'))
        .filter(visible)
        .find(f => /\/auth\/signin\/google\b/i.test(String(f.getAttribute("action") || f.action || "")));
      if (providerForm) {
        const btn = Array.from(providerForm.querySelectorAll("button[type='submit'], button, [role='button'], input[type='submit']"))
          .find(visible);
        if (btn) {
          await clickHuman(btn);
          return { clicked: true, source: "provider_form_submit", url: String(location.href || "") };
        }
      }

      // 2) 退化：按可见文案匹配 "Sign in with Google" 按钮/链接。
      const byText = Array.from(document.querySelectorAll("button, [role='button'], a, input[type='submit']"))
        .filter(visible)
        .find(el => matchesGoogleText(el.innerText || el.textContent || el.value || el.getAttribute("aria-label")));
      if (byText) {
        const clickable = byText.closest("button, [role='button'], a") || byText;
        await clickHuman(clickable);
        return { clicked: true, source: "provider_text_button", url: String(location.href || "") };
      }

      return { clicked: false, reason: "provider_button_not_found", url: String(location.href || "") };
    }
  });
  return Array.isArray(frames) && frames[0] ? frames[0].result : { clicked: false, reason: "no_frame" };
}

async function runGoogleAutoLogin(credsPatch = {}, options = {}) {
  const oldCfg = await getConfig();
  const creds = {
    googleAccount: String(credsPatch.googleAccount ?? oldCfg.googleAccount ?? "").trim(),
    googlePassword: String(credsPatch.googlePassword ?? oldCfg.googlePassword ?? ""),
    googleEfa: String(credsPatch.googleEfa ?? oldCfg.googleEfa ?? "").trim()
  };
  await chrome.storage.local.set({
    google_account: creds.googleAccount,
    google_password: creds.googlePassword,
    google_efa: creds.googleEfa
  });
  if (!creds.googleAccount || !creds.googlePassword) throw new Error("Please fill Google account and password first");

  let tab = null;
  if (options && options.tabId) {
    try { tab = await chrome.tabs.get(options.tabId); } catch (_) { tab = null; }
  }
  if (!tab) tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error("no active tab found");
  const tabId = tab.id;
  let curUrl = String(options.url || tab.url || "");
  if (isGoogleAutoLoginProtectedUrl(curUrl)) {
    return { skipped: true, reason: "protected_google_page", url: curUrl };
  }
  // onlyIfGoogleLoginPage 用于自动监听：只在真正的登录页上动作。但第三方 OAuth
  // 起始页（如 labs.google/fx/api/auth/signin）并非 accounts.google.com，
  // isGoogleLoginUrl 会判 false。这类页面同样是合法登录入口（调用方已用 watch URL +
  // DOM 文案双重确认过），必须放行，否则监听路径在此直接 skip，走不到下面点击
  // "Sign in with Google" 并跳转 accounts.google.com 的逻辑。真正的非登录页仍由
  // 下方的 DOM 检测兜底拦下。
  if (options.onlyIfGoogleLoginPage && !isGoogleLoginUrl(curUrl) && !isGoogleOAuthStartUrl(curUrl)) {
    return { skipped: true, reason: "not_google_login_page", url: curUrl };
  }
  if (!isGoogleAccountsUrl(curUrl)) {
    if (!isGoogleOAuthStartUrl(curUrl)) {
      return { skipped: true, reason: "not_google_login_entry", url: curUrl };
    }
    // 第三方 OAuth 起始页（如 labs.google/fx/api/auth/signin）：先点它自己的
    // "Sign in with Google" 按钮走正常 OAuth 流程；点不到再退回直接导航。
    let clickedProvider = false;
    try {
      const providerClick = await clickGoogleProviderSignInButtonInTab(tabId);
      clickedProvider = !!(providerClick && providerClick.clicked);
      await pushLog("info", "Google provider sign-in button", providerClick || { clicked: false });
    } catch (e) {
      await pushLog("debug", "Google provider button click failed", { error: String(e && e.message || e) });
    }
    if (clickedProvider) {
      await waitTabComplete(tabId, 45000);
      await sleep(1200);
      try {
        const afterClick = await chrome.tabs.get(tabId);
        curUrl = String(afterClick && afterClick.url || curUrl);
      } catch (_) {}
    }
    if (!isGoogleAccountsUrl(curUrl)) {
      await chrome.tabs.update(tabId, { url: "https://accounts.google.com/", active: true });
    }
  }
  await waitTabComplete(tabId, 45000);
  await sleep(800);
  try {
    const refreshed = await chrome.tabs.get(tabId);
    curUrl = String(refreshed && refreshed.url || curUrl);
  } catch (_) {}
  if (options.onlyIfGoogleLoginPage && !isGoogleLoginUrl(curUrl)) {
    const detected = await detectGoogleLoginPageInTab(tabId).catch(() => null);
    if (!shouldGoogleAutoLoginActOnPageResult(detected)) {
      return { skipped: true, reason: "not_google_login_dom", url: curUrl, detected };
    }
  }
  await pushLog("info", "Google auto login start", { account: creds.googleAccount, tab_id: tabId, auto_watch: !!options.autoWatch });

  let last = null;
  for (let round = 1; round <= 28; round++) {
    let totpCode = "";
    // 2FA/TOTP 码有时间窗口，且用户希望验证码页出现后稍等再计算并填写。
    // 因此不要在每轮一开始就提前计算；只有上一轮已提交密码或已确认在验证码页时才生成。
    if (creds.googleEfa && last && ["password", "need_2fa", "totp", "clicked_authenticator_option"].includes(last.action)) {
      try { totpCode = await generateTotpCode(creds.googleEfa); } catch (_) { totpCode = ""; }
    }
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [{ ...creds, totpCode, round }],
      func: async (cfg) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const visible = (el) => {
          if (!el) return false;
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        };
        const q = (sels) => {
          for (const sel of sels) {
            const list = Array.from(document.querySelectorAll(sel));
            const el = list.find(visible);
            if (el) return { el, selector: sel };
          }
          return { el: null, selector: "" };
        };
        const center = (el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.max(1, Math.min(innerWidth - 2, r.left + r.width / 2)), y: Math.max(1, Math.min(innerHeight - 2, r.top + r.height / 2)) };
        };
        const clickHuman = async (el) => {
          if (!el) return false;
          try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (_) {}
          await sleep(80);
          const p = center(el);
          const target = document.elementFromPoint(p.x, p.y) || el;
          for (const t of ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown"]) {
            target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y, buttons: t.endsWith("down") ? 1 : 0 }));
          }
          try { if (typeof target.focus === "function") target.focus({ preventScroll: true }); } catch (_) {}
          for (const t of ["pointerup", "mouseup", "click"]) {
            target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y, buttons: 0, detail: 1 }));
          }
          return true;
        };
        const inputText = async (el, text, options = {}) => {
          if (!el) return false;
          await clickHuman(el);
          await sleep(80);
          const v = String(text || "");
          const minDelay = Math.max(0, Number(options.minDelayMs ?? 8) || 0);
          const maxDelay = Math.max(minDelay, Number(options.maxDelayMs ?? 24) || minDelay);
          const charDelay = async () => {
            if (maxDelay <= 0) return;
            await sleep(minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1)));
          };
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            try { el.select(); } catch (_) {}
            try { document.execCommand("delete"); } catch (_) {}
            for (const ch of v) {
              try { document.execCommand("insertText", false, ch); } catch (_) {}
              el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
              await charDelay();
            }
            if (el.value !== v) {
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
              if (setter) setter.call(el, v); else el.value = v;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
          if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
            const sel = getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("delete");
            document.execCommand("insertText", false, v);
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
            return true;
          }
          return false;
        };
        const clickNext = async () => {
          const candidates = Array.from(document.querySelectorAll("#identifierNext, #passwordNext, #totpNext, button, [role='button']"))
            .filter(visible)
            .filter(el => {
              const txt = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
              const id = String(el.id || "").toLowerCase();
              return id.includes("next") || ["next", "下一步", "继续", "verify", "验证"].some(x => txt.includes(x));
            });
          if (!candidates.length) return false;
          await clickHuman(candidates[0]);
          return true;
        };
        const clickNextAndWait = async (waitMs) => {
          const ok = await clickNext();
          if (ok && waitMs > 0) await sleep(waitMs);
          return ok;
        };
        const looksLikeAccountPickerPage = () => {
          const u = String(location.href || "").toLowerCase();
          if (u.includes("selectaccount") || u.includes("oauthchooseaccount") || u.includes("/signin/chooser") || u.includes("/identifier")) return true;
          const title = String(document.title || "").toLowerCase();
          const bodyText = String(document.body && document.body.innerText || "").toLowerCase();
          return title.includes("choose an account")
            || bodyText.includes("choose an account")
            || bodyText.includes("use another account")
            || bodyText.includes("选择帐号")
            || bodyText.includes("选择账号")
            || bodyText.includes("konto auswählen")
            || bodyText.includes("anderes konto verwenden")
            || bodyText.includes("über google anmelden")
            || bodyText.includes("abgemeldet");
        };
        const clickGmailPicker = async () => {
          // 密码页/验证码页左侧也会显示邮箱文本，不能把它误认为账号选择行反复点击。
          if (!looksLikeAccountPickerPage()) return false;
          const email = String(cfg.googleAccount || "").toLowerCase();
          const rows = Array.from(document.querySelectorAll(
            '[role="link"]:has([data-email]), li:has([data-email]), [data-email], [data-identifier], [jsname="W3oRb"]'
          )).filter(visible);
          const hit = rows.find(el => {
            const de = String(el.getAttribute("data-email") || "").toLowerCase();
            const di = String(el.getAttribute("data-identifier") || "").toLowerCase();
            const txt = String(el.innerText || el.textContent || "").toLowerCase();
            return (email && (de.includes(email) || txt.includes(email))) || /@gmail\.com/i.test(de || txt);
          });
          if (!hit) return false;
          let clickable = hit.closest('[role="link"], [role="button"], a, button') || hit;
          await clickHuman(clickable);
          return true;
        };
        const clickGoogleAuthenticatorOption = async () => {
          const pageText = String(document.body && document.body.innerText || "").toLowerCase();
          if (!/choose how you want to sign in|2-step verification|google authenticator|verification code/i.test(pageText)) return false;
          const candidates = Array.from(document.querySelectorAll(
            '[role="link"], [role="button"], button, a, li, [data-challengetype], [jsname], div'
          )).filter(visible);
          const hit = candidates.find(el => {
            const txt = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (!txt || txt.length > 220) return false;
            return txt.includes("authenticator")
              && txt.includes("verification code")
              && !txt.includes("one-time security code");
          });
          if (!hit) return false;
          const clickable = hit.closest('[role="link"], [role="button"], button, a, li, [data-challengetype]') || hit;
          await clickHuman(clickable);
          return true;
        };
        const clickNotNow = async () => {
          const candidates = Array.from(document.querySelectorAll(
            'button, [role="button"], a, [jsname], [data-is-touch-wrapper]'
          )).filter(visible);
          const hit = candidates.find(el => {
            const txt = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            if (!txt || txt.length > 80) return false;
            return txt === "not now";
          });
          if (!hit) return false;
          const clickable = hit.closest('[role="button"], button, a') || hit;
          await clickHuman(clickable);
          return true;
        };
        const clickCancelIfRecoveryPage = async () => {
          // 识别 "Make sure you can always sign in" 找回信息页，点击 Cancel 跳过
          const bodyText = String(document.body && document.body.innerText || "");
          if (!/make sure you can always sign in/i.test(bodyText)) return false;
          const candidates = Array.from(document.querySelectorAll(
            'button, [role="button"], a'
          )).filter(visible);
          const hit = candidates.find(el => {
            const txt = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            return txt === "cancel";
          });
          if (!hit) return false;
          const clickable = hit.closest('[role="button"], button, a') || hit;
          await clickHuman(clickable);
          return true;
        };
        const clickSkipIfAddressPage = async () => {
          // 识别 "Set a home address" 地址设置页，点击 Skip 跳过
          const bodyText = String(document.body && document.body.innerText || "");
          if (!/set a home address/i.test(bodyText)) return false;
          const candidates = Array.from(document.querySelectorAll(
            'button, [role="button"], a'
          )).filter(visible);
          const hit = candidates.find(el => {
            const txt = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            return txt === "skip";
          });
          if (!hit) return false;
          const clickable = hit.closest('[role="button"], button, a') || hit;
          await clickHuman(clickable);
          return true;
        };

        const url = String(location.href || "");
        // gds.google.com/web/recoveryoptions 等 Google 账号附属页也需要处理，不能视为已离开
        if (!/accounts\.google\.com/i.test(url) && !/gds\.google\.com/i.test(url)) return { done: true, action: "left_google", url };

        // 优先处理弹窗/提示页面（必须在输入框检查之前）：
        // 这些页面可能含 input[type='email'] 等，若不先拦截会误填账号。
        if (await clickCancelIfRecoveryPage()) return { done: false, action: "clicked_cancel_recovery", url };
        if (await clickSkipIfAddressPage()) return { done: false, action: "clicked_skip_address", url };
        if (await clickNotNow()) return { done: false, action: "clicked_not_now", url };

        // 优先处理当前页明确存在的输入框。Google 密码页左侧会显示邮箱，
        // 若先扫账号文本会误点左侧账号区域，导致一直 clicked_account_picker。
        const pw = q(["input[type='password']"]);
        if (pw.el) {
          await inputText(pw.el, cfg.googlePassword, { minDelayMs: 90, maxDelayMs: 180 });
          await clickNext();
          return { done: false, action: "password", selector: pw.selector, url };
        }
        const em = q(["#identifierId", "input[name='identifier']", "input[type='email']"]);
        if (em.el) {
          await inputText(em.el, cfg.googleAccount, { minDelayMs: 90, maxDelayMs: 180 });
          await clickNext();
          return { done: false, action: "email", selector: em.selector, url };
        }
        const otp = q(["input[name='totpPin']", "#totpPin", "input[autocomplete='one-time-code']", "input[type='tel']", "input[id='idvPin']", "input[name='pin']"]);
        if (otp.el) {
          if (!cfg.totpCode) return { done: false, action: "need_2fa", selector: otp.selector, url };
          await inputText(otp.el, cfg.totpCode);
          await clickNextAndWait(5000);
          return { done: false, action: "totp", selector: otp.selector, url };
        }
        if (await clickGoogleAuthenticatorOption()) return { done: false, action: "clicked_authenticator_option", url };
        if (await clickGmailPicker()) return { done: false, action: "clicked_account_picker", url };
        return { done: false, action: "idle", url };
      }
    });
    last = Array.isArray(frames) && frames[0] ? frames[0].result : null;
    await pushLog("debug", "Google 自动登录步骤", last || { round });
    if (last && last.done) {
      await pushLog("info", "Google 自动登录完成", last);
      return last;
    }
    // 放慢 Google 登录节奏：
    // - 输入账号并点击下一步后，等待几秒再进入密码页处理；
    // - 输入密码并点击下一步后，等待 2 秒再计算/输入 EFA(TOTP)；
    // - 已在验证码页但尚未生成验证码时，也等待 2 秒后下一轮再生成。
    const nextDelayByAction = {
      email: 3500,
      password: 2000,
      need_2fa: 2000,
      clicked_not_now: 2500,
      clicked_cancel_recovery: 2500,
      clicked_skip_address: 2500,
      clicked_authenticator_option: 2500,
      clicked_account_picker: 2500,
      idle: 900
    };
    await sleep(nextDelayByAction[last?.action] ?? 1600);
  }
  await pushLog("warn", "Google 自动登录轮询结束，请检查是否需要人工验证", last);
  return { done: false, last };
}

async function detectGoogleLoginPageInTab(tabId) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const visible = (el) => {
        if (!el) return false;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      };
      const hasVisible = (sel) => Array.from(document.querySelectorAll(sel)).some(visible);
      const title = String(document.title || "");
      const bodyText = String(document.body && document.body.innerText || "").slice(0, 3000);
      const pickerRows = Array.from(document.querySelectorAll("[data-email], [data-identifier], [role='link'], [role='button']"))
        .filter(visible)
        .filter(el => /@|choose an account|use another account|选择帐号|选择账号|konto auswählen|anderes konto verwenden|über google anmelden|abgemeldet/i.test(String(el.innerText || el.textContent || el.getAttribute("aria-label") || "")));
      return {
        url: String(location.href || ""),
        title,
        bodyText,
        hasPassword: hasVisible("input[type='password']"),
        hasEmail: hasVisible("#identifierId, input[name='identifier'], input[type='email']"),
        hasOtp: hasVisible("input[name='totpPin'], #totpPin, input[autocomplete='one-time-code'], input[type='tel'], input[id='idvPin'], input[name='pin']"),
        hasAccountPicker: pickerRows.length > 0
      };
    }
  });
  return Array.isArray(frames) && frames[0] ? frames[0].result : null;
}

const GOOGLE_AUTO_LOGIN_COOLDOWN_MS = 60 * 1000;
const googleAutoLoginRunningTabs = new Set();
const googleAutoLoginLastByTab = new Map();
let googleAutoLoginLastConfigWarnAt = 0;
const GPT_CLOUDFLARE_WATCH_COOLDOWN_MS = 8000;
const gptCloudflareRunningTabs = new Set();
const gptCloudflareLastByTab = new Map();
const gptBusyTabs = new Set();
const VEO_CHANGELOG_WATCH_COOLDOWN_MS = 5000;
const veoChangelogRunningTabs = new Set();
const veoChangelogLastByTab = new Map();

async function maybeRunGoogleAutoLoginForTab(tabId, url, reason = "tab_event") {
  if (!tabId || !isGoogleAutoLoginWatchUrl(url)) return { skipped: true, reason: "not_google_watch_page" };
  if (isGoogleAutoLoginProtectedUrl(url)) return { skipped: true, reason: "protected_google_page", url };

  const cfg = await getConfig();
  if (!cfg.googleAutoLoginWatchEnabled) return { skipped: true, reason: "disabled" };

  if (!cfg.googleAccount || !cfg.googlePassword) {
    const now = Date.now();
    if (now - googleAutoLoginLastConfigWarnAt > 5 * 60 * 1000) {
      googleAutoLoginLastConfigWarnAt = now;
      await pushLog("warn", "Google auto login watch is enabled but account/password is empty");
    }
    return { skipped: true, reason: "missing_credentials" };
  }

  if (googleAutoLoginRunningTabs.has(tabId)) return { skipped: true, reason: "already_running" };

  const now = Date.now();
  const lastAt = Number(googleAutoLoginLastByTab.get(tabId) || 0);
  if (now - lastAt < GOOGLE_AUTO_LOGIN_COOLDOWN_MS) {
    return { skipped: true, reason: "cooldown", cooldown_ms: GOOGLE_AUTO_LOGIN_COOLDOWN_MS - (now - lastAt) };
  }

  let detected = null;
  if (!isGoogleLoginUrl(url)) {
    detected = await detectGoogleLoginPageInTab(tabId).catch(() => null);
    if (!shouldGoogleAutoLoginActOnPageResult(detected)) {
      return { skipped: true, reason: "not_google_login_dom", url, detected };
    }
    if (!isGoogleAccountsUrl(url) && hasGoogleSignedOutText(String(detected?.title || "") + "\n" + String(detected?.bodyText || ""))) {
      await pushLog("info", "Google signed-out page detected, redirecting to accounts.google.com", { tab_id: tabId, url, reason, detected });
      await chrome.tabs.update(tabId, { url: "https://accounts.google.com/", active: true });
      url = "https://accounts.google.com/";
    }
  }

  googleAutoLoginLastByTab.set(tabId, now);
  googleAutoLoginRunningTabs.add(tabId);
  await pushLog("info", "Google login page detected, auto login watch triggered", { tab_id: tabId, url, reason, detected });
  runGoogleAutoLogin({}, {
    tabId,
    url,
    onlyIfGoogleLoginPage: true,
    autoWatch: true
  }).then(async (result) => {
    await pushLog("info", "Google auto login watch finished", { tab_id: tabId, result });
  }).catch(async (e) => {
    await pushLog("warn", "Google auto login watch failed", { tab_id: tabId, error: String(e && e.message || e) });
  }).finally(() => {
    googleAutoLoginRunningTabs.delete(tabId);
  });
  return { skipped: false, started: true };
}

async function maybeRunGoogleAutoLoginForActiveTab(reason = "manual_enable") {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return { skipped: true, reason: "no_active_tab" };
  return maybeRunGoogleAutoLoginForTab(tab.id, String(tab.url || ""), reason);
}

async function maybeRunGptCloudflareWatchForTab(tabId, url, reason = "tab_event") {
  if (!tabId || !isChatGptWatchUrl(url)) return { skipped: true, reason: "not_chatgpt_page" };
  if (gptBusyTabs.has(tabId)) return { skipped: true, reason: "gpt_task_running" };
  if (gptCloudflareRunningTabs.has(tabId)) return { skipped: true, reason: "already_running" };

  const now = Date.now();
  const lastAt = Number(gptCloudflareLastByTab.get(tabId) || 0);
  if (now - lastAt < GPT_CLOUDFLARE_WATCH_COOLDOWN_MS) {
    return { skipped: true, reason: "cooldown", cooldown_ms: GPT_CLOUDFLARE_WATCH_COOLDOWN_MS - (now - lastAt) };
  }

  gptCloudflareLastByTab.set(tabId, now);
  gptCloudflareRunningTabs.add(tabId);
  const runtime = {
    progress: async (progress, data = {}) => {
      await pushLog("debug", "GPT Cloudflare watch progress", { tab_id: tabId, progress, data });
    }
  };
  await pushLog("debug", "GPT Cloudflare watch checking", { tab_id: tabId, url, reason });
  maybeHandleGptCloudflare(tabId, runtime, {
    maxWaitMs: 22000,
    maxClicks: 3,
    initialDelayMs: 1500
  }).then(async (result) => {
    if (result && (result.passed || result.clicked_count || result.is_cloudflare)) {
      await pushLog(result.passed ? "info" : "warn", "GPT Cloudflare watch finished", { tab_id: tabId, result });
    }
  }).catch(async (e) => {
    await pushLog("warn", "GPT Cloudflare watch failed", { tab_id: tabId, error: String(e && e.message || e) });
  }).finally(() => {
    gptCloudflareRunningTabs.delete(tabId);
    gptCloudflareLastByTab.set(tabId, Date.now());
  });
  return { skipped: false, started: true };
}

async function scanChatGptCloudflareWatch(reason = "scan") {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  for (const tab of tabs || []) {
    if (!tab || !tab.id) continue;
    await maybeRunGptCloudflareWatchForTab(tab.id, String(tab.url || ""), reason).catch(() => {});
  }
}

function isLabsGoogleWatchUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && u.hostname === "labs.google";
  } catch (_) {
    return false;
  }
}

async function maybeRunVeoChangelogWatchForTab(tabId, url, reason = "tab_event") {
  if (!tabId || !isLabsGoogleWatchUrl(url)) return { skipped: true, reason: "not_labs_google_page" };
  if (veoChangelogRunningTabs.has(tabId)) return { skipped: true, reason: "already_running" };

  const now = Date.now();
  const lastAt = Number(veoChangelogLastByTab.get(tabId) || 0);
  if (now - lastAt < VEO_CHANGELOG_WATCH_COOLDOWN_MS) {
    return { skipped: true, reason: "cooldown", cooldown_ms: VEO_CHANGELOG_WATCH_COOLDOWN_MS - (now - lastAt) };
  }

  veoChangelogLastByTab.set(tabId, now);
  veoChangelogRunningTabs.add(tabId);
  (async () => {
    let result = null;
    let detectedLogged = false;
    for (let i = 0; i < 10; i += 1) {
      if (i > 0) await sleep(1000);
      result = await dismissVeoChangelogModalIfPresent(tabId).catch((e) => ({ clicked: false, reason: "watch_failed", error: String(e && e.message || e) }));
      if (result && result.found && !detectedLogged) {
        detectedLogged = true;
        await pushLog("info", "VEO changelog modal detected", { tab_id: tabId, reason, x: result.x, y: result.y });
      }
      if (result && result.clicked) {
        await pushLog("info", "VEO changelog modal dismissed by safe-area click", { tab_id: tabId, reason, x: result.x, y: result.y, via: result.via });
        break;
      }
    }
  })().finally(() => {
    veoChangelogRunningTabs.delete(tabId);
    veoChangelogLastByTab.set(tabId, Date.now());
  });
  return { skipped: false, started: true };
}

async function scanVeoChangelogWatch(reason = "scan") {
  const tabs = await chrome.tabs.query({ url: ["https://labs.google/*"] });
  for (const tab of tabs || []) {
    if (!tab || !tab.id) continue;
    await maybeRunVeoChangelogWatchForTab(tab.id, String(tab.url || ""), reason).catch(() => {});
  }
}

function parseVeoProjectPage(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.hostname !== "labs.google") return null;
    const m = u.pathname.match(/^\/fx\/tools\/flow\/project\/([^/?#]+)/);
    if (!m || !m[1]) return null;
    return {
      url: u.href,
      project_id: decodeURIComponent(m[1])
    };
  } catch (_) {
    return null;
  }
}

async function runPopupVeoGenerateTest(kind) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = Array.isArray(tabs) && tabs[0] ? tabs[0] : null;
  const currentUrl = String(tab && tab.url || "");
  const project = parseVeoProjectPage(currentUrl);
  const testKind = String(kind || "").toLowerCase() === "video" ? "video" : "image";
  if (!project) {
    await pushLog("warn", "VEO 生成测试已停止：当前页面不是 Flow 项目页", {
      current_url: currentUrl,
      required_url: "https://labs.google/fx/tools/flow/project/xxxxxx",
      test_kind: testKind
    });
    return { skipped: true, reason: "not_flow_project_page", current_url: currentUrl };
  }

  if (status.activeTask) {
    await pushLog("warn", "VEO 生成测试已停止：已有任务正在运行", {
      active_task: status.activeTask,
      test_kind: testKind
    });
    return { skipped: true, reason: "active_task_running", active_task: status.activeTask };
  }

  await chargeNewapiUsage("veo_generate_test", { source: "popup.veoGenerateTest", test_kind: testKind });

  const taskId = `popup-veo-test-${testKind}-${Date.now()}`;
  const prompt = testKind === "video"
    ? "A calm cinematic shot of a small red paper boat floating on a clear pond, soft morning light, gentle ripples."
    : "A clean studio photo of a small red paper boat on a blue tabletop, soft natural light, high detail.";
  const payload = {
    action: testKind === "image" ? "image" : "video",
    workflow_kind: testKind === "image" ? "image" : "video",
    image_mode: testKind === "image",
    video_mode: "t2v",
    prompt,
    project_page: project.url,
    target_url: project.url,
    project_id: project.project_id,
    popup_test_task: true,
    veo_test_task: true,
    archive_workflow: false,
    archive_uploaded_workflows: false
  };
  const runtime = {
    taskId,
    progress: async (progress, data = null) => {
      await pushLog("debug", "popup.veoGenerateTest.progress", {
        task_id: taskId,
        test_kind: testKind,
        progress,
        data
      });
    }
  };

  await pushLog("info", "VEO 生成测试开始", {
    task_id: taskId,
    test_kind: testKind,
    project_id: project.project_id,
    project_page: project.url
  });
  await setStatus({ activeTask: { provider: "veo", task_id: taskId, started_at: beijingTimeString(), source: "popup", test_kind: testKind } });
  (async () => {
    try {
      const result = await runVeoTask({ provider: "veo", task_id: taskId, payload }, runtime);
      await pushLog("info", "VEO 生成测试完成", {
        task_id: taskId,
        test_kind: testKind,
        result_type: result && result.type,
        result
      });
    } catch (e) {
      await pushLog("error", "VEO 生成测试失败", {
        task_id: taskId,
        test_kind: testKind,
        error: String(e && e.message || e)
      });
    } finally {
      await setStatus({ activeTask: null });
    }
  })().catch(() => {});
  return { skipped: false, started: true, task_id: taskId };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const type = message && message.type;
    if (type === "fpb.networkCapture.event") {
      const out = await handleNetworkRuntimeMessage(message, sender);
      sendResponse(out || { ok: true });
      return;
    }
    if (type === "content.fpbConfig") {
      const cfg = message.config || {};
      const redirectUrl = normalizeRedirectUrl(message.redirect_url || cfg.redirect_url || "");
      const patch = {};
      if (cfg.bridge_url) patch.bridge_url = cfg.bridge_url;
      if (cfg.bridge_token) patch.bridge_token = cfg.bridge_token;
      if (cfg.space_id) patch.space_id = cfg.space_id;
      if (cfg.window_key) patch.window_key = cfg.window_key;
      if (cfg.google_account) patch.google_account = cfg.google_account;
      if (cfg.google_password) patch.google_password = cfg.google_password;
      if (cfg.google_efa) patch.google_efa = cfg.google_efa;
      if (Object.keys(patch).length) {
        await chrome.storage.local.set(patch);
        const logPatch = { ...patch };
        if (logPatch.google_password) logPatch.google_password = "***";
        await pushLog("info", "config received from content script", logPatch);
      }
      await connectBridge({ force: true, reason: "content.fpbConfig" });
      let bridgeReady = false;
      let redirected = false;
      if (redirectUrl && sender && sender.tab && sender.tab.id) {
        bridgeReady = await waitForBridgeReady(5000);
        // 给 Python 侧 trigger 函数留出时间断开 Playwright/CDP，再由插件跳转目标站点。
        await sleep(3000);
        await pushLog("info", "redirecting tab after fpb config and cdp grace delay", { redirect_url: redirectUrl, bridge_ready: bridgeReady, delay_ms: 3000 });
        try {
          await chrome.tabs.update(sender.tab.id, { url: redirectUrl, active: true });
          redirected = true;
        } catch (e) {
          await pushLog("warn", "redirect tab failed", { redirect_url: redirectUrl, error: String(e && e.message || e) });
        }
      }
      sendResponse({ ok: true, redirected, bridge_ready: bridgeReady });
      return;
    }
    if (type === "popup.getState") {
      const cfg = await getConfig();
      const got = await chrome.storage.local.get(["runtime_status", "debug_logs", "transfer_data", "popup_active_tab"]);
      sendResponse({
        ok: true,
        config: cfg,
        status: got.runtime_status || status,
        logs: Array.isArray(got.debug_logs) ? got.debug_logs : [],
        transferData: got.transfer_data || null,
        activeTab: got.popup_active_tab || "debug"
      });
      return;
    }
    if (type === "popup.saveConfig") {
      const cfg = message.config || {};
      await chrome.storage.local.set({
        bridge_url: cfg.bridgeUrl || "",
        bridge_token: cfg.bridgeToken || "",
        space_id: cfg.spaceId || "",
        window_key: cfg.windowKey || "",
        google_account: cfg.googleAccount || "",
        google_password: cfg.googlePassword || "",
        google_efa: cfg.googleEfa || "",
        google_auto_login_watch_enabled: cfg.googleAutoLoginWatchEnabled === true,
        veo_archive_enabled: cfg.veoArchiveEnabled !== false
      });
      await pushLog("info", "config saved from popup");
      connectBridge({ force: true, reason: "popup.saveConfig" }).catch(console.error);
      sendResponse({ ok: true });
      return;
    }
    if (type === "popup.reconnect") {
      await pushLog("info", "manual reconnect");
      connectBridge({ force: true, reason: "popup.reconnect" }).catch(console.error);
      sendResponse({ ok: true });
      return;
    }
    if (type === "popup.clearCurrentPageLocalStorage") {
      const result = await clearCurrentPageLocalStorage();
      sendResponse({ ok: true, result });
      return;
    }
    if (type === "popup.googleAutoLogin") {
      const tab = await getActiveTab();
      const url = String(tab?.url || "");
      if (tab?.id && isGoogleAutoLoginProtectedUrl(url)) {
        sendResponse({
          ok: true,
          result: { skipped: true, reason: "protected_google_page", url }
        });
        return;
      }
      await chargeNewapiUsage("popup_google_auto_login", { source: "popup.googleAutoLogin" });
      const result = await runGoogleAutoLogin(
        message.creds || {},
        tab?.id ? { charged: true, tabId: tab.id, url, onlyIfGoogleLoginPage: true } : { charged: true, onlyIfGoogleLoginPage: true }
      );
      sendResponse({ ok: true, result });
      return;
    }
    if (type === "popup.setGoogleAutoLoginWatch") {
      const enabled = message.enabled === true;
      const creds = message.creds || {};
      const patch = { google_auto_login_watch_enabled: enabled };
      if (typeof creds.googleAccount === "string") patch.google_account = creds.googleAccount;
      if (typeof creds.googlePassword === "string") patch.google_password = creds.googlePassword;
      if (typeof creds.googleEfa === "string") patch.google_efa = creds.googleEfa;
      await chrome.storage.local.set(patch);
      await pushLog("info", "Google auto login watch config saved", { enabled });
      let trigger = null;
      if (enabled && message.triggerNow) {
        trigger = await maybeRunGoogleAutoLoginForActiveTab("watch_enabled");
      }
      sendResponse({ ok: true, trigger });
      return;
    }
    if (type === "popup.veoGenerateTest") {
      const result = await runPopupVeoGenerateTest(message.kind);
      sendResponse({ ok: true, result });
      return;
    }
    if (type === "popup.setActiveTab") {
      const allowed = ["debug", "transfer", "analysis"];
      const tab = allowed.includes(String(message.tab || "")) ? String(message.tab) : "debug";
      await chrome.storage.local.set({ popup_active_tab: tab });
      sendResponse({ ok: true });
      return;
    }
    if (type === "popup.clearTransferData") {
      await chrome.storage.local.remove(["transfer_data"]);
      sendResponse({ ok: true });
      return;
    }
    if (type === "popup.clearLogs") {
      await chrome.storage.local.set({ debug_logs: [] });
      sendResponse({ ok: true });
      return;
    }
    if (type === "popup.networkCapture.start") {
      let tab = null;
      const requestedTabId = Number(message.tabId || message.tab_id || 0) || 0;
      if (requestedTabId) {
        try { tab = await chrome.tabs.get(requestedTabId); } catch (_) { tab = null; }
      }
      if (!tab) {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tab = tabs && tabs[0];
      }
      const url = String(tab && tab.url || "");
      if (!/^https?:\/\//i.test(url)) {
        sendResponse({
          ok: false,
          error: "连接失败：当前页面不是可注入的目标网页，请切换到 http/https 业务页面后再点击开始",
          current_url: url
        });
        return;
      }
      const resp = await runNetworkTask({ payload: { action: "start", tabId: tab.id } }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.networkCapture.pause") {
      const resp = await runNetworkTask({ payload: { action: "pause" } }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.networkCapture.resume") {
      const resp = await runNetworkTask({ payload: { action: "resume" } }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.networkCapture.stop") {
      const resp = await runNetworkTask({ payload: { action: "stop" } }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.networkCapture.clear") {
      const resp = await runNetworkTask({ payload: { action: "clear" } }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.networkCapture.status") {
      const resp = await runNetworkTask({ payload: { action: "status" } }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.networkCapture.snapshot") {
      const since_seq = message.since_seq != null ? Number(message.since_seq) : undefined;
      const limit = message.limit != null ? Number(message.limit) : undefined;
      const payload = { action: "snapshot" };
      if (since_seq != null) payload.since_seq = since_seq;
      if (limit != null) payload.limit = limit;
      const resp = await runNetworkTask({ payload }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.networkCapture.deleteEvent") {
      const resp = await runNetworkTask({ payload: { action: "delete_event", seq: message.seq } }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.networkCapture.updateEvent") {
      const resp = await runNetworkTask({ payload: { action: "update_event", seq: message.seq, patch: message.patch || {} } }, null);
      sendResponse({ ok: true, result: resp });
      return;
    }
    if (type === "popup.analysis.getConfig") {
      const got = await chrome.storage.local.get(["analysis_api_key", "analysis_model"]);
      sendResponse({ ok: true, result: {
        apiKey: got.analysis_api_key || "",
        model:  got.analysis_model  || ""
      }});
      return;
    }
    if (type === "popup.analysis.saveConfig") {
      const c = message.config || {};
      await chrome.storage.local.set({
        analysis_api_key: String(c.apiKey || ""),
        analysis_model:   String(c.model  || "")
      });
      sendResponse({ ok: true });
      return;
    }
    if (type === "popup.analysis.listModels") {
      const got = await chrome.storage.local.get(["analysis_api_key"]);
      const cfg = await getConfig();
      const token = String(got.analysis_api_key || cfg.bridgeToken || "").trim();
      try {
        const resp = await fetch(`${NEWAPI_CHARGE_BASE_URL}/v1/models`, {
          headers: token ? { "Authorization": `Bearer ${token}` } : {}
        });
        const data = await resp.json();
        sendResponse({ ok: true, result: data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }
    if (type === "popup.analysis.fetchScriptFragment") {
      // Fetch ~4 KB of a minified JS file around a given line:col position
      const scriptUrl = String(message.url || "").trim();
      const lineNum = Math.max(0, Number(message.line || 0));
      const colNum = Math.max(0, Number(message.col || 0));
      const contextBytes = Math.min(8192, Math.max(512, Number(message.contextBytes || 4096)));
      if (!scriptUrl) { sendResponse({ ok: false, error: "url required" }); return; }
      let text;
      try {
        const r = await fetch(scriptUrl, { cache: "force-cache" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        text = await r.text();
      } catch (e) {
        sendResponse({ ok: false, error: `fetch failed: ${e.message}` });
        return;
      }
      // Convert line:col to byte offset (lines are 0-indexed from CDP)
      let offset = 0;
      let currentLine = 0;
      while (currentLine < lineNum && offset < text.length) {
        const nl = text.indexOf("\n", offset);
        if (nl === -1) { offset = text.length; break; }
        offset = nl + 1;
        currentLine++;
      }
      offset = Math.min(offset + colNum, text.length);
      const half = Math.floor(contextBytes / 2);
      const start = Math.max(0, offset - half);
      const end = Math.min(text.length, offset + half);
      sendResponse({
        ok: true,
        fragment: text.slice(start, end),
        fragmentStart: start,
        fragmentEnd: end,
        totalLength: text.length,
        cursorOffset: offset - start
      });
      return;
    }
    if (type === "popup.analysis.runGeneratedTest") {
      const tabId = Number(message.tabId || 0);
      const code = String(message.code || "");
      const config = message.config || {};
      if (!tabId) { sendResponse({ ok: false, error: "tabId required" }); return; }
      if (!code.trim()) { sendResponse({ ok: false, error: "generated code required" }); return; }
      try {
        const result = await runAnalysisGeneratedTestWithDebugger(tabId, code, config);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
      return;
    }
    if (type === "popup.analysis.evaluateTargetPage") {
      const tabId = Number(message.tabId || 0);
      const expression = String(message.expression || "");
      const options = message.options || {};
      if (!tabId) { sendResponse({ ok: false, error: "tabId required" }); return; }
      if (!expression.trim()) { sendResponse({ ok: false, error: "expression required" }); return; }
      try {
        const result = await runAnalysisExpressionWithDebugger(tabId, expression, options);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
      return;
    }
    if (type === "popup.analysis.cancelAiChat") {
      const requestId = String(message.requestId || "");
      const controller = requestId ? analysisAiControllers.get(requestId) : null;
      if (controller) {
        try { controller.abort(); } catch (_) {}
        analysisAiControllers.delete(requestId);
      }
      sendResponse({ ok: true, cancelled: !!controller });
      return;
    }
    if (type === "popup.analysis.aiChat") {
      const got = await chrome.storage.local.get(["analysis_api_key"]);
      const cfg = await getConfig();
      const token = String(got.analysis_api_key || cfg.bridgeToken || "").trim();
      if (!token) { sendResponse({ ok: false, error: "bridge_token 未配置" }); return; }
      const baseUrl = NEWAPI_CHARGE_BASE_URL.replace(/\/+$/, "");
      const model = String(message.model || "").trim() || "claude-sonnet-4-6";
      const messages = Array.isArray(message.messages) ? message.messages : [];
      const tools = Array.isArray(message.tools) ? message.tools : undefined;
      const body = { model, messages, max_tokens: message.max_tokens || 8192 };
      if (tools && tools.length) { body.tools = tools; body.tool_choice = { type: "auto" }; }
      if (message.system) body.system = String(message.system);
      let resp, text;
      const requestId = String(message.requestId || message.request_id || "");
      const controller = requestId && typeof AbortController !== "undefined" ? new AbortController() : null;
      if (requestId && controller) analysisAiControllers.set(requestId, controller);
      try {
        resp = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": token,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          },
          signal: controller ? controller.signal : undefined,
          body: JSON.stringify(body)
        });
        text = await resp.text();
      } catch (e) {
        if (requestId) analysisAiControllers.delete(requestId);
        if (String(e && e.name || "") === "AbortError") {
          sendResponse({ ok: false, stopped: true, error: "已停止" });
          return;
        }
        sendResponse({ ok: false, error: `AI request failed: ${e.message}` });
        return;
      }
      if (requestId) analysisAiControllers.delete(requestId);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) {}
      if (!resp.ok) {
        const msg = (json && (json.error?.message || json.error?.code)) || text || `HTTP ${resp.status}`;
        sendResponse({ ok: false, error: msg });
        return;
      }
      sendResponse({ ok: true, result: json });
      return;
    }
    sendResponse({ ok: false, error: "unknown message type" });
  })().catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const keys = ["bridge_url", "bridge_token", "space_id", "window_key"];
  const changed = keys.some(k => {
    if (!Object.prototype.hasOwnProperty.call(changes, k)) return false;
    return changes[k].oldValue !== changes[k].newValue;
  });
  if (changed) {
    pushLog("info", "config changed, reconnecting").catch(() => {});
    connectBridge({ force: true, reason: "storage.changed" }).catch(console.error);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = String(changeInfo.url || tab?.url || "");
  if (!url) return;
  const statusValue = String(changeInfo.status || tab?.status || "");
  // 仅在 URL 变化或页面 complete 时触发，不轮询页面，适合大量浏览器实例低资源运行。
  if (changeInfo.url || statusValue === "complete") {
    if (isGoogleAutoLoginWatchUrl(url)) {
      maybeRunGoogleAutoLoginForTab(tabId, url, changeInfo.url ? "url_change" : "page_complete").catch(() => {});
    }
    if (isLabsGoogleWatchUrl(url)) {
      maybeRunVeoChangelogWatchForTab(tabId, url, changeInfo.url ? "url_change" : "page_complete").catch(() => {});
    }
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  const tabId = activeInfo && activeInfo.tabId;
  if (!tabId) return;
  chrome.tabs.get(tabId).then((tab) => {
    const url = String(tab && tab.url || "");
    if (isLabsGoogleWatchUrl(url)) {
      maybeRunVeoChangelogWatchForTab(tabId, url, "tab_activated").catch(() => {});
    }
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  googleAutoLoginRunningTabs.delete(tabId);
  googleAutoLoginLastByTab.delete(tabId);
  gptCloudflareRunningTabs.delete(tabId);
  gptCloudflareLastByTab.delete(tabId);
  gptBusyTabs.delete(tabId);
  veoChangelogRunningTabs.delete(tabId);
  veoChangelogLastByTab.delete(tabId);
});

try {
  chrome.windows.onBoundsChanged.addListener((win) => {
    queueAnalysisWindowStateSave(win);
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (!windowId || windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.windows.get(windowId).then(win => {
      queueAnalysisWindowStateSave(win);
    }).catch(() => {});
  });
} catch (_) {}

try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
      pushLog("warn", "side panel behavior setup failed", { error: String(e && e.message || e) }).catch(() => {});
    });
  }
} catch (_) {}

chrome.runtime.onInstalled.addListener(() => {
  ensurePersistentConnection("runtime.onInstalled").catch(console.error);
  scanVeoChangelogWatch("runtime.onInstalled").catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  ensurePersistentConnection("runtime.onStartup").catch(console.error);
  scanVeoChangelogWatch("runtime.onStartup").catch(() => {});
});
try {
  chrome.alarms.create("fpb_keep_ws", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === "fpb_keep_ws") {
      ensurePersistentConnection("alarm.keep_ws").catch(console.error);
      scanVeoChangelogWatch("alarm.keep_ws").catch(() => {});
    }
  });
} catch (_) {}
ensurePersistentConnection("startup").catch(console.error);
scanVeoChangelogWatch("startup").catch(() => {});
