(() => {
  const LANGUAGE_STORAGE_KEY = "fpb_language";
  const LANGUAGE_OPTIONS = [
    { value: "auto", label: "Auto" },
    { value: "zh_CN", label: "中文" },
    { value: "en", label: "English" }
  ];
  let activeLanguage = "auto";
  let activeMessages = null;

  const fallbackMessages = {
    extName: "FPBrowser2API Task Executor",
    extDescription: "Execute VEO/Dreamina tasks from inside the fingerprint browser.",
    analysisTitle: "Network Analysis & AI Agent",
    targetPage: "Target Page",
    notBound: "Not bound",
    notStarted: "Not started",
    start: "Start",
    stop: "Stop",
    pause: "Pause",
    resume: "Resume",
    refresh: "Refresh",
    refreshing: "Refreshing",
    clear: "Clear",
    clearChat: "Clear Chat",
    resetTestConfig: "Reset Params",
    editParams: "Edit Params",
    noRequests: "No request records",
    summary: "Summary",
    callStack: "Call Stack",
    selectRequestHint: "Select a request on the left to view details",
    aiAgent: "AI Agent",
    apiKeyPlaceholder: "API Key (optional when using Bridge Token)",
    toggleApiKeyTitle: "Show/hide API Key",
    applyKeyTitle: "Open NewToken to request an API key",
    applyKey: "Get key",
    loadModels: "-- Click to load models --",
    customModelId: "Custom model ID",
    save: "Save",
    saved: "Saved",
    saveFailed: "Save failed",
    taskGoal: "Task Goal",
    cleanupLogs: "CleanIrrelevantRequests",
    analyzeAll: "AnalyzeAllRequests",
    analyzeToken: "AnalyzeTokenSource",
    generateTestCode: "GenerateTestCode",
    test: "Test",
    editPromptTitle: "Edit Prompt",
    editTestCodeTitle: "Edit test code",
    referenceImageUrl: "Reference image URL",
    testPrompt: "Test prompt",
    testConfigJsonPlaceholder: "JSON config passed to runGeneratedTest(config). Add or edit any fields you need.",
    referencedNetwork: "Referenced Network",
    uploadImageTitle: "Upload image",
    chatInputPlaceholder: "Enter analysis instructions, e.g. analyze token generation logic...\nShift+Enter for newline, Enter to send",
    send: "Send",
    close: "Close",
    resetDefault: "Reset Default",
    cancel: "Cancel",
    myDrafts: "My Scripts",
    chooseMyScript: "Choose existing script",
    fetch: "Fetch",
    new: "New Draft",
    saveDraft: "Save Draft",
    scriptSquare: "Script Square",
    openScriptSquare: "Open Script Square",
    scriptId: "Script ID",
    loadToTestBox: "Import to Editor",
    testCode: "Test Code",
    generateTestCodePrompt: "Generate Test Code Prompt",
    cleanupPrompt: "Clean Irrelevant Requests Prompt",
    analyzeTokenPrompt: "Analyze Token Source Prompt",
    analyzeAllPrompt: "Analyze All Requests Prompt",
    editRequest: "Edit Request",
    editResponse: "Edit Response",
    loadingModels: "Loading...",
    custom: "Custom...",
    addCustomTaskGoal: "+ Add custom...",
    customTaskGoalPrompt: "Enter custom task goal",
    operationFailed: "Operation failed",
    runningCapture: "Capturing ({count} items)",
    pausedCapture: "Paused ({count} items)",
    stoppedCapture: "Stopped ({count} items)",
    deleteLogFailed: "Failed to delete {count} Network Log item(s): {seqs}",
    noCallStack: "No call stack. It may be non-fetch/XHR or restricted by the page.",
    toolUse: "Tool use",
    you: "You",
    toolResult: "Tool Result",
    system: "System",
    deleteThis: "Delete",
    deleteBelow: "Delete Below",
    deleteThisTitle: "Delete this message",
    deleteBelowTitle: "Delete this message and all messages below",
    stoppingAi: "Requested to stop the current AI analysis",
    targetUnavailable: "Target page unavailable",
    unnamedPage: "Untitled page",
    targetClosed: "Target page closed",
    targetClosedTip: "Target page closed. Return to the business page and open the entry again.",
    currentPage: "Current page",
    captureTarget: "Capture target",
    analysisTarget: "Analysis target",
    noTargetPage: "No target page",
    bound: "Bound",
    popupClose: "Close",
    loading: "Loading...",
    connectedRegistered: "Connected and registered",
    wsConnectedWaiting: "WebSocket connected, waiting for registration",
    disconnected: "Disconnected: {state}",
    none: "None",
    source: "Source",
    received: "Received",
    noReceivedData: "No received data",
    copy: "Copy",
    copied: "Copied",
    noLogs: "No logs",
    countItems: "{count} items",
    capture: "Capture",
    viewLogsAndAnalyze: "View Logs & AI Analysis",
    networkRequestList: "Network Request List",
    googleAccount: "Google Account",
    password: "Password",
    autoLoginKeepAlive: "Keep Login",
    autoLoginHint: "Automatically log in when a Google login page is detected",
    mediaArchive: "Images/Videos",
    autoCleanup: "Auto cleanup",
    saveReconnect: "Save & Reconnect",
    autoLogin: "Auto Login",
    tasksLogs: "Tasks / Logs",
    clearLogs: "Clear Logs",
    veoTest: "VEO Test",
    veoTestType: "VEO test type",
    image: "Image",
    video: "Video",
    generateTest: "Generate Test",
    tokenPlaceholder: "Request fpbrowser-use model token from the official site",
    efaPlaceholder: "2FA Secret (optional)",
    saveHint: "After saving, visit backend /api/extension/clients to view registration status.",
    transferHint: "Each line can be copied separately. Links are clickable and open in a new page. Data is cached in browser local storage.",
    openExternalLinks: "External links",
    masking: "Masking...",
    mask: "Mask",
    masked: "Masked",
    failed: "Failed",
    testing: "Testing...",
    loggingIn: "Logging in...",
    completed: "Completed",
    executed: "Executed",
    generateTestCodeFirst: "Please click Generate Test Code first.",
    legacySyntaxWarning: "The cached test code contains ?. or ??, which older JS engines may not parse. Regenerate the test code before testing.",
    generatingTestCode: "Generating test code from conversation history...",
    generatedTestCodeCached: "Generated and cached test code:\n\n```javascript\n{code}\n```",
    generateTestCodeFailed: "Failed to generate test code: {error}",
    executingTestCode: "Executing test code on target tab {tabId} via Debugger...",
    testExecutionFailed: "Test execution failed: {error}",
    testResult: "Test Result",
    targetInjectableNotFound: "Could not find an injectable target tab",
    requestFailed: "Request failed: {error}",
    stopReason: "Stop reason: {reason}",
    exception: "Exception: {error}",
    savePromptFailed: "Failed to save Prompt: {error}",
    saveTaskGoalFailed: "Failed to save task goal: {error}"
  };

  function format(message, values) {
    return String(message || "").replace(/\{(\w+)\}/g, (_, key) => {
      return values && values[key] != null ? String(values[key]) : "";
    });
  }

  function normalizeLanguage(value) {
    return value === "zh_CN" || value === "en" ? value : "auto";
  }

  function resolveLanguage(value) {
    const normalized = normalizeLanguage(value);
    if (normalized !== "auto") return normalized;
    const browserLanguage = String(navigator.language || (navigator.languages && navigator.languages[0]) || "").toLowerCase();
    return browserLanguage.startsWith("zh") ? "zh_CN" : "en";
  }

  async function loadLocaleMessages(locale) {
    locale = resolveLanguage(locale);
    if (!locale) return null;
    try {
      const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      return Object.fromEntries(Object.entries(raw || {}).map(([key, value]) => [key, String(value && value.message || "")]));
    } catch (_) {
      return null;
    }
  }

  function t(key, values) {
    let message = activeMessages && activeMessages[key] || "";
    try {
      if (!message) message = typeof chrome !== "undefined" && chrome.i18n ? chrome.i18n.getMessage(key) : "";
    } catch (_) {}
    return format(message || fallbackMessages[key] || key, values);
  }

  function createLanguageSwitch(id) {
    const select = document.createElement("select");
    select.id = id;
    select.className = "fpb-language-switch";
    select.title = "Language";
    LANGUAGE_OPTIONS.forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.value;
      opt.textContent = item.label;
      select.appendChild(opt);
    });
    select.value = activeLanguage;
    select.addEventListener("change", () => setLanguage(select.value));
    return select;
  }

  function ensureLanguageSwitches() {
    if (!document.getElementById("fpbAnalysisLanguageSwitch")) {
      const toolbar = document.getElementById("toolbar");
      const targetInfo = document.getElementById("targetPageInfo");
      if (toolbar && targetInfo) targetInfo.insertAdjacentElement("afterend", createLanguageSwitch("fpbAnalysisLanguageSwitch"));
    }
    if (!document.getElementById("fpbPopupLanguageSwitch")) {
      const topbar = document.querySelector(".topbar");
      const closeBtn = document.getElementById("closePanelBtn");
      if (topbar) {
        const select = createLanguageSwitch("fpbPopupLanguageSwitch");
        if (closeBtn) topbar.insertBefore(select, closeBtn);
        else topbar.appendChild(select);
      }
    }
    document.querySelectorAll(".fpb-language-switch").forEach(select => {
      select.value = activeLanguage;
    });
  }

  function applyI18n(root = document) {
    ensureLanguageSwitches();
    const textById = {
      targetPageTitle: "notBound",
      captureStatusText: "notStarted",
      captureToggleBtn: "start",
      captureStopBtn: "stop",
      refreshLogBtn: "refresh",
      tbClearBtn: "clear",
      logEmpty: "noRequests",
      editLogBtn: "editRequest",
      saveAnalysisConfigBtn: "save",
      cleanupLogsBtn: "cleanupLogs",
      analyzeAllBtn: "analyzeAll",
      analyzeTokenBtn: "analyzeToken",
      generateTestCodeBtn: "generateTestCode",
      runGeneratedTestBtn: "test",
      clearNetworkRefsBtn: "clear",
      sendBtn: "send",
      clearChatBtn: "clearChat",
      resetTestConfigBtn: "resetTestConfig",
      openScriptSquareBtn: "openScriptSquare",
      promptCloseBtn: "close",
      newScriptDraftBtn: "new",
      saveScriptDraftBtn: "saveDraft",
      loadSquareScriptBtn: "loadToTestBox",
      promptResetBtn: "resetDefault",
      promptSaveBtn: "save",
      closePanelBtn: "popupClose",
      clearPageStorageBtn: "mask",
      saveBtn: "saveReconnect",
      refreshBtn: "refresh",
      googleAutoLoginBtn: "autoLogin",
      veoGenerateTestBtn: "generateTest",
      clearBtn: "clearLogs",
      copyAllTransferBtn: "copy",
      clearTransferBtn: "clear",
      openAnalysisBtn: "viewLogsAndAnalyze",
      captureRefreshBtn: "refresh",
      captureClearBtn: "clear"
    };
    const tabTextById = {
      tabDebugBtn: "tabTask",
      tabTransferBtn: "tabDataTransfer",
      tabAnalysisBtn: "tabWebAgent"
    };
    const placeholderById = {
      analysisApiKey: "apiKeyPlaceholder",
      analysisModelCustom: "customModelId",
      testConfigJson: "testConfigJsonPlaceholder",
      chatInput: "chatInputPlaceholder",
      squareScriptIdInput: "scriptId",
      bridgeToken: "tokenPlaceholder",
      googleEfa: "efaPlaceholder"
    };
    const titleById = {
      toggleApiKeyBtn: "toggleApiKeyTitle",
      applyKeyBtn: "applyKeyTitle",
      editCleanupPromptBtn: "editPromptTitle",
      editAllPromptBtn: "editPromptTitle",
      editTokenPromptBtn: "editPromptTitle",
      editTestCodePromptBtn: "editPromptTitle",
      editGeneratedCodeBtn: "editTestCodeTitle",
      editTestConfigBtn: "editParams",
      attachImageBtn: "uploadImageTitle"
    };
    const ariaById = {
      veoTestKind: "veoTestType"
    };
    Object.entries(textById).forEach(([id, key]) => {
      const el = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      if (el) el.textContent = t(key);
    });
    Object.entries(tabTextById).forEach(([id, key]) => {
      const el = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      if (el) el.textContent = t(key);
    });
    Object.entries(placeholderById).forEach(([id, key]) => {
      const el = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      if (el) el.placeholder = t(key);
    });
    Object.entries(titleById).forEach(([id, key]) => {
      const el = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      if (el) el.title = t(key);
    });
    Object.entries(ariaById).forEach(([id, key]) => {
      const el = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      if (el) el.setAttribute("aria-label", t(key));
    });
    const setFirstOption = (id, key) => {
      const el = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      if (el && el.options && el.options[0]) el.options[0].textContent = t(key);
    };
    setFirstOption("analysisModelSelect", "loadModels");
    setFirstOption("myScriptSelect", "chooseMyScript");
    const imageOpt = document.querySelector('#veoTestKind option[value="image"]');
    const videoOpt = document.querySelector('#veoTestKind option[value="video"]');
    if (imageOpt) imageOpt.textContent = t("image");
    if (videoOpt) videoOpt.textContent = t("video");
    const h1 = document.querySelector("#toolbar h1");
    if (h1) h1.textContent = t("analysisTitle");
    const targetLabel = document.querySelector("#targetPageInfo .target-label");
    if (targetLabel) targetLabel.textContent = t("targetPage");
    const detailTabs = document.querySelectorAll(".detail-tab");
    detailTabs.forEach(btn => {
      if (btn.dataset.tab === "summary") btn.textContent = t("summary");
      if (btn.dataset.tab === "stack") btn.textContent = t("callStack");
    });
    const detailEmpty = document.getElementById("detailEmpty");
    if (detailEmpty) detailEmpty.textContent = t("selectRequestHint");
    const chatTitle = document.querySelector("#chatHeader .chat-title");
    if (chatTitle) chatTitle.textContent = t("aiAgent");
    const taskGoalLabel = document.querySelector('#taskGoalWrap label[for="taskGoalSelect"]');
    if (taskGoalLabel) taskGoalLabel.textContent = t("taskGoal");
    const refLabel = document.querySelector("#networkReferenceBar .ref-label");
    if (refLabel) refLabel.textContent = t("referencedNetwork");
    const scriptHeadings = document.querySelectorAll(".script-manager-section h3");
    if (scriptHeadings[0]) scriptHeadings[0].textContent = t("myDrafts");
    if (scriptHeadings[1]) scriptHeadings[1].textContent = t("scriptSquare");
    const popupLabels = [
      ["googleAccount", "googleAccount"],
      ["googlePassword", "password"],
      ["googleAutoLoginWatchEnabled", "autoLoginKeepAlive"],
      ["veoArchiveEnabled", "mediaArchive"],
      ["veoTestKind", "veoTest"]
    ];
    popupLabels.forEach(([forId, key]) => {
      const input = document.getElementById(forId);
      const row = input && input.closest(".row");
      const label = row && row.querySelector("label");
      if (label) label.textContent = t(key);
    });
    const autoLoginHint = document.querySelector("#googleAutoLoginWatchEnabled + .hint");
    if (autoLoginHint) autoLoginHint.textContent = t("autoLoginHint");
    const archiveHint = document.querySelector("#veoArchiveEnabled + .hint");
    if (archiveHint) archiveHint.textContent = t("autoCleanup");
    const debugLinks = document.querySelector(".external-links");
    if (debugLinks) debugLinks.setAttribute("aria-label", t("openExternalLinks"));
    const taskLogsTitle = document.querySelector("#debugPanel .card:nth-of-type(3) b");
    if (taskLogsTitle) taskLogsTitle.textContent = t("tasksLogs");
    const analysisTitle = document.querySelector("#analysisPanel .card b");
    if (analysisTitle) analysisTitle.textContent = t("capture");
    const capturePreviewTitle = document.querySelector(".capture-preview-title b");
    if (capturePreviewTitle) capturePreviewTitle.textContent = t("networkRequestList");
    const transferHint = document.querySelector("#transferPanel .hint");
    if (transferHint) transferHint.textContent = t("transferHint");
    const saveHint = document.querySelector("#debugPanel .card .hint:last-child");
    if (saveHint) saveHint.textContent = t("saveHint");
    root.querySelectorAll("[data-i18n]").forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    root.querySelectorAll("[data-i18n-title]").forEach(el => {
      el.title = t(el.dataset.i18nTitle);
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach(el => {
      el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
    });
    const titleKey = document.documentElement && document.documentElement.dataset.i18nTitle;
    if (titleKey) document.title = t(titleKey);
  }

  async function setLanguage(value) {
    activeLanguage = normalizeLanguage(value);
    activeMessages = await loadLocaleMessages(activeLanguage);
    try { await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: activeLanguage }); } catch (_) {}
    applyI18n();
    window.dispatchEvent(new CustomEvent("fpb-language-changed", { detail: { language: activeLanguage } }));
  }

  async function initLanguage() {
    try {
      const got = await chrome.storage.local.get([LANGUAGE_STORAGE_KEY]);
      activeLanguage = normalizeLanguage(got[LANGUAGE_STORAGE_KEY]);
      activeMessages = await loadLocaleMessages(activeLanguage);
      applyI18n();
      window.dispatchEvent(new CustomEvent("fpb-language-changed", { detail: { language: activeLanguage } }));
    } catch (_) {}
  }

  function startInitLanguage() {
    const promise = initLanguage();
    window.__fpbI18nReady = promise;
    return promise;
  }

  window.__fpbT = t;
  window.__fpbApplyI18n = applyI18n;
  window.__fpbSetLanguage = setLanguage;
  window.__fpbGetLanguage = () => activeLanguage;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      applyI18n();
      startInitLanguage();
    });
  } else {
    applyI18n();
    startInitLanguage();
  }
})();
