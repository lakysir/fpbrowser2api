function $(id) { return document.getElementById(id); }

function T(key, values) { return window.__fpbT ? window.__fpbT(key, values) : key; }

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

const ANALYSIS_TARGET_TAB_STORAGE_KEY = "analysis_target_tab_id";
const ANALYSIS_TARGET_UPDATED_STORAGE_KEY = "analysis_target_updated_at";
const ANALYSIS_WINDOW_STATE_STORAGE_KEY = "analysis_window_state";

async function getActiveHttpTab() {
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const focused = (windows || []).find(win => win.focused);
    const ordered = focused ? [focused].concat((windows || []).filter(win => win !== focused)) : (windows || []);
    for (const win of ordered) {
      const tab = (win.tabs || []).find(t => t.active && t.id && /^https?:\/\//i.test(String(t.url || "")));
      if (tab) return tab;
    }
  } catch (_) {}
  return null;
}

async function getStoredAnalysisTargetTab() {
  try {
    const got = await chrome.storage.local.get([ANALYSIS_TARGET_TAB_STORAGE_KEY]);
    const tabId = Number(got[ANALYSIS_TARGET_TAB_STORAGE_KEY] || 0) || 0;
    if (!tabId) return null;
    const tab = await chrome.tabs.get(tabId);
    return tab && tab.id && /^https?:\/\//i.test(String(tab.url || "")) ? tab : null;
  } catch (_) {
    return null;
  }
}

function renderTargetPageInfo(tab, sourceText) {
  const titleEl = $("targetPageTitle");
  const urlEl = $("targetPageUrl");
  const sourceEl = $("targetPageSource");
  const box = $("targetPageBox");
  if (!titleEl || !urlEl || !sourceEl) return;
  if (!tab) {
    titleEl.textContent = T("noTargetPage");
    urlEl.textContent = "";
    sourceEl.textContent = T("notBound");
    if (box) box.title = "";
    return;
  }
  const title = tab.title || T("unnamedPage");
  const url = String(tab.url || "");
  titleEl.textContent = title;
  urlEl.textContent = url;
  sourceEl.textContent = sourceText || T("bound");
  if (box) box.title = title + "\n" + url;
}

async function refreshTargetPageInfo() {
  const captureResp = await send("popup.networkCapture.status").catch(() => null);
  const captureTabId = Number(captureResp && captureResp.result && captureResp.result.tab_id || 0) || 0;
  if (captureTabId) {
    try {
      const tab = await chrome.tabs.get(captureTabId);
      if (tab && /^https?:\/\//i.test(String(tab.url || ""))) {
        renderTargetPageInfo(tab, T("captureTarget"));
        return tab;
      }
    } catch (_) {}
  }
  const stored = await getStoredAnalysisTargetTab();
  if (stored) {
    renderTargetPageInfo(stored, T("analysisTarget"));
    return stored;
  }
  const active = await getActiveHttpTab();
  renderTargetPageInfo(active, active ? T("currentPage") : T("notBound"));
  return active;
}

async function findAnalysisTab() {
  const analysisUrl = chrome.runtime.getURL("analysis.html");
  const tabs = await chrome.tabs.query({});
  return (tabs || []).find(tab => tab && tab.id && String(tab.url || "").startsWith(analysisUrl)) || null;
}

async function saveAnalysisTargetTab(targetTab) {
  if (!targetTab || !targetTab.id) return;
  await chrome.storage.local.set({
    [ANALYSIS_TARGET_TAB_STORAGE_KEY]: targetTab.id,
    [ANALYSIS_TARGET_UPDATED_STORAGE_KEY]: Date.now()
  });
}

async function getCachedAnalysisWindowState() {
  try {
    const got = await chrome.storage.local.get([ANALYSIS_WINDOW_STATE_STORAGE_KEY]);
    const value = got[ANALYSIS_WINDOW_STATE_STORAGE_KEY];
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
}

function clampWindowBounds(bounds, screenWidth, screenHeight) {
  const width = Math.max(640, Math.min(screenWidth, Math.round(Number(bounds.width) || 0)));
  const height = Math.max(480, Math.min(screenHeight, Math.round(Number(bounds.height) || 0)));
  const left = Math.max(0, Math.min(screenWidth - width, Math.round(Number(bounds.left) || 0)));
  const top = Math.max(0, Math.min(screenHeight - height, Math.round(Number(bounds.top) || 0)));
  return { width, height, left, top };
}

async function openAnalysisWindow() {
  const targetTab = await getActiveHttpTab();
  if (targetTab && targetTab.id) await saveAnalysisTargetTab(targetTab);

  const existingAnalysisTab = await findAnalysisTab();
  if (existingAnalysisTab && existingAnalysisTab.id) {
    if (existingAnalysisTab.windowId != null) {
      await chrome.windows.update(existingAnalysisTab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(existingAnalysisTab.id, { active: true }).catch(() => {});
    return;
  }

  const url = new URL(chrome.runtime.getURL("analysis.html"));
  if (targetTab && targetTab.id) url.searchParams.set("targetTabId", String(targetTab.id));

  try {
    const currentWindow = await chrome.windows.getCurrent();
    const screenWidth = window.screen && window.screen.availWidth ? window.screen.availWidth : 1440;
    const screenHeight = window.screen && window.screen.availHeight ? window.screen.availHeight : 900;
    const baseWidth = Math.min(1416, Math.max(1080, Math.floor(screenWidth * 0.552)));
    const width = Math.min(screenWidth, Math.floor(baseWidth * 1.2));
    const height = Math.min(900, Math.max(700, Math.floor(screenHeight * 0.88)));
    const left = Math.max(0, Math.min(
      screenWidth - width,
      Number(currentWindow.left || 0) + Math.max(40, Number(currentWindow.width || screenWidth) - width - 24)
    ));
    const top = Math.max(0, Math.min(
      screenHeight - height,
      Number(currentWindow.top || 0) + 24
    ));
    const cached = await getCachedAnalysisWindowState();
    const createOptions = {
      url: url.toString(),
      type: "popup",
      focused: true
    };
    if (cached && (cached.state === "maximized" || cached.state === "fullscreen")) {
      createOptions.state = cached.state;
    } else if (cached && Number(cached.width) && Number(cached.height)) {
      Object.assign(createOptions, clampWindowBounds(cached, screenWidth, screenHeight));
    } else {
      Object.assign(createOptions, { width, height, left, top });
    }
    await chrome.windows.create(createOptions);
  } catch (_) {
    chrome.tabs.create({ url: url.toString() });
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function renderStatus(st) {
  const dot = $("dot");
  dot.className = "dot";
  if (st.connected && st.helloOk) dot.classList.add("ok");
  else if (st.wsState === "connecting" || st.reconnectScheduled) dot.classList.add("warn");
  else dot.classList.add("bad");

  $("connText").textContent = st.connected && st.helloOk
    ? T("connectedRegistered")
    : (st.connected ? T("wsConnectedWaiting") : T("disconnected", { state: st.wsState || "unknown" }));

  const active = st.activeTask ? `${st.activeTask.provider || ""} / ${st.activeTask.task_id || ""}` : T("none");
  const statusHtml = `
    <div>${esc(st.spaceId)} / ${esc(st.windowKey)} · ${esc(st.clientId || "-")}</div>
    <div>task: ${esc(active)}${st.lastError ? ` · error: ${esc(st.lastError)}` : ""}</div>
  `;
  if ($("statusKv").innerHTML !== statusHtml) $("statusKv").innerHTML = statusHtml;
}

const TRANSFER_URL_RE = /(https?:\/\/[^\s<>'"]+)/ig;

function linkifyEscapedLine(line) {
  const raw = String(line ?? "");
  let out = "";
  let last = 0;
  raw.replace(TRANSFER_URL_RE, (m, _g, idx) => {
    out += esc(raw.slice(last, idx));
    const href = esc(m);
    out += `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
    last = idx + m.length;
    return m;
  });
  out += esc(raw.slice(last));
  return out;
}

function getTransferLines(data) {
  if (Array.isArray(data?.lines)) return data.lines.map(x => String(x ?? ""));
  const text = String(data?.text || "");
  return text ? text.split(/\r?\n/) : [];
}

async function setActiveTab(tab) {
  const allowed = ["debug", "transfer", "analysis"];
  const name = allowed.includes(tab) ? tab : "debug";
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === name));
  $("debugPanel")?.classList.toggle("active", name === "debug");
  $("transferPanel")?.classList.toggle("active", name === "transfer");
  $("analysisPanel")?.classList.toggle("active", name === "analysis");
  try { await send("popup.setActiveTab", { tab: name }); } catch (_) {}
}

function renderTransferData(data) {
  const root = $("transferData");
  const meta = $("transferMeta");
  if (!root) return;
  // 不要在用户正在选择、点击或复制 Data Panel 内容时重建 DOM，否则会导致选区/点击状态瞬间失效。
  if (isUserInteractingWith(root)) return;
  const lines = getTransferLines(data);
  if (meta) {
    const bits = [];
    if (data?.title) bits.push(data.title);
    if (data?.source) bits.push(`${T("source")}: ${data.source}`);
    if (data?.received_at) bits.push(`${T("received")}: ${data.received_at}`);
    const metaText = bits.join(" · ");
    if (meta.textContent !== metaText) meta.textContent = metaText;
  }
  if (!lines.length) {
    const html = `<div class="empty">${esc(T("noReceivedData"))}</div>`;
    if (root.innerHTML !== html) root.innerHTML = html;
    return;
  }
  const html = lines.map((line, idx) => `
    <div class="transfer-line">
      <div class="transfer-text">${linkifyEscapedLine(line)}</div>
      <button class="copy-line-btn" data-copy-line="${idx}" type="button">${esc(T("copy"))}</button>
    </div>
  `).join("");
  if (root.innerHTML !== html) root.innerHTML = html;
}

function renderLogs(logs) {
  const root = $("logs");
  // 日志区也避免在用户选择文字时全量刷新。
  if (isUserInteractingWith(root)) return;
  if (!logs || !logs.length) {
    const html = `<div class='hint'>${esc(T("noLogs"))}</div>`;
    if (root.innerHTML !== html) root.innerHTML = html;
    return;
  }
  const html = logs.map(x => {
    const data = x.data ? "\n" + JSON.stringify(x.data, null, 2) : "";
    return `<div class="log ${esc(x.level || "")}">
      <span class="ts">${esc(x.ts || "")}</span>
      <span class="lvl">[${esc(x.level || "info")}]</span>
      ${esc(x.message || "")}${esc(data)}
    </div>`;
  }).join("");
  if (root.innerHTML !== html) root.innerHTML = html;
}

function renderCapturePreview(events, totalCount = null) {
  const root = $("capturePreviewList");
  const countEl = $("capturePreviewCount");
  if (!root) return;
  const list = Array.isArray(events) ? events : [];
  if (countEl) countEl.textContent = T("countItems", { count: Number(totalCount ?? list.length) || 0 });
  if (isUserInteractingWith(root)) return;
  if (!list.length) {
    const html = `<div class="empty">${esc(T("noRequests"))}</div>`;
    if (root.innerHTML !== html) root.innerHTML = html;
    return;
  }
  const rows = list.slice(-120).reverse();
  const html = rows.map(e => {
    const method = String(e.method || "GET").toUpperCase();
    const status = Number(e.status || 0) || 0;
    const ok = status >= 200 && status < 400;
    const statusText = status ? String(status) : "-";
    const url = e.path || e.url || "";
    const duration = e.duration_ms != null ? `${e.duration_ms} ms` : "-";
    return `<div class="capture-preview-item">
      <div><span class="capture-preview-method">${esc(method)}</span><span class="capture-preview-status${ok || !status ? "" : " err"}">${esc(statusText)}</span></div>
      <div class="capture-preview-url" title="${esc(e.url || url)}">${esc(url)}</div>
      <div class="capture-preview-meta">${esc(duration)} · ${esc(e.source || "")}</div>
    </div>`;
  }).join("");
  if (root.innerHTML !== html) root.innerHTML = html;
}

async function refreshCapturePreview() {
  const root = $("capturePreviewList");
  if (!root) return;
  try {
    const resp = await send("popup.networkCapture.snapshot", { since_seq: 0, limit: 120 });
    if (!resp?.ok) return;
    const result = resp.result || {};
    renderCapturePreview(result.events || [], result.count ?? result.total ?? (result.events || []).length);
  } catch (_) {}
}

async function clearNetworkLogList() {
  await captureAction("clear");
  renderCapturePreview([], 0);
  await refreshCaptureStatus().catch(() => {});
  await updateToggleBtn().catch(() => {});
  await refreshCapturePreview().catch(() => {});
}

function setInputValueIfIdle(id, value) {
  const el = $(id);
  if (!el) return;
  // 输入框获得焦点时不要用 storage 中的旧值覆盖用户正在输入的内容。
  if (document.activeElement === el) return;
  const next = String(value ?? "");
  if (el.value !== next) el.value = next;
}

function setCheckboxIfIdle(id, checked) {
  const el = $(id);
  if (!el) return;
  if (document.activeElement === el) return;
  const next = !!checked;
  if (el.checked !== next) el.checked = next;
}

function isUserInteractingWith(root) {
  if (!root) return false;
  if (root.contains(document.activeElement)) return true;
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  return root.contains(sel.anchorNode) || root.contains(sel.focusNode);
}

let refreshInFlight = false;

async function refresh() {
  // 防止定时刷新和手动刷新重叠，进一步减少抖动。
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const resp = await send("popup.getState");
    if (!resp || !resp.ok) {
      $("connText").textContent = T("operationFailed");
      return;
    }
    const cfg = resp.config || {};
    const st = resp.status || {};
    setInputValueIfIdle("bridgeUrl", cfg.bridgeUrl || st.bridgeUrl || "");
    setInputValueIfIdle("bridgeToken", cfg.bridgeToken || "");
    setInputValueIfIdle("spaceId", cfg.spaceId || st.spaceId || "");
    setInputValueIfIdle("windowKey", cfg.windowKey || st.windowKey || "");
    setInputValueIfIdle("googleAccount", cfg.googleAccount || "");
    setInputValueIfIdle("googlePassword", cfg.googlePassword || "");
    setInputValueIfIdle("googleEfa", cfg.googleEfa || "");
    setCheckboxIfIdle("googleAutoLoginWatchEnabled", !!cfg.googleAutoLoginWatchEnabled);
    setCheckboxIfIdle("veoArchiveEnabled", cfg.veoArchiveEnabled !== false);
    renderStatus(st);
    renderLogs(resp.logs || []);
    renderTransferData(resp.transferData || null);
    const active = resp.activeTab || "debug";
    document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === active));
    $("debugPanel")?.classList.toggle("active", active === "debug");
    $("transferPanel")?.classList.toggle("active", active === "transfer");
    $("analysisPanel")?.classList.toggle("active", active === "analysis");
    // Update capture status display if analysis panel is visible
    if (active === "analysis") {
      refreshTargetPageInfo().catch(() => {});
      refreshCaptureStatus().catch(() => {});
      updateToggleBtn().catch(() => {});
      refreshCapturePreview().catch(() => {});
    }
  } finally {
    refreshInFlight = false;
  }
}

async function save() {
  await send("popup.saveConfig", {
    config: {
      bridgeUrl: $("bridgeUrl").value.trim(),
      bridgeToken: $("bridgeToken").value.trim(),
      spaceId: $("spaceId").value.trim(),
      windowKey: $("windowKey").value.trim(),
      googleAccount: $("googleAccount").value.trim(),
      googlePassword: $("googlePassword").value,
      googleEfa: $("googleEfa").value.trim(),
      googleAutoLoginWatchEnabled: $("googleAutoLoginWatchEnabled").checked,
      veoArchiveEnabled: $("veoArchiveEnabled").checked
    }
  });
  setTimeout(refresh, 300);
}

async function saveGoogleAutoLoginWatch(triggerNow = true) {
  const enabled = !!$("googleAutoLoginWatchEnabled")?.checked;
  await send("popup.setGoogleAutoLoginWatch", {
    enabled,
    triggerNow: enabled && triggerNow,
    creds: {
      googleAccount: $("googleAccount")?.value.trim() || "",
      googlePassword: $("googlePassword")?.value || "",
      googleEfa: $("googleEfa")?.value.trim() || ""
    }
  });
  setTimeout(refresh, 300);
}

async function reconnect() {
  await send("popup.reconnect");
  setTimeout(refresh, 300);
}

async function clearCurrentPageLocalStorage() {
  const btn = $("clearPageStorageBtn");
  const oldText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = T("masking");
  }
  try {
    const resp = await send("popup.clearCurrentPageLocalStorage");
    if (!resp || !resp.ok) throw new Error(resp?.error || "clear localStorage failed");
    if (btn) {
      const before = resp.result?.before;
      const after = resp.result?.after;
      btn.textContent = Number.isFinite(before) && Number.isFinite(after)
        ? T("masking")
        : T("masked");
    }
    setTimeout(refresh, 300);
  } catch (e) {
    if (btn) btn.textContent = T("failed");
    console.error(e);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || T("mask");
      }
    }, 1200);
  }
}

async function runVeoGenerateTest() {
  const btn = $("veoGenerateTestBtn");
  const kind = $("veoTestKind")?.value === "video" ? "video" : "image";
  const oldText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = T("testing");
  }
  try {
    const resp = await send("popup.veoGenerateTest", { kind });
    if (!resp || !resp.ok) throw new Error(resp?.error || "VEO generate test failed");
    setTimeout(refresh, 300);
  } catch (e) {
    if (btn) btn.textContent = T("failed");
    console.error(e);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || T("generateTest");
      }
    }, 1200);
  }
}

async function runGoogleAutoLogin() {
  const btn = $("googleAutoLoginBtn");
  const oldText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = T("loggingIn");
  }
  try {
    const resp = await send("popup.googleAutoLogin", {
      creds: {
        googleAccount: $("googleAccount")?.value.trim() || "",
        googlePassword: $("googlePassword")?.value || "",
        googleEfa: $("googleEfa")?.value.trim() || ""
      }
    });
    if (!resp || !resp.ok) throw new Error(resp?.error || "google auto login failed");
    if (btn) btn.textContent = resp.result?.done ? T("completed") : T("executed");
    setTimeout(refresh, 300);
  } catch (e) {
    if (btn) btn.textContent = T("failed");
    console.error(e);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || T("autoLogin");
      }
    }, 1500);
  }
}

async function refreshCaptureStatus() {
  const resp = await send("popup.networkCapture.status");
  if (!resp?.ok) return;
  const st = resp.result || {};
  const el = $("captureStatusText");
  if (!el) return;
  const count = st.count ?? st.eventCount ?? 0;
  el.className = "capture-status";
  if (st.running) {
    el.classList.add("running");
    el.textContent = T("runningCapture", { count });
  } else if (st.paused) {
    el.classList.add("paused");
    el.textContent = T("pausedCapture", { count });
  } else {
    el.textContent = count ? T("stoppedCapture", { count }) : T("notStarted");
  }
}

async function clearLogs() {
  await send("popup.clearLogs");
  await refresh();
}

async function copyText(text) {
  const t = String(text || "");
  if (!t) return;
  if (navigator?.clipboard?.writeText) return navigator.clipboard.writeText(t);
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

async function clearTransfer() {
  await send("popup.clearTransferData");
  await refresh();
}

async function copyAllTransfer() {
  const resp = await send("popup.getState");
  const lines = getTransferLines(resp?.transferData || null);
  await copyText(lines.join("\n"));
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
});
$("transferData")?.addEventListener("click", async (e) => {
  const btn = e.target?.closest?.("[data-copy-line]");
  if (!btn) return;
  const resp = await send("popup.getState");
  const lines = getTransferLines(resp?.transferData || null);
  await copyText(lines[Number(btn.dataset.copyLine)] || "");
  btn.textContent = T("copied");
  setTimeout(() => { btn.textContent = T("copy"); }, 900);
});

$("saveBtn").addEventListener("click", save);
$("refreshBtn").addEventListener("click", refresh);
$("googleAutoLoginBtn")?.addEventListener("click", runGoogleAutoLogin);
$("googleAutoLoginWatchEnabled")?.addEventListener("change", () => saveGoogleAutoLoginWatch(true).catch(console.error));
$("clearPageStorageBtn")?.addEventListener("click", clearCurrentPageLocalStorage);
$("veoGenerateTestBtn")?.addEventListener("click", runVeoGenerateTest);
$("clearBtn").addEventListener("click", clearLogs);
$("clearTransferBtn")?.addEventListener("click", clearTransfer);
$("copyAllTransferBtn")?.addEventListener("click", copyAllTransfer);
$("closePanelBtn")?.addEventListener("click", () => window.close());

// Analysis tab — capture controls
function logAnalysis(level, msg) {
  const container = $("analysisLog");
  if (!container) return;
  container.style.display = "block";
  const now = new Date().toTimeString().slice(0, 8);
  const entry = document.createElement("div");
  entry.className = `analysis-log-entry ${level}`;
  entry.innerHTML = `<span class="al-ts">${now}</span> <span class="al-lvl">[${level}]</span> ${esc(msg)}`;
  container.prepend(entry);
  // keep at most 60 entries
  while (container.children.length > 60) container.removeChild(container.lastChild);
}

async function captureAction(action) {
  logAnalysis("info", "send " + action + "...");
  try {
    const payload = {};
    if (action === "start") {
      const targetTab = await getActiveHttpTab();
      if (!targetTab || !targetTab.id) throw new Error("No current http/https target page");
      payload.tabId = targetTab.id;
      await saveAnalysisTargetTab(targetTab).catch(() => {});
      renderTargetPageInfo(targetTab, "Capture target");
    }
    const resp = await send("popup.networkCapture." + action, payload);
    logAnalysis(resp?.ok ? "ok" : "error", resp?.ok ? JSON.stringify(resp) : (resp?.error || JSON.stringify(resp)));
    if (resp?.ok) {
      refreshCaptureStatus().catch(() => {});
      refreshTargetPageInfo().catch(() => {});
    }
  } catch (e) {
    logAnalysis("error", String(e));
  }
}
$("captureToggleBtn")?.addEventListener("click", async () => {
  const resp = await send("popup.networkCapture.status");
  const st = resp?.result || {};
  if (!st.running && !st.paused) {
    await captureAction("start");
  } else if (st.paused) {
    await captureAction("resume");
  } else {
    await captureAction("pause");
  }
  await refreshCaptureStatus();
  await updateToggleBtn();
});
$("captureStopBtn")?.addEventListener("click", async () => {
  await captureAction("stop");
  await refreshCaptureStatus();
  await updateToggleBtn();
});
$("captureClearBtn")?.addEventListener("click", async () => {
  await clearNetworkLogList();
});
$("captureRefreshBtn")?.addEventListener("click", async () => {
  const btn = $("captureRefreshBtn");
  const oldText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = T("refreshing");
  }
  try {
    await refreshCapturePreview();
    await refreshCaptureStatus();
    await updateToggleBtn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || T("refresh");
    }
  }
});
$("openAnalysisBtn")?.addEventListener("click", () => {
  openAnalysisWindow().catch(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("analysis.html") });
  });
});

async function updateToggleBtn() {
  const resp = await send("popup.networkCapture.status");
  const st = resp?.result || {};
  const btn = $("captureToggleBtn");
  if (!btn) return;
  if (st.paused) btn.textContent = T("resume");
  else if (st.running) btn.textContent = T("pause");
  else btn.textContent = T("start");
}

refresh();
window.addEventListener("fpb-language-changed", () => {
  refresh().catch(() => {});
  refreshTargetPageInfo().catch(() => {});
  refreshCaptureStatus().catch(() => {});
  updateToggleBtn().catch(() => {});
  refreshCapturePreview().catch(() => {});
});
setInterval(refresh, 2000);

// Real-time capture count update when analysis panel is active
setInterval(async () => {
  const analysisPanel = $("analysisPanel");
  if (analysisPanel?.classList.contains("active")) {
    await refreshCaptureStatus().catch(() => {});
    await updateToggleBtn().catch(() => {});
    await refreshCapturePreview().catch(() => {});
    await refreshTargetPageInfo().catch(() => {});
  }
}, 1000);
