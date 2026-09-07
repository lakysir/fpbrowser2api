import { ensureTab as ensureGenericTab, fetchJson, compactErrorResponse, simulateHumanActivity, uploadDataUrlToR2 } from "./common.js";

const URLS = {
  credits: "https://aisandbox-pa.googleapis.com/v1/credits",
  uploadImage: "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage",
  videoT2V: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText",
  videoI2VStart: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage",
  videoI2VStartEnd: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage",
  videoR2V: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages",
  videoEdit: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoEditVideo",
  videoPoll: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
  uploadVideoStart: "https://labs.google/fx/api/upload-video?action=start",
  uploadVideoChunk: "https://labs.google/fx/api/upload-video?action=upload",
  updateVideoOffset: "https://labs.google/fx/api/trpc/videoFx.updateVideoOffset",
  upsampleImage: "https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage",
  workflows: "https://aisandbox-pa.googleapis.com/v1/flowWorkflows"
};

function authHeaders(at) {
  return { "Accept": "application/json", "Content-Type": "application/json", "Authorization": `Bearer ${at}` };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sessionId() { return `;${Date.now()}`; }
function randSeed(max = 99999) { return 1 + Math.floor(Math.random() * max); }
const VEO_UPLOAD_IMAGE_TIMEOUT_MS = 60000;

// VEO supports concurrent jobs in the same fingerprint-browser window. When
// several jobs reuse one labs.google tab, job B's submit/done refresh can
// destroy the frame while job A is running a MAIN-world fetch via
// chrome.scripting.executeScript; Chrome may then resolve with an undefined
// result ("pageFetchJson returned empty result ..."). Serialize per-tab
// navigation/refresh with frame-dependent executeScript calls, without locking
// the whole workflow, so video polling and separate jobs can still overlap.
const veoTabOpLocks = new Map();
const VEO_RUN_ID = Symbol("veoRunId");
const activeVeoTaskRuns = new Map();
const HUMAN_ACTIVITY_ACTIONS = new Set([
  "human_activity",
  "simulate_human_activity"
]);
let veoTaskRunSeq = 0;
let veoHumanActivityPromise = null;
let veoHumanActivityInfo = null;

function beginVeoTaskRun(msg, runtime) {
  const taskId = String((runtime && runtime.taskId) || (msg && msg.task_id) || "unknown");
  const runId = `${taskId}:${Date.now()}:${++veoTaskRunSeq}`;
  activeVeoTaskRuns.set(runId, {
    task_id: taskId,
    provider: "veo",
    started_at: Date.now()
  });
  if (runtime) {
    try { runtime[VEO_RUN_ID] = runId; } catch (_) {}
  }
  return runId;
}

function endVeoTaskRun(runId, runtime) {
  if (runId) activeVeoTaskRuns.delete(runId);
  if (runtime) {
    try {
      if (runtime[VEO_RUN_ID] === runId) delete runtime[VEO_RUN_ID];
    } catch (_) {}
  }
}

function countOtherActiveVeoTaskRuns(runtime) {
  const currentRunId = runtime && runtime[VEO_RUN_ID];
  let n = 0;
  for (const runId of activeVeoTaskRuns.keys()) {
    if (runId !== currentRunId) n++;
  }
  return n;
}

async function waitForVeoHumanActivityIdle(runtime) {
  const p = veoHumanActivityPromise;
  if (!p) return false;
  try {
    await runtime.progress(1, {
      stage: "wait_human_activity",
      reason: "human_activity_running",
      human_activity: veoHumanActivityInfo || {}
    });
  } catch (_) {}
  try {
    await p;
  } catch (_) {}
  try {
    await runtime.progress(1, { stage: "wait_human_activity_done" });
  } catch (_) {}
  return true;
}

async function runVeoHumanActivityAction(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = normalizeVeoProjectPageUrl(p.project_page || p.target_url || p.veo_url || "https://flow.google.com/");
  if (activeVeoTaskRuns.size > 0) {
    try {
      await runtime.progress(100, {
        stage: "human_activity_skipped",
        reason: "veo_task_running",
        active_veo_tasks: activeVeoTaskRuns.size
      });
    } catch (_) {}
    return {
      type: "veo_human_activity",
      skipped: true,
      reason: "veo_task_running",
      active_veo_tasks: activeVeoTaskRuns.size
    };
  }
  if (veoHumanActivityPromise) {
    try {
      await runtime.progress(100, {
        stage: "human_activity_skipped",
        reason: "human_activity_already_running",
        human_activity: veoHumanActivityInfo || {}
      });
    } catch (_) {}
    return {
      type: "veo_human_activity",
      skipped: true,
      reason: "human_activity_already_running"
    };
  }

  const minMs = Math.max(1000, Number(p.human_activity_min_ms || p.min_ms || 10000) || 10000);
  const maxMs = Math.max(minMs + 1, Number(p.human_activity_max_ms || p.max_ms || 15000) || 15000);
  const startedAt = Date.now();
  veoHumanActivityInfo = {
    task_id: String((msg && msg.task_id) || (runtime && runtime.taskId) || ""),
    project_page: projectPage,
    started_at: startedAt,
    min_ms: minMs,
    max_ms: maxMs
  };
  const activityRuntime = {
    ...(runtime || {}),
    progress: async (progress, data = {}) => {
      try {
        if (runtime && typeof runtime.progress === "function") {
          await runtime.progress(progress, data);
        }
      } catch (_) {}
    }
  };

  veoHumanActivityPromise = (async () => {
    await activityRuntime.progress(2, { stage: "human_activity_ensure_tab", url: projectPage });
    const tabId = await ensureVeoProjectTab(projectPage, {
      navigate: p.navigate !== false,
      active: p.active !== false
    });
    const shouldReload = p.reload !== false && p.reload_page !== false;
    let reloaded = false;
    if (shouldReload) {
      reloaded = await reloadProjectPage(4, tabId, projectPage, activityRuntime, { skipActiveCheck: true });
    }
    const result = await simulateHumanActivity(tabId, activityRuntime, minMs, maxMs, {
      stage: "veo_human_activity",
      progress: 8,
      clickInputs: true,
      scroll: true,
      moveMouse: true
    });
    const elapsedMs = Date.now() - startedAt;
    await activityRuntime.progress(100, {
      stage: "human_activity_done",
      url: projectPage,
      tab_id: tabId,
      reloaded,
      elapsed_ms: elapsedMs,
      result
    });
    return {
      type: "veo_human_activity",
      skipped: false,
      project_page: projectPage,
      tab_id: tabId,
      reloaded,
      elapsed_ms: elapsedMs,
      result
    };
  })();

  try {
    return await veoHumanActivityPromise;
  } finally {
    veoHumanActivityPromise = null;
    veoHumanActivityInfo = null;
  }
}

async function shouldSkipProjectPageRefresh(progress, runtime, stage, url) {
  const otherActiveTasks = countOtherActiveVeoTaskRuns(runtime);
  if (!otherActiveTasks) return false;
  try {
    await runtime.progress(progress, {
      stage: `${stage}_skipped`,
      url,
      reason: "other_tasks_running",
      active_veo_tasks: activeVeoTaskRuns.size,
      other_active_veo_tasks: otherActiveTasks
    });
  } catch (_) {}
  return true;
}

async function withVeoTabOpLock(tabId, label, fn) {
  const key = `veo-tab:${String(tabId || "unknown")}`;
  const prev = veoTabOpLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = prev.catch(() => {}).then(() => gate);
  veoTabOpLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    try { release(); } catch (_) {}
    if (veoTabOpLocks.get(key) === tail) veoTabOpLocks.delete(key);
  }
}

function isTransientPageFetchError(e) {
  const s = String((e && e.message) || e || "");
  return /empty result|frame.*(removed|detached|destroyed)|cannot access.*contents|extension context invalidated|no tab with id|tab.*closed|target closed|execution context.*destroyed/i.test(s);
}

function isNonRetryableVeoSubmitError(e) {
  const s = String((e && e.message) || e || "");
  if (!/\bVEO\s+(?:image|video)\s+submit\s+failed:/i.test(s)) return false;
  return /\bINVALID_ARGUMENT\b/i.test(s) || /\bPUBLIC_ERROR_USER_QUOTA_REACHED\b/i.test(s);
}

function archiveEnabled(p, key = "archive_workflow") {
  const v = p && Object.prototype.hasOwnProperty.call(p, key) ? p[key] : true;
  return v !== false;
}

function isVeoFlowPageUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && (
      (u.hostname === "labs.google" && u.pathname.startsWith("/fx/tools/flow")) ||
      u.hostname === "flow.google.com"
    );
  } catch (_) {
    return false;
  }
}

// Flow migrated from labs.google. Normalize user/task supplied workspace URLs
// before opening or refreshing a tab, while leaving API endpoints untouched.
function normalizeVeoProjectPageUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "https://flow.google.com/";
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") return value;
    if (u.hostname === "labs.google") {
      const projectMatch = u.pathname.match(/^\/fx\/tools\/flow\/project\/([^/?#]+)\/?$/i);
      if (projectMatch) return `https://flow.google.com/project/${encodeURIComponent(decodeURIComponent(projectMatch[1]))}`;
      if (/^\/fx\/?$/i.test(u.pathname) || /^\/fx\/tools\/flow\/?$/i.test(u.pathname)) return "https://flow.google.com/";
    }
    return value;
  } catch (_) {
    return value;
  }
}

function isVeoWorkspacePageUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && (u.hostname === "labs.google" || u.hostname === "flow.google.com");
  } catch (_) {
    return false;
  }
}

async function getCurrentWindowActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (Array.isArray(tabs) && tabs[0]) return tabs[0];
  } catch (_) {}
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
    const tabs = Array.isArray(win && win.tabs) ? win.tabs : [];
    return tabs.find(t => t && t.active) || tabs[0] || null;
  } catch (_) {}
  try {
    const tabs = await chrome.tabs.query({});
    return (tabs || []).find(t => t && t.active) || (tabs || [])[0] || null;
  } catch (_) {
    return null;
  }
}

async function fetchVeoCurrentPageTask(msg, runtime) {
  const tab = await getCurrentWindowActiveTab();
  const url = String((tab && tab.url) || "");
  try {
    await runtime.progress(100, { stage: "current_page", url, is_flow_page: isVeoFlowPageUrl(url) });
  } catch (_) {}
  return {
    type: "veo_current_page",
    tab_id: tab && tab.id ? tab.id : null,
    window_id: tab && tab.windowId ? tab.windowId : null,
    url,
    title: String((tab && tab.title) || ""),
    is_flow_page: isVeoFlowPageUrl(url),
    required_url_prefix: "https://flow.google.com/"
  };
}

async function waitTabComplete(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === "complete") return true;
    } catch (_) {}
    await sleep(250);
  }
  return false;
}

function isGoogleLoginPageUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    if (u.protocol !== "https:" || u.hostname !== "accounts.google.com") return false;
    const s = (u.pathname + u.search + u.hash).toLowerCase();
    if (u.pathname === "/" || s.includes("/signin/") || s.includes("/v3/signin/")) return true;
    return ["identifier", "challenge", "selectaccount", "oauth", "service=", "continue=", "speedbump", "passkey"].some(x => s.includes(x));
  } catch (_) {
    return /accounts\.google\.com/i.test(String(raw || ""));
  }
}

async function waitGoogleAutoLoginIfNeeded(tabId, runtime, timeoutMs = 40000) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch (_) { tab = null; }
  let url = String(tab && tab.url || "");
  if (!isGoogleLoginPageUrl(url)) return { waited: false, reason: "not_google_login_page", url };

  const startedAt = Date.now();
  try {
    await runtime.progress(6, {
      stage: "wait_google_auto_login",
      tab_id: tabId,
      url,
      timeout_ms: timeoutMs
    });
  } catch (_) {}

  const deadline = startedAt + Math.max(1000, Number(timeoutMs || 0) || 40000);
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      tab = await chrome.tabs.get(tabId);
      url = String(tab && tab.url || "");
      if (tab && tab.status !== "complete") await waitTabComplete(tabId, Math.min(5000, Math.max(1000, deadline - Date.now())));
      if (!isGoogleLoginPageUrl(url)) {
        const elapsedMs = Date.now() - startedAt;
        try {
          await runtime.progress(8, {
            stage: "wait_google_auto_login_done",
            tab_id: tabId,
            url,
            elapsed_ms: elapsedMs
          });
        } catch (_) {}
        return { waited: true, success: true, url, elapsed_ms: elapsedMs };
      }
    } catch (_) {
      break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  try {
    await runtime.progress(8, {
      stage: "wait_google_auto_login_timeout",
      tab_id: tabId,
      url,
      elapsed_ms: elapsedMs,
      timeout_ms: timeoutMs
    });
  } catch (_) {}
  return { waited: true, success: false, reason: "timeout", url, elapsed_ms: elapsedMs };
}

export async function dismissVeoChangelogModalIfPresent(tabId) {
  if (!tabId) return { clicked: false, reason: "no_tab_id" };
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = String((tab && tab.url) || "");
    if (!isVeoWorkspacePageUrl(url)) return { clicked: false, reason: "not_veo_workspace", url };
    if (tab && tab.status !== "complete") await waitTabComplete(tabId, 15000);
  } catch (_) {}
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        if (location.protocol !== "https:" || (location.hostname !== "labs.google" && location.hostname !== "flow.google.com")) {
          return { found: false, clicked: false, reason: "not_veo_workspace", url: String(location.href || "") };
        }
        const getText = () => String(document.body && document.body.innerText || "");
        const text = getText();
        const idx = text.toLowerCase().indexOf("view all changelogs");
        const hasPopup = !!document.querySelector('div[role="dialog"]');
        try { console.log("dialog exists:", hasPopup); } catch (_) {}
        if (idx < 0 && !hasPopup) {
          return { found: false, clicked: false, reason: "changelog_modal_not_found", url: String(location.href || "") };
        }
        const x = Math.max(8, Math.min(24, window.innerWidth - 8));
        const y = Math.max(8, Math.min(Math.round(window.innerHeight / 2), window.innerHeight - 8));
        const target = document.elementFromPoint(x, y) || document.body || document.documentElement;
        const dispatch = (type, extra = {}) => {
          const init = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
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
        };
        dispatch("pointermove");
        dispatch("mousemove");
        await sleep(30);
        dispatch("pointerdown");
        dispatch("mousedown");
        await sleep(60);
        dispatch("pointerup");
        dispatch("mouseup");
        dispatch("click");
        await sleep(350);
        const dismissed = getText().toLowerCase().indexOf("view all changelogs") < 0 &&
          !document.querySelector('div[role="dialog"]');
        return {
          found: true,
          clicked: dismissed,
          dismissed,
          reason: dismissed ? undefined : "safe_area_click_did_not_dismiss",
          via: "dom_safe_area",
          x,
          y,
          url: String(location.href || ""),
          matched_text: idx >= 0 ? text.slice(Math.max(0, idx - 40), idx + 80) : "",
          has_dialog: hasPopup
        };
      }
    });
    return Array.isArray(frames) && frames[0] && frames[0].result ? frames[0].result : { clicked: false, reason: "empty_execute_result" };
  } catch (e) {
    return { clicked: false, reason: "dismiss_failed", error: String((e && e.message) || e || "") };
  }
}

async function closeOtherTabsInSameWindow(keepTabId) {
  const keepIds = Array.isArray(keepTabId) ? keepTabId : [keepTabId];
  const keepSet = new Set(keepIds.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0));
  let keepTab = null;
  try { keepTab = await chrome.tabs.get(keepIds[0]); } catch (_) {}
  const query = keepTab && keepTab.windowId ? { windowId: keepTab.windowId } : {};
  const tabs = await chrome.tabs.query(query);
  const removeIds = [];
  for (const tab of tabs || []) {
    if (!tab || !tab.id || keepSet.has(Number(tab.id))) continue;
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

async function ensureAiStudioNewChatTab({ active = false, windowId = null } = {}) {
  const targetUrl = "https://aistudio.google.com/prompts/new_chat?model=gemini-3-pro-image";
  const queryWindowId = Number(windowId);
  const tabs = await chrome.tabs.query(Number.isFinite(queryWindowId) ? { windowId: queryWindowId } : {});
  const found = tabs.find(t => (t.url || "") === targetUrl) ||
    tabs.find(t => String(t.url || "").startsWith(targetUrl));
  if (found && found.id) {
    if (found.url !== targetUrl) {
      await chrome.tabs.update(found.id, { url: targetUrl, active });
      await waitTabComplete(found.id, 45000);
      await sleep(1200);
    } else {
      await chrome.tabs.update(found.id, { active });
      if (found.status !== "complete") await waitTabComplete(found.id, 45000);
    }
    return found.id;
  }
  const createInfo = { url: targetUrl, active };
  if (Number.isFinite(Number(windowId))) createInfo.windowId = Number(windowId);
  const tab = await chrome.tabs.create(createInfo);
  if (tab && tab.id) {
    await waitTabComplete(tab.id, 45000);
    await sleep(1200);
  }
  return tab && tab.id ? tab.id : null;
}

async function ensureVeoProjectTab(projectPage, { active = true, navigate = true, create = true } = {}) {
  const targetUrl = normalizeVeoProjectPageUrl(projectPage || "https://flow.google.com/");
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find(t => (t.url || "") === targetUrl);
  const found = exact || tabs.find(t => isVeoWorkspacePageUrl(t.url));
  if (found && found.id) {
    // A Labs page may have migrated to flow.google.com. Reuse either host
    // instead of navigating back to the requested Labs URL.
    let targetHost = "";
    let foundHost = "";
    try { targetHost = new URL(targetUrl).hostname; } catch (_) {}
    try { foundHost = new URL(found.url || "").hostname; } catch (_) {}
    const shouldNavigate = navigate && targetUrl && found.url !== targetUrl && !(foundHost === "flow.google.com" && targetHost !== "flow.google.com");
    if (shouldNavigate) {
      await withVeoTabOpLock(found.id, "ensure_project_tab_navigate", async () => {
        await chrome.tabs.update(found.id, { url: targetUrl, active });
        await waitTabComplete(found.id, 45000);
        await sleep(1200);
      });
    } else {
      await chrome.tabs.update(found.id, { active });
    }
    await dismissVeoChangelogModalIfPresent(found.id);
    return found.id;
  }
  if (!create) return null;
  const tab = await chrome.tabs.create({ url: targetUrl, active });
  if (tab && tab.id) {
    await waitTabComplete(tab.id, 45000);
    await sleep(1200);
    await dismissVeoChangelogModalIfPresent(tab.id);
  }
  return tab.id;
}

async function assertProjectPageAccessible(projectPage, runtime) {
  const url = normalizeVeoProjectPageUrl(projectPage || "https://flow.google.com/");
  let resp = null;
  let text = "";
  try {
    await runtime.progress(2, { stage: "check_project_page", url, method: "GET" });
  } catch (_) {}
  try {
    resp = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    });
    try { text = await resp.text(); } catch (_) { text = ""; }
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    throw new Error(`VEO project page GET failed: ${url}; Request Method: GET; error=${msg}`);
  }
  if (!resp || !resp.ok) {
    const status = resp ? resp.status : 0;
    const statusText = resp ? (resp.statusText || "") : "";
    const finalUrl = resp ? (resp.url || url) : url;
    const body = String(text || "").slice(0, 500);
    throw new Error(`VEO project page is not accessible: ${finalUrl}; Request Method: GET; Status Code: ${status}${statusText ? ` ${statusText}` : ""}; response: ${body}`);
  }
  try {
    await runtime.progress(2, { stage: "check_project_page_ok", url: resp.url || url, status: resp.status });
  } catch (_) {}
  return { status: resp.status, url: resp.url || url };
}

async function reloadProjectPage(progress, tabId, projectPage, runtime, options = {}) {
  return await withVeoTabOpLock(tabId, "reload_project_page", async () => {
    projectPage = normalizeVeoProjectPageUrl(projectPage);
    if (options.skipActiveCheck !== true && await shouldSkipProjectPageRefresh(progress, runtime, "reload_project_page", projectPage)) return false;
    await runtime.progress(progress, { stage: "reload_project_page", url: projectPage });
    try {
      // 单任务时对 project_page 做一次真实刷新；如果还有其它 VEO
      // 任务在跑，上面的检查会跳过刷新，避免销毁其它任务正在使用的 frame。
      await chrome.tabs.update(tabId, { active: true });
      await chrome.tabs.reload(tabId, { bypassCache: false });
      await waitTabComplete(tabId, 45000);
      await sleep(1200);
      await dismissVeoChangelogModalIfPresent(tabId);
      return true;
    } catch (e) {
      // reload 失败时兜底导航到项目页，仍保证插件任务从 projectPage 开始。
      await chrome.tabs.update(tabId, { url: projectPage, active: true });
      await waitTabComplete(tabId, 45000);
      await sleep(1200);
      await dismissVeoChangelogModalIfPresent(tabId);
      return true;
    }
  });
}

async function clearLabsGoogleLocalStorageBeforeReload(progress, tabId, projectPage, runtime) {
  return await withVeoTabOpLock(tabId, "clear_labs_google_local_storage", async () => {
    await runtime.progress(progress, {
      stage: "clear_labs_google_local_storage",
      url: projectPage,
      target_origin: "https://labs.google"
    });
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status !== "complete") await waitTabComplete(tabId, 45000);
    } catch (_) {}
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const currentUrl = String(location.href || "");
        if (location.protocol !== "https:" || (location.hostname !== "labs.google" && location.hostname !== "flow.google.com")) {
          return {
            cleared: false,
            reason: "not_veo_workspace_page",
            url: currentUrl,
            before: null,
            after: null
          };
        }
        const before = localStorage.length;
        localStorage.clear();
        return {
          cleared: true,
          url: currentUrl,
          before,
          after: localStorage.length
        };
      }
    });
    const result = Array.isArray(frames) && frames[0] ? frames[0].result : null;
    if (!result) throw new Error("clear labs.google localStorage returned empty result");
    if (!result.cleared) {
      throw new Error(`clear labs.google localStorage skipped: ${result.reason || "unknown"}; url=${result.url || ""}`);
    }
    await runtime.progress(progress, {
      stage: "clear_labs_google_local_storage_done",
      url: result.url,
      before: result.before,
      after: result.after
    });
    return result;
  });
}

async function resetLabsGoogleLocalStorageAndReload(progress, tabId, projectPage, runtime, options = {}) {
  const clearResult = await clearLabsGoogleLocalStorageBeforeReload(progress, tabId, projectPage, runtime);
  const reloaded = await reloadProjectPage(progress, tabId, projectPage, runtime, options);
  return { clearResult, reloaded };
}

async function resetLabsGoogleLocalStorageAndReloadForRetry(progress, tabId, projectPage, runtime, reason = "") {
  try {
    await resetLabsGoogleLocalStorageAndReload(progress, tabId, projectPage, runtime);
    return true;
  } catch (e) {
    try {
      await runtime.progress(progress, {
        stage: "clear_labs_google_local_storage_retry_failed",
        url: projectPage,
        reason,
        error: String((e && e.message) || e || "").slice(0, 300)
      });
    } catch (_) {}
    return false;
  }
}

async function pageFetchJson(tabId, url, { method = "GET", headers = {}, body = null, attempts = 3, timeoutMs = 0 } = {}) {
  let lastErr = null;
  let lastAttempt = 0;
  const reqMethod = String(method || "GET").toUpperCase();
  const maxAttempts = Math.max(1, Number.parseInt(attempts, 10) || 1);
  const requestTimeoutMs = Math.max(0, Number(timeoutMs || 0) || 0);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptNo = attempt + 1;
    lastAttempt = attemptNo;
    try {
      const result = await withVeoTabOpLock(tabId, "page_fetch_json", async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab && tab.status !== "complete") await waitTabComplete(tabId, 45000);
        } catch (_) {}
        const frames = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [url, { method, headers, body, timeoutMs: requestTimeoutMs }],
          func: async (u, opts) => {
            const timeoutMs = Math.max(0, Number(opts.timeoutMs || 0) || 0);
            const controller = timeoutMs > 0 && typeof AbortController !== "undefined" ? new AbortController() : null;
            let timer = null;
            const init = {
              method: opts.method || "GET",
              headers: opts.headers || {},
              credentials: "include"
            };
            if (controller) {
              init.signal = controller.signal;
              timer = setTimeout(() => {
                try { controller.abort(); } catch (_) {}
              }, timeoutMs);
            }
            if (opts.body !== null && opts.body !== undefined) {
              init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
            }
            try {
              const resp = await fetch(u, init);
              const text = await resp.text();
              const hdrs = {};
              try {
                for (const [k, v] of resp.headers.entries()) hdrs[k] = v;
              } catch (_) {}
              let json = null;
              try { json = text ? JSON.parse(text) : null; } catch (_) {}
              return { status: resp.status, headers: hdrs, text, json, url: resp.url };
            } catch (e) {
              const name = String((e && e.name) || "");
              const msg = String((e && e.message) || e || "unknown error");
              if (name === "AbortError") throw new Error(`fetch timeout after ${timeoutMs}ms`);
              throw new Error(msg);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
        });
        return Array.isArray(frames) && frames[0] ? frames[0].result : null;
      });
      if (result) return result;
      lastErr = new Error(`pageFetchJson returned empty result; Request Method: ${reqMethod}; url=${url}; attempt=${attemptNo}/${maxAttempts}`);
    } catch (e) {
      const rawMsg = String((e && e.message) || e || "unknown error");
      lastErr = new Error(`pageFetchJson failed; Request Method: ${reqMethod}; url=${url}; attempt=${attemptNo}/${maxAttempts}; error=${rawMsg}`);
      try { lastErr.cause = e; } catch (_) {}
    }
    if (attempt + 1 < maxAttempts) {
      const extra = isTransientPageFetchError(lastErr) ? 500 : 0;
      await sleep(extra + 250 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`pageFetchJson returned empty result; Request Method: ${reqMethod}; url=${url}; attempt=${lastAttempt || 0}/${maxAttempts}`);
}

async function getGeneratedVideoUrl(tabId, projectId, mediaName, attempts = 3) {
  const project = String(projectId || "").trim().replace(/^projects\//, "");
  if (!project) throw new Error("VEO generated video project id is missing");
  const media = String(mediaName || "").trim();
  if (!media) throw new Error("VEO generated video media name is missing");
  const maxAttempts = Math.max(1, Number.parseInt(attempts, 10) || 1);
  let lastErr = null;
  // Give the backend time to expose the signed URL, then retry at a fixed
  // interval when the project query still returns no media URL.
  await sleep(5000);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [project, media],
        func: async (projectId, mediaName) => {
          const params = { fSid: null, atToken: null, bl: null };
          for (const val of (window.WIZ_global_data ? Object.values(window.WIZ_global_data) : [])) {
            if (!params.fSid && typeof val === "string" && /^\d{15,20}$/.test(val)) params.fSid = val;
            if (!params.atToken && typeof val === "string" && /^AIQ-[A-Za-z0-9_-]+:\d+$/.test(val)) params.atToken = val;
            if (!params.bl && typeof val === "string" && /^boq[_-]/.test(val)) params.bl = val;
          }
          if (!params.fSid || !params.bl) {
            try {
              const entries = performance.getEntriesByType("resource").filter(e => String(e.name).includes("batchexecute"));
              if (entries.length) {
                const u = new URL(entries[entries.length - 1].name);
                params.fSid ||= u.searchParams.get("f.sid");
                params.bl ||= u.searchParams.get("bl");
              }
            } catch (_) {}
          }
          if (!params.bl) params.bl = "boq_labs-ai-sandbox-frontend_20260903.13_p1";
          if (!params.fSid || !params.atToken) throw new Error("Flow 请求参数不可用，请刷新页面后重试");
          const rpcids = "as29s";
          const reqid = Math.floor(Math.random() * 9000 + 1000) * 100000 + 22222;
          const hl = document.documentElement.lang || "en";
          const url = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${rpcids}&source-path=${encodeURIComponent(`/project/${projectId}`)}&bl=${encodeURIComponent(params.bl)}&f.sid=${encodeURIComponent(params.fSid)}&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
          const payload = JSON.stringify([mediaName]);
          const requestData = [[[rpcids, payload, null, "generic"]]];
          const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Same-Domain": "1" }, body: `f.req=${encodeURIComponent(JSON.stringify(requestData))}&at=${encodeURIComponent(params.atToken)}&`, credentials: "include" });
          const text = await response.text();
          if (!response.ok) throw new Error(`请求失败: ${response.status} ${response.statusText}`);
          return text;
        }
      });
      let decoded = String(result || "");
      // batchexecute wraps the response payload in one or more JSON strings,
      // so URL escapes may arrive with doubled backslashes. Normalize and
      // decode repeatedly before applying the URL matcher.
      for (let i = 0; i < 3; i++) {
        const next = decoded
          .replace(/\\\\/g, "\\")
          .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\\//g, "/");
        if (next === decoded) break;
        decoded = next;
      }
      const match = decoded.match(/https:\/\/flow-content\.google\/video\/[0-9a-f-]+\?[^\s"'\\\]]+/i);
      if (match) return match[0].replace(/[),]+$/, "");
      throw new Error(`as29s 响应中未找到视频地址: ${decoded.slice(0, 500)}`);
    } catch (e) {
      lastErr = e;
      if (attempt + 1 < maxAttempts) await sleep(5000);
    }
  }
  throw new Error(`VEO generated video URL query failed; project=${project}; error=${String((lastErr && lastErr.message) || lastErr || "unknown error").slice(0, 500)}`);
}

async function getAccessTokenFromPage(tabId) {
  const result = await withVeoTabOpLock(tabId, "get_access_token", async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status !== "complete") await waitTabComplete(tabId, 45000);
    } catch (_) {}
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        const tries = [
          "/api/auth/session",
          "/fx/api/auth/session"
        ];
        for (const u of tries) {
          try {
            const r = await fetch(u, { credentials: "include" });
            if (!r.ok) continue;
            const j = await r.json();
            const tok = j && (j.accessToken || j.access_token || j.token);
            if (tok) return { access_token: tok, expires: j.expires || null, email: (j.user && j.user.email) || null };
          } catch (_) {}
        }
        return {};
      }
    });
    return Array.isArray(frames) && frames[0] ? frames[0].result : null;
  });
  if (!result || !result.access_token) throw new Error(`VEO access token not found: ${JSON.stringify(result || {})}`);
  return result;
}

function cookieExpiresToIso(cookie) {
  const exp = Number(cookie && cookie.expirationDate);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  try {
    return new Date(exp * 1000).toISOString();
  } catch (_) {
    return null;
  }
}

function veoCookieUrl(targetUrl) {
  try {
    const u = new URL(targetUrl || "https://labs.google");
    // Flow pages migrated to flow.google.com, but the NextAuth session cookie
    // is still owned by labs.google and cannot be read through the new origin.
    if (u.hostname === "flow.google.com") return "https://labs.google";
    if (!/(\.|^)labs\.google$/i.test(u.hostname)) return "https://labs.google";
    return `${u.origin}`;
  } catch (_) {
    return "https://labs.google";
  }
}

async function getLongAccessTokenFromCookies(targetUrl) {
  const url = veoCookieUrl(targetUrl);
  const baseName = "__Secure-next-auth.session-token";
  let exact = null;
  try {
    exact = await chrome.cookies.get({ url, name: baseName });
  } catch (_) {
    exact = null;
  }
  if (exact && exact.value) {
    return {
      access_token: exact.value,
      session_token: exact.value,
      expires: cookieExpiresToIso(exact),
      cookie_name: exact.name
    };
  }

  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ url });
  } catch (_) {
    cookies = [];
  }
  const parts = cookies
    .filter(c => c && typeof c.name === "string" && (c.name === baseName || c.name.startsWith(`${baseName}.`)) && c.value)
    .sort((a, b) => {
      const ai = a.name === baseName ? -1 : Number.parseInt(a.name.slice(baseName.length + 1), 10);
      const bi = b.name === baseName ? -1 : Number.parseInt(b.name.slice(baseName.length + 1), 10);
      return (Number.isFinite(ai) ? ai : 9999) - (Number.isFinite(bi) ? bi : 9999);
    });
  if (!parts.length) {
    throw new Error("未找到 __Secure-next-auth.session-token cookie（请确认窗口已登录 Google/VEO）");
  }
  const token = parts.map(c => String(c.value || "")).join("");
  if (!token) throw new Error("VEO long session-token cookie 为空");
  const expCookie = parts.find(c => Number(c.expirationDate) > 0) || parts[0];
  return {
    access_token: token,
    session_token: token,
    expires: cookieExpiresToIso(expCookie),
    cookie_name: parts.length === 1 ? parts[0].name : `${baseName}.*`,
    cookie_parts: parts.length
  };
}

async function fetchShortAccessTokenByExtensionFetch(targetUrl) {
  const cookieUrl = veoCookieUrl(targetUrl);
  const origin = new URL(cookieUrl).origin;
  const tries = [
    `${origin}/fx/api/auth/session`,
    `${origin}/api/auth/session`
  ];
  let last = "";
  for (const u of tries) {
    try {
      const r = await fetch(u, {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      const text = await r.text();
      if (!r.ok) {
        last = `HTTP ${r.status} ${text.slice(0, 200)}`;
        continue;
      }
      const j = text ? JSON.parse(text) : {};
      const tok = j && (j.accessToken || j.access_token || j.token);
      if (tok) {
        return {
          access_token: tok,
          expires: j.expires || null,
          email: (j.user && j.user.email) || null
        };
      }
      last = `auth/session missing token: ${JSON.stringify(j).slice(0, 200)}`;
    } catch (e) {
      last = String((e && e.message) || e || "");
    }
  }
  throw new Error(last || "auth/session 未返回 access_token");
}

function cleanTokenValue(v) {
  return String(v || "").trim();
}

async function fetchVeoLongAccessTokenTask(msg, runtime) {
  const p = msg.payload || {};
  const targetUrl = p.target_url || p.project_page || "https://labs.google/fx";
  await runtime.progress(5, { stage: "long_access_token" });
  const longInfo = await getLongAccessTokenFromCookies(targetUrl);
  await runtime.progress(100, { stage: "done", token_kind: "long" });
  return {
    type: "veo_long_access_token",
    ...longInfo,
    source: "extension.cookies"
  };
}

async function fetchVeoShortAccessTokenTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = normalizeVeoProjectPageUrl(p.project_page || p.target_url || "https://flow.google.com/");
  await runtime.progress(5, { stage: "short_access_token" });
  let shortInfo = null;
  try {
    shortInfo = await fetchShortAccessTokenByExtensionFetch(projectPage);
  } catch (_) {
    const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
    shortInfo = await getAccessTokenFromPage(tabId);
  }
  await runtime.progress(100, { stage: "done", token_kind: "short" });
  return {
    type: "veo_short_access_token",
    access_token: shortInfo.access_token,
    expires: shortInfo.expires || null,
    email: shortInfo.email || null,
    source: "extension.auth_session"
  };
}

async function fetchVeoAccessTokensTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = normalizeVeoProjectPageUrl(p.project_page || p.target_url || "https://flow.google.com/");
  const existingTabId = Number(p.tab_id || p.labs_tab_id || 0) || null;
  await runtime.progress(10, { stage: "read_at_token" });
  const tabId = existingTabId || await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
  if (!tabId) throw new Error("VEO Flow tab unavailable");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      let token = "";
      if (window.WIZ_global_data) {
        for (const value of Object.values(window.WIZ_global_data)) {
          if (typeof value === "string" && /^AIQ-[A-Za-z0-9_-]+:\d+$/.test(value)) {
            token = value;
            break;
          }
        }
      }
      if (!token) return null;
      const timestamp = Number(token.slice(token.lastIndexOf(":") + 1));
      return {
        token,
        expires: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
      };
    }
  });
  if (!result || !result.token) throw new Error("VEO at token not found; refresh the Flow page and retry");
  await runtime.progress(100, { stage: "done", token_kind: "at" });
  return {
    type: "veo_access_tokens",
    access_token: result.token,
    session_token: result.token,
    expires: result.expires,
    short_access_token: result.token,
    short_expires: result.expires,
    source: "extension.wiz_global_data"
  };
}

async function runVeoFlowProjectRpc(tabId, operation, projectId, projectName) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: async (operation, projectId, projectName) => {
      const params = { fSid: null, atToken: null, bl: null };
      for (const val of (window.WIZ_global_data ? Object.values(window.WIZ_global_data) : [])) {
        if (!params.fSid && typeof val === "string" && /^\d{15,20}$/.test(val)) params.fSid = val;
        if (!params.atToken && typeof val === "string" && /^AIQ-[A-Za-z0-9_-]+:\d+$/.test(val)) params.atToken = val;
        if (!params.bl && typeof val === "string" && /^boq[_-]/.test(val)) params.bl = val;
      }
      if (!params.fSid || !params.bl) {
        try {
          const entries = performance.getEntriesByType("resource").filter(e => String(e.name).includes("batchexecute"));
          if (entries.length) {
            const u = new URL(entries[entries.length - 1].name);
            if (!params.fSid) params.fSid = u.searchParams.get("f.sid");
            if (!params.bl) params.bl = u.searchParams.get("bl");
          }
        } catch (_) {}
      }
      if (!params.bl) params.bl = "boq_labs-ai-sandbox-frontend_20260903.13_p1";
      if (!params.fSid) throw new Error("无法获取 f.sid（会话ID），请刷新页面后重试");
      if (!params.atToken) throw new Error("无法获取认证token，请刷新页面后重试");
      const rpcids = operation === "create" ? "jHPbke" : "QI2zvc";
      const reqid = Math.floor(Math.random() * 9000 + 1000) * 100000 + 22222;
      const hl = document.documentElement.lang || "en";
      const url = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${rpcids}&source-path=%2F&bl=${encodeURIComponent(params.bl)}&f.sid=${encodeURIComponent(params.fSid)}&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
      const payload = operation === "create" ? JSON.stringify(["projects/*", [null, [projectName]], [null, 22]]) : JSON.stringify([projectId]);
      const requestData = [[[rpcids, payload, null, "generic"]]];
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Same-Domain": "1" }, body: `f.req=${encodeURIComponent(JSON.stringify(requestData))}&at=${encodeURIComponent(params.atToken)}&`, credentials: "include" });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`请求失败: ${response.status} ${response.statusText}`);
      return { status: response.status, responseText };
    }, args: [operation, projectId, projectName]
  });
  if (!result) throw new Error("Flow 项目请求未返回结果");
  return result;
}

function extractVeoProjectUuid(responseText) {
  const matches = String(responseText || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  return matches && matches.length ? matches[0] : "";
}

async function createVeoFlowProjectTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = normalizeVeoProjectPageUrl(p.project_page || p.target_url || "https://flow.google.com/");
  const title = String(p.title || p.project_title || p.projectTitle || "").trim() || (() => {
    const now = new Date();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[now.getMonth()]} ${String(now.getDate()).padStart(2, "0")} - ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  })();
  if (!title) throw new Error("项目标题不能为空");

  await runtime.progress(2, { stage: "ensure_tab", url: projectPage });
  const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
  await runtime.progress(10, { stage: "create_flow_project", title });
  const tx = await runVeoFlowProjectRpc(tabId, "create", "", title);
  if (tx.status >= 400) throw new Error(`createProject 失败：HTTP ${tx.status} ${String(tx.responseText || "").slice(0, 500)}`);
  const projectId = extractVeoProjectUuid(tx.responseText);
  if (!projectId) throw new Error(`createProject 响应无效：${String(tx.responseText || "").slice(0, 400)}`);
  const projectUrl = `https://flow.google.com/project/${encodeURIComponent(projectId)}`;
  let navigated = false;
  try {
    await chrome.tabs.update(tabId, { url: projectUrl, active: true });
    await waitTabComplete(tabId, 60000);
    await sleep(1200);
    navigated = true;
  } catch (_) {}
  await runtime.progress(100, { stage: "done", project_id: projectId, project_url: projectUrl, navigated });
  return {
    type: "veo_flow_project_create",
    success: true,
    project_id: projectId,
    project_name: title,
    project_url: projectUrl,
    navigated,
    status: tx.status,
    response: tx.responseText
  };
}

async function deleteVeoFlowProjectTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = normalizeVeoProjectPageUrl(p.project_page || p.target_url || "https://flow.google.com/");
  const projectId = String(p.project_id || p.projectId || p.flow_project_id || "").trim();
  if (!projectId) throw new Error("project_id 不能为空");

  await runtime.progress(2, { stage: "ensure_tab", url: projectPage });
  const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
  await runtime.progress(10, { stage: "delete_flow_project", project_id: projectId });
  const normalizedProjectId = projectId.startsWith("projects/") ? projectId : `projects/${projectId}`;
  const tx = await runVeoFlowProjectRpc(tabId, "delete", normalizedProjectId, "");
  if (tx.status >= 400) throw new Error(`deleteProject 失败：HTTP ${tx.status} ${String(tx.responseText || "").slice(0, 500)}`);
  await runtime.progress(100, { stage: "done", project_id: projectId });
  return {
    type: "veo_flow_project_delete",
    success: true,
    project_id: normalizedProjectId,
    status: tx.status,
    response: tx.responseText
  };
}

function normalizeCreditsPayload(data) {
  const credits = Number.parseInt(data && data.credits != null ? data.credits : 0, 10) || 0;
  const tier = data && (data.userPaygateTier || data.user_paygate_tier) || null;
  return { credits, user_paygate_tier: tier ? String(tier) : null, raw: data || null };
}

function localNext0105() {
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 5, 0, 0);
  if (now.getTime() > dt.getTime()) dt.setDate(dt.getDate() + 1);
  return dt;
}

function fmtLocal(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

function parseNextUpdateText(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  if (/Next\s+update\s*:\s*tomorrow\b/i.test(s)) return fmtLocal(localNext0105());
  const m = s.match(/Next\s+update\s*:\s*([A-Za-z]{3,9})\s+(\d{1,2})(?:\s*,\s*(\d{4}))?/i);
  if (!m) return null;
  const monMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mon = monMap[String(m[1] || "").slice(0, 3).toLowerCase()];
  const day = Number.parseInt(m[2], 10);
  if (mon == null || !day || day < 1 || day > 31) return null;
  const now = new Date();
  let year = m[3] ? Number.parseInt(m[3], 10) : now.getFullYear();
  let dt = new Date(year, mon, day, 13, 5, 0, 0);
  if (!m[3] && dt.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) dt = new Date(year + 1, mon, day, 13, 5, 0, 0);
  if (dt.toDateString() === now.toDateString()) dt = localNext0105();
  return fmtLocal(dt);
}

async function fetchNextUpdateCooldown() {
  try {
    const tabId = await ensureGenericTab("https://one.google.com/ai/activity", "https://one.google.com/ai/activity?g1_landing_page=0", { active: false });
    await sleep(4000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => document.body ? document.body.innerText || "" : ""
    });
    return parseNextUpdateText(result || "");
  } catch (_) {
    return null;
  }
}

export async function refreshVeoBalanceTask(msg, runtime) {
  const p = msg.payload || {};
  const projectPage = normalizeVeoProjectPageUrl(p.project_page || p.target_url || "https://flow.google.com/");
  let projectId = String(p.project_id || p.projectId || p.flow_project_id || "").trim().replace(/^projects\//, "");
  if (!projectId) {
    try {
      const match = new URL(projectPage).pathname.match(/^\/project\/([^/?#]+)/i);
      if (match) projectId = decodeURIComponent(match[1]);
    } catch (_) {}
  }
  if (!projectId) {
    try {
      const stored = await chrome.storage.local.get(["veo_pending_project_id"]);
      projectId = String(stored && stored.veo_pending_project_id || "").trim().replace(/^projects\//, "");
    } catch (_) {}
  }
  if (!projectId) throw new Error("缺少 project_id，无法读取 VEO 余额");
  const balancePage = `https://flow.google.com/project/${encodeURIComponent(projectId)}`;
  const otherActiveTasks = countOtherActiveVeoTaskRuns(runtime);
  const avoidPageMutation = otherActiveTasks > 0;
  await runtime.progress(2, { stage: "ensure_tab", url: balancePage });
  const tabId = await ensureVeoProjectTab(balancePage, {
    navigate: !avoidPageMutation,
    active: !avoidPageMutation,
    create: !avoidPageMutation
  });
  if (avoidPageMutation) {
    try {
      await runtime.progress(3, {
        stage: "balance_refresh_non_intrusive",
        reason: "other_tasks_running",
        active_veo_tasks: activeVeoTaskRuns.size,
        other_active_veo_tasks: otherActiveTasks,
        tab_found: !!tabId
      });
    } catch (_) {}
  }
  if (!tabId) throw new Error("VEO balance project tab is unavailable");
  await runtime.progress(20, { stage: "credits" });
  const info = await fetchVeoBalanceByBatchExecute(tabId, projectId);
  if (p.fetch_cooldown) {
    await runtime.progress(60, { stage: "next_update" });
    const cu = await fetchNextUpdateCooldown();
    if (cu) info.cooldown_until = cu;
    try {
      if (avoidPageMutation) {
        await runtime.progress(80, {
          stage: "restore_project_page_skipped",
          reason: "other_tasks_running",
          active_veo_tasks: activeVeoTaskRuns.size,
          other_active_veo_tasks: otherActiveTasks
        });
      } else {
        await ensureVeoProjectTab(balancePage, { navigate: true, active: true });
      }
    } catch (_) {}
  }
  await runtime.progress(100, { stage: "done", credits: info.credits, cooldown_until: info.cooldown_until || null });
  return { type: "veo_balance", ...info };
}

export async function getRecaptchaToken(tabId, action) {
  const recaptchaTimeoutMs = 60000;
  const result = await withVeoTabOpLock(tabId, "get_recaptcha_token", async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status !== "complete") await waitTabComplete(tabId, 45000);
    } catch (_) {}
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [action, recaptchaTimeoutMs],
      func: async (act, timeoutMs) => {
        const siteKey = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
        const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("recaptcha timeout")), Math.max(1000, Number(ms || 0) || 60000));
          Promise.resolve(promise).then(
            (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            }
          );
        });
        try {
          if (!window.grecaptcha || !window.grecaptcha.enterprise) return "";
          await withTimeout(new Promise(resolve => window.grecaptcha.enterprise.ready(resolve)), timeoutMs);
          return await withTimeout(window.grecaptcha.enterprise.execute(siteKey, { action: act || "VIDEO_GENERATION" }), timeoutMs);
        } catch (e) {
          return "";
        }
      }
    });
    return Array.isArray(frames) && frames[0] ? frames[0].result : "";
  });
  return String(result || "");
}

async function downloadImageAsBase64(url, timeoutMs = VEO_UPLOAD_IMAGE_TIMEOUT_MS) {
  const reqMethod = "GET";
  const requestTimeoutMs = Math.max(1000, Number(timeoutMs || 0) || VEO_UPLOAD_IMAGE_TIMEOUT_MS);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  let resp;
  try {
    if (controller) {
      timer = setTimeout(() => {
        try { controller.abort(); } catch (_) {}
      }, requestTimeoutMs);
    }
    resp = await fetch(url, { method: reqMethod, credentials: "omit", signal: controller ? controller.signal : undefined });
    if (!resp.ok) throw new Error(`download image failed; Request Method: ${reqMethod}; url=${url}; Status Code: ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}`);
    const blob = await resp.blob();
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const mime = normalizeDownloadedImageMime(blob.type, url, bytes);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { base64: btoa(bin), mime };
  } catch (e) {
    const name = String((e && e.name) || "");
    if (name === "AbortError") throw new Error(`download image timeout after ${requestTimeoutMs}ms; Request Method: ${reqMethod}; url=${url}`);
    if (/^download image failed;/i.test(String((e && e.message) || ""))) throw e;
    const rawMsg = String((e && e.message) || e || "unknown error");
    throw new Error(`download image failed; Request Method: ${reqMethod}; url=${url}; error=${rawMsg}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function uploadImage(tabId, url, at, projectId, runtime, index, total) {
  const timeoutMs = VEO_UPLOAD_IMAGE_TIMEOUT_MS;
  await runtime.progress(7 + index, { stage: "upload_image", index: index + 1, total, url, timeout_ms: timeoutMs });
  const startedAt = Date.now();
  const img = await downloadImageAsBase64(url, timeoutMs);
  const remainingTimeoutMs = Math.max(1000, timeoutMs - (Date.now() - startedAt));
  const ext = imageExtensionFromMime(img.mime);
  const tx = await pageFetchJson(tabId, URLS.uploadImage, {
    method: "POST",
    headers: authHeaders(at),
    body: {
      clientContext: { tool: "PINHOLE", projectId: String(projectId) },
      fileName: `fpbrowser2api_veo_ext_${Date.now()}_${index}.${ext}`,
      imageBytes: img.base64,
      isHidden: false,
      isUserUploaded: true,
      mimeType: img.mime
    },
    attempts: 1,
    timeoutMs: remainingTimeoutMs
  });
  if (tx.status >= 400) throw new Error(`VEO upload image failed: ${compactErrorResponse(tx)}`);
  const media = tx.json?.media || {};
  const mediaId = media.name || tx.json?.mediaGenerationId?.mediaGenerationId || tx.json?.mediaGenerationId;
  if (!mediaId) throw new Error(`VEO upload missing mediaId: ${JSON.stringify(tx.json).slice(0, 500)}`);
  return {
    mediaId,
    workflowId: media.workflowId || tx.json?.workflow?.name || "",
    projectId: media.projectId || tx.json?.workflow?.projectId || projectId
  };
}

function guessVideoMimeFromUrl(url) {
  const s = String(url || "").split("?", 1)[0].toLowerCase();
  if (s.endsWith(".webm")) return "video/webm";
  if (s.endsWith(".mov")) return "video/quicktime";
  if (s.endsWith(".mkv")) return "video/x-matroska";
  if (s.endsWith(".avi")) return "video/x-msvideo";
  if (s.endsWith(".ogv") || s.endsWith(".ogg")) return "video/ogg";
  return "video/mp4";
}

function guessVideoExtFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime") || m.includes("mov")) return "mov";
  if (m.includes("matroska")) return "mkv";
  if (m.includes("avi")) return "avi";
  if (m.includes("ogg")) return "ogv";
  return "mp4";
}

function extractProjectIdFromUploadSessionUrl(sessionUrl) {
  try {
    const u = new URL(String(sessionUrl || ""));
    const m = u.pathname.match(/\/upload\/video\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : "";
  } catch (_) {
    return "";
  }
}

const VEO_REFERENCE_VIDEO_MAX_SECONDS = 30;

function finitePositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function computeVideoEndFrameIndex(p, meta, durationSeconds) {
  const explicit = Number.parseInt(p.ingredients_video_end_frame_index || p.video_reference_end_frame_index || "", 10);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;

  const frameCount = Number.parseInt(
    p.ingredients_video_frame_count || p.video_reference_frame_count || meta.frameCount || meta.frame_count || "",
    10
  );
  if (Number.isFinite(frameCount) && frameCount > 0) {
    // videoInput frame index 从 0 开始，结束帧应为最后一帧下标。
    return Math.max(0, frameCount - 1);
  }

  const fps = finitePositiveNumber(p.ingredients_video_fps || p.video_reference_fps || meta.fps || meta.frameRate || meta.frame_rate);
  if (fps && durationSeconds > 0) return Math.max(0, Math.round(durationSeconds * fps) - 1);

  // 最后的兼容兜底：旧逻辑固定按 8fps 猜，只有在 Python/显式元数据都缺失时才使用。
  return Math.max(1, Math.round((durationSeconds || 30) * 8));
}

function assertReferenceVideoDuration(durationSeconds, url) {
  if (Number.isFinite(durationSeconds) && durationSeconds > VEO_REFERENCE_VIDEO_MAX_SECONDS + 0.001) {
    throw new Error(`VEO_REFERENCE_VIDEO_DURATION_VIOLATION: 参考视频时长不能超过30秒，当前约 ${durationSeconds.toFixed(3)} 秒，违规：${String(url || "").slice(0, 300)}`);
  }
}

async function getLocalVideoMetadata(tabId, url, runtime) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [url],
      func: async (u) => {
        return await new Promise((resolve) => {
          const v = document.createElement("video");
          let done = false;
          const finish = (result) => {
            if (done) return;
            done = true;
            try { v.removeAttribute("src"); v.load(); } catch (_) {}
            resolve(result || {});
          };
          v.preload = "metadata";
          v.muted = true;
          v.onloadedmetadata = () => finish({
            duration: Number.isFinite(v.duration) ? v.duration : 0,
            width: v.videoWidth || 0,
            height: v.videoHeight || 0
          });
          v.onerror = () => finish({ duration: 0, width: 0, height: 0, error: "loadedmetadata_failed" });
          setTimeout(() => finish({ duration: 0, width: 0, height: 0, error: "metadata_timeout" }), 15000);
          v.src = u;
        });
      }
    });
    const meta = Array.isArray(frames) && frames[0] ? (frames[0].result || {}) : {};
    if (meta && meta.error) {
      try { await runtime.progress(8, { stage: "video_metadata_warning", url, error: meta.error }); } catch (_) {}
    }
    return meta;
  } catch (e) {
    try { await runtime.progress(8, { stage: "video_metadata_warning", url, error: String((e && e.message) || e || "").slice(0, 200) }); } catch (_) {}
    return {};
  }
}

async function uploadVideoInChunks(tabId, url, at, projectId, runtime) {
  const chunkSize = 2 * 1024 * 1024; // labs.google upload-video 单片 Content-Length 最大 2097152
  const mimeFallback = guessVideoMimeFromUrl(url);
  await runtime.progress(8, { stage: "upload_video_start", url, chunk_size: chunkSize });
  const result = await withVeoTabOpLock(tabId, "upload_video_chunks", async () => {
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [url, at, String(projectId || ""), chunkSize, URLS.uploadVideoStart, URLS.uploadVideoChunk, mimeFallback],
      func: async (videoUrl, accessToken, pid, maxChunkSize, startUrl, uploadUrl, defaultMime) => {
        const auth = accessToken ? { "Authorization": `Bearer ${accessToken}` } : {};
        const sourceResp = await fetch(videoUrl, { method: "GET", credentials: "omit", cache: "no-store" });
        if (!sourceResp.ok) {
          throw new Error(`download video failed; Request Method: GET; url=${videoUrl}; Status Code: ${sourceResp.status}${sourceResp.statusText ? ` ${sourceResp.statusText}` : ""}`);
        }
        const blob = await sourceResp.blob();
        const size = blob.size || 0;
        if (!size) throw new Error(`download video failed: empty blob; url=${videoUrl}`);
        const mime = blob.type || defaultMime || "video/mp4";
        const ext = mime.includes("webm") ? "webm" : (mime.includes("quicktime") ? "mov" : "mp4");
        const fileName = `fpbrowser2api_veo_ext_${Date.now()}.${ext}`;

        const startBody = { projectId: pid, fileName, mimeType: mime, sizeBytes: String(size) };
        const startHeaders = {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "x-upload-content-length": String(size),
          "x-upload-content-type": mime,
          "x-upload-file-name": fileName,
          "x-upload-project-id": pid,
          ...auth
        };
        let startResp = await fetch(startUrl, {
          method: "POST",
          credentials: "include",
          headers: startHeaders,
          body: JSON.stringify(startBody)
        });
        let startText = await startResp.text();
        let startJson = null;
        try { startJson = startText ? JSON.parse(startText) : null; } catch (_) {}
        // 兼容服务端只接受空 POST 的实现。
        if (startResp.status >= 400) {
          startResp = await fetch(startUrl, {
            method: "POST",
            credentials: "include",
            headers: startHeaders
          });
          startText = await startResp.text();
          try { startJson = startText ? JSON.parse(startText) : null; } catch (_) { startJson = null; }
        }
        if (startResp.status >= 400) {
          throw new Error(`VEO upload video start failed: status=${startResp.status}; response=${String(startText || "").slice(0, 500)}`);
        }
        const sessionUrl = String((startJson && (startJson.sessionUrl || startJson.session_url)) || "");
        if (!sessionUrl || !/active/i.test(String((startJson && startJson.status) || ""))) {
          throw new Error(`VEO upload video start invalid response: ${JSON.stringify(startJson).slice(0, 500)}`);
        }

        let finalJson = null;
        let uploadedBytes = 0;
        let chunkCount = 0;
        for (let offset = 0; offset < size; offset += maxChunkSize) {
          const endExclusive = Math.min(size, offset + maxChunkSize);
          const chunk = blob.slice(offset, endExclusive, mime);
          const isLast = endExclusive >= size;
          const headers = {
            "Accept": "application/json",
            "Content-Type": mime,
            "Content-Range": `bytes ${offset}-${endExclusive - 1}/${size}`,
            "X-Goog-Upload-URL": sessionUrl,
            "X-Upload-Session-Url": sessionUrl,
            "x-upload-file-name": fileName,
            "x-upload-offset": String(offset),
            "x-upload-project-id": pid,
            "x-upload-command": isLast ? "upload, finalize" : "upload",
            ...auth
          };
          const resp = await fetch(uploadUrl, {
            method: "PUT",
            credentials: "include",
            headers,
            body: chunk
          });
          const text = await resp.text();
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) {}
          if (resp.status >= 400) {
            throw new Error(`VEO upload video chunk failed: status=${resp.status}; range=${headers["Content-Range"]}; response=${String(text || "").slice(0, 500)}`);
          }
          if (!json || !/^(active|final)$/i.test(String(json.status || ""))) {
            throw new Error(`VEO upload video chunk invalid response: range=${headers["Content-Range"]}; response=${JSON.stringify(json).slice(0, 500)}`);
          }
          uploadedBytes = endExclusive;
          chunkCount++;
          if (isLast) finalJson = json;
        }
        if (!finalJson || !/final/i.test(String(finalJson.status || "")) || !finalJson.mediaServerId) {
          throw new Error(`VEO upload video missing final mediaServerId: ${JSON.stringify(finalJson).slice(0, 500)}`);
        }
        return { ...finalJson, sessionUrl, uploadProjectId: "", size, mime, fileName, uploadedBytes, chunkCount };
      }
    });
    return Array.isArray(frames) && frames[0] ? frames[0].result : null;
  });
  if (!result || !result.mediaServerId) throw new Error(`VEO upload video returned empty result: ${JSON.stringify(result || {}).slice(0, 500)}`);
  result.uploadProjectId = result.uploadProjectId || extractProjectIdFromUploadSessionUrl(result.sessionUrl) || projectId;
  await runtime.progress(12, {
    stage: "upload_video_done",
    media_id: result.mediaServerId,
    project_id: result.uploadProjectId,
    size: result.size,
    chunks: result.chunkCount
  });
  return result;
}

async function confirmUploadedVideoOffset(tabId, at, uploadInfo, durationSeconds, runtime) {
  const duration = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0 ? Number(durationSeconds) : 30;
  const endOffset = `${duration.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}s`;
  const body = {
    json: {
      mediaId: uploadInfo.mediaServerId,
      startOffset: "0s",
      endOffset
    }
  };
  await runtime.progress(13, { stage: "update_video_offset", media_id: uploadInfo.mediaServerId, end_offset: endOffset });
  const tx = await pageFetchJson(tabId, URLS.updateVideoOffset, { method: "POST", headers: authHeaders(at), body });
  if (tx.status >= 400) throw new Error(`VEO update video offset failed: ${compactErrorResponse(tx)}`);
  const status = firstStringByKey(tx.json, "mediaGenerationStatus");
  if (!/MEDIA_GENERATION_STATUS_PENDING/i.test(status)) {
    throw new Error(`VEO update video offset unexpected status=${status || "unknown"}; response=${JSON.stringify(tx.json).slice(0, 500)}`);
  }
  return { status, endOffset };
}

async function pollUploadedVideoProcessing(tabId, at, uploadInfo, runtime, p) {
  const maxWait = Math.max(60, Number(p.video_upload_max_wait_seconds || p.max_wait_seconds || p.timeout_seconds || 600));
  const interval = Math.max(0.5, Number(p.video_upload_poll_interval_seconds || p.poll_interval_seconds || 5));
  const deadline = Date.now() + maxWait * 1000;
  const pollMedia = [{ name: uploadInfo.mediaServerId, projectId: uploadInfo.uploadProjectId || uploadInfo.projectId || p.project_id }];
  let last = {};
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    attempt++;
    const tx = await pageFetchJson(tabId, URLS.videoPoll, { method: "POST", headers: authHeaders(at), body: { media: pollMedia } });
    if (tx.status >= 400) throw new Error(`VEO uploaded video poll failed: ${compactErrorResponse(tx)}`);
    last = parseVideoPoll(tx.json);
    const pct = 14 + Math.min(10, Math.floor((Date.now() - (deadline - maxWait * 1000)) / (maxWait * 1000) * 10));
    await runtime.progress(pct, {
      stage: last.failed ? "uploaded_video_failed" : "uploaded_video_processing",
      attempt,
      status: last.status,
      media_id: uploadInfo.mediaServerId,
      error: last.failed ? formatVideoPollFailure(last.failure) : undefined
    });
    if (last.failed) throw new Error(`VEO uploaded video processing failed: ${formatVideoPollFailure(last.failure)}`);
    if (/MEDIA_GENERATION_STATUS_SUCCESSFUL/i.test(String(last.status || ""))) return { ...last, pollMedia };
  }
  throw new Error(`VEO uploaded video processing timeout; last=${JSON.stringify(last).slice(0, 300)}`);
}

function firstStringByKey(obj, key) {
  if (!obj || typeof obj !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === "string" && obj[key]) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const got = firstStringByKey(v, key);
      if (got) return got;
    }
  }
  return "";
}

function parseImageResult(resp) {
  const mediaList = Array.isArray(resp?.media) ? resp.media : (Array.isArray(resp?.responses?.[0]?.media) ? resp.responses[0].media : []);
  const m0 = mediaList.find(x => x && typeof x === "object");
  if (!m0) throw new Error(`VEO image result empty: ${JSON.stringify(resp).slice(0, 500)}`);
  const fifeUrl = m0.image?.generatedImage?.fifeUrl || firstStringByKey(m0, "fifeUrl");
  if (!fifeUrl) throw new Error(`VEO image missing fifeUrl: ${JSON.stringify(resp).slice(0, 500)}`);
  return {
    fifeUrl,
    mediaName: m0.name || "",
    workflowId: m0.workflowId || m0.image?.generatedImage?.workflowId || "",
    projectId: m0.projectId || ""
  };
}

function parseVideoPoll(resp) {
  let workflowId = "", projectId = "", status = "", videoUrl = "", mediaName = "";
  let failure = null;

  const normalizeFailureReasons = (value) => {
    if (Array.isArray(value)) {
      return value
        .map(x => {
          if (typeof x === "string") return x;
          if (x && typeof x === "object") return x.reason || x.message || x.name || JSON.stringify(x);
          return String(x || "");
        })
        .map(x => String(x || "").trim())
        .filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  };

  const pickFailureReasons = (source) => {
    const candidates = [
      source?.mediaMetadata?.mediaStatus?.failureReasons,
      source?.mediaStatus?.failureReasons,
      source?.failureReasons,
      source?.operation?.failureReasons,
      source?.operation?.metadata?.failureReasons
    ];
    for (const candidate of candidates) {
      const reasons = normalizeFailureReasons(candidate);
      if (reasons.length) return reasons;
    }
    return [];
  };

  const rememberFailure = (source, itemStatus, err, failureReasons) => {
    if (failure) return;
    if (itemStatus) status = itemStatus;
    const op = source?.operation || {};
    const e = err || op.error || source?.error || null;
    const reasons = normalizeFailureReasons(failureReasons);
    failure = {
      status: itemStatus || status || source?.status || "",
      code: e && (e.code ?? e.status ?? ""),
      message: e && (e.message || e.statusMessage || e.reason || ""),
      operation: op.name || source?.operationName || "",
      sceneId: source?.sceneId || "",
      mediaGenerationId: source?.mediaGenerationId || source?.name || "",
      failureReasons: reasons.length ? reasons : pickFailureReasons(source)
    };
  };

  const isFailedStatus = (s) => /(^|_)FAILED($|_)/i.test(String(s || ""));
  const media = Array.isArray(resp?.media) ? resp.media : [];
  for (const item of media) {
    mediaName ||= item.name || "";
    workflowId ||= item.workflowId || "";
    projectId ||= item.projectId || "";
    const mediaStatus = item.mediaMetadata?.mediaStatus || {};
    const itemStatus = mediaStatus.mediaGenerationStatus || item.status || "";
    status ||= itemStatus;
    videoUrl ||= item.mediaMetadata?.video?.fifeUrl || firstStringByKey(item, "fifeUrl");
    const err = item.operation?.error || item.error || mediaStatus.error || null;
    const failureReasons = mediaStatus.failureReasons || item.failureReasons || null;
    if (err || isFailedStatus(itemStatus) || normalizeFailureReasons(failureReasons).length) {
      rememberFailure(item, itemStatus, err, failureReasons);
    }
  }
  const operations = Array.isArray(resp?.operations) ? resp.operations : [];
  for (const item of operations) {
    mediaName ||= item.mediaGenerationId || item.operation?.name || "";
    const itemStatus = item.status || item.mediaGenerationStatus || item.operation?.status || "";
    status ||= itemStatus;
    const err = item.operation?.error || item.error || null;
    const failureReasons = item.failureReasons || item.operation?.failureReasons || item.operation?.metadata?.failureReasons || null;
    if (err || isFailedStatus(itemStatus) || normalizeFailureReasons(failureReasons).length) {
      rememberFailure(item, itemStatus, err, failureReasons);
    }
  }
  videoUrl ||= firstStringByKey(resp, "fifeUrl");
  return { workflowId, projectId, status: (failure && failure.status) || status, videoUrl, mediaName, failed: !!failure, failure };
}

function formatVideoPollFailure(failure) {
  const f = failure || {};
  const parts = [];
  if (f.status) parts.push(`status=${f.status}`);
  if (f.code !== undefined && f.code !== null && f.code !== "") parts.push(`code=${f.code}`);
  if (f.message) parts.push(`message=${f.message}`);
  if (Array.isArray(f.failureReasons) && f.failureReasons.length) parts.push(`failureReasons=${f.failureReasons.join(",")}`);
  if (f.operation) parts.push(`operation=${f.operation}`);
  if (f.mediaGenerationId) parts.push(`mediaGenerationId=${String(f.mediaGenerationId).slice(0, 120)}`);
  if (f.sceneId) parts.push(`sceneId=${f.sceneId}`);
  return parts.join("; ") || "unknown failure";
}

function parseVideoSubmitWorkflow(resp) {
  const workflows = Array.isArray(resp?.workflows) ? resp.workflows : [];
  const media = Array.isArray(resp?.media) ? resp.media : [];
  const workflow = workflows.find(x => x && typeof x === "object" && (x.name || x.workflowId || x.id)) || null;
  const videoMedia = media.find(x => x && typeof x === "object" && (x.mediaMetadata?.video || x.workflowId || x.name)) || null;
  const workflowId = (videoMedia && (videoMedia.workflowId || videoMedia.mediaMetadata?.video?.workflowId))
    || (workflow && (workflow.name || workflow.workflowId || workflow.id))
    || firstStringByKey(resp, "workflowId")
    || "";
  const projectId = (videoMedia && videoMedia.projectId)
    || (workflow && (workflow.projectId || workflow.metadata?.projectId))
    || firstStringByKey(resp, "projectId")
    || "";
  const mediaName = (videoMedia && videoMedia.name)
    || (workflow && workflow.metadata?.primaryMediaId)
    || "";
  return { workflowId, projectId, mediaName };
}

function normalizeVideoPollMedia(mediaList, fallbackProjectId = "") {
  const out = [];
  for (const item of Array.isArray(mediaList) ? mediaList : []) {
    if (!item || typeof item !== "object") continue;
    // batchCheckAsyncVideoGenerationStatus 当前需要 media[]:
    // { media: [{ name, projectId }] }，而不是旧的
    // { operations: [{ operation: { name } }] }。必须保留 projectId，否则
    // 服务端可能只返回 operation 级别状态，缺少 mediaStatus.failureReasons。
    const name = String(item.operation?.name || item.operation || item.name || item.mediaGenerationId || "").trim();
    const projectId = String(item.projectId || item.mediaMetadata?.projectId || fallbackProjectId || "").trim();
    if (name) out.push(projectId ? { name, projectId } : { name });
  }
  return out;
}

function normalizeVideoPollOperations(mediaList) {
  const out = [];
  for (const item of Array.isArray(mediaList) ? mediaList : []) {
    if (!item || typeof item !== "object") continue;
    if (item.operation && typeof item.operation === "object") {
      out.push({ operation: item.operation });
      continue;
    }
    if (typeof item.operation === "string" && item.operation) {
      out.push({ operation: { name: item.operation } });
      continue;
    }
    if (typeof item.name === "string" && item.name) {
      out.push({ operation: { name: item.name } });
    }
  }
  return out;
}

function flowWorkflowUrl(workflowName) {
  const name = String(workflowName || "").trim().replace(/^\/+/, "");
  return `${URLS.workflows}/${name}`;
}

async function archiveWorkflow(tabId, at, workflowId, projectId) {
  if (!workflowId) return false;
  try {
    const url = flowWorkflowUrl(workflowId);
    const tx = await pageFetchJson(tabId, url, {
      method: "PATCH",
      headers: authHeaders(at),
      body: {
        workflow: {
          name: workflowId,
          projectId: String(projectId || ""),
          metadata: { archived: true }
        },
        updateMask: "metadata.archived"
      }
    });
    return tx.status < 400;
  } catch (_) {
    return false;
  }
}

function inferImageMimeFromBytes(bytes) {
  const b = bytes || [];
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return "image/png";
  if (
    b.length >= 6 &&
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 &&
    b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
  ) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return "";
}

function guessImageMimeFromUrl(url) {
  try {
    const path = new URL(String(url || ""), location.href).pathname.toLowerCase();
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".bmp")) return "image/bmp";
    if (path.endsWith(".avif")) return "image/avif";
  } catch (_) {}
  return "";
}

function normalizeDownloadedImageMime(declaredMime, url, bytes) {
  const declared = String(declaredMime || "").split(";", 1)[0].trim().toLowerCase();
  const sniffed = inferImageMimeFromBytes(bytes);
  if (sniffed) return sniffed;
  if (declared.startsWith("image/")) return declared;
  return guessImageMimeFromUrl(url) || "image/jpeg";
}

async function cleanupProjectWorkflowsBeforeRun(tabId, _at, projectId, runtime) {
  const pid = String(projectId || "").trim().replace(/^projects\//, "");
  if (!pid) return { skipped: true, reason: "missing_project_id" };
  const report = async (progress, data) => {
    try { await runtime.progress(progress, data); } catch (_) {}
  };
  try {
    await report(6, { stage: "cleanup_project_media", project_id: pid });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [pid, 500],
      func: async (projectId, delayMs) => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const getStableParams = () => {
          const params = { fSid: null, atToken: null, bl: null };
          for (const val of (window.WIZ_global_data ? Object.values(window.WIZ_global_data) : [])) {
            if (!params.fSid && typeof val === "string" && /^-?\d{15,20}$/.test(val)) params.fSid = val;
            if (!params.atToken && typeof val === "string" && /^AIQ-[A-Za-z0-9_-]+:\d+$/.test(val)) params.atToken = val;
            if (!params.bl && typeof val === "string" && /^boq[_-]/.test(val)) params.bl = val;
          }
          if (!params.fSid || !params.bl) {
            try {
              const entries = performance.getEntriesByType("resource").filter(e => String(e.name).includes("batchexecute"));
              if (entries.length) {
                const url = new URL(entries[entries.length - 1].name);
                params.fSid ||= url.searchParams.get("f.sid");
                params.bl ||= url.searchParams.get("bl");
              }
            } catch (_) {}
          }
          if (!params.bl) params.bl = "boq_labs-ai-sandbox-frontend_20260903.13_p1";
          return params;
        };
        const params = getStableParams();
        if (!params.fSid || !params.atToken) throw new Error("Flow media cleanup parameters are unavailable; refresh the page and retry");
        const requestRpc = async (rpcids, payload) => {
          const reqid = Math.floor(Math.random() * 9000 + 1000) * 100000 + Math.floor(Math.random() * 100000);
          const hl = document.documentElement.lang || "en";
          const url = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${rpcids}&source-path=${encodeURIComponent(`/project/${projectId}`)}&bl=${encodeURIComponent(params.bl)}&f.sid=${encodeURIComponent(params.fSid)}&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
          const requestData = [[[rpcids, payload, null, "generic"]]];
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Same-Domain": "1" },
            body: `f.req=${encodeURIComponent(JSON.stringify(requestData))}&at=${encodeURIComponent(params.atToken)}&`,
            credentials: "include"
          });
          const responseText = await response.text();
          if (!response.ok) throw new Error(`${rpcids} request failed: ${response.status} ${response.statusText}`);
          return responseText;
        };
        const listText = await requestRpc("Zzl0ze", JSON.stringify([`projects/${projectId}`, null, null, null, [0]]));
        const mediaItems = [];
        for (const line of listText.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
          if (!line.startsWith("[[")) continue;
          try {
            const chunk = JSON.parse(line);
            const rpc = Array.isArray(chunk) && chunk.find(item => Array.isArray(item) && item[0] === "wrb.fr" && item[1] === "Zzl0ze");
            if (!rpc || typeof rpc[2] !== "string") continue;
            const payload = JSON.parse(rpc[2]);
            const items = Array.isArray(payload && payload[1]) ? payload[1] : [];
            for (const item of items) {
              if (!Array.isArray(item) || !item[0] || !Array.isArray(item[3])) continue;
              mediaItems.push({
                id: String(item[0]),
                filename: String(item[3][0] || "unknown"),
                isArchived: item[3][2] === true,
                projectId: String(item[4] || projectId)
              });
            }
          } catch (_) {}
        }
        const pending = mediaItems.filter(item => !item.isArchived);
        const results = { total: mediaItems.length, to_archive_count: pending.length, archived: 0, errors: [] };
        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          try {
            const archivePayload = JSON.stringify([[[item.id, null, null, [null, null, 1], projectId]], [["metadata.archived"]]]);
            const archiveText = await requestRpc("pGCYOe", archivePayload);
            if (!archiveText.includes('"pGCYOe"') && !archiveText.includes("wrb.fr")) {
              throw new Error("archive response did not contain pGCYOe result");
            }
            results.archived++;
          } catch (e) {
            results.errors.push({ id: item.id, filename: item.filename, error: String((e && e.message) || e || "").slice(0, 300) });
          }
          if (i < pending.length - 1) await sleep(delayMs);
        }
        return results;
      }
    });
    if (!result) throw new Error("VEO cleanup media request returned empty result");
    const results = result;
    await report(7, {
      stage: results.errors.length ? "cleanup_project_media_partial_failed" : "cleanup_project_media_done",
      project_id: pid,
      total: results.total,
      to_archive_count: results.to_archive_count,
      archived: results.archived,
      errors: results.errors.slice(0, 5)
    });
    return results;
  } catch (e) {
    const error = String((e && e.message) || e || "").slice(0, 300);
    await report(7, {
      stage: "cleanup_project_workflows_skipped_after_error",
      project_id: pid,
      error
    });
    return { skipped: true, reason: "cleanup_failed", error };
  }
}

async function archiveUploadedWorkflows(tabId, at, uploaded, runtime, reason = "cleanup_uploaded_workflows") {
  const items = Array.isArray(uploaded) ? uploaded : [];
  let archived = 0;
  let total = 0;
  for (const up of items) {
    if (!up || !up.workflowId) continue;
    total++;
    if (await archiveWorkflow(tabId, at, up.workflowId, up.projectId)) archived++;
  }
  if (total) {
    try {
      await runtime.progress(12, { stage: reason, archived, total });
    } catch (_) {}
  }
  return { archived, total };
}

async function archiveGeneratedWorkflow(tabId, at, workflowId, projectId, runtime, reason = "archive_generated_workflow") {
  const archived = workflowId ? await archiveWorkflow(tabId, at, workflowId, projectId) : false;
  try {
    await runtime.progress(96, {
      stage: reason,
      workflow_id: workflowId || "",
      project_id: projectId || "",
      archived
    });
  } catch (_) {}
  return archived;
}

async function refreshProjectPageAfterArchive(progress, tabId, projectPage, runtime, reason = "refresh_project_page_after_archive") {
  const url = String(projectPage || "").trim();
  if (!url) return false;
  return await withVeoTabOpLock(tabId, reason, async () => {
    if (await shouldSkipProjectPageRefresh(progress, runtime, reason, url)) return false;
    try {
      await runtime.progress(progress, { stage: reason, url });
    } catch (_) {}
    try {
      await chrome.tabs.update(tabId, { url, active: true });
      await waitTabComplete(tabId, 45000);
      await sleep(1200);
      return true;
    } catch (_) {
      try {
        await chrome.tabs.reload(tabId, { bypassCache: false });
        await waitTabComplete(tabId, 45000);
        await sleep(1200);
        return true;
      } catch (_e) {
        return false;
      }
    }
  });
}

async function fetchWorkflowList(tabId, at, projectId) {
  const urls = [
    `${URLS.workflows}?projectId=${encodeURIComponent(projectId)}`,
    `${URLS.workflows}?project_id=${encodeURIComponent(projectId)}`,
    `${URLS.workflows}?parent=${encodeURIComponent(projectId)}`
  ];
  for (const url of urls) {
    try {
      const tx = await pageFetchJson(tabId, url, { method: "GET", headers: authHeaders(at) });
      if (tx.status < 400 && tx.json) return tx.json;
    } catch (_) {}
  }
  return null;
}

function pickLatestWorkflowFromList(resp) {
  const arr = Array.isArray(resp?.workflows) ? resp.workflows
    : Array.isArray(resp?.workflow) ? resp.workflow
    : Array.isArray(resp?.items) ? resp.items
    : [];
  let best = null;
  let bestTs = 0;
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const wid = item.name || item.workflowId || item.id || "";
    if (!wid) continue;
    const ts = Date.parse(item.metadata?.createTime || item.createTime || item.updateTime || 0) || 0;
    if (ts >= bestTs) {
      bestTs = ts;
      best = item;
    }
  }
  if (!best) return null;
  return {
    workflowId: best.name || best.workflowId || best.id || "",
    projectId: best.projectId || best.metadata?.projectId || "",
    archived: !!best.metadata?.archived
  };
}

async function recoverWorkflowAfterEmptySubmit(tabId, at, projectId, runtime, kind) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const resp = await fetchWorkflowList(tabId, at, projectId);
    const picked = pickLatestWorkflowFromList(resp);
    if (picked && picked.workflowId) {
      await runtime.progress(95, { stage: "recovered_workflow", workflow_id: picked.workflowId, workflow_kind: kind });
      return picked;
    }
  }
  return null;
}

async function fetchVeoUserPaygateTier(tabId, at) {
  try {
    const tx = await fetchJson(URLS.credits, { method: "GET", headers: authHeaders(at) });
    if (tx && tx.status < 400) return normalizeCreditsPayload(tx.json).user_paygate_tier || "PAYGATE_TIER_NOT_PAID";
  } catch (_) {}
  return "PAYGATE_TIER_NOT_PAID";
}

function normalizePaygateTier(tier) {
  const s = String(tier || "").trim();
  if (["PAYGATE_TIER_NOT_PAID", "PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO"].includes(s)) return s;
  return "PAYGATE_TIER_NOT_PAID";
}

function normalizeImageUpsampleTarget(p) {
  const rawTarget = String(
    p.extension_image_upsample_target_resolution ||
    p.targetResolution ||
    p.target_resolution ||
    ""
  ).trim().toUpperCase();
  if (rawTarget === "UPSAMPLE_IMAGE_RESOLUTION_4K") {
    return { label: "4K", targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_4K" };
  }
  if (rawTarget === "UPSAMPLE_IMAGE_RESOLUTION_2K") {
    return { label: "2K", targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_2K" };
  }

  const label = String(
    p.extension_image_resolution_label ||
    p.resolution ||
    p.image_resolution ||
    p.veo_image_resolution ||
    ""
  ).trim().toLowerCase().replace(/\s+/g, "");
  if (label === "4k" || label === "4096" || label === "3840" || label === "4k_output" || label === "uhd_4k") {
    return { label: "4K", targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_4K" };
  }
  return { label: "2K", targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_2K" };
}

function normalizeAiStudioImageResolution(p) {
  const rawTarget = String(
    p.extension_image_upsample_target_resolution ||
    p.targetResolution ||
    p.target_resolution ||
    ""
  ).trim().toUpperCase();
  if (rawTarget === "UPSAMPLE_IMAGE_RESOLUTION_4K") return "4K";
  if (rawTarget === "UPSAMPLE_IMAGE_RESOLUTION_2K") return "2K";

  const raw = String(
    p.extension_image_resolution_label ||
    p.resolution ||
    p.image_resolution ||
    p.veo_image_resolution ||
    ""
  ).trim().toLowerCase().replace(/\s+/g, "");
  if (["4k", "4096", "3840", "4k_output", "uhd_4k"].includes(raw)) return "4K";
  if (["2k", "2048", "2k_output", "uhd_2k"].includes(raw)) return "2K";
  return "1K";
}

function parseVeoBalanceBatchResponse(responseText) {
  const lines = String(responseText || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("[[")) continue;
    let chunk = null;
    try { chunk = JSON.parse(line); } catch (_) { continue; }
    if (!Array.isArray(chunk)) continue;
    const rpc = chunk.find(item => Array.isArray(item) && item[0] === "wrb.fr" && item[1] === "nzlxg");
    if (!rpc || typeof rpc[2] !== "string") continue;
    let payload = null;
    try { payload = JSON.parse(rpc[2]); } catch (_) { continue; }
    const credits = Number.parseInt(Array.isArray(payload) ? payload[0] : NaN, 10);
    const membershipLevel = Number.parseInt(Array.isArray(payload) ? payload[1] : NaN, 10);
    if (Number.isFinite(credits)) {
      return {
        credits,
        user_paygate_tier: Number.isFinite(membershipLevel) ? String(membershipLevel) : null,
        membership_level: Number.isFinite(membershipLevel) ? membershipLevel : null,
        raw: payload
      };
    }
  }
  throw new Error(`VEO balance response is invalid: ${String(responseText || "").slice(0, 500)}`);
}

async function fetchVeoBalanceByBatchExecute(tabId, projectId) {
  const project = String(projectId || "").trim().replace(/^projects\//, "");
  if (!project) throw new Error("VEO balance project id is missing");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [project],
    func: async (projectId) => {
      const params = { fSid: null, atToken: null, bl: null };
      for (const val of (window.WIZ_global_data ? Object.values(window.WIZ_global_data) : [])) {
        if (!params.fSid && typeof val === "string" && /^-?\d{15,20}$/.test(val)) params.fSid = val;
        if (!params.atToken && typeof val === "string" && /^AIQ-[A-Za-z0-9_-]+:\d+$/.test(val)) params.atToken = val;
        if (!params.bl && typeof val === "string" && /^boq[_-]/.test(val)) params.bl = val;
      }
      if (!params.fSid || !params.bl) {
        try {
          const entries = performance.getEntriesByType("resource").filter(e => String(e.name).includes("batchexecute"));
          if (entries.length) {
            const u = new URL(entries[entries.length - 1].name);
            params.fSid ||= u.searchParams.get("f.sid");
            params.bl ||= u.searchParams.get("bl");
          }
        } catch (_) {}
      }
      if (!params.bl) params.bl = "boq_labs-ai-sandbox-frontend_20260903.13_p1";
      if (!params.fSid || !params.atToken) throw new Error("Flow balance request parameters are unavailable; refresh the page and retry");
      const rpcids = "nzlxg";
      const reqid = Math.floor(Math.random() * 9000 + 1000) * 100000 + 22222;
      const hl = document.documentElement.lang || "en";
      const url = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${rpcids}&source-path=${encodeURIComponent(`/project/${projectId}`)}&bl=${encodeURIComponent(params.bl)}&f.sid=${encodeURIComponent(params.fSid)}&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
      const requestData = [[[rpcids, "[]", null, "generic"]]];
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Same-Domain": "1" },
        body: `f.req=${encodeURIComponent(JSON.stringify(requestData))}&at=${encodeURIComponent(params.atToken)}&`,
        credentials: "include"
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`VEO balance request failed: ${response.status} ${response.statusText}`);
      return responseText;
    }
  });
  if (!result) throw new Error("VEO balance request returned empty result");
  return parseVeoBalanceBatchResponse(result);
}

function mapAiStudioImageAspectRatio(p) {
  const raw = String(p.extension_image_aspect_ratio || p.image_aspect_ratio || p.aspect_ratio || "").trim();
  const upper = raw.toUpperCase();
  if (raw.includes(":")) return raw;
  if (upper.includes("LANDSCAPE_FOUR_THREE")) return "4:3";
  if (upper.includes("PORTRAIT_THREE_FOUR")) return "3:4";
  if (upper.includes("PORTRAIT")) return "9:16";
  if (upper.includes("SQUARE")) return "1:1";
  if (upper.includes("LANDSCAPE")) return "16:9";
  return "1:1";
}

function mapAiStudioImageModelName(p) {
  return String(p.extension_image_model_name || "NARWHAL").trim().toUpperCase() === "NARWHAL"
    ? "models/gemini-3.1-flash-image"
    : "models/gemini-3-pro-image";
}

function cleanBase64ForAiStudio(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, "");
}

function inferImageMimeFromBase64(base64) {
  const s = cleanBase64ForAiStudio(base64);
  if (s.startsWith("/9j/")) return "image/jpeg";
  if (s.startsWith("iVBORw0KGgo")) return "image/png";
  if (s.startsWith("R0lGOD")) return "image/gif";
  if (s.startsWith("UklGR")) return "image/webp";
  return "";
}

function imageExtensionFromMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

function parseImageDataUrlForAiStudio(value) {
  const s = String(value || "").trim().replace(/^["']|["']$/g, "");
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(s);
  if (!m) return null;
  const base64Data = cleanBase64ForAiStudio(m[2]);
  return { mimeType: m[1] || inferImageMimeFromBase64(base64Data) || "image/jpeg", base64Data };
}

function parseBareBase64ImageForAiStudio(value) {
  const base64Data = cleanBase64ForAiStudio(value);
  if (!base64Data || /^https?:\/\//i.test(base64Data) || /^blob:/i.test(base64Data)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) return null;
  const mimeType = inferImageMimeFromBase64(base64Data);
  if (!mimeType) return null;
  return { mimeType, base64Data };
}

function parseAiStudioReferenceImageObject(value) {
  if (!value || typeof value !== "object") return null;
  const dataUrl = value.dataUrl || value.data_url || "";
  const fromDataUrl = parseImageDataUrlForAiStudio(dataUrl);
  if (fromDataUrl) return { ...fromDataUrl, filename: value.filename || value.name || "" };
  const base64Data = cleanBase64ForAiStudio(value.base64Data || value.base64 || value.imageBytes || value.data || "");
  if (!base64Data) return null;
  const mimeType = value.mimeType || value.mime_type || value.mime || inferImageMimeFromBase64(base64Data) || "image/jpeg";
  return { mimeType, base64Data, filename: value.filename || value.name || "" };
}

function getAiStudioReferenceImageSources(p) {
  const raw = p.extension_image_reference_urls ||
    p.image_reference_urls ||
    p.reference_image_urls ||
    p.i2i_urls ||
    p.image_urls ||
    [];
  return Array.isArray(raw) ? raw.filter(Boolean) : (raw ? [raw] : []);
}

async function collectAiStudioReferenceImages(p, runtime) {
  const sources = getAiStudioReferenceImageSources(p);
  const images = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const data = parseAiStudioReferenceImageObject(source) ||
      parseImageDataUrlForAiStudio(source) ||
      parseBareBase64ImageForAiStudio(source);
    if (data && data.base64Data) {
      const filename = data.filename || `reference_${i + 1}.${imageExtensionFromMime(data.mimeType)}`;
      images.push({ ...data, filename });
      await runtime.progress(7 + i, {
        stage: "prepare_aistudio_reference_image",
        index: i + 1,
        total: sources.length,
        source_kind: "base64",
        filename,
        mime_type: data.mimeType,
        base64_prefix: data.base64Data.slice(0, 12),
        base64_length: data.base64Data.length
      });
      continue;
    }
    await runtime.progress(7 + i, {
      stage: "prepare_aistudio_reference_image",
      index: i + 1,
      total: sources.length,
      url: String(source || ""),
      timeout_ms: VEO_UPLOAD_IMAGE_TIMEOUT_MS
    });
    const img = await downloadImageAsBase64(source, VEO_UPLOAD_IMAGE_TIMEOUT_MS);
    const base64Data = cleanBase64ForAiStudio(img.base64);
    const mimeType = img.mime || inferImageMimeFromBase64(base64Data) || "image/jpeg";
    let filename = "";
    try {
      const u = new URL(String(source || ""));
      filename = decodeURIComponent((u.pathname.split("/").pop() || "").split("?")[0] || "");
    } catch (_) {}
    if (!filename) filename = `reference_${i + 1}.${imageExtensionFromMime(mimeType)}`;
    images.push({ mimeType, base64Data, filename });
    await runtime.progress(7 + i, {
      stage: "prepare_aistudio_reference_image_done",
      index: i + 1,
      total: sources.length,
      source_kind: "url",
      filename,
      mime_type: mimeType,
      base64_prefix: base64Data.slice(0, 12),
      base64_length: base64Data.length
    });
  }
  return images;
}

async function runAiStudio4kImageWorkflow(aiStudioTabId, p, runtime) {
  const prompt = String(p.prompt || "");
  const modelName = mapAiStudioImageModelName(p);
  const aspectRatio = mapAiStudioImageAspectRatio(p);
  const resolution = normalizeAiStudioImageResolution(p);
  const referenceImages = await collectAiStudioReferenceImages(p, runtime);
  const tabId = aiStudioTabId || await ensureAiStudioNewChatTab({ active: true });
  if (!tabId) throw new Error("AI Studio new_chat tab not found");
  await chrome.tabs.update(tabId, { active: true });
  await waitTabComplete(tabId, 45000);
  await chrome.tabs.reload(tabId, { bypassCache: false });
  await waitTabComplete(tabId, 45000);
  const googleLoginWait = await waitGoogleAutoLoginIfNeeded(tabId, runtime, 40000);
  if (googleLoginWait && googleLoginWait.waited) {
    await waitTabComplete(tabId, 10000);
    await sleep(800);
  }
  await sleep(1200);
  await runtime.progress(10, {
    stage: "submit_image_task_aistudio",
    workflow_kind: "image",
    model_name: modelName,
    aspect_ratio: aspectRatio,
    resolution,
    i2i_image_count: referenceImages.length,
    google_login_wait: googleLoginWait
  });
  try {
    const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [modelName, prompt, aspectRatio, resolution, referenceImages],
    func: async (model_name, prompt, aspectRatio, resolution, referenceImages) => {
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      let originalOpen = null;
      let originalSend = null;
      let originalSetRequestHeader = null;
      try {
        if (location.hostname !== "aistudio.google.com" || !location.pathname.startsWith("/prompts/new_chat")) {
          return { ok: false, error: "Expected AI Studio new_chat page", url: String(location.href || "") };
        }
        let capturedPayload = null;
        let capturedHeaders = null;
        let capturedUrl = null;
        const base64ToBlob = (base64, mimeType) => {
          const bin = atob(String(base64 || ""));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new Blob([bytes], { type: mimeType || "image/jpeg" });
        };
        const acknowledgeImageRightsIfPresent = async () => {
          const bodyText = document.body ? (document.body.innerText || document.body.textContent || "") : "";
          if (!bodyText.includes("necessary rights to any images you upload")) {
            return { success: true, dismissed: false, message: "image rights dialog not present" };
          }

          const buttons = Array.from(document.querySelectorAll("button"));
          let acknowledgeButton = buttons.find(btn =>
            String(btn.textContent || "").trim() === "Acknowledge" ||
            String(btn.innerText || "").trim() === "Acknowledge"
          );

          if (!acknowledgeButton) {
            acknowledgeButton = buttons.find(btn =>
              String(btn.textContent || "").includes("Acknowledge") ||
              String(btn.innerText || "").includes("Acknowledge")
            );
          }

          if (!acknowledgeButton) {
            const clickables = Array.from(document.querySelectorAll('[role="button"], a, div[onclick]'));
            acknowledgeButton = clickables.find(el =>
              String(el.textContent || el.innerText || "").includes("Acknowledge")
            );
          }

          if (!acknowledgeButton) {
            return { success: false, dismissed: false, message: "image rights dialog found but Acknowledge button not found" };
          }

          acknowledgeButton.click();
          await sleep(1000);
          const afterText = document.body ? (document.body.innerText || document.body.textContent || "") : "";
          const dismissed = !afterText.includes("necessary rights to any images you upload");
          return {
            success: true,
            dismissed,
            message: dismissed
              ? "image rights dialog acknowledged"
              : "Acknowledge clicked but image rights dialog may still be present"
          };
        };
        const uploadReferenceImageByDrop = async (image, index) => {
          const promptBox = document.querySelector("ms-prompt-box");
          if (!promptBox) return { success: false, error: "ms-prompt-box not found" };
          const filename = image.filename || `reference_${index + 1}.jpg`;
          const mimeType = image.mimeType || "image/jpeg";
          const blob = base64ToBlob(image.base64Data, mimeType);
          const file = new File([blob], filename, { type: blob.type || mimeType });
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          for (const type of ["dragenter", "dragover", "drop"]) {
            promptBox.dispatchEvent(new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer
            }));
            await sleep(120);
          }
          const acknowledge = await acknowledgeImageRightsIfPresent();
          if (!acknowledge.success) return { success: false, error: acknowledge.message, acknowledge, filename, size: file.size, type: file.type };
          const startedAt = Date.now();
          let uploaded = false;
          while (Date.now() - startedAt < 12000) {
            uploaded = !!(
              promptBox.querySelector(`img[alt="${CSS.escape(filename)}"]`) ||
              promptBox.querySelector("img") ||
              promptBox.querySelector('[data-test-file-preview]') ||
              promptBox.querySelector('[data-test-media-preview]')
            );
            if (uploaded) break;
            await sleep(300);
          }
          return { success: uploaded, filename, size: file.size, type: file.type, uploaded, acknowledge };
        };
        const uploadedReferences = [];
        for (let i = 0; i < (Array.isArray(referenceImages) ? referenceImages.length : 0); i++) {
          const ref = referenceImages[i];
          if (!ref || !ref.base64Data) continue;
          const uploaded = await uploadReferenceImageByDrop(ref, i);
          uploadedReferences.push(uploaded);
          if (!uploaded.success) {
            return { ok: false, error: `Reference image drop upload failed: ${uploaded.error || "unknown error"}`, upload: uploaded, uploadedReferences };
          }
          await sleep(300);
        }
        const OriginalXHR = XMLHttpRequest;
        originalOpen = OriginalXHR.prototype.open;
        originalSend = OriginalXHR.prototype.send;
        originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
        OriginalXHR.prototype.open = function(method, url) {
          this._veoAiStudioUrl = url;
          this._veoAiStudioMethod = method;
          return originalOpen.apply(this, arguments);
        };
        OriginalXHR.prototype.setRequestHeader = function(name, value) {
          if (!this._veoAiStudioHeaders) this._veoAiStudioHeaders = {};
          this._veoAiStudioHeaders[name] = value;
          return originalSetRequestHeader.apply(this, arguments);
        };
        OriginalXHR.prototype.send = function(body) {
          if (this._veoAiStudioUrl && String(this._veoAiStudioUrl).includes("/GenerateContent")) {
            try {
              capturedPayload = JSON.parse(body);
              capturedHeaders = this._veoAiStudioHeaders || {};
              capturedUrl = this._veoAiStudioUrl;
              setTimeout(() => {
                try { this.abort(); } catch (_) {}
              }, 0);
              return;
            } catch (_) {
              return originalSend.call(this, body);
            }
          }
          return originalSend.call(this, body);
        };
        const restoreXhr = () => {
          XMLHttpRequest.prototype.open = originalOpen;
          XMLHttpRequest.prototype.send = originalSend;
          XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
        };
        // 点击 Stop 按钮，清掉应用卡住的 "Thinking" 状态。
        // 优先按文本/aria-label 匹配，其次 ms-run-button，最后回退到发送按钮。
        const clickStop = () => {
          const stopEl = document.querySelector("ms-run-button button") ||
            document.querySelector('button[aria-label*="stop" i]');
          const all = Array.from(document.querySelectorAll("button"));
          const byText = all.filter(b => /stop/i.test((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")));
          const target = byText[0] || stopEl || sendBtn;
          if (target) target.click();
        };

        let textarea = document.querySelector("ms-prompt-box textarea") ||
          document.querySelector('textarea[placeholder*="prompt" i]') ||
          document.querySelector('textarea[aria-label*="prompt" i]') ||
          document.querySelector("textarea");
        if (!textarea) {
          restoreXhr();
          return { ok: false, error: "Textarea not found", url: String(location.href || "") };
        }
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(textarea, prompt);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(200);

        let sendBtn = document.querySelector("ms-run-button button") ||
          document.querySelector('button[aria-label*="run" i]') ||
          document.querySelector('button[aria-label*="send" i]') ||
          document.querySelector('button[type="submit"]');
        if (!sendBtn) {
          restoreXhr();
          return { ok: false, error: "Send button not found", url: String(location.href || "") };
        }
        if (sendBtn.disabled) sendBtn.disabled = false;
        sendBtn.click();

        const start = Date.now();
        while (!capturedPayload && Date.now() - start < 5000) await sleep(100);
        restoreXhr();
        if (!capturedPayload) {
          return { ok: false, error: "Failed to capture GenerateContent request", url: String(location.href || "") };
        }

        capturedPayload[0] = model_name;
        if (capturedPayload[3]) {
          let imageParamsIndex = -1;
          for (let i = 0; i < capturedPayload[3].length; i++) {
            const item = capturedPayload[3][i];
            if (!Array.isArray(item) || item.length < 2) continue;
            const hasRatio = item[0] && typeof item[0] === "string" && item[0].includes(":");
            const hasResolution = item[1] && typeof item[1] === "string" && item[1].includes("K");
            const hasNullAndResolution = item[0] === null && typeof item[1] === "string" && item[1].includes("K");
            if (hasRatio || hasResolution || hasNullAndResolution) {
              imageParamsIndex = i;
              break;
            }
          }
          if (imageParamsIndex !== -1) capturedPayload[3][imageParamsIndex] = [aspectRatio, resolution];
        }

        const responseStartedAt = Date.now();
        const response = await fetch(capturedUrl, {
          method: "POST",
          headers: capturedHeaders,
          body: JSON.stringify(capturedPayload),
          credentials: "include"
        });
        if (!response.ok) {
          const errorText = await response.text();
          try { clickStop(); } catch (_) {}
          return {
            ok: false,
            error: `API returned status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
            status: response.status,
            statusText: response.statusText || "",
            responseText: errorText,
            details: errorText.slice(0, 4000)
          };
        }
        const responseText = await response.text();
        try { clickStop(); } catch (_) {}
        const images = [];
        const generationErrors = [];
        const findImages = (node, depth) => {
          if (depth > 40 || !node) return;
          if (Array.isArray(node) && node.length >= 2 && typeof node[0] === "string" && typeof node[1] === "string" && node[0].startsWith("image/")) {
            images.push({
              mimeType: node[0],
              base64Data: node[1],
              dataUrl: `data:${node[0]};base64,${node[1]}`
            });
            return;
          }
          if (Array.isArray(node)) {
            for (const item of node) findImages(item, depth + 1);
          } else if (typeof node === "object") {
            for (const item of Object.values(node)) findImages(item, depth + 1);
          }
        };
        const rememberGenerationError = (message) => {
          const s = String(message || "").trim();
          if (!s || s.length < 8 || s.length > 2000) return;
          if (/^[A-Za-z0-9+/=_-]{120,}$/.test(s)) return;
          if (!/(error|failed|failure|permission|policy|prohibited|sensitive|violate|could not|try rephrasing|not allowed|blocked)/i.test(s)) return;
          if (!generationErrors.includes(s)) generationErrors.push(s);
        };
        const findGenerationErrors = (node, depth) => {
          if (depth > 40 || !node) return;
          if (Array.isArray(node)) {
            if (typeof node[0] === "number" && typeof node[2] === "string") rememberGenerationError(node[2]);
            for (const item of node) findGenerationErrors(item, depth + 1);
          } else if (typeof node === "object") {
            for (const item of Object.values(node)) findGenerationErrors(item, depth + 1);
          } else if (typeof node === "string") {
            rememberGenerationError(node);
          }
        };
        const parseGenerateContentStream = (text) => {
          const clean = String(text || "").replace(/^\)\]\}'\s*/, "").trim();
          const parsed = [];
          const tryPush = (s) => {
            const t = String(s || "").trim();
            if (!t || t === "[DONE]") return false;
            try {
              parsed.push(JSON.parse(t));
              return true;
            } catch (_) {
              return false;
            }
          };
          if (tryPush(clean)) return parsed;
          for (const rawLine of clean.split(/\r?\n/)) {
            let line = rawLine.trim();
            if (!line || /^\d+$/.test(line)) continue;
            if (line.startsWith("data:")) line = line.slice(5).trim();
            if (tryPush(line)) continue;
            const firstJson = line.search(/[\[{]/);
            if (firstJson > 0) tryPush(line.slice(firstJson));
          }
          if (parsed.length) return parsed;

          let start = -1;
          let depth = 0;
          let inString = false;
          let escape = false;
          for (let i = 0; i < clean.length; i++) {
            const ch = clean[i];
            if (inString) {
              if (escape) {
                escape = false;
              } else if (ch === "\\") {
                escape = true;
              } else if (ch === "\"") {
                inString = false;
              }
              continue;
            }
            if (ch === "\"") {
              inString = true;
              continue;
            }
            if (ch === "[" || ch === "{") {
              if (depth === 0) start = i;
              depth++;
            } else if ((ch === "]" || ch === "}") && depth > 0) {
              depth--;
              if (depth === 0 && start >= 0) {
                tryPush(clean.slice(start, i + 1));
                start = -1;
              }
            }
          }
          return parsed;
        };
        const apiResponses = parseGenerateContentStream(responseText);
        for (const item of apiResponses) {
          findImages(item, 0);
          findGenerationErrors(item, 0);
        }
        return {
          ok: true,
          result: {
            prompt,
            config: { model_name, aspectRatio, resolution, referenceImageCount: Array.isArray(referenceImages) ? referenceImages.length : 0 },
            imageCount: images.length,
            images,
            generationErrors,
            responsePreview: images.length ? "" : responseText.slice(0, 4000),
            parsedResponseCount: apiResponses.length,
            responseTimeMs: Date.now() - responseStartedAt
          }
        };
      } catch (error) {
        try {
          if (originalOpen) XMLHttpRequest.prototype.open = originalOpen;
          if (originalSend) XMLHttpRequest.prototype.send = originalSend;
          if (originalSetRequestHeader) XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
        } catch (_) {}
        // 异常路径：内联兜底点击 Stop，避免 UI 持续卡在 Thinking 状态
        try {
          const all = Array.from(document.querySelectorAll("button"));
          const byText = all.find(b => /stop/i.test((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")));
          const stopEl = byText ||
            document.querySelector("ms-run-button button") ||
            document.querySelector('button[aria-label*="stop" i]');
          if (stopEl) stopEl.click();
        } catch (_) {}
        return { ok: false, error: error && error.message ? error.message : String(error || ""), stack: error && error.stack ? error.stack : "" };
      }
    }
  });
  const injected = Array.isArray(frames) && frames[0] ? frames[0].result : null;
  if (!injected || !injected.ok) {
    const parts = [];
    if (injected && injected.error) parts.push(String(injected.error));
    if (injected && injected.details) parts.push(`response=${String(injected.details)}`);
    if (injected && injected.responseText && injected.responseText !== injected.details) {
      parts.push(`full_response=${String(injected.responseText).slice(0, 4000)}`);
    }
    throw new Error(`AI Studio ${resolution} image generation failed: ${(parts.join("; ") || "empty executeScript result").slice(0, 4500)}`);
  }
  const images = injected.result && Array.isArray(injected.result.images) ? injected.result.images : [];
  const selectedImageIndex = images.length > 0 ? images.length - 1 : -1;
  const selectedImage = selectedImageIndex >= 0 ? (images[selectedImageIndex] || {}) : {};
  if (!selectedImage.dataUrl) {
    const generationErrors = injected.result && Array.isArray(injected.result.generationErrors) ? injected.result.generationErrors : [];
    const responsePreview = injected.result && injected.result.responsePreview ? String(injected.result.responsePreview) : "";
    const details = [];
    if (generationErrors.length) details.push(`generation_error=${generationErrors.join(" | ")}`);
    if (responsePreview) details.push(`response=${responsePreview}`);
    throw new Error(`AI Studio ${resolution} image generation returned no image${details.length ? `; ${details.join("; ")}` : ""}`);
  }
  let shareUrl = selectedImage.dataUrl;
  let r2Uploads = [];
  const r2Cfg = p.r2_upload || p.extension_r2_upload || null;
  if (r2Cfg) {
    const r2StartedAt = Date.now();
    await runtime.progress(92, {
      stage: "r2_upload",
      target_resolution: resolution,
      timeout_ms: Number((r2Cfg && (r2Cfg.timeout_ms || r2Cfg.timeoutMs || r2Cfg.upload_timeout_ms || r2Cfg.uploadTimeoutMs)) || 60000) || 60000,
      attempts: Number((r2Cfg && (r2Cfg.attempts || r2Cfg.upload_attempts || r2Cfg.uploadAttempts)) || 3) || 3
    });
    const uploaded = await uploadDataUrlToR2(r2Cfg, shareUrl, {
      objectKeyPrefix: (r2Cfg && (r2Cfg.object_key_prefix || r2Cfg.objectKeyPrefix)) || `veo_workflow/image/aistudio/${resolution.toLowerCase()}`,
      taskId: p._bridge_task_id || p.task_id || "",
      resolution,
      contentType: selectedImage.mimeType || "image/png"
    });
    r2Uploads = [uploaded];
    shareUrl = uploaded.url;
    await runtime.progress(93, {
      stage: "r2_upload_done",
      target_resolution: resolution,
      size: uploaded.size || 0,
      duration_ms: uploaded.duration_ms || (Date.now() - r2StartedAt),
      object_key: uploaded.object_key
    });
  }
  await runtime.progress(100, {
    stage: "done",
    image_url: shareUrl,
    image_count: images.length,
    selected_image_index: selectedImageIndex + 1
  });
  return {
    type: "veo_workflow_image",
    message: `AI Studio ${resolution} image generation completed`,
    workflow_kind: "image",
    share_url: shareUrl,
    image_url: shareUrl,
    model_name: p.extension_image_model_name || "NARWHAL",
    ai_studio_model_name: modelName,
    aspect_ratio: p.extension_image_aspect_ratio || aspectRatio,
    resolution,
    upsample_ok: false,
    upsample_error: undefined,
    r2_uploads: r2Uploads,
    upsample_url: (r2Uploads[0] && r2Uploads[0].url) || undefined,
    upsample_r2_object_key: (r2Uploads[0] && r2Uploads[0].object_key) || undefined,
    project_id: p.project_id,
    generated_media_id: "",
    generated_workflow_id: "",
    workflow_archived: false,
    i2i_image_count: referenceImages.length,
    ai_studio_reference_image_count: referenceImages.length,
    ai_studio_image_count: images.length,
    ai_studio_selected_image_index: selectedImageIndex + 1
  };
  } finally {
    try {
      await runtime.progress(99, { stage: "refresh_aistudio_page_after_image_generation" });
    } catch (_) {}
    // TODO: stop 按钮已在注入脚本内处理 UI 状态，暂时不需要在 finally 里刷新页面
    // try {
    //   await chrome.tabs.reload(tabId, { bypassCache: false });
    //   await waitTabComplete(tabId, 45000);
    //   await sleep(1200);
    // } catch (_) {}
  }
}

async function upsampleImage(tabId, at, p, parsed, runtime) {
  const target = normalizeImageUpsampleTarget(p);
  const maxRetries = 3;
  let lastErr = "";
  for (let i = 0; i < maxRetries; i++) {
    const recaptcha = p.recaptcha_token || p.veo_recaptcha_token || p.recaptchaContextToken || await getRecaptchaToken(tabId, "IMAGE_GENERATION");
    if (!recaptcha) {
      lastErr = "no recaptcha token";
      if (i + 1 < maxRetries) {
        await resetLabsGoogleLocalStorageAndReloadForRetry(72, tabId, p.project_page, runtime, lastErr);
      }
      await sleep(1500);
      continue;
    }
    const tier = normalizePaygateTier(p.user_paygate_tier || p.userPaygateTier || await fetchVeoUserPaygateTier(tabId, at));
    const body = {
      mediaId: String(parsed.mediaName || "").trim(),
      targetResolution: target.targetResolution,
      clientContext: {
        recaptchaContext: { token: recaptcha, applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB" },
        sessionId: sessionId(),
        projectId: String(p.project_id || parsed.projectId || ""),
        tool: "PINHOLE",
        userPaygateTier: tier
      }
    };
    await runtime.progress(72, { stage: "upsample_image", target_resolution: target.label, target_resolution_key: target.targetResolution, attempt: i + 1, user_paygate_tier: tier });
    let ux = null;
    try {
      // upsample 不创建新工作流，遇到并发刷新导致的 transient 空 result 可以安全重试。
      ux = await pageFetchJson(tabId, URLS.upsampleImage, { method: "POST", headers: authHeaders(at), body, attempts: 3 });
    } catch (e) {
      lastErr = String((e && e.message) || e || "");
      // 如果仍然被外部/手动刷新打断，最后再走一次扩展 Service Worker fetch，
      // 它不依赖页面 frame，能避开 MAIN world 被销毁的问题。
      try {
        const fx = await fetchJson(URLS.upsampleImage, { method: "POST", headers: authHeaders(at), body });
        if (fx) ux = fx;
      } catch (e2) {
        lastErr = `${lastErr || "page fetch failed"}; extension fetch: ${String((e2 && e2.message) || e2 || "")}`;
      }
    }
    if (!ux) {
      if (i + 1 < maxRetries) {
        await resetLabsGoogleLocalStorageAndReloadForRetry(72, tabId, p.project_page, runtime, lastErr || "upsample returned empty result");
      }
      await sleep(1500);
      continue;
    }
    const enc = ux.json?.encodedImage || "";
    if (ux.status < 400 && enc) return { encodedImage: enc, userPaygateTier: tier, resolutionLabel: target.label, targetResolution: target.targetResolution };
    lastErr = compactErrorResponse(ux) || `status=${ux && ux.status}`;
    if (i + 1 < maxRetries) {
      await resetLabsGoogleLocalStorageAndReloadForRetry(72, tabId, p.project_page, runtime, lastErr);
    }
    await sleep(1500);
  }
  return { encodedImage: "", error: lastErr, resolutionLabel: target.label, targetResolution: target.targetResolution };
}

async function runImageWorkflow(tabId, p, at, runtime) {
  return await runAiStudio4kImageWorkflow(p._ai_studio_tab_id, p, runtime);
  /* Legacy Flow image generation is intentionally kept below for rollback,
     but all current 1K/2K/4K image requests use AI Studio. */
  const projectId = p.project_id;
  const prompt = p.prompt || "";
  const imageUrls = p.extension_image_reference_urls || [];
  const imageInputs = [];
  const uploaded = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const up = await uploadImage(tabId, imageUrls[i], at, projectId, runtime, i, imageUrls.length);
    uploaded.push(up);
    imageInputs.push({ name: up.mediaId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });
  }
  await runtime.progress(10, { stage: "submit_image_task", workflow_kind: "image" });
  const submitUrl = `https://aisandbox-pa.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/flowMedia:batchGenerateImages`;
  let tx = null;
  let parsed = null;
  let submitErr = "";
  const maxImageSubmitAttempts = 3; // 首次提交 + 失败后连续重试 3 次
  const imageSubmitTimeoutMs = Math.max(10000, Number(p.image_submit_timeout_ms || p.submit_timeout_ms || 150000) || 150000);
  for (let attempt = 0; attempt < maxImageSubmitAttempts; attempt++) {
    try {
      const recaptcha = await getRecaptchaToken(tabId, "IMAGE_GENERATION");
      if (!recaptcha) throw new Error("VEO image recaptcha token not found");
      const clientContext = {
        recaptchaContext: { token: recaptcha, applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB" },
        sessionId: sessionId(),
        projectId: String(projectId),
        tool: "PINHOLE"
      };
      const body = {
        clientContext,
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        useNewMedia: true,
        requests: [{
          clientContext,
          seed: randSeed(999999),
          imageModelName: p.extension_image_model_name || "NARWHAL",
          imageAspectRatio: p.extension_image_aspect_ratio || "IMAGE_ASPECT_RATIO_LANDSCAPE",
          structuredPrompt: { parts: [{ text: prompt }] },
          imageInputs
        }]
      };
      await runtime.progress(10, { stage: "submit_image_task", workflow_kind: "image", attempt: attempt + 1, max_attempts: maxImageSubmitAttempts, timeout_ms: imageSubmitTimeoutMs });
      tx = await pageFetchJson(tabId, submitUrl, { method: "POST", headers: authHeaders(at), body, attempts: 1, timeoutMs: imageSubmitTimeoutMs });
      if (tx.status >= 400) throw new Error(`VEO image submit failed: ${compactErrorResponse(tx)}`);
      parsed = parseImageResult(tx.json);
      break;
    } catch (e) {
      submitErr = String(e && e.message ? e.message : e || "");
      if (isNonRetryableVeoSubmitError(e)) throw e;
      if (/empty result|result null|missing fifeUrl|result undefined/i.test(submitErr)) {
        const recovered = await recoverWorkflowAfterEmptySubmit(tabId, at, projectId, runtime, "image");
        if (recovered && recovered.workflowId) {
          const finalUrl = await fetchWorkflowList(tabId, at, projectId);
          const latest = pickLatestWorkflowFromList(finalUrl) || recovered;
          parsed = {
            fifeUrl: "",
            mediaName: latest.workflowId,
            workflowId: latest.workflowId,
            projectId: latest.projectId || projectId
          };
          break;
        }
      }
      if (attempt + 1 < maxImageSubmitAttempts) {
        await runtime.progress(10, {
          stage: "submit_image_retry",
          workflow_kind: "image",
          attempt: attempt + 1,
          next_attempt: attempt + 2,
          max_attempts: maxImageSubmitAttempts,
          error: submitErr.slice(0, 300)
        });
        await resetLabsGoogleLocalStorageAndReloadForRetry(10, tabId, p.project_page, runtime, submitErr);
        await sleep(500 * (attempt + 1));
      }
    }
  }
  if (!parsed) {
    if (archiveEnabled(p, "archive_uploaded_workflows")) await archiveUploadedWorkflows(tabId, at, uploaded, runtime, "cleanup_uploaded_workflows_submit_failed");
    await refreshProjectPageAfterArchive(98, tabId, p.project_page, runtime);
    throw new Error(submitErr || "VEO image submit failed");
  }
  let shareUrl = parsed.fifeUrl;
  let originImageUrl = parsed.fifeUrl;
  let resLabel = p.extension_image_resolution_label || "1K";
  let upsampleOk = false;
  let upsampleError = "";
  let r2Uploads = [];
  if ((p.extension_image_want_upsample || p.extension_image_want_2k) && parsed.mediaName) {
    const up = await upsampleImage(tabId, at, p, parsed, runtime);
    if (up.encodedImage) {
      const dataUrl = `data:image/jpeg;base64,${up.encodedImage}`;
      upsampleOk = true;
      resLabel = up.resolutionLabel || resLabel;
      const r2Cfg = p.r2_upload || p.extension_r2_upload || null;
      if (r2Cfg) {
        try {
          const r2StartedAt = Date.now();
          await runtime.progress(92, {
            stage: "r2_upload",
            target_resolution: resLabel,
            media_id: parsed.mediaName,
            timeout_ms: Number((r2Cfg && (r2Cfg.timeout_ms || r2Cfg.timeoutMs || r2Cfg.upload_timeout_ms || r2Cfg.uploadTimeoutMs)) || 60000) || 60000,
            attempts: Number((r2Cfg && (r2Cfg.attempts || r2Cfg.upload_attempts || r2Cfg.uploadAttempts)) || 3) || 3
          });
          const uploaded = await uploadDataUrlToR2(r2Cfg, dataUrl, {
            objectKeyPrefix: (r2Cfg && (r2Cfg.object_key_prefix || r2Cfg.objectKeyPrefix)) || `veo_workflow/image/upsample/${String(resLabel || "2K").toLowerCase()}`,
            taskId: p._bridge_task_id || p.task_id || "",
            resolution: resLabel,
            contentType: "image/jpeg"
          });
          r2Uploads = [uploaded];
          shareUrl = uploaded.url;
          await runtime.progress(93, {
            stage: "r2_upload_done",
            target_resolution: resLabel,
            media_id: parsed.mediaName,
            size: uploaded.size || 0,
            duration_ms: uploaded.duration_ms || (Date.now() - r2StartedAt),
            object_key: uploaded.object_key
          });
        } catch (e) {
          upsampleError = `R2 upload failed: ${String((e && e.message) || e || "").slice(0, 300)}`;
          if (r2Cfg && r2Cfg.required !== false) throw new Error(upsampleError);
          shareUrl = dataUrl;
        }
      } else {
        shareUrl = dataUrl;
      }
    } else {
      upsampleError = up.error || "upsample returned empty encodedImage";
      resLabel = "1K";
    }
  }
  const archived = archiveEnabled(p, "archive_workflow") ? await archiveWorkflow(tabId, at, parsed.workflowId, parsed.projectId || projectId) : false;
  if (archiveEnabled(p, "archive_uploaded_workflows")) await archiveUploadedWorkflows(tabId, at, uploaded, runtime, "cleanup_uploaded_workflows_done");
  await refreshProjectPageAfterArchive(98, tabId, p.project_page, runtime);
  await runtime.progress(100, { stage: "done", image_url: shareUrl, workflow_id: parsed.workflowId });
  return {
    type: "veo_workflow_image",
    message: imageUrls.length ? "VEO 图生图完成" : "VEO 文生图完成",
    workflow_kind: "image",
    share_url: shareUrl,
    image_url: shareUrl,
    origin_image_url: originImageUrl,
    model_name: p.extension_image_model_name || "NARWHAL",
    aspect_ratio: p.extension_image_aspect_ratio || "IMAGE_ASPECT_RATIO_LANDSCAPE",
    resolution: resLabel,
    upsample_ok: upsampleOk,
    upsample_error: upsampleError || undefined,
    upsample_url: (r2Uploads[0] && r2Uploads[0].url) || undefined,
    upsample_r2_object_key: (r2Uploads[0] && r2Uploads[0].object_key) || undefined,
    r2_uploads: r2Uploads,
    project_id: projectId,
    generated_media_id: parsed.mediaName,
    generated_workflow_id: parsed.workflowId,
    workflow_archived: archived,
    i2i_image_count: imageUrls.length
  };
}

async function pollVideo(tabId, at, pollMedia, pollOperations, runtime, p) {
  const maxWait = Math.max(60, Number(p.max_wait_seconds || p.timeout_seconds || 600));
  const interval = Math.max(0.5, Number(p.poll_interval_seconds || 5));
  const deadline = Date.now() + maxWait * 1000;
  let last = {};
  let attempt = 0;
  let urlFetchAttempts = 0;
  let unsafeFailureReasonWaits = 0;
  const maxUnsafeFailureReasonWaits = Math.max(0, Number(p.unsafe_failure_reason_extra_polls ?? 5));
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    attempt++;
    const tx = await pageFetchJson(tabId, URLS.videoPoll, { method: "POST", headers: authHeaders(at), body: { media: pollMedia } });
    if (tx.status >= 400) throw new Error(`VEO video poll failed: ${compactErrorResponse(tx)}`);
    last = parseVideoPoll(tx.json);
    const failureReasons = Array.isArray(last.failure?.failureReasons) ? last.failure.failureReasons : [];
    const isUnsafeGenerationFailure = last.failed
      && /PUBLIC_ERROR_UNSAFE_GENERATION/i.test(String(last.failure?.message || ""));
    const shouldWaitForUnsafeFailureReasons = isUnsafeGenerationFailure
      && !failureReasons.length
      && unsafeFailureReasonWaits < maxUnsafeFailureReasonWaits;
    if (shouldWaitForUnsafeFailureReasons) unsafeFailureReasonWaits++;
    const pct = 25 + Math.min(70, Math.floor((Date.now() - (deadline - maxWait * 1000)) / (maxWait * 1000) * 70));
    await runtime.progress(pct, {
      stage: shouldWaitForUnsafeFailureReasons ? "waiting_failure_reasons" : (last.failed ? "failed" : "polling"),
      attempt,
      status: last.status,
      workflow_id: last.workflowId,
      failure_reason_wait_attempt: shouldWaitForUnsafeFailureReasons ? unsafeFailureReasonWaits : undefined,
      failure_reason_wait_max: shouldWaitForUnsafeFailureReasons ? maxUnsafeFailureReasonWaits : undefined,
      failure_reasons: last.failed && failureReasons.length ? failureReasons : undefined,
      error: last.failed ? formatVideoPollFailure(last.failure) : undefined
    });
    if (shouldWaitForUnsafeFailureReasons) continue;
    if (last.failed) {
      const err = new Error(`VEO video generation failed: ${formatVideoPollFailure(last.failure)}`);
      if (failureReasons.length) {
        err.failureReasons = failureReasons;
        err.failure_reasons = failureReasons;
      }
      throw err;
    }
    if (last.videoUrl) return last;
    if (/MEDIA_GENERATION_STATUS_SUCCESSFUL/i.test(String(last.status || ""))) {
      const mediaName = String(last.mediaName || ((pollMedia || []).find(item => item && item.name) || {}).name || "").trim();
      const resultProjectId = String(last.projectId || p.project_id || "").trim();
      if (!mediaName) throw new Error("VEO video generation succeeded but poll media name is missing");
      urlFetchAttempts++;
      await runtime.progress(pct, {
        stage: "fetching_video_url",
        attempt,
        url_fetch_attempt: urlFetchAttempts,
        status: last.status,
        workflow_id: last.workflowId,
        media_name: mediaName
      });
      last.videoUrl = await getGeneratedVideoUrl(tabId, resultProjectId, mediaName);
      last.mediaName ||= mediaName;
      return last;
    }
  }
  throw new Error(`VEO video polling timeout; last=${JSON.stringify(last).slice(0, 300)}`);
}

function stripI2vFl(modelKey) {
  return String(modelKey || "").replace("_fl_", "_").replace(/_fl$/, "");
}

async function loadVeoInjectedVideoScript(tabId, fileName) {
  const path = `providers/veo/${fileName.replace(/\.txt$/i, ".js")}`;
  return path;
}

async function runInjectedVeoVideo(tabId, scriptPath, config) {
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: [scriptPath] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (runnerConfig) => {
      try {
        const runner = globalThis.runGeneratedTest;
        if (typeof runner !== "function") throw new Error("Injected script did not define runGeneratedTest(config)");
        return await runner(runnerConfig || {});
      } catch (error) {
        return { ok: false, error: String(error && error.message || error), stack: error && error.stack };
      }
    },
    args: [config]
  });
  if (!result) throw new Error("VEO injected script returned an empty result");
  return result;
}

async function runVideoWorkflowLegacy(tabId, p, at, runtime) {
  const projectId = p.project_id;
  const prompt = p.prompt || "";
  const mode = p.video_mode || "t2v";
  const uploaded = [];
  let submitUrl = URLS.videoT2V;
  let reqItem;
  const aspectRatio = p.extension_video_aspect_ratio || "VIDEO_ASPECT_RATIO_LANDSCAPE";
  let modelKey = p.extension_model_key || "veo_3_1_t2v_fast";
  let r2vVideoUpload = null;

  try {
  if (mode === "r2v") {
    const refs = [];
    const urls = p.ingredients_urls || [];
    const videoUrls = (Array.isArray(p.ingredients_video_urls) ? p.ingredients_video_urls : (p.ingredients_video_url ? [p.ingredients_video_url] : []))
      .map(x => String(x || "").trim())
      .filter(Boolean);
    if (videoUrls.length > 1) throw new Error("VEO r2v video reference supports at most one video url");
    for (let i = 0; i < urls.length; i++) {
      const up = await uploadImage(tabId, urls[i], at, projectId, runtime, i, urls.length);
      uploaded.push(up);
      refs.push({ imageUsageType: "IMAGE_USAGE_TYPE_ASSET", mediaId: up.mediaId });
    }
    if (videoUrls.length) {
      modelKey = "abra_edit";
      const videoUrl = videoUrls[0];
      const meta = await getLocalVideoMetadata(tabId, videoUrl, runtime);
      const durationSeconds = finitePositiveNumber(p.ingredients_video_duration_seconds || p.video_reference_duration_seconds || meta.duration) || 30;
      assertReferenceVideoDuration(durationSeconds, videoUrl);
      const uploadInfo = await uploadVideoInChunks(tabId, videoUrl, at, projectId, runtime);
      if (uploadInfo.workflowServerId) {
        uploaded.push({
          workflowId: uploadInfo.workflowServerId,
          projectId: uploadInfo.uploadProjectId || uploadInfo.projectId || projectId,
          mediaId: uploadInfo.mediaServerId || "",
          uploadType: "video_reference"
        });
      }
      const offsetInfo = await confirmUploadedVideoOffset(tabId, at, uploadInfo, durationSeconds, runtime);
      await pollUploadedVideoProcessing(tabId, at, uploadInfo, runtime, p);
      const endFrameIndex = computeVideoEndFrameIndex(p, meta, durationSeconds);
      await runtime.progress(14, {
        stage: "reference_video_frame_range",
        duration_seconds: durationSeconds,
        fps: finitePositiveNumber(p.ingredients_video_fps || p.video_reference_fps || meta.fps || meta.frameRate || meta.frame_rate) || undefined,
        frame_count: Number.parseInt(p.ingredients_video_frame_count || p.video_reference_frame_count || meta.frameCount || meta.frame_count || "", 10) || undefined,
        start_frame_index: Number(p.ingredients_video_start_frame_index || p.video_reference_start_frame_index || 0) || 0,
        end_frame_index: endFrameIndex
      });
      r2vVideoUpload = { ...uploadInfo, ...offsetInfo, durationSeconds, endFrameIndex };
      submitUrl = URLS.videoEdit;
    } else {
      submitUrl = URLS.videoR2V;
    }
    reqItem = {
      aspectRatio, seed: randSeed(),
      textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
      videoModelKey: modelKey,
      referenceImages: refs,
      metadata: { sceneId: crypto.randomUUID() }
    };
    if (r2vVideoUpload) {
      reqItem.videoInput = {
        mediaId: r2vVideoUpload.mediaServerId,
        startFrameIndex: Number(p.ingredients_video_start_frame_index || p.video_reference_start_frame_index || 0) || 0,
        endFrameIndex: r2vVideoUpload.endFrameIndex
      };
    }
  } else if (mode === "i2v") {
    const urls = p.i2v_urls || [];
    if (!urls.length) throw new Error("VEO i2v missing image urls");
    const ids = [];
    for (let i = 0; i < urls.length; i++) {
      const up = await uploadImage(tabId, urls[i], at, projectId, runtime, i, urls.length);
      uploaded.push(up);
      ids.push(up.mediaId);
    }
    if (ids[1]) {
      submitUrl = URLS.videoI2VStartEnd;
      reqItem = { aspectRatio, seed: randSeed(), textInput: { prompt }, videoModelKey: modelKey, startImage: { mediaId: ids[0] }, endImage: { mediaId: ids[1] }, metadata: { sceneId: crypto.randomUUID() } };
    } else {
      submitUrl = URLS.videoI2VStart;
      modelKey = stripI2vFl(modelKey);
      reqItem = { aspectRatio, seed: randSeed(), textInput: { prompt }, videoModelKey: modelKey, startImage: { mediaId: ids[0] }, metadata: { sceneId: crypto.randomUUID() } };
    }
  } else {
    reqItem = { aspectRatio, seed: randSeed(), textInput: { prompt }, videoModelKey: modelKey, metadata: { sceneId: crypto.randomUUID() } };
  }

  await runtime.progress(10, { stage: "submit_task", video_mode: mode });
  let pollMedia = [];
  let pollOperations = [];
  let submittedWorkflow = { workflowId: "", projectId: "", mediaName: "" };
  let submitErr = "";
  const maxVideoSubmitAttempts = 3; // 首次提交 + 失败后连续重试 3 次
  const videoSubmitTimeoutMs = Math.max(10000, Number(p.video_submit_timeout_ms || p.submit_timeout_ms || 90000) || 90000);
  const userPaygateTier = normalizePaygateTier(await fetchVeoUserPaygateTier(tabId, at));
  for (let attempt = 0; attempt < maxVideoSubmitAttempts; attempt++) {
    try {
      const recaptcha = await getRecaptchaToken(tabId, "VIDEO_GENERATION");
      if (!recaptcha) throw new Error("VEO video recaptcha token not found");
      const clientContext = {
        recaptchaContext: { token: recaptcha, applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB" },
        sessionId: sessionId(),
        projectId: String(projectId),
        tool: "PINHOLE",
        userPaygateTier
      };
      const mediaGenerationContext = {
        batchId: crypto.randomUUID(),
        audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
      };
      const body = mode === "r2v"
        ? {
            mediaGenerationContext,
            clientContext,
            requests: [reqItem],
            ...(r2vVideoUpload ? {} : { useV2ModelConfig: true })
          }
        : { mediaGenerationContext, clientContext, requests: [reqItem] };
      await runtime.progress(10, { stage: "submit_task", video_mode: mode, attempt: attempt + 1, max_attempts: maxVideoSubmitAttempts, timeout_ms: videoSubmitTimeoutMs, user_paygate_tier: userPaygateTier });
      const tx = await pageFetchJson(tabId, submitUrl, { method: "POST", headers: authHeaders(at), body, attempts: 1, timeoutMs: videoSubmitTimeoutMs });
      if (tx.status >= 400) throw new Error(`VEO video submit failed: ${compactErrorResponse(tx)}`);
      const submitMedia = Array.isArray(tx.json?.media) ? tx.json.media : [];
      submittedWorkflow = parseVideoSubmitWorkflow(tx.json);
      pollMedia = normalizeVideoPollMedia(submitMedia, submittedWorkflow.projectId || projectId);
      pollOperations = normalizeVideoPollOperations(submitMedia);
      if (!pollMedia.length) throw new Error(`VEO video submit missing poll media: ${JSON.stringify(tx.json).slice(0, 500)}`);
      break;
    } catch (e) {
      submitErr = String(e && e.message ? e.message : e || "");
      if (isNonRetryableVeoSubmitError(e)) throw e;
      if (attempt + 1 < maxVideoSubmitAttempts) {
        await runtime.progress(10, {
          stage: "submit_video_retry",
          video_mode: mode,
          attempt: attempt + 1,
          next_attempt: attempt + 2,
          max_attempts: maxVideoSubmitAttempts,
          error: submitErr.slice(0, 300)
        });
        await resetLabsGoogleLocalStorageAndReloadForRetry(10, tabId, p.project_page, runtime, submitErr);
        await sleep(500 * (attempt + 1));
      }
    }
  }
  if (!pollMedia.length) throw new Error(submitErr || "VEO video submit failed");
  await runtime.progress(25, { stage: "polling", media: pollMedia.length, operations: pollOperations.length });
  const done = await pollVideo(tabId, at, pollMedia, pollOperations, runtime, p);
  const generatedWorkflowId = done.workflowId || submittedWorkflow.workflowId || "";
  const generatedProjectId = done.projectId || submittedWorkflow.projectId || projectId;
  const generatedMediaId = done.mediaName || submittedWorkflow.mediaName || "";
  const archived = archiveEnabled(p, "archive_workflow")
    ? await archiveGeneratedWorkflow(tabId, at, generatedWorkflowId, generatedProjectId, runtime, "archive_video_workflow")
    : false;
  if (archiveEnabled(p, "archive_uploaded_workflows")) await archiveUploadedWorkflows(tabId, at, uploaded, runtime, "cleanup_uploaded_workflows_done");
  await refreshProjectPageAfterArchive(98, tabId, p.project_page, runtime);
  await runtime.progress(100, { stage: "done", video_url: done.videoUrl, workflow_id: generatedWorkflowId });
  return {
    type: "veo_workflow_video",
    message: mode === "r2v" ? "VEO Ingredients（多图参考）视频完成" : (mode === "i2v" ? "VEO 图生视频完成" : "VEO 文生视频完成"),
    share_url: done.videoUrl,
    thumb_url: (mode === "i2v" ? (p.i2v_urls || [])[0] : (mode === "r2v" ? (p.ingredients_urls || [])[0] : "")) || "",
    video_type: mode,
    model_key: modelKey,
    aspect_ratio: aspectRatio,
    project_id: projectId,
    generated_media_id: generatedMediaId,
    generated_workflow_id: generatedWorkflowId,
    workflow_archived: archived
  };
  } catch (e) {
    if (archiveEnabled(p, "archive_uploaded_workflows")) await archiveUploadedWorkflows(tabId, at, uploaded, runtime, "cleanup_uploaded_workflows_video_failed");
    await refreshProjectPageAfterArchive(98, tabId, p.project_page, runtime);
    throw e;
  }
}

// New Flow browser-console implementation. The legacy REST implementation is
// retained above for rollback only and is never selected by runVeoTask.
async function runVideoWorkflow(tabId, p, at, runtime) {
  const imageUrls = [
    ...(Array.isArray(p.ingredients_urls) ? p.ingredients_urls : []),
    ...(Array.isArray(p.i2v_urls) ? p.i2v_urls : [])
  ]
    .map(x => String(x || "").trim()).filter(Boolean);
  const videoUrls = (Array.isArray(p.ingredients_video_urls) ? p.ingredients_video_urls :
    (p.ingredients_video_url ? [p.ingredients_video_url] : []))
    .map(x => String(x || "").trim()).filter(Boolean);
  const mode = String(p.video_mode || "t2v").toLowerCase();

  // Video + image editing is intentionally left as an explicit branch until
  // the new console workflow for video inputs is available.
  if (videoUrls.length) {
    await runtime.progress(10, { stage: "video_image_branch_not_implemented", video_count: videoUrls.length, image_count: imageUrls.length });
    throw new Error("VEO video+image generation is not implemented yet");
  }

  const aspect = String(p.extension_video_aspect_ratio || "VIDEO_ASPECT_RATIO_LANDSCAPE");
  const aspectRatio = /PORTRAIT|9:16|VERTICAL/i.test(aspect) ? "9:16" : "16:9";
  const prompt = String(p.prompt || "").trim();
  if (!prompt) throw new Error("VEO video prompt is empty");
  if (imageUrls.length > 9) throw new Error("VEO reference images support at most 9 images");

  const useImages = imageUrls.length > 0 || mode === "r2v" || mode === "i2v";
  const scriptName = useImages ? "image2video_injected.txt" : "text2video_injected.txt";
  await runtime.progress(10, { stage: "load_injected_script", video_mode: useImages ? "r2v" : "t2v", image_count: imageUrls.length });
  const scriptPath = await loadVeoInjectedVideoScript(tabId, scriptName);
  const config = {
    prompt,
    project_id: String(p.project_id || ""),
    aspectRatio,
    referenceImageUrls: imageUrls.slice(0, 9),
    maxWaitSeconds: Number(p.max_wait_seconds || p.timeout_seconds || 600),
    pollIntervalSeconds: Number(p.poll_interval_seconds || 5),
  };
  await runtime.progress(15, { stage: "execute_injected_script", video_mode: useImages ? "r2v" : "t2v", image_count: imageUrls.length });
  const result = await runInjectedVeoVideo(tabId, scriptPath, config);
  if (!result.ok) throw new Error(String(result.error || "VEO injected video generation failed"));
  const videoUrl = String(result.video_url || result.share_url || result.videoUrl || result.result?.videoUrl || "").trim();
  if (!videoUrl) throw new Error("VEO injected video generation returned no video URL");
  await runtime.progress(100, { stage: "done", video_url: videoUrl, video_mode: useImages ? "r2v" : "t2v" });
  return {
    type: "veo_workflow_video",
    message: useImages ? "VEO 多图生视频完成" : "VEO 文生视频完成",
    share_url: videoUrl,
    video_url: videoUrl,
    thumb_url: imageUrls[0] || "",
    video_type: useImages ? "r2v" : "t2v",
    model_key: p.extension_model_key || undefined,
    aspect_ratio: p.extension_video_aspect_ratio || (aspectRatio === "9:16" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE"),
    project_id: String(p.project_id || ""),
    generated_media_id: result.result?.mediaUUID || result.mediaUUID || undefined,
    generated_workflow_id: result.result?.workflowId || result.workflow_id || undefined,
    workflow_archived: false,
    injected_result: result,
  };
}

export async function runVeoTask(msg, runtime) {
  const p = msg.payload || {};
  const action = String(p.action || p.workflow_kind || "").trim().toLowerCase();
  if (HUMAN_ACTIVITY_ACTIONS.has(action)) {
    return await runVeoHumanActivityAction(msg, runtime);
  }
  const veoRunId = beginVeoTaskRun(msg, runtime);
  try {
    await waitForVeoHumanActivityIdle(runtime);
    if (action === "current_page" || action === "get_current_page" || action === "current_url" || action === "get_current_url") {
      return await fetchVeoCurrentPageTask(msg, runtime);
    }
    const projectPage = normalizeVeoProjectPageUrl(p.project_page || p.target_url || "https://flow.google.com/");
    await assertProjectPageAccessible(projectPage, runtime);
    const tabId = await ensureVeoProjectTab(projectPage, { navigate: true, active: true });
    let aiStudioTabId = null;
    const projectTab = await chrome.tabs.get(tabId);
    aiStudioTabId = await ensureAiStudioNewChatTab({ active: false, windowId: projectTab && projectTab.windowId });
    if (!aiStudioTabId) throw new Error("AI Studio new_chat tab could not be opened");
    p._ai_studio_tab_id = aiStudioTabId;
    await chrome.tabs.update(tabId, { active: true });
    closeOtherTabsInSameWindowLater([tabId, aiStudioTabId].filter(Boolean), 5000);

    if (action === "fetch_tokens" || action === "fetch_access_tokens" || action === "get_access_tokens") {
      const pendingProjectId = String(p.project_id || p.projectId || p.flow_project_id || "").trim()
        || (() => {
          const m = String(projectPage || "").match(/\/project\/([^/?#]+)/i);
          return m ? decodeURIComponent(m[1]) : "";
        })();
      if (pendingProjectId) {
        try {
          await chrome.storage.local.set({ veo_pending_project_id: pendingProjectId.replace(/^projects\//, "") });
        } catch (_) {}
      }
      await reloadProjectPage(1, tabId, projectPage, runtime);
      return await fetchVeoAccessTokensTask({ ...msg, payload: { ...p, tab_id: tabId } }, runtime);
    }
    if (action === "create_flow_project" || action === "flow_project_create" || action === "create_project") {
      return await createVeoFlowProjectTask(msg, runtime);
    }
    if (action === "delete_flow_project" || action === "flow_project_delete" || action === "delete_project") {
      return await deleteVeoFlowProjectTask(msg, runtime);
    }
    if (p.popup_test_task || p.veo_test_task) {
      // Popup 手动生成测试用于连通性验证，生成结果应保留在项目页供人工查看，
      // 不走常规任务的自动归档/清理流程。
      p.archive_workflow = false;
      p.archive_uploaded_workflows = false;
      await runtime.progress(1, { stage: "archive_setting", archive_enabled: false, reason: "popup_test_task" });
    } else {
      try {
        const got = await chrome.storage.local.get(["veo_archive_enabled"]);
        const enabled = got.veo_archive_enabled !== false; // default enabled
        p.archive_workflow = enabled;
        p.archive_uploaded_workflows = enabled;
        await runtime.progress(1, { stage: "archive_setting", archive_enabled: enabled });
      } catch (_) {
        p.archive_workflow = true;
        p.archive_uploaded_workflows = true;
      }
    }
    if (action === "balance_refresh" || action === "refresh_balance") {
      return await refreshVeoBalanceTask(msg, runtime);
    }
    await runtime.progress(2, { stage: "ensure_tab", url: projectPage });
    // 普通生成任务必须保持在 project_page；如果余额刷新打开了 one.google 标签，
    // 这里会重新选中/导航回精确项目页，避免停留到 /tools/flow 列表页。
    
    //await resetLabsGoogleLocalStorageAndReload(3, tabId, projectPage, runtime);
    await runtime.progress(5, { stage: "access_token" });
    const isImageTask = p.workflow_kind === "image" || p.image_mode;
    // AI Studio image generation authenticates in its own tab and does not
    // require a Labs/Flow access token. Avoid failing on Flow pages whose
    // legacy relative auth-session endpoint may not exist during migration.
    // Video generation now runs the browser-console Flow scripts. Those
    // scripts obtain their own batchexecute/reCAPTCHA credentials from the
    // page, so do not require the removed legacy /api/auth/session token.
    const tokenInfo = isImageTask
      ? { access_token: p.access_token || "", expires: p.access_expires }
      : { access_token: p.access_token || "", expires: p.access_expires };
    const at = tokenInfo.access_token;
    //引入拟人操作
    await simulateHumanActivity(tabId, runtime, 5000, 15000, {
      stage: "veo_pre_workflow_human_activity",
      progress: 5,
      // 预提交阶段只需要轻量活动；不要点击 Flow 的 prompt/editor 输入框。
      // 复杂 SPA 中点击输入框可能触发焦点/懒加载/重渲染，且 chrome.scripting
      // 注入偶发会被拖到数分钟后才返回，阻塞真正的 submit_task。
      clickInputs: false,
      scroll: true,
      moveMouse: true,
      timeoutMs: 20000
    });
    if (isImageTask) {
      return await runImageWorkflow(tabId, p, at, runtime);
    }
    await cleanupProjectWorkflowsBeforeRun(tabId, at, p.project_id, runtime);
    return await runVideoWorkflow(tabId, p, at, runtime);
  } finally {
    endVeoTaskRun(veoRunId, runtime);
  }
}
