// analysis.js 鈥?network log viewer + multi-turn AI agent

let activeModel = "claude-sonnet-4-6";

const PRESET_MODELS = [
  { id: "claude-opus-4-8",           label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6 (Default)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-fable-5",            label: "Claude Fable 5" },
  { id: "__custom__",                label: "Custom..." }
];
const DEFAULT_TASK_GOALS = ["文生图", "图生图", "文生视频", "图生视频", "大模型对话", "数据爬取"];
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;
const POLL_INTERVAL = 1500;
const FRAGMENT_BYTES = 4096;

const DEFAULT_AGENT_PROMPT = `你是浏览器 Network Log 分析智能体。请基于提供的抓包数据识别关键 API、鉴权 token/sign/cookie/nonce/timestamp 来源、请求参数含义，并在需要时生成可运行的 Chrome Extension content_script.js。优先使用消息中已附带的 Network Log，只有缺少关键细节时才调用工具补充。`;

const TOKEN_ANALYSIS_PROMPT = `你是浏览器 JS 逆向专家。请分析选中请求中的 token/鉴权字段位置、格式、来源、调用栈线索，并给出可在 Chrome Extension MAIN world 中运行的 hook 或复用方案。优先说明 token 是服务端签发、页面缓存、响应写入还是请求前读取。`;

const CLEANUP_LOGS_PROMPT = `你是 Network Log 清理助手。请判断哪些请求与目标业务流程/API 逆向分析无关，可以删除静态资源、埋点、遥测、广告、重复心跳和明显无关第三方请求；必须保留认证、核心业务 API、GraphQL/gRPC/JSON、上传下载、带 body、带调用栈、token/sign/cookie/nonce/timestamp 相关请求。不确定时保留。

只输出 JSON，不要 Markdown。格式：
{"delete_seq":[1,2,3],"keep_seq":[4,5],"reason":"一句话说明清理依据"}`;

const TEST_CODE_PROMPT = `你是浏览器插件自动化测试代码生成专家。请基于历史对话、抓包分析结论、选中请求详情、当前 Network Log 摘要和 Test Config JSON，生成可注入目标网站 MAIN world 执行的 JavaScript 测试代码。必须提供 async function runGeneratedTest(config) 入口，所有外部参数都必须从单一 config 对象读取，不要额外定义第二套参数来源。生成代码顶部必须包含一段注释，逐项列出当前 config JSON 中的参数；即使某些参数暂时用不到，也要在注释中说明它们可用。返回可结构化克隆的普通 JSON 数据，不依赖 import，不使用扩展页 DOM。只输出 JavaScript 代码块。`;

const DEFAULT_TEST_CONFIG = {
  prompt: "Hello from FPBrowser2API",
  referenceImageUrl: "https://example.com/reference.png",
  model: "demo-model",
  count: 1,
  dryRun: true,
  metadata: {
    scene: "default test config",
    source: "analysis.html"
  }
};

const DEFAULT_GENERATED_TEST_CODE = `async function runGeneratedTest(config) {
  // This code runs in the target page MAIN world.
  // Config parameters available:
  // - config.prompt: text prompt or instruction.
  // - config.referenceImageUrl: optional reference image URL.
  // - config.model: optional model name.
  // - config.count: optional requested count.
  // - config.dryRun: when true, do not perform destructive actions.
  // - config.metadata: free-form metadata object.
  // Some parameters may be unused by this simple example, but keep this comment updated.
  const prompt = String(config.prompt || "");
  const referenceImageUrl = String(config.referenceImageUrl || "");
  const count = Number(config.count || 1);
  const dryRun = config.dryRun !== false;

  // Simple "hello world" example. Replace this block with real page/API logic.
  const pageInfo = {
    title: document.title,
    url: location.href,
    readyState: document.readyState
  };

  return {
    ok: true,
    message: "Hello from runGeneratedTest(config)",
    dryRun,
    input: {
      prompt,
      referenceImageUrl,
      count,
      model: config.model || "",
      metadata: config.metadata || {}
    },
    page: pageInfo,
    nextStep: "Edit this function to call the target page API or interact with page state."
  };
}`;

const PROMPT_STORAGE_KEYS = {
  all: "analysis_prompt_all",
  token: "analysis_prompt_token",
  cleanup: "analysis_prompt_cleanup",
  testCode: "analysis_prompt_test_code"
};

const AGENT_SYSTEM_PROMPT = `You are a continuous browser/network analysis agent inside this extension.
Do not behave like a single-turn Q&A bot. Work step by step with tools, inspect the captured requests and the live target web page when needed, generate runnable test code when the user asks for verification or automation, run that test with the available tool, then use the result to continue debugging or refining the code.
You can analyze both network logs and the target page opened by network capture. Prefer get_target_page_snapshot for page structure/state, and use evaluate_target_page for focused diagnostics or safe page-local JavaScript.
If the user asks to clean/prune/delete/remove irrelevant network logs, call cleanup_network_logs instead of only explaining what to do. The cleanup tool performs its own multi-batch AI review and never sends more than 100 records per batch.
When the user asks to generate test code, call generate_test_code so the code follows the current JSON config contract and is saved as a draft when possible. If you manually revise code, save it with save_generated_test_code before calling run_generated_test. If a test fails and the result gives enough information, revise the saved code and run it again. Stop after a clear success, a clear explanation of the remaining blocker, or when further action would be unsafe.`;

const TEST_STORAGE_KEYS = {
  generatedCode: "analysis_generated_test_code",
  configJson: "analysis_test_config_json",
  referenceUrl: "analysis_test_reference_url",
  prompt: "analysis_test_prompt",
  scriptEditorState: "analysis_script_editor_state"
};

const TASK_GOAL_STORAGE_KEYS = {
  selected: "analysis_task_goal_selected",
  custom: "analysis_task_goal_custom"
};

const CHAT_HISTORY_STORAGE_KEY = "analysis_chat_history";
const NETWORK_LOG_STORAGE_KEY = "analysis_network_log_cache";
const CHAT_PANE_HEIGHT_STORAGE_KEY = "analysis_chat_pane_height";
const MAX_CACHED_NETWORK_EVENTS = 3000;
const MAX_PENDING_IMAGES = 5;
const IMAGE_MAX_EDGE = 1568;
const IMAGE_JPEG_QUALITY = 0.86;

// 鈹€鈹€ state 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
let events = [];          // all captured events
let filteredEvents = [];  // after filter
let selectedIdx = null;   // index into filteredEvents
let activeDetailTab = "summary";
let pollTimer = null;
let sinceSeq = 0;
let chatHistory = [];     // Anthropic messages array
let agentRunning = false;
let agentStopRequested = false;
let activeAiRequestId = "";
let filterText = "";
let deletedSeqs = new Set();
let analysisAllPrompt = DEFAULT_AGENT_PROMPT;
let tokenAnalysisPrompt = TOKEN_ANALYSIS_PROMPT;
let cleanupLogsPrompt = CLEANUP_LOGS_PROMPT;
let testCodePrompt = TEST_CODE_PROMPT;
let generatedTestCode = DEFAULT_GENERATED_TEST_CODE;
let taskGoals = DEFAULT_TASK_GOALS.slice();
let activeTaskGoal = DEFAULT_TASK_GOALS[0];
let pendingImages = [];
let referencedSeqs = new Set();
let activeScriptDraftId = 0;
let activeScriptSource = "mine";
let activeSquareScriptId = 0;
let scriptEditorRestoring = false;
let promptFindState = { query: "", index: -1, matches: [] };

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes[ANALYSIS_TARGET_TAB_STORAGE_KEY]) return;
  const tabId = Number(changes[ANALYSIS_TARGET_TAB_STORAGE_KEY].newValue || 0) || 0;
  setActiveTargetTabId(tabId, { persist: false }).catch(() => {});
});

// 鈹€鈹€ helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function $(id) { return document.getElementById(id); }
function T(key, values) { return window.__fpbT ? window.__fpbT(key, values) : key; }

async function waitForI18nReady() {
  try {
    if (window.__fpbI18nReady && typeof window.__fpbI18nReady.then === "function") {
      await window.__fpbI18nReady;
    }
  } catch (_) {}
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function getInitialTargetTabId() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    return Number(params.get("targetTabId") || 0) || 0;
  } catch (_) {
    return 0;
  }
}

const ANALYSIS_TARGET_TAB_STORAGE_KEY = "analysis_target_tab_id";
const ANALYSIS_TARGET_UPDATED_STORAGE_KEY = "analysis_target_updated_at";
let activeTargetTabId = getInitialTargetTabId();

function nextAiRequestId() {
  return `analysis-ai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function resizeChatInput(input = $("chatInput")) {
  if (!input) return;
  input.style.height = "auto";
  const style = window.getComputedStyle(input);
  const maxHeight = parseFloat(style.maxHeight) || 180;
  const borderY = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  const nextHeight = Math.min(input.scrollHeight + borderY, maxHeight);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight + borderY > maxHeight ? "auto" : "hidden";
}

function setTargetPageInfo(title, url, tooltip) {
  const titleEl = $("targetPageTitle");
  const urlEl = $("targetPageUrl");
  const wrap = $("targetPageInfo");
  if (titleEl) titleEl.textContent = title || T("notBound");
  if (urlEl) urlEl.textContent = url || "";
  if (wrap) wrap.title = tooltip || [title, url].filter(Boolean).join("\n");
}

async function setActiveTargetTabId(tabId, options = {}) {
  const nextTabId = Number(tabId || 0) || 0;
  activeTargetTabId = nextTabId;
  if (options.persist !== false) {
    await chrome.storage.local.set({
      [ANALYSIS_TARGET_TAB_STORAGE_KEY]: activeTargetTabId,
      [ANALYSIS_TARGET_UPDATED_STORAGE_KEY]: Date.now()
    }).catch(() => {});
  }
  await refreshTargetPageInfo();
}

async function refreshTargetPageInfo() {
  if (!activeTargetTabId) {
    setTargetPageInfo(T("notBound"), "", T("viewLogsAndAnalyze"));
    return;
  }
  try {
    const tab = await chrome.tabs.get(activeTargetTabId);
    const url = String(tab && tab.url || "");
    if (!tab || !isInjectableTargetUrl(url)) {
      setTargetPageInfo(T("targetUnavailable"), url, url);
      return;
    }
    setTargetPageInfo(tab.title || T("unnamedPage"), url, `${tab.title || T("unnamedPage")}\n${url}`);
  } catch (_) {
    setTargetPageInfo(T("targetClosed"), "", T("targetClosedTip"));
  }
}

async function sendAiChat(payload) {
  if (agentStopRequested) return { ok: false, stopped: true, error: "已停止" };
  const requestId = nextAiRequestId();
  activeAiRequestId = requestId;
  try {
    const resp = await send("popup.analysis.aiChat", { ...payload, requestId });
    if (agentStopRequested) return { ok: false, stopped: true, error: "已停止" };
    return resp;
  } finally {
    if (activeAiRequestId === requestId) activeAiRequestId = "";
  }
}

function stopAgentRun() {
  if (!agentRunning) return;
  if (agentStopRequested) return;
  agentStopRequested = true;
  const requestId = activeAiRequestId;
  if (requestId) {
    send("popup.analysis.cancelAiChat", { requestId }).catch(() => {});
  }
  addSystemContext(T("stoppingAi"));
}

function networkEventKey(e) {
  if (!e || typeof e !== "object") return "";
  if (e.id) return `id:${e.id}`;
  return [
    e.seq || "",
    e.tab_id || "",
    e.method || "",
    e.url || "",
    e.started_at || e.start_epoch_ms || ""
  ].join("|");
}

function mergeNetworkEvents(current, incoming) {
  const out = [];
  const seen = new Set();
  for (const e of [...(current || []), ...(incoming || [])]) {
    if (e && deletedSeqs.has(Number(e.seq))) continue;
    const key = networkEventKey(e);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.slice(Math.max(0, out.length - MAX_CACHED_NETWORK_EVENTS));
}

function persistNetworkLogCache() {
  const cachedEvents = events.slice(Math.max(0, events.length - MAX_CACHED_NETWORK_EVENTS));
  chrome.storage.local.set({
    [NETWORK_LOG_STORAGE_KEY]: {
      events: cachedEvents,
      updated_at: new Date().toISOString()
    }
  }).catch(() => {});
}

async function loadNetworkLogCache() {
  try {
    const got = await chrome.storage.local.get([NETWORK_LOG_STORAGE_KEY]);
    const cached = got[NETWORK_LOG_STORAGE_KEY];
    const cachedEvents = cached && Array.isArray(cached.events) ? cached.events : [];
    if (!cachedEvents.length) return;
    events = mergeNetworkEvents(events, cachedEvents);
    applyFilter();
    renderLogList();
    renderDetail();
  } catch (_) {}
}

async function clearNetworkLogCache() {
  try { await chrome.storage.local.remove([NETWORK_LOG_STORAGE_KEY]); } catch (_) {}
}

async function restoreChatPaneHeight() {
  const chatPane = $("chatPane");
  const rightPane = $("rightPane");
  if (!chatPane || !rightPane) return;
  try {
    const got = await chrome.storage.local.get([CHAT_PANE_HEIGHT_STORAGE_KEY]);
    const raw = Number(got[CHAT_PANE_HEIGHT_STORAGE_KEY]);
    if (!Number.isFinite(raw) || raw <= 0) return;
    const max = Math.max(120, rightPane.offsetHeight - 85);
    const height = Math.min(max, Math.max(120, raw));
    chatPane.style.height = height + "px";
  } catch (_) {}
}

function persistChatPaneHeight(height) {
  const value = Math.round(Number(height || 0));
  if (!Number.isFinite(value) || value <= 0) return;
  chrome.storage.local.set({ [CHAT_PANE_HEIGHT_STORAGE_KEY]: value }).catch(() => {});
}

async function loadPromptCache() {
  try {
    const got = await chrome.storage.local.get([
      PROMPT_STORAGE_KEYS.all,
      PROMPT_STORAGE_KEYS.token,
      PROMPT_STORAGE_KEYS.cleanup,
      PROMPT_STORAGE_KEYS.testCode,
      TEST_STORAGE_KEYS.generatedCode,
      TEST_STORAGE_KEYS.configJson,
      TEST_STORAGE_KEYS.referenceUrl,
      TEST_STORAGE_KEYS.prompt,
      TASK_GOAL_STORAGE_KEYS.selected,
      TASK_GOAL_STORAGE_KEYS.custom,
      CHAT_HISTORY_STORAGE_KEY
    ]);
    const allPrompt = got[PROMPT_STORAGE_KEYS.all];
    const tokenPrompt = got[PROMPT_STORAGE_KEYS.token];
    const cleanupPrompt = got[PROMPT_STORAGE_KEYS.cleanup];
    const testPrompt = got[PROMPT_STORAGE_KEYS.testCode];
    if (typeof allPrompt === "string" && allPrompt.trim()) analysisAllPrompt = allPrompt;
    if (typeof tokenPrompt === "string" && tokenPrompt.trim()) tokenAnalysisPrompt = tokenPrompt;
    if (typeof cleanupPrompt === "string" && cleanupPrompt.trim()) cleanupLogsPrompt = cleanupPrompt;
    if (typeof testPrompt === "string" && testPrompt.trim()) testCodePrompt = testPrompt;
    if (typeof got[TEST_STORAGE_KEYS.generatedCode] === "string" && got[TEST_STORAGE_KEYS.generatedCode].trim()) {
      generatedTestCode = got[TEST_STORAGE_KEYS.generatedCode];
    }
    const customGoals = Array.isArray(got[TASK_GOAL_STORAGE_KEYS.custom]) ? got[TASK_GOAL_STORAGE_KEYS.custom] : [];
    taskGoals = DEFAULT_TASK_GOALS.concat(customGoals.filter(x => typeof x === "string" && x.trim()));
    const savedGoal = typeof got[TASK_GOAL_STORAGE_KEYS.selected] === "string" ? got[TASK_GOAL_STORAGE_KEYS.selected].trim() : "";
    if (savedGoal) {
      activeTaskGoal = savedGoal;
      if (!taskGoals.includes(savedGoal)) taskGoals.push(savedGoal);
    }
    const configInput = $("testConfigJson");
    if (configInput) {
      const savedConfigJson = typeof got[TEST_STORAGE_KEYS.configJson] === "string" ? got[TEST_STORAGE_KEYS.configJson].trim() : "";
      if (savedConfigJson) {
        configInput.value = savedConfigJson;
      } else {
        const migrated = {
          ...DEFAULT_TEST_CONFIG,
          referenceImageUrl: typeof got[TEST_STORAGE_KEYS.referenceUrl] === "string" ? got[TEST_STORAGE_KEYS.referenceUrl] : DEFAULT_TEST_CONFIG.referenceImageUrl,
          prompt: typeof got[TEST_STORAGE_KEYS.prompt] === "string" ? got[TEST_STORAGE_KEYS.prompt] : DEFAULT_TEST_CONFIG.prompt
        };
        configInput.value = jsonText(migrated);
      }
    }
    if (Array.isArray(got[CHAT_HISTORY_STORAGE_KEY])) {
      chatHistory = sanitizeMessagesForAnthropic(got[CHAT_HISTORY_STORAGE_KEY].filter(isValidChatMessage)).slice(-80);
      renderChatHistory();
    }
  } catch (_) {}
  renderTaskGoalSelect();
}

async function savePromptCache(kind, value) {
  const key = PROMPT_STORAGE_KEYS[kind];
  if (!key) return;
  const patch = {};
  patch[key] = String(value || "");
  await chrome.storage.local.set(patch);
}

function uniqueTaskGoals(list) {
  const seen = new Set();
  const out = [];
  list.forEach(item => {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  });
  return out;
}

function renderTaskGoalSelect() {
  const select = $("taskGoalSelect");
  if (!select) return;
  taskGoals = uniqueTaskGoals(taskGoals);
  select.innerHTML = "";
  taskGoals.forEach(goal => {
    const opt = document.createElement("option");
    opt.value = goal;
    opt.textContent = goal;
    select.appendChild(opt);
  });
  const addOpt = document.createElement("option");
  addOpt.value = "__add_custom__";
  addOpt.textContent = T("addCustomTaskGoal");
  select.appendChild(addOpt);
  if (!taskGoals.includes(activeTaskGoal)) activeTaskGoal = taskGoals[0] || DEFAULT_TASK_GOALS[0];
  select.value = activeTaskGoal;
}

async function saveTaskGoalState() {
  const custom = taskGoals.filter(goal => !DEFAULT_TASK_GOALS.includes(goal));
  const patch = {};
  patch[TASK_GOAL_STORAGE_KEYS.selected] = activeTaskGoal;
  patch[TASK_GOAL_STORAGE_KEYS.custom] = custom;
  await chrome.storage.local.set(patch);
}

async function addCustomTaskGoal() {
  const value = window.prompt(T("customTaskGoalPrompt"), "");
  const goal = String(value || "").trim();
  if (!goal) {
    renderTaskGoalSelect();
    return;
  }
  if (!taskGoals.includes(goal)) taskGoals.push(goal);
  activeTaskGoal = goal;
  renderTaskGoalSelect();
  await saveTaskGoalState();
}

function getTaskGoalContext() {
  const goal = String(activeTaskGoal || "").trim();
  return goal ? "\n\n当前任务目标：" + goal + "\n请围绕该任务目标筛选请求、判断关键接口、分析 token/签名逻辑，并生成匹配该任务目标的代码。" : "";
}

function withTaskGoal(promptText) {
  return String(promptText || "") + getTaskGoalContext();
}

function getPromptValue(kind) {
  if (kind === "generatedCode") return generatedTestCode;
  if (kind === "testConfig") return getTestConfigText();
  if (kind === "testCode") return testCodePrompt;
  if (kind === "cleanup") return cleanupLogsPrompt;
  return kind === "token" ? tokenAnalysisPrompt : analysisAllPrompt;
}

function getDefaultPromptValue(kind) {
  if (kind === "generatedCode") return DEFAULT_GENERATED_TEST_CODE;
  if (kind === "testConfig") return jsonText(DEFAULT_TEST_CONFIG);
  if (kind === "testCode") return TEST_CODE_PROMPT;
  if (kind === "cleanup") return CLEANUP_LOGS_PROMPT;
  return kind === "token" ? TOKEN_ANALYSIS_PROMPT : DEFAULT_AGENT_PROMPT;
}

function setPromptValue(kind, value) {
  if (kind === "generatedCode") generatedTestCode = value;
  else if (kind === "testConfig") {
    const input = $("testConfigJson");
    if (input) input.value = value;
  }
  else if (kind === "testCode") testCodePrompt = value;
  else if (kind === "cleanup") cleanupLogsPrompt = value;
  else if (kind === "token") tokenAnalysisPrompt = value;
  else analysisAllPrompt = value;
}

function getScriptApiBase() {
  const input = $("scriptApiBaseInput");
  return String((input && input.value) || "https://api.newtoken.club").replace(/\/+$/, "");
}

function getScriptApiKey() {
  const input = $("analysisApiKey");
  return String((input && input.value) || "").trim();
}

function setScriptManagerStatus(message, isError = false) {
  const el = $("scriptManagerStatus");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = isError ? "#f87171" : "#94a3b8";
}

async function requestScriptApi(path, options = {}) {
  const apiKey = getScriptApiKey();
  if (!apiKey) throw new Error("请先填写 API Key");
  const headers = Object.assign({
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey
  }, options.headers || {});
  const resp = await fetch(getScriptApiBase() + path, {
    ...options,
    headers
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.success === false) {
    throw new Error(data.message || ("HTTP " + resp.status));
  }
  return data.data;
}

function setGeneratedCodeEditorValue(code) {
  const textarea = $("promptTextarea");
  generatedTestCode = String(code || "");
  if (textarea) textarea.value = generatedTestCode;
  updatePromptLineNumbers();
}

function getGeneratedCodeEditorValue() {
  const textarea = $("promptTextarea");
  return String(textarea ? textarea.value : generatedTestCode || "");
}

async function saveGeneratedCodeLocal(code) {
  generatedTestCode = String(code || "");
  const patch = {};
  patch[TEST_STORAGE_KEYS.generatedCode] = generatedTestCode;
  await chrome.storage.local.set(patch);
}

function setPromptSaveStatus(message, isError = false) {
  const el = $("promptSaveStatus");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = isError ? "#f87171" : "#22c55e";
}

function updatePromptLineNumbers() {
  const modal = $("promptModal");
  const textarea = $("promptTextarea");
  const gutter = $("promptLineNumbers");
  if (!modal || !textarea || !gutter) return;
  if (modal.dataset.kind !== "generatedCode") {
    gutter.textContent = "";
    return;
  }
  const lineCount = Math.max(1, String(textarea.value || "").split("\n").length);
  let text = "";
  for (let i = 1; i <= lineCount; i++) text += i + (i === lineCount ? "" : "\n");
  if (gutter.dataset.lineCount !== String(lineCount)) {
    gutter.textContent = text;
    gutter.dataset.lineCount = String(lineCount);
  }
  gutter.scrollTop = textarea.scrollTop;
}

function getPromptLineForOffset(text, offset) {
  const head = String(text || "").slice(0, Math.max(0, Number(offset || 0)));
  return head.split("\n").length;
}

function scrollPromptTextareaToOffset(offset) {
  const textarea = $("promptTextarea");
  if (!textarea) return;
  const style = window.getComputedStyle(textarea);
  const lineHeight = parseFloat(style.lineHeight) || ((parseFloat(style.fontSize) || 12) * 1.5);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const line = getPromptLineForOffset(textarea.value, offset);
  const targetTop = paddingTop + Math.max(0, line - 1) * lineHeight;
  textarea.scrollTop = Math.max(0, targetTop - textarea.clientHeight * 0.35);
  updatePromptLineNumbers();
}

function getPromptFindMatches(text, query) {
  const q = String(query || "");
  if (!q) return [];
  const haystack = String(text || "").toLowerCase();
  const needle = q.toLowerCase();
  const matches = [];
  let at = 0;
  while (at <= haystack.length) {
    const found = haystack.indexOf(needle, at);
    if (found < 0) break;
    matches.push({ start: found, end: found + q.length });
    at = found + Math.max(1, q.length);
    if (matches.length > 2000) break;
  }
  return matches;
}

function setPromptFindBarActive(active) {
  const bar = $("promptFindBar");
  const input = $("promptFindInput");
  if (!bar) return;
  bar.classList.toggle("active", !!active);
  if (!active) {
    promptFindState = { query: "", index: -1, matches: [] };
    const count = $("promptFindCount");
    if (count) count.textContent = "0/0";
    if (input) input.value = "";
    return;
  }
  if (input) {
    input.focus();
    input.select();
  }
}

function runPromptFind(delta = 0, selectMatch = true) {
  const modal = $("promptModal");
  const textarea = $("promptTextarea");
  const input = $("promptFindInput");
  const count = $("promptFindCount");
  if (!modal || modal.dataset.kind !== "generatedCode" || !textarea || !input) return;
  const query = input.value;
  const matches = getPromptFindMatches(textarea.value, query);
  if (!query || !matches.length) {
    promptFindState = { query, index: -1, matches };
    if (count) count.textContent = query ? "0/0" : "0/0";
    return;
  }
  if (!selectMatch) {
    promptFindState = { query, index: -1, matches };
    if (count) count.textContent = "0/" + matches.length;
    return;
  }
  let index = promptFindState.query === query ? promptFindState.index : -1;
  if (index < 0) {
    const cursor = textarea.selectionStart || 0;
    index = matches.findIndex(m => m.start >= cursor);
    if (index < 0) index = 0;
  } else if (delta) {
    index = (index + delta + matches.length) % matches.length;
  }
  promptFindState = { query, index, matches };
  const match = matches[index];
  if (selectMatch) {
    scrollPromptTextareaToOffset(match.start);
    textarea.focus();
    textarea.setSelectionRange(match.start, match.end);
  }
  if (count) count.textContent = (index + 1) + "/" + matches.length;
}

function handlePromptEditorKeydown(e) {
  const modal = $("promptModal");
  if (!modal || !modal.classList.contains("active") || modal.dataset.kind !== "generatedCode") return;
  if ((e.ctrlKey || e.metaKey) && String(e.key || "").toLowerCase() === "f") {
    e.preventDefault();
    setPromptFindBarActive(true);
    return;
  }
  if (e.key === "Escape") {
    const bar = $("promptFindBar");
    if (bar && bar.classList.contains("active")) {
      e.preventDefault();
      setPromptFindBarActive(false);
      const textarea = $("promptTextarea");
      if (textarea) textarea.focus();
    }
  }
}

function setScriptDraftFields(script) {
  activeScriptDraftId = Number(script && script.id || 0) || 0;
  const titleInput = $("scriptTitleInput");
  const descInput = $("scriptDescriptionInput");
  if (titleInput) titleInput.value = script && script.title ? script.title : "";
  if (descInput) descInput.value = script && script.description ? script.description : "";
  setScriptParamsText(script && script.script_params ? script.script_params : "", { syncTestConfig: true });
}

function getScriptEditorState() {
  const select = $("myScriptSelect");
  const squareInput = $("squareScriptIdInput");
  return {
    source: activeScriptSource === "square" ? "square" : "mine",
    myScriptId: Number(select && select.value || activeScriptDraftId || 0) || 0,
    draftId: Number(activeScriptDraftId || 0) || 0,
    squareScriptId: Number(squareInput && squareInput.value || activeSquareScriptId || 0) || 0
  };
}

async function persistScriptEditorState() {
  try {
    await chrome.storage.local.set({ [TEST_STORAGE_KEYS.scriptEditorState]: getScriptEditorState() });
  } catch (_) {}
}

function refreshGeneratedCodeSaveButton() {
  const modal = $("promptModal");
  const btn = $("promptSaveBtn");
  if (!btn) return;
  const isGeneratedCode = modal && modal.dataset.kind === "generatedCode";
  const isSquare = isGeneratedCode && activeScriptSource === "square";
  btn.disabled = false;
  btn.classList.toggle("is-disabled", !!isSquare);
  btn.setAttribute("aria-disabled", isSquare ? "true" : "false");
  btn.title = isSquare ? "脚本广场内容不可直接保存，请切换到我的脚本或新建草稿后保存" : "";
}

function setupScriptManagerLayout() {
  const panel = $("scriptManagerPanel");
  if (!panel || panel.dataset.layoutReady === "1") return;
  panel.dataset.layoutReady = "1";
  panel.innerHTML = `
    <div id="scriptManagerTabs">
      <button class="script-manager-tab active" type="button" data-script-manager-tab="mine" data-i18n="myDrafts">My Scripts</button>
      <button class="script-manager-tab" type="button" data-script-manager-tab="square" data-i18n="scriptSquare">Import from Square</button>
    </div>
    <div class="script-manager-pane active" id="scriptManagerMinePane" data-script-manager-pane="mine">
      <div class="script-manager-toolbar">
        <select id="myScriptSelect"><option value="" data-i18n="chooseMyScript">Choose my script</option></select>
        <button id="refreshMyScriptsBtn" type="button" title="Refresh" aria-label="Refresh">&#8635;</button>
        <button id="newScriptDraftBtn" type="button" data-i18n="new">New Draft</button>
      </div>
      <div class="script-manager-fields">
        <input id="scriptTitleInput" type="text" placeholder="Title" />
        <input id="scriptDescriptionInput" type="text" placeholder="Description" />
      </div>
    </div>
    <div class="script-manager-pane" id="scriptManagerSquarePane" data-script-manager-pane="square">
      <div class="script-square-entry">
        <button id="openScriptSquareBtn" type="button" class="secondary" data-i18n="openScriptSquare">Open Script Square</button>
      </div>
      <div class="script-manager-import">
        <input id="squareScriptIdInput" type="number" min="1" placeholder="Script ID" data-i18n-placeholder="scriptId" />
        <button id="loadSquareScriptBtn" class="primary" type="button" data-i18n="loadToTestBox">Import to Editor</button>
      </div>
    </div>
    <div id="scriptManagerStatus"></div>
  `;
  if (window.__fpbApplyI18n) window.__fpbApplyI18n(panel);
  const refreshBtn = $("refreshMyScriptsBtn");
  if (refreshBtn) refreshBtn.textContent = "↻";
}

function setScriptManagerTab(name) {
  const mode = name === "square" ? "square" : "mine";
  activeScriptSource = mode;
  document.querySelectorAll("[data-script-manager-tab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.scriptManagerTab === mode);
  });
  document.querySelectorAll("[data-script-manager-pane]").forEach(pane => {
    pane.classList.toggle("active", pane.dataset.scriptManagerPane === mode);
  });
  refreshGeneratedCodeSaveButton();
  if (!scriptEditorRestoring) persistScriptEditorState();
}

async function loadMyScriptsForPanel() {
  setScriptManagerStatus("正在拉取我的脚本...");
  const scripts = await requestScriptApi("/api/script-api/scripts/mine");
  const select = $("myScriptSelect");
  if (select) {
    select.innerHTML = `<option value="">${esc(T("chooseMyScript"))}</option>`;
    (scripts || []).forEach(script => {
      const opt = document.createElement("option");
      opt.value = String(script.id);
      opt.textContent = "#" + script.id + " " + (script.title || "Untitled") + (script.published ? "（已发布）" : "（草稿）");
      select.appendChild(opt);
    });
  }
  setScriptManagerStatus("已拉取 " + ((scripts || []).length) + " 个脚本");
  return scripts || [];
}

async function loadSelectedMyScript() {
  const select = $("myScriptSelect");
  const id = Number(select && select.value || 0);
  if (!id) return;
  activeScriptSource = "mine";
  setScriptManagerStatus("正在读取脚本 #" + id + "...");
  const script = await requestScriptApi("/api/script-api/scripts/" + id);
  setScriptDraftFields(script);
  setGeneratedCodeEditorValue(script.draft_code || "");
  setScriptManagerStatus("已读取脚本 #" + id + " 到编辑器");
  refreshGeneratedCodeSaveButton();
  await persistScriptEditorState();
}

async function saveScriptDraftFromPanel() {
  const titleInput = $("scriptTitleInput");
  const descInput = $("scriptDescriptionInput");
  if (activeScriptSource === "square") throw new Error("脚本广场内容不可直接保存，请切换到我的脚本或新建草稿后保存");
  const title = String(titleInput && titleInput.value || "").trim();
  const description = String(descInput && descInput.value || "").trim();
  const scriptParams = getScriptParamsText();
  const code = getGeneratedCodeEditorValue();
  const payload = { title, description, script_params: scriptParams, code };
  const path = activeScriptDraftId
    ? "/api/script-api/scripts/" + activeScriptDraftId
    : "/api/script-api/scripts";
  const method = activeScriptDraftId ? "PUT" : "POST";
  setScriptManagerStatus("正在保存草稿...");
  const script = await requestScriptApi(path, {
    method,
    body: JSON.stringify(payload)
  });
  setScriptDraftFields(script);
  activeScriptSource = "mine";
  await loadMyScriptsForPanel().catch(() => {});
  const select = $("myScriptSelect");
  if (select && script && script.id) select.value = String(script.id);
  await saveGeneratedCodeLocal(code);
  await persistScriptEditorState();
  refreshGeneratedCodeSaveButton();
  setScriptManagerStatus("草稿已保存 #" + script.id);
  return script;
}

async function saveGeneratedCodeAsNewDraft(code, meta = {}) {
  const title = String(meta.title || "").trim() || ("AI 测试代码草稿 " + new Date().toLocaleString());
  const description = String(meta.description || "").trim() || "由 AI 智能体生成并自动保存。";
  const scriptParams = String(meta.script_params || meta.scriptParams || getScriptParamsText() || getTestConfigText() || "").trim();
  const script = await requestScriptApi("/api/script-api/scripts", {
    method: "POST",
    body: JSON.stringify({ title, description, script_params: scriptParams, code: String(code || "") })
  });
  activeScriptSource = "mine";
  setScriptDraftFields(script);
  await loadMyScriptsForPanel().catch(() => {});
  const select = $("myScriptSelect");
  if (select && script && script.id) select.value = String(script.id);
  setScriptManagerTab("mine");
  await persistScriptEditorState();
  refreshGeneratedCodeSaveButton();
  setScriptManagerStatus("AI 生成代码已保存为新草稿 #" + script.id);
  return script;
}

async function persistGeneratedCodeFromAgent(code, meta = {}) {
  await saveGeneratedCodeLocal(code);
  const textarea = $("promptTextarea");
  const modal = $("promptModal");
  if (textarea && modal && modal.dataset.kind === "generatedCode") {
    textarea.value = String(code || "");
    updatePromptLineNumbers();
  }
  try {
    const script = await saveGeneratedCodeAsNewDraft(code, meta);
    return { ok: true, scriptId: script && script.id };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function loadSquareScriptToEditor() {
  const input = $("squareScriptIdInput");
  const id = Number(input && input.value || 0);
  if (!id) throw new Error("请输入脚本广场 ID");
  activeScriptSource = "square";
  activeSquareScriptId = id;
  setScriptManagerStatus("正在读取广场脚本 #" + id + "...");
  const script = await requestScriptApi("/api/script-api/square/" + id + "/code");
  setScriptDraftFields({
    id: 0,
    title: script.title || ("Square Script #" + id),
    description: script.description || "",
    script_params: script.script_params || ""
  });
  const select = $("myScriptSelect");
  if (select) select.value = "";
  setGeneratedCodeEditorValue(script.code || "");
  setScriptManagerStatus("已导入广场脚本 #" + id + " 到编辑器");
  refreshGeneratedCodeSaveButton();
  await persistScriptEditorState();
}

function resetScriptDraftPanel() {
  activeScriptSource = "mine";
  activeScriptDraftId = 0;
  const select = $("myScriptSelect");
  if (select) select.value = "";
  setScriptDraftFields({ id: 0, title: "", description: "", script_params: getTestConfigText() });
  setScriptManagerTab("mine");
  refreshGeneratedCodeSaveButton();
  persistScriptEditorState();
}

async function restoreScriptEditorSelection() {
  scriptEditorRestoring = true;
  try {
    const got = await chrome.storage.local.get([TEST_STORAGE_KEYS.scriptEditorState]);
    const state = got[TEST_STORAGE_KEYS.scriptEditorState] || {};
    const source = state.source === "square" ? "square" : "mine";
    setScriptManagerTab(source);
    if (source === "square") {
      const id = Number(state.squareScriptId || 0) || 0;
      const input = $("squareScriptIdInput");
      if (input && id) input.value = String(id);
      if (id) await loadSquareScriptToEditor();
      else setScriptManagerStatus("请输入脚本广场 ID 后读取脚本");
      return;
    }
    const scripts = await loadMyScriptsForPanel();
    const id = Number(state.myScriptId || state.draftId || 0) || 0;
    const select = $("myScriptSelect");
    if (select && id && (scripts || []).some(script => Number(script.id) === id)) {
      select.value = String(id);
      await loadSelectedMyScript();
    } else if (id) {
      setScriptDraftFields({ id, title: "", description: "", script_params: "" });
      setScriptManagerStatus("上次脚本未在列表中找到，请重新选择或新建草稿");
    } else {
      setScriptManagerStatus("请选择我的脚本，或新建草稿后使用底部保存");
    }
  } catch (err) {
    setScriptManagerStatus(String(err && err.message || err), true);
  } finally {
    scriptEditorRestoring = false;
    refreshGeneratedCodeSaveButton();
  }
}

function toggleScriptManagerPanel(kind) {
  const panel = $("scriptManagerPanel");
  if (!panel) return;
  const active = kind === "generatedCode";
  const editorArea = $("promptEditorArea");
  if (active && editorArea && panel.parentElement === editorArea.parentElement) {
    editorArea.parentElement.insertBefore(panel, editorArea);
  }
  const paramsPanel = $("scriptParamsPanel");
  if (active && editorArea && paramsPanel && paramsPanel.parentElement === editorArea.parentElement) {
    editorArea.parentElement.insertBefore(paramsPanel, editorArea);
  }
  const findBar = $("promptFindBar");
  const codeEditor = $("promptCodeEditor");
  if (active && findBar && codeEditor && findBar.parentElement !== editorArea) {
    editorArea.insertBefore(findBar, codeEditor);
  }
  panel.classList.toggle("active", active);
  if (active) {
    restoreScriptEditorSelection();
  }
}

function openPromptEditor(kind) {
  const modal = $("promptModal");
  const title = $("promptDialogTitle");
  const textarea = $("promptTextarea");
  if (!modal || !textarea) return;
  modal.dataset.kind = kind;
  if (title) {
    title.textContent = kind === "generatedCode"
      ? T("testCode")
      : (kind === "testConfig"
        ? T("editParams")
        : (kind === "testCode"
            ? T("generateTestCodePrompt")
            : (kind === "cleanup"
              ? T("cleanupPrompt")
              : (kind === "token" ? T("analyzeTokenPrompt") : T("analyzeAllPrompt")))));
  }
  textarea.value = getPromptValue(kind);
  if (kind === "generatedCode") ensureScriptParamsEditorValue();
  setPromptSaveStatus("");
  setPromptFindBarActive(false);
  toggleScriptManagerPanel(kind);
  refreshGeneratedCodeSaveButton();
  modal.classList.add("active");
  updatePromptLineNumbers();
  textarea.focus();
}

function closePromptEditor() {
  const modal = $("promptModal");
  if (modal) {
    modal.classList.remove("active");
    setPromptSaveStatus("");
    setPromptFindBarActive(false);
    updatePromptLineNumbers();
    toggleScriptManagerPanel("");
    delete modal.dataset.editor;
    delete modal.dataset.seq;
    delete modal.dataset.sourceField;
  }
}

function resetPromptEditor() {
  const modal = $("promptModal");
  const textarea = $("promptTextarea");
  if (!modal || !textarea) return;
  if (modal.dataset.editor === "networkLog") {
    const ev = getEventBySeq(Number(modal.dataset.seq));
    if (ev) textarea.value = buildEditableNetworkLogText(ev, modal.dataset.kind || "request");
    textarea.focus();
    return;
  }
  textarea.value = getDefaultPromptValue(modal.dataset.kind || "all");
  setPromptSaveStatus("");
  updatePromptLineNumbers();
  if (modal.dataset.kind === "generatedCode") runPromptFind(0);
  textarea.focus();
}

async function savePromptEditor() {
  const modal = $("promptModal");
  const textarea = $("promptTextarea");
  if (!modal || !textarea) return;
  if (modal.dataset.editor === "networkLog") {
    await saveNetworkLogEditor();
    return;
  }
  const kind = modal.dataset.kind || "all";
  if (kind === "generatedCode" && activeScriptSource === "square") {
    setPromptSaveStatus("脚本广场内容不可直接保存，请切换到我的脚本或新建草稿后保存", true);
    return;
  }
  const value = textarea.value.trim() || getDefaultPromptValue(kind);
  if (kind === "testConfig") {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      throw new Error("测试配置 JSON 解析失败: " + String(err && err.message || err));
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("测试配置必须是 JSON 对象");
    }
    setTestConfigUi(parsed);
    await saveTestConfig();
    textarea.value = getTestConfigText();
    setPromptSaveStatus(T("saved"));
    return;
  }
  setPromptValue(kind, value);
  if (kind === "generatedCode") {
    syncScriptParamsToTestConfig();
    await saveGeneratedCodeLocal(value);
    const script = await saveScriptDraftFromPanel();
    setPromptSaveStatus("已保存到本地和我的脚本 #" + (script && script.id));
    return;
  } else {
    await savePromptCache(kind, value);
  }
  setPromptSaveStatus(T("saved"));
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtSize(n) {
  if (!n) return "-";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

function fmtMs(n) {
  if (!n) return "-";
  return n < 1000 ? n + " ms" : (n / 1000).toFixed(2) + " s";
}

// 鈹€鈹€ polling 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function pollEvents() {
  try {
    const resp = await send("popup.networkCapture.snapshot", { since_seq: sinceSeq, limit: 200 });
    if (!(resp && resp.ok)) return;
    const newEvts = ((resp.result && resp.result.events) || []).filter(e => !deletedSeqs.has(Number(e.seq)));
    if (newEvts.length) {
      events = mergeNetworkEvents(events, newEvts);
      sinceSeq = newEvts[newEvts.length - 1].seq + 1;
      applyFilter();
      renderLogList();
      persistNetworkLogCache();
    }
  } catch (_) {}
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollEvents, POLL_INTERVAL);
  pollEvents();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function refreshCaptureControls() {
  const resp = await send("popup.networkCapture.status");
  if (!(resp && resp.ok)) return;
  const st = resp.result || {};
  const statusEl = $("captureStatusText");
  const toggleBtn = $("captureToggleBtn");
  const count = st.count != null ? st.count : (st.eventCount != null ? st.eventCount : 0);
  if (statusEl) {
    statusEl.className = "capture-status";
    if (st.running) {
      statusEl.classList.add("running");
      statusEl.textContent = T("runningCapture", { count });
    } else if (st.paused) {
      statusEl.classList.add("paused");
      statusEl.textContent = T("pausedCapture", { count });
    } else {
      statusEl.textContent = count ? T("stoppedCapture", { count }) : T("notStarted");
    }
  }
  if (toggleBtn) {
    if (st.paused) toggleBtn.textContent = T("resume");
    else if (st.running) toggleBtn.textContent = T("pause");
    else toggleBtn.textContent = T("start");
  }
}

async function captureAction(action) {
  const payload = {};
  if (action === "start") {
    try {
      const tabId = await getStartTargetTabId();
      if (tabId) payload.tabId = tabId;
    } catch (err) {
      const statusEl = $("captureStatusText");
      if (statusEl) {
        statusEl.className = "capture-status";
        statusEl.textContent = String(err && err.message || err);
      }
      return { ok: false, error: String(err && err.message || err) };
    }
  }
  const resp = await send("popup.networkCapture." + action, payload);
  if (!(resp && resp.ok)) {
    const statusEl = $("captureStatusText");
    if (statusEl) {
      statusEl.className = "capture-status";
      statusEl.textContent = (resp && resp.error) || T("operationFailed");
    }
    return resp;
  }
  await refreshCaptureControls().catch(() => {});
  return resp;
}

async function refreshNetworkLogSnapshot() {
  const snap = await send("popup.networkCapture.snapshot", { since_seq: 0, limit: 5000 });
  if (!(snap && snap.ok)) throw new Error((snap && snap.error) || "snapshot failed");
  const nextEvents = ((snap.result && snap.result.events) || []).filter(e => !deletedSeqs.has(Number(e.seq)));
  if (nextEvents.length) {
    events = mergeNetworkEvents([], nextEvents);
    sinceSeq = nextEvents[nextEvents.length - 1].seq + 1;
    persistNetworkLogCache();
  } else {
    sinceSeq = 0;
  }
  if (selectedIdx !== null) {
    const selected = filteredEvents[selectedIdx];
    if (!selected || !events.some(e => e.seq === selected.seq)) selectedIdx = null;
  }
  applyFilter();
  renderLogList();
  renderDetail();
  return events;
}

async function clearNetworkLogList() {
  await send("popup.networkCapture.clear");
  events = [];
  filteredEvents = [];
  selectedIdx = null;
  sinceSeq = 0;
  deletedSeqs = new Set();
  referencedSeqs = new Set();
  await clearNetworkLogCache();
  renderLogList();
  renderDetail();
  renderNetworkReferences();
  await refreshCaptureControls().catch(() => {});
}


// 鈹€鈹€ filter + render log list 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function removeNetworkEventsLocal(seqs) {
  const deleteSet = new Set((seqs || []).map(seq => Number(seq)).filter(n => Number.isFinite(n)));
  if (!deleteSet.size) return 0;
  deleteSet.forEach(seq => {
    deletedSeqs.add(seq);
    referencedSeqs.delete(seq);
  });
  const selectedSeq = selectedIdx !== null && filteredEvents[selectedIdx] ? Number(filteredEvents[selectedIdx].seq) : null;
  const before = events.length;
  events = events.filter(e => !deleteSet.has(Number(e.seq)));
  if (selectedSeq !== null && deleteSet.has(selectedSeq)) selectedIdx = null;
  applyFilter();
  if (selectedIdx !== null) {
    const selected = filteredEvents[selectedIdx];
    if (!selected || deleteSet.has(Number(selected.seq))) selectedIdx = null;
  }
  persistNetworkLogCache();
  renderLogList();
  renderDetail();
  renderNetworkReferences();
  return before - events.length;
}

async function deleteNetworkEvents(seqs) {
  const uniqueSeqs = Array.from(new Set((seqs || []).map(seq => Number(seq)).filter(n => Number.isFinite(n))));
  if (!uniqueSeqs.length) return { ok: true, deleted: 0 };
  removeNetworkEventsLocal(uniqueSeqs);
  const results = await Promise.all(uniqueSeqs.map(async seq => {
    try {
      const resp = await send("popup.networkCapture.deleteEvent", { seq });
      return { seq, ok: !!(resp && resp.ok), resp };
    } catch (err) {
      return { seq, ok: false, error: String(err && err.message || err) };
    }
  }));
  const okSeqs = results.filter(r => r.ok).map(r => r.seq);
  const failed = results.filter(r => !r.ok);
  if (failed.length) addSystemContext(T("deleteLogFailed", { count: failed.length, seqs: failed.map(r => r.seq).join(", ") }));
  return { ok: failed.length === 0, deleted: okSeqs.length, failed };
}

function applyFilter() {
  const q = filterText.toLowerCase();
  filteredEvents = (q
    ? events.filter(e => {
        const url = (e.url || "").toLowerCase();
        const method = (e.method || "").toLowerCase();
        return url.includes(q) || method.includes(q);
      })
    : events.slice()
  ).filter(e => !deletedSeqs.has(Number(e.seq)));
}

function renderLogList() {
  const list = $("logList");
  if (!filteredEvents.length) {
    list.innerHTML = `<div id="logEmpty">${esc(T("noRequests"))}</div>`;
    return;
  }
  const html = filteredEvents.map((e, i) => {
    const method = e.method || "?";
    const url = e.url || "";
    const status = e.status || "";
    const statusClass = status >= 400 ? "err" : (status >= 200 ? "ok" : "");
    const dur = e.duration_ms;
    const size = null;
    const sel = selectedIdx === i ? " selected" : "";
    const shortUrl = url.replace(/^https?:\/\/[^/]+/, "").slice(0, 80) || url.slice(0, 80);
    return `<div class="log-item${sel}" data-idx="${i}">
      <div>
        <span class="li-method">${esc(method)}</span>
        <span class="li-status ${statusClass}">${esc(String(status))}</span>
      </div>
      <div class="li-url" title="${esc(url)}">${esc(shortUrl)}</div>
      <div class="li-meta">${fmtMs(dur)} 路 ${fmtSize(size)}</div>
      <button class="li-del" data-del-seq="${e.seq}" title="Delete">DEL</button>
    </div>`;
  }).join("");
  list.innerHTML = html;
}

// 鈹€鈹€ detail panel 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function getSelectedEvent() {
  return selectedIdx !== null ? filteredEvents[selectedIdx] : null;
}

function renderDetail() {
  const e = getSelectedEvent();
  const content = $("detailContent");
  const tokenBtn = $("analyzeTokenBtn");
  const editBtn = $("editLogBtn");
  if (tokenBtn) tokenBtn.disabled = agentRunning || !e;
  if (editBtn) editBtn.classList.toggle("active", !!e && (activeDetailTab === "request" || activeDetailTab === "response"));
  if (!e) { content.innerHTML = `<div id="detailEmpty">${esc(T("selectRequestHint"))}</div>`; return; }
  switch (activeDetailTab) {
    case "summary": content.textContent = buildSummary(e); break;
    case "request": content.textContent = buildRequestText(e); break;
    case "response": content.textContent = buildResponseText(e); break;
    case "stack": content.textContent = buildStackText(e); break;
  }
}

function prettyMaybe(text) {
  const s = String(text || "");
  if (!s) return "";
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

function jsonText(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function formatBeijingTime(value, epochMs) {
  const ms = Number(epochMs || 0) || Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return value || "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date(ms)).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  const millis = String(new Date(ms).getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${millis} +08:00`;
}

function buildSummary(e) {
  return jsonText({
    seq: e.seq,
    source: e.source,
    method: e.method,
    url: e.url,
    path: e.path,
    origin: e.origin,
    status: e.status,
    ok: e.ok,
    duration_ms: e.duration_ms,
    started_at: formatBeijingTime(e.started_at, e.start_epoch_ms),
    completed_at: formatBeijingTime(e.completed_at, e.end_epoch_ms),
    resource_type: e.resource_type,
    tab_id: e.tab_id,
    frame_url: e.frame_url,
    web_request_id: e.web_request_id,
    ip: e.ip,
    from_cache: e.from_cache,
    error: e.error,
  });
}

function buildRequestText(e) {
  return jsonText({
    request_headers: e.request_headers || {},
    request_payload: prettyMaybe(e.request_payload || ""),
  });
}

function buildResponseText(e) {
  return jsonText({
    response_headers: e.response_headers || {},
    response_type: e.response_type || "",
    response_body: prettyMaybe(e.response_body || ""),
  });
}

function getEventBySeq(seq) {
  return events.find(e => Number(e.seq) === Number(seq) && !deletedSeqs.has(Number(e.seq))) || null;
}

function buildEditableNetworkLogText(e, kind) {
  if (kind === "response") {
    return jsonText({
      response_headers: e.response_headers || {},
      response_type: e.response_type || "",
      response_body: e.response_body || "",
    });
  }
  return jsonText({
    request_headers: e.request_headers || {},
    request_payload: e.request_payload || "",
  });
}

function normalizeHeaderObject(value, fieldName) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${fieldName} must be an object`);
  return value;
}

function updateLocalNetworkEvent(seq, patch) {
  const targetSeq = Number(seq);
  let updated = null;
  events = events.map(ev => {
    if (Number(ev.seq) !== targetSeq) return ev;
    updated = { ...ev, ...patch, edited_at: new Date().toISOString() };
    return updated;
  });
  applyFilter();
  if (updated && selectedIdx !== null) {
    const nextIdx = filteredEvents.findIndex(ev => Number(ev.seq) === targetSeq);
    selectedIdx = nextIdx >= 0 ? nextIdx : null;
  }
  persistNetworkLogCache();
  renderLogList();
  renderDetail();
  return updated;
}

function openNetworkLogEditor() {
  const ev = getSelectedEvent();
  if (!ev || (activeDetailTab !== "request" && activeDetailTab !== "response")) return;
  const modal = $("promptModal");
  const title = $("promptDialogTitle");
  const textarea = $("promptTextarea");
  if (!modal || !textarea) return;
  modal.dataset.editor = "networkLog";
  modal.dataset.kind = activeDetailTab;
  modal.dataset.seq = String(ev.seq);
  if (title) title.textContent = activeDetailTab === "response" ? T("editResponse") : T("editRequest");
  textarea.value = buildEditableNetworkLogText(ev, activeDetailTab);
  modal.classList.add("active");
  textarea.focus();
}

async function saveNetworkLogEditor() {
  const modal = $("promptModal");
  const textarea = $("promptTextarea");
  if (!modal || !textarea) return;
  const seq = Number(modal.dataset.seq);
  const kind = modal.dataset.kind || "request";
  let parsed;
  try {
    parsed = JSON.parse(textarea.value || "{}");
  } catch (err) {
    throw new Error(`JSON parse failed: ${String(err && err.message || err)}`);
  }
  const patch = {};
  if (kind === "response") {
    patch.response_headers = normalizeHeaderObject(parsed.response_headers, "response_headers");
    patch.response_type = String(parsed.response_type || "");
    patch.response_body = typeof parsed.response_body === "string" ? parsed.response_body : jsonText(parsed.response_body);
  } else {
    patch.request_headers = normalizeHeaderObject(parsed.request_headers, "request_headers");
    patch.request_payload = typeof parsed.request_payload === "string" ? parsed.request_payload : jsonText(parsed.request_payload);
  }
  updateLocalNetworkEvent(seq, patch);
  try {
    await send("popup.networkCapture.updateEvent", { seq, patch });
  } catch (err) {
    appendChatMsg("system-note", `鍚庡彴鏇存柊 Network Log 澶辫触锛屼粎宸叉洿鏂版湰椤电紦瀛? ${String(err && err.message || err)}`);
  }
  closePromptEditor();
}

function buildStackText(e) {
  return e.initiator_stack || T("noCallStack");
}

// 鈹€鈹€ chat UI 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function isValidChatMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.role !== "user" && msg.role !== "assistant") return false;
  const c = msg.content;
  return typeof c === "string" || Array.isArray(c);
}

function imageBlockMeta(item) {
  const source = item && item.source;
  const mediaType = String((source && source.media_type) || item.media_type || "image").trim();
  const name = String(item.name || item.filename || "image").trim();
  const size = Number(item.size || 0);
  const suffix = size ? `, ${fmtSize(size)}` : "";
  return `${name} (${mediaType}${suffix})`;
}

function chatContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(item => {
    if (!item || typeof item !== "object") return "";
    if (item.type === "text") return String(item.text || "");
    if (item.type === "image") return `[image: ${imageBlockMeta(item)}]`;
    if (item.type === "tool_result") {
      if (typeof item.display_text === "string" && item.display_text) return item.display_text;
      const value = item.content;
      if (typeof value === "string") return value || "(empty tool result)";
      if (value == null) return String(value);
      return jsonText(value);
    }
    if (item.type === "tool_use") return `${T("toolUse")}: ${item.name || ""}(${JSON.stringify(item.input || {})})`;
    return "";
  }).filter(Boolean).join("\n");
}

function stringifyToolResult(result) {
  if (typeof result === "undefined") return "undefined";
  if (typeof result === "string") return result || "(empty string)";
  if (result == null) return String(result);
  const text = jsonText(result);
  return text || "(empty tool result)";
}

function formatToolResultForDisplay(toolUse, resultText) {
  const name = toolUse && toolUse.name ? String(toolUse.name) : "tool";
  const inputText = stringifyToolResult(toolUse && toolUse.input ? toolUse.input : {});
  return `[${name}]\ninput:\n${inputText}\n\nresult:\n${resultText || "(empty tool result)"}`;
}

function chatContentForStorage(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const out = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "image") {
      out.push({ type: "text", text: `[image omitted from saved history: ${imageBlockMeta(item)}]` });
    } else if (item.type === "tool_result") {
      out.push({
        type: "tool_result",
        tool_use_id: item.tool_use_id,
        content: typeof item.content === "string" ? item.content : stringifyToolResult(item.content),
        display_text: item.display_text || ""
      });
    } else {
      out.push(item);
    }
  }
  return out;
}

function buildImageDataUrl(item) {
  if (!item || item.type !== "image") return "";
  if (item.previewUrl) return item.previewUrl;
  const source = item.source || {};
  const data = String(source.data || "");
  const mediaType = String(source.media_type || item.media_type || "image/jpeg");
  return data ? `data:${mediaType};base64,${data}` : "";
}

function renderImageThumbs(container, images) {
  if (!container || !Array.isArray(images) || !images.length) return;
  const wrap = document.createElement("div");
  wrap.className = "chat-images";
  images.forEach(item => {
    const dataUrl = buildImageDataUrl(item);
    const thumb = document.createElement("div");
    thumb.className = "chat-image-thumb";
    if (dataUrl) {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = item.name || "image";
      thumb.appendChild(img);
    }
    const meta = document.createElement("div");
    meta.className = "image-meta";
    meta.title = imageBlockMeta(item);
    meta.textContent = item.name || item.filename || "image";
    thumb.appendChild(meta);
    wrap.appendChild(thumb);
  });
  container.appendChild(wrap);
}

function appendChatContentMsg(role, content, historyIndex = null, options = {}) {
  if (typeof content === "string") {
    appendChatMsg(role, content, historyIndex, options);
    return;
  }
  if (!Array.isArray(content)) {
    appendChatMsg(role, "", historyIndex, options);
    return;
  }
  const text = content
    .filter(item => item && item.type === "text")
    .map(item => String(item.text || ""))
    .filter(Boolean)
    .join("\n");
  const images = content.filter(item => item && item.type === "image");
  appendChatMsg(role, text, historyIndex, { ...options, images });
}

function displayChatHistoryMessage(msg, historyIndex, options = {}) {
  const text = chatContentToText(msg.content);
  if (!text) return;
  if (msg.role === "assistant") {
    appendChatContentMsg("assistant", msg.content, historyIndex, options);
  } else if (text.startsWith("[system]\n")) {
    appendChatMsg("system-note", text.slice(9), historyIndex, options);
  } else if (text.startsWith("[绯荤粺]\n")) {
    appendChatMsg("system-note", text.slice(5), historyIndex, options);
  } else if (/^\[[^\]]+\]\n/.test(text)) {
    appendChatMsg("tool", text, historyIndex, options);
  } else {
    appendChatContentMsg("user", msg.content, historyIndex, options);
  }
}

function renderChatHistory(options = {}) {
  const box = $("chatMessages");
  if (!box) return;
  box.innerHTML = "";
  chatHistory.forEach((msg, idx) => displayChatHistoryMessage(msg, idx, options));
}

function persistChatHistory() {
  const compact = chatHistory.filter(isValidChatMessage).slice(-80);
  if (compact.length !== chatHistory.length) chatHistory = compact;
  const stored = compact.map(msg => ({ ...msg, content: chatContentForStorage(msg.content) }));
  chrome.storage.local.set({ [CHAT_HISTORY_STORAGE_KEY]: stored }).catch(() => {});
}

function appendChatMsg(role, text, historyIndex = null, options = {}) {
  const box = $("chatMessages");
  if (role === "tool" && !String(text || "").trim()) text = "(empty tool result)";
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  if (Number.isInteger(historyIndex)) div.dataset.historyIndex = String(historyIndex);
  const roleLabel = { user: T("you"), assistant: "AI", tool: T("toolResult"), "system-note": T("system") }[role] || role;
  const actions = Number.isInteger(historyIndex)
    ? `<span class="msg-actions">
        <button class="msg-action-btn" data-chat-action="delete-one" data-history-index="${historyIndex}" title="${esc(T("deleteThisTitle"))}">${esc(T("deleteThis"))}</button>
        <button class="msg-action-btn" data-chat-action="delete-from" data-history-index="${historyIndex}" title="${esc(T("deleteBelowTitle"))}">${esc(T("deleteBelow"))}</button>
      </span>`
    : "";
  div.innerHTML = `<div class="msg-head"><span class="msg-role">${esc(roleLabel)}</span>${actions}</div><div class="msg-body">${esc(text)}</div>`;
  renderImageThumbs(div, options.images || []);
  box.appendChild(div);
  if (options.scroll !== false) box.scrollTop = box.scrollHeight;
}

function deleteChatHistoryAt(index) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= chatHistory.length) return;
  chatHistory.splice(idx, 1);
  persistChatHistory();
  const box = $("chatMessages");
  const scrollTop = box ? box.scrollTop : 0;
  renderChatHistory({ scroll: false });
  if (box) box.scrollTop = Math.min(scrollTop, box.scrollHeight - box.clientHeight);
}

function deleteChatHistoryFrom(index) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= chatHistory.length) return;
  chatHistory.splice(idx);
  persistChatHistory();
  const box = $("chatMessages");
  const scrollTop = box ? box.scrollTop : 0;
  renderChatHistory({ scroll: false });
  if (box) box.scrollTop = Math.min(scrollTop, box.scrollHeight - box.clientHeight);
}

function addSystemContext(text) {
  const value = String(text || "");
  if (!value) return;
  chatHistory.push({ role: "user", content: `[system]\n${value}` });
  appendChatMsg("system-note", value, chatHistory.length - 1);
  persistChatHistory();
}

function addSystemNotice(text) {
  const value = String(text || "");
  if (!value) return;
  appendChatMsg("system-note", value);
}

function addToolContext(name, result) {
  const toolName = String(name || T("toolResult"));
  const resultText = typeof result === "string" ? result : jsonText(result);
  chatHistory.push({ role: "user", content: `[${toolName}]\n${resultText}` });
  appendChatMsg("tool", `[${toolName}] ${resultText}`, chatHistory.length - 1);
  persistChatHistory();
}

function inferToolFromAssistantTextWithoutToolUse(text) {
  const s = String(text || "");
  const lower = s.toLowerCase();
  if (
    /get_generated_test_code/.test(lower) ||
    /(读取|获取|查看|看|检查|先看|先读取)[\s\S]{0,24}(当前)?[\s\S]{0,12}(测试代码|代码)/.test(s) ||
    /(read|get|inspect|check|look at)[\s\S]{0,40}(current )?(generated )?test code/.test(lower)
  ) {
    return { name: "get_generated_test_code", input: {} };
  }
  return null;
}

async function handleMissingToolUseFromAssistantText(text) {
  const inferred = inferToolFromAssistantTextWithoutToolUse(text);
  if (!inferred) return false;
  addSystemNotice(`AI 没有发出工具参数，已根据文本自动执行: ${inferred.name}`);
  let result;
  try {
    result = await executeTool(inferred.name, inferred.input);
  } catch (err) {
    result = { error: String(err && err.message || err) };
  }
  const resultText = stringifyToolResult(result);
  const displayText = formatToolResultForDisplay(inferred, resultText);
  const contextText = `[inferred_tool:${inferred.name}]\n${displayText}\n\nContinue from this tool output. If you modify code, call save_generated_test_code with the complete revised code, then call run_generated_test.`;
  chatHistory.push({ role: "user", content: contextText });
  appendChatMsg("tool", displayText, chatHistory.length - 1);
  persistChatHistory();
  return true;
}

function clearChat() {
  chatHistory = [];
  pendingImages = [];
  const box = $("chatMessages");
  box.innerHTML = "";
  renderPendingImages();
  chrome.storage.local.remove([CHAT_HISTORY_STORAGE_KEY]).catch(() => {});
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read image failed"));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode image failed"));
    img.src = src;
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise(resolve => {
    if (!canvas.toBlob) {
      const dataUrl = canvas.toDataURL(mime, quality);
      const parts = dataUrl.split(",");
      const bin = atob(parts[1] || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      resolve(new Blob([bytes], { type: mime }));
      return;
    }
    canvas.toBlob(blob => resolve(blob), mime, quality);
  });
}

function dataUrlParts(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;,]+);base64,(.*)$/);
  if (!m) return null;
  return { mediaType: m[1] || "image/jpeg", data: m[2] || "" };
}

async function normalizeImageFile(file) {
  if (!file || !/^image\//i.test(file.type || "")) throw new Error("not an image file");
  const originalDataUrl = await fileToDataUrl(file);
  const img = await loadImageElement(originalDataUrl);
  const ratio = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth || img.width || 1, img.naturalHeight || img.height || 1));
  const width = Math.max(1, Math.round((img.naturalWidth || img.width || 1) * ratio));
  const height = Math.max(1, Math.round((img.naturalHeight || img.height || 1) * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  const targetMime = /^image\/png$/i.test(file.type || "") ? "image/png" : "image/jpeg";
  const blob = await canvasToBlob(canvas, targetMime, IMAGE_JPEG_QUALITY);
  const finalBlob = blob || file;
  const dataUrl = finalBlob === file ? originalDataUrl : await fileToDataUrl(finalBlob);
  const parsed = dataUrlParts(dataUrl);
  if (!parsed) throw new Error("invalid image data");
  return {
    id: `img-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: "image",
    name: file.name || "image",
    size: finalBlob.size || file.size || 0,
    width,
    height,
    previewUrl: dataUrl,
    source: {
      type: "base64",
      media_type: parsed.mediaType,
      data: parsed.data
    }
  };
}

function renderPendingImages() {
  const bar = $("imagePreviewBar");
  if (!bar) return;
  bar.innerHTML = "";
  bar.classList.toggle("active", pendingImages.length > 0);
  pendingImages.forEach(item => {
    const card = document.createElement("div");
    card.className = "pending-image";
    const img = document.createElement("img");
    img.src = item.previewUrl || buildImageDataUrl(item);
    img.alt = item.name || "image";
    card.appendChild(img);
    const name = document.createElement("div");
    name.className = "pending-name";
    name.title = imageBlockMeta(item);
    name.textContent = item.name || "image";
    card.appendChild(name);
    const remove = document.createElement("button");
    remove.className = "pending-remove";
    remove.type = "button";
    remove.textContent = "x";
    remove.title = "Remove image";
    remove.addEventListener("click", () => {
      pendingImages = pendingImages.filter(img => img.id !== item.id);
      renderPendingImages();
    });
    card.appendChild(remove);
    bar.appendChild(card);
  });
}

async function addPendingImageFiles(fileList) {
  const files = Array.from(fileList || []).filter(file => /^image\//i.test(file.type || ""));
  if (!files.length) return;
  const room = Math.max(0, MAX_PENDING_IMAGES - pendingImages.length);
  if (!room) {
    appendChatMsg("system-note", `Image limit reached: max ${MAX_PENDING_IMAGES} images per message.`);
    return;
  }
  for (const file of files.slice(0, room)) {
    try {
      const image = await normalizeImageFile(file);
      pendingImages.push(image);
      renderPendingImages();
    } catch (err) {
      appendChatMsg("system-note", `Image load failed: ${String(err && err.message || err)}`);
    }
  }
  if (files.length > room) {
    appendChatMsg("system-note", `Only attached ${room} image(s); max ${MAX_PENDING_IMAGES} per message.`);
  }
}

function buildUserContent(text, images) {
  const cleanText = String(text || "").trim();
  const blocks = [];
  blocks.push({ type: "text", text: cleanText || "Please analyze the attached image(s)." });
  (images || []).forEach(img => {
    blocks.push({
      type: "image",
      name: img.name,
      size: img.size,
      width: img.width,
      height: img.height,
      previewUrl: img.previewUrl,
      source: img.source
    });
  });
  return blocks.length === 1 && !(images && images.length) ? cleanText : blocks;
}

function chatContentForApi(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map(item => {
    if (!item || typeof item !== "object") return item;
    if (item.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: String(item.source && item.source.media_type || "image/jpeg"),
          data: String(item.source && item.source.data || "")
        }
      };
    }
    if (item.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: item.tool_use_id,
        content: typeof item.content === "string" ? item.content : stringifyToolResult(item.content)
      };
    }
    return item;
  });
}

function getToolUseIds(msg) {
  const content = msg && Array.isArray(msg.content) ? msg.content : [];
  return content.filter(item => item && item.type === "tool_use" && item.id).map(item => String(item.id));
}

function getToolResultBlocks(msg) {
  const content = msg && Array.isArray(msg.content) ? msg.content : [];
  return content.filter(item => item && item.type === "tool_result" && item.tool_use_id);
}

function isToolResultMessage(msg) {
  return !!(msg && msg.role === "user" && getToolResultBlocks(msg).length);
}

function isSkippableBetweenToolUseAndResult(msg) {
  if (!msg || msg.role !== "user" || typeof msg.content !== "string") return false;
  const text = String(msg.content || "");
  return text.startsWith("[system]\n调用工具:") || text.startsWith("[system]\nCalling tool:");
}

function sanitizeMessagesForAnthropic(messages) {
  const src = (messages || []).filter(isValidChatMessage);
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const msg = src[i];
    if (isToolResultMessage(msg)) continue;

    if (msg.role === "assistant") {
      const toolUseIds = getToolUseIds(msg);
      if (toolUseIds.length) {
        let j = i + 1;
        while (j < src.length && isSkippableBetweenToolUseAndResult(src[j])) j++;
        const resultBlocks = getToolResultBlocks(src[j]);
        const byId = new Map(resultBlocks.map(block => [String(block.tool_use_id), block]));
        const paired = toolUseIds.every(id => byId.has(id));
        if (paired) {
          out.push(msg);
          out.push({
            role: "user",
            content: toolUseIds.map(id => byId.get(id))
          });
          i = j;
          continue;
        }

        const textOnly = (Array.isArray(msg.content) ? msg.content : [])
          .filter(item => item && item.type === "text");
        if (textOnly.length) out.push({ role: "assistant", content: textOnly });
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}

function chatMessagesForApi(messages) {
  return sanitizeMessagesForAnthropic(messages)
    .map(msg => ({ ...msg, content: chatContentForApi(msg.content) }));
}

function referenceLabel(ev) {
  if (!ev) return "";
  const method = String(ev.method || "?").toUpperCase();
  const status = ev.status ? ` ${ev.status}` : "";
  const raw = String(ev.path || ev.url || "");
  let path = raw;
  try {
    const u = new URL(raw);
    path = `${u.pathname || "/"}${u.search || ""}`;
  } catch (_) {}
  return `#${ev.seq} ${method}${status} ${path || raw}`;
}

function getReferencedEvents() {
  const seqs = Array.from(referencedSeqs);
  return seqs
    .map(seq => events.find(e => Number(e.seq) === Number(seq) && !deletedSeqs.has(Number(e.seq))))
    .filter(Boolean);
}

function renderNetworkReferences() {
  const bar = $("networkReferenceBar");
  const list = $("networkReferenceList");
  if (!bar || !list) return;
  const refs = getReferencedEvents();
  bar.classList.toggle("active", refs.length > 0);
  if (!refs.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = refs.map(ev => `
    <span class="network-ref-chip" title="${esc(ev.url || ev.path || "")}">
      <span class="ref-text">${esc(referenceLabel(ev))}</span>
      <button class="ref-remove" type="button" data-ref-remove-seq="${esc(ev.seq)}" title="移除引用">x</button>
    </span>
  `).join("");
}

function addNetworkReference(ev) {
  if (!ev || deletedSeqs.has(Number(ev.seq))) return;
  referencedSeqs.add(Number(ev.seq));
  renderNetworkReferences();
}

function buildReferencedNetworkPrompt() {
  const refs = getReferencedEvents();
  if (!refs.length) return "";
  const payload = refs.map(buildSingleEventPayload);
  return `请优先分析下面引用的 Network Log（共 ${refs.length} 条）。除非用户明确要求全量排查，否则主要围绕这些引用请求推断：\n\n\`\`\`json\n${jsonText(payload)}\n\`\`\``;
}

function withReferencedNetworkContext(content) {
  const refPrompt = buildReferencedNetworkPrompt();
  if (!refPrompt) return content;
  if (typeof content === "string") {
    return `${refPrompt}\n\n用户指令：\n${content}`;
  }
  if (Array.isArray(content)) {
    const blocks = content.slice();
    const firstText = blocks.find(item => item && item.type === "text");
    if (firstText) firstText.text = `${refPrompt}\n\n用户指令：\n${String(firstText.text || "")}`;
    else blocks.unshift({ type: "text", text: refPrompt });
    return blocks;
  }
  return content;
}

function setAgentBusy(busy) {
  agentRunning = busy;
  if (busy) agentStopRequested = false;
  else activeAiRequestId = "";
  const sendBtn = $("sendBtn");
  const analyzeBtn = $("analyzeAllBtn");
  const tokenBtn = $("analyzeTokenBtn");
  const cleanupBtn = $("cleanupLogsBtn");
  const generateBtn = $("generateTestCodeBtn");
  const testBtn = $("runGeneratedTestBtn");
  const attachBtn = $("attachImageBtn");
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.textContent = busy ? T("stop") : T("send");
  }
  if (analyzeBtn) analyzeBtn.disabled = busy;
  if (tokenBtn) tokenBtn.disabled = busy || !getSelectedEvent();
  if (cleanupBtn) cleanupBtn.disabled = busy;
  if (generateBtn) generateBtn.disabled = busy;
  if (testBtn) testBtn.disabled = busy;
  if (attachBtn) attachBtn.disabled = busy;
  if ($("chatInput")) $("chatInput").disabled = busy;
}

function buildCleanupPayload(list) {
  return list.map(e => ({
    seq: e.seq,
    method: e.method || "",
    status: e.status || "",
    url: e.url || "",
    path: e.path || "",
    resource_type: e.resource_type || "",
    request_content_type: (e.request_headers && (e.request_headers["content-type"] || e.request_headers["Content-Type"])) || "",
    response_content_type: (e.response_headers && (e.response_headers["content-type"] || e.response_headers["Content-Type"])) || "",
    has_request_body: !!e.request_payload,
    has_response_body: !!e.response_body,
    has_stack: !!e.initiator_stack
  }));
}

function cleanupEventScore(e) {
  const method = String(e.method || "GET").toUpperCase();
  const url = String(e.url || "");
  const path = String(e.path || url);
  const lower = url.toLowerCase();
  const reqCt = String((e.request_headers && (e.request_headers["content-type"] || e.request_headers["Content-Type"])) || "").toLowerCase();
  const resCt = String((e.response_headers && (e.response_headers["content-type"] || e.response_headers["Content-Type"])) || "").toLowerCase();
  const hasBody = !!(e.request_payload || e.response_body);
  const hasStack = !!e.initiator_stack;
  const importantWords = /(api|graphql|grpc|rpc|auth|token|session|login|oauth|csrf|nonce|sign|signature|credential|account|user|project|task|generate|generation|image|video|upload|download|conversation|message|completion|submit|create|poll|status|result)/i;
  const staticExt = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|map|woff2?|ttf|otf|mp4|webm|mp3|wav)(?:[?#]|$)/i;
  const noiseHost = /(google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|sentry|segment|mixpanel|hotjar|clarity|stats|telemetry|beacon|analytics|collect|log|metrics|rum)/i;
  if (importantWords.test(lower) || hasBody || hasStack || method !== "GET") return 100;
  if (staticExt.test(path) || noiseHost.test(lower)) return 0;
  if (/\/(?:assets?|static|fonts?|images?|img|icons?)\//i.test(path) && !/(api|upload|download)/i.test(path)) return 10;
  if (resCt && !/(json|text|event-stream|grpc|protobuf|javascript)/i.test(resCt)) return 15;
  if (reqCt || resCt.includes("json")) return 70;
  return 45;
}

function splitCleanupCandidates(source) {
  const autoDelete = [];
  const aiCandidates = [];
  const keep = [];
  const seenNoise = new Set();
  for (const e of source) {
    const score = cleanupEventScore(e);
    if (score <= 15) {
      let key = "";
      try {
        const u = new URL(e.url || "");
        key = `${String(e.method || "GET").toUpperCase()} ${u.origin}${u.pathname.replace(/[a-f0-9]{16,}/ig, ":id")}`;
      } catch (_) {
        key = `${e.method || "GET"} ${e.path || e.url || ""}`;
      }
      if (seenNoise.has(key)) autoDelete.push(e);
      else {
        seenNoise.add(key);
        aiCandidates.push(e);
      }
    } else if (score >= 90) {
      keep.push(e);
    } else {
      aiCandidates.push(e);
    }
  }
  return { autoDelete, aiCandidates, keep };
}

function compactCleanupPayload(list, limit = 350) {
  const sorted = list.slice().sort((a, b) => cleanupEventScore(b) - cleanupEventScore(a));
  return buildCleanupPayload(sorted.slice(0, limit));
}

function chunkArray(list, size) {
  const out = [];
  const n = Math.max(1, Number(size || 100));
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

async function askAiCleanupBatch(batch, batchIndex, batchCount, totalCount) {
  const payload = buildCleanupPayload(batch);
  const prompt = withTaskGoal(cleanupLogsPrompt) +
    `\n\n杩欐槸绗?${batchIndex + 1}/${batchCount} 鎵?Network Log 鎽樿銆傛湰鎵规渶澶?100 鏉★紱璇峰彧鍒ゆ柇鏈壒 delete_seq銆傛€诲€欓€夋暟锛?{totalCount}銆俓n\n` +
    "```json\n" + jsonText(payload) + "\n```";
  const resp = await sendAiChat({
    model: activeModel,
    max_tokens: Math.min(MAX_TOKENS, 2048),
    messages: [{ role: "user", content: prompt }]
  });
  if (resp && resp.stopped) return { stopped: true, deleteSeqs: [], reason: "" };
  if (!(resp && resp.ok)) throw new Error((resp && resp.error) || "cleanup failed");
  return parseCleanupResult(aiTextContent(resp.result));
}

function aiTextContent(msg) {
  const content = msg && msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b && b.type === "text")
    .map(b => b.text || "")
    .join("\n");
}

function parseCleanupResult(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("AI 未返回内容");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("AI 杩斿洖涓嶆槸 JSON");
    parsed = JSON.parse(body.slice(start, end + 1));
  }
  const arr = Array.isArray(parsed.delete_seq) ? parsed.delete_seq : (Array.isArray(parsed.deleteSeq) ? parsed.deleteSeq : []);
  const seqs = arr.map(x => Number(x)).filter(n => Number.isFinite(n));
  return {
    deleteSeqs: Array.from(new Set(seqs)),
    reason: String(parsed.reason || "")
  };
}

async function cleanupIrrelevantLogs() {
  return await cleanupNetworkLogsBatched({ fromAgent: false, batchSize: 100 });
}

async function cleanupIrrelevantLogsLegacy() {
  if (agentRunning) return;
  setAgentBusy(true);
  try {
    addSystemContext("正在暂停抓取并同步 Network Log 列表...");
    stopPolling();
    await send("popup.networkCapture.pause").catch(() => null);
    await refreshNetworkLogSnapshot();
    const source = (filteredEvents.length ? filteredEvents : events).filter(e => !deletedSeqs.has(Number(e.seq)));
    if (!source.length) {
      addSystemContext("娌℃湁鍙竻鐞嗙殑 Network Log");
      return;
    }
    addSystemContext("开始清理无关请求：待判断 " + source.length + " 条");
    const useFastPreclean = source.length > 200;
    const classified = useFastPreclean
      ? splitCleanupCandidates(source)
      : { autoDelete: [], aiCandidates: source, keep: [] };
    const autoSeqs = classified.autoDelete.map(e => Number(e.seq)).filter(n => Number.isFinite(n));
    if (autoSeqs.length) {
      await deleteNetworkEvents(autoSeqs);
      addSystemContext("已快速清理 " + autoSeqs.length + " 条");
    }
    let aiSource = classified.aiCandidates.filter(e => !deletedSeqs.has(Number(e.seq)));
    if (!aiSource.length) aiSource = source.filter(e => !deletedSeqs.has(Number(e.seq))).slice(0, 200);
    if (!aiSource.length) {
      persistNetworkLogCache();
      applyFilter();
      renderLogList();
      renderDetail();
      addSystemContext("娓呯悊瀹屾垚锛氬墿浣欒姹傚潎琚湰鍦拌鍒欏垽瀹氫负搴斾繚鐣欐垨鏃犻』 AI 鍒ゆ柇");
      return;
    }
    addSystemContext("AI 清理候选已压缩：总计 " + source.length + " 条，提交 " + Math.min(aiSource.length, 350) + " 条高价值候选");
    const payload = useFastPreclean ? compactCleanupPayload(aiSource, 350) : buildCleanupPayload(aiSource);
    const prompt = withTaskGoal(cleanupLogsPrompt) + "\n\nNetwork Log 鎽樿锛歕n\n```json\n" + jsonText(payload) + "\n```";
    const resp = await sendAiChat({
      model: activeModel,
      max_tokens: Math.min(MAX_TOKENS, 2048),
      messages: [{ role: "user", content: prompt }]
    });
    if (resp && resp.stopped) return;
    if (!(resp && resp.ok)) throw new Error((resp && resp.error) || "cleanup failed");
    const parsed = parseCleanupResult(aiTextContent(resp.result));
    const existing = new Set(source.map(e => Number(e.seq)));
    const seqs = parsed.deleteSeqs.filter(seq => existing.has(seq));
    if (!seqs.length) {
      addSystemContext(parsed.reason ? `鏈垹闄よ姹傦細${parsed.reason}` : "鏈垹闄よ姹傦細AI 鍒ゆ柇娌℃湁鏃犲叧鏃ュ織");
      return;
    }
    await deleteNetworkEvents(seqs);
    if (selectedIdx !== null && filteredEvents[selectedIdx] && deletedSeqs.has(Number(filteredEvents[selectedIdx].seq))) {
      selectedIdx = null;
    }
    applyFilter();
    renderLogList();
    renderDetail();
    addSystemContext(`宸叉竻鐞?${seqs.length} 鏉℃棤鍏宠姹?{parsed.reason ? "锛? + parsed.reason : ""}`);
  } catch (err) {
    addSystemContext(`清理无关请求失败: ${String(err && err.message || err)}`);
  } finally {
    setAgentBusy(false);
  }
}

function buildRecentNetworkSummary(limit) {
  const list = (filteredEvents.length ? filteredEvents : events).filter(e => !deletedSeqs.has(Number(e.seq)));
  return list.slice(Math.max(0, list.length - limit)).map(e => ({
    seq: e.seq,
    method: e.method || "",
    status: e.status || "",
    url: e.url || "",
    path: e.path || "",
    has_request_body: !!e.request_payload,
    has_response_body: !!e.response_body,
    has_stack: !!e.initiator_stack
  }));
}

function extractJavaScriptCode(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("AI 未返回代码");
  const fenced = raw.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

function trimChatHistoryForCode() {
  return chatHistory.slice(Math.max(0, chatHistory.length - 10));
}

async function saveTestConfig() {
  const configInput = $("testConfigJson");
  const patch = {};
  patch[TEST_STORAGE_KEYS.configJson] = configInput ? configInput.value.trim() : jsonText(DEFAULT_TEST_CONFIG);
  await chrome.storage.local.set(patch);
}

function getTestConfigText() {
  const input = $("testConfigJson");
  const text = input ? input.value.trim() : "";
  return text || jsonText(DEFAULT_TEST_CONFIG);
}

function parseTestConfigFromUi() {
  const text = getTestConfigText();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("测试配置 JSON 解析失败: " + String(err && err.message || err));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("测试配置必须是 JSON 对象");
  }
  return parsed;
}

function setTestConfigUi(config) {
  const input = $("testConfigJson");
  if (input) input.value = jsonText(config && typeof config === "object" && !Array.isArray(config) ? config : DEFAULT_TEST_CONFIG);
}

function getScriptParamsText() {
  const input = $("scriptParamsInput");
  const text = input ? input.value.trim() : "";
  return text || "";
}

function setScriptParamsText(value, options = {}) {
  const input = $("scriptParamsInput");
  const text = String(value || "").trim();
  if (input) input.value = text;
  if (options.syncTestConfig && text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setTestConfigUi(parsed);
        saveTestConfig().catch(() => {});
      }
    } catch (_) {}
  }
}

function ensureScriptParamsEditorValue() {
  const input = $("scriptParamsInput");
  if (input && !String(input.value || "").trim()) input.value = getTestConfigText();
}

function syncScriptParamsToTestConfig() {
  const text = getScriptParamsText();
  if (!text) return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("脚本参数 JSON 解析失败: " + String(err && err.message || err));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("脚本参数必须是 JSON 对象");
  }
  setTestConfigUi(parsed);
  saveTestConfig().catch(() => {});
}

function toggleScriptParamsExpanded() {
  const panel = $("scriptParamsPanel");
  if (!panel) return;
  panel.classList.toggle("expanded");
  const input = $("scriptParamsInput");
  if (input) input.focus();
}

async function resetTestConfig() {
  setTestConfigUi(DEFAULT_TEST_CONFIG);
  await saveTestConfig();
}

function flattenConfigPaths(value, prefix = "config", out = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  Object.keys(value).sort().forEach(key => {
    const path = `${prefix}.${key}`;
    const item = value[key];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out.push({ path, type: "object" });
      flattenConfigPaths(item, path, out);
    } else {
      out.push({ path, type: Array.isArray(item) ? "array" : typeof item });
    }
  });
  return out;
}

function buildConfigComment(config) {
  const rows = flattenConfigPaths(config && typeof config === "object" && !Array.isArray(config) ? config : DEFAULT_TEST_CONFIG);
  const lines = [
    "/*",
    "runGeneratedTest(config) parameter contract:",
    "The JSON in the Test Config box is passed as config. Keep this list even when some fields are unused."
  ];
  rows.forEach(row => lines.push(`- ${row.path}: ${row.type}`));
  lines.push("*/");
  return lines.join("\n");
}

function annotateGeneratedTestCode(code, config) {
  const body = String(code || "").trim() || DEFAULT_GENERATED_TEST_CODE;
  if (/runGeneratedTest\(config\) parameter contract/i.test(body)) return body;
  return `${buildConfigComment(config)}\n\n${body}`;
}

async function generateTestCodeViaInterface(options = {}) {
  const input = options && typeof options === "object" ? options : {};
  const selected = getSelectedEvent();
  const config = input.config && typeof input.config === "object" && !Array.isArray(input.config)
    ? input.config
    : (() => { try { return parseTestConfigFromUi(); } catch (_) { return DEFAULT_TEST_CONFIG; } })();
  if (input.saveConfig !== false) {
    setTestConfigUi(config);
    await saveTestConfig();
  }
  const context = {
    task_goal: input.taskGoal || activeTaskGoal,
    user_request: String(input.instruction || input.userRequest || ""),
    selected_event: selected ? buildSingleEventPayload(selected) : null,
    recent_network_log: buildRecentNetworkSummary(Number(input.networkLimit || 80) || 80),
    expected_entry: "async function runGeneratedTest(config)",
    config_shape: config,
    current_test_config: config,
    required_code_comment: buildConfigComment(config),
    default_test_code_example: DEFAULT_GENERATED_TEST_CODE,
    requirements: [
      "Only output JavaScript code.",
      "The code must expose async function runGeneratedTest(config).",
      "The code must read parameters from the single config object.",
      "The code must include a comment block listing every config parameter, even if some parameters are unused.",
      "Return a structured-clone-safe plain JSON value."
    ]
  };
  const userPrompt = withTaskGoal(testCodePrompt) + "\n\n补充上下文：\n\n```json\n" + jsonText(context) + "\n```";
  const messages = trimChatHistoryForCode();
  messages.push({ role: "user", content: userPrompt });
  const resp = await sendAiChat({
    model: activeModel,
    max_tokens: MAX_TOKENS,
    messages
  });
  if (resp && resp.stopped) return { ok: false, stopped: true };
  if (!(resp && resp.ok)) throw new Error((resp && resp.error) || "generate test code failed");
  generatedTestCode = annotateGeneratedTestCode(extractJavaScriptCode(aiTextContent(resp.result)), config);
  const draft = await persistGeneratedCodeFromAgent(generatedTestCode, {
    title: "AI 生成测试代码",
    description: "由生成测试代码流程自动创建。",
    script_params: jsonText(config)
  });
  return { ok: true, code: generatedTestCode, chars: generatedTestCode.length, config, draft };
}

async function generateTestCode() {
  if (agentRunning) return;
  setAgentBusy(true);
  addSystemContext(T("generatingTestCode"));
  try {
    const result = await generateTestCodeViaInterface({});
    if (result && result.stopped) return;
    const message = T("generatedTestCodeCached", { code: generatedTestCode });
    chatHistory.push({ role: "assistant", content: [{ type: "text", text: message }] });
    appendChatMsg("assistant", message, chatHistory.length - 1);
    if (result && result.draft && result.draft.ok === false) {
      addSystemContext("测试代码已保存到本地缓存，但上传我的脚本草稿失败：" + result.draft.error);
    } else if (result && result.draft && result.draft.scriptId) {
      addSystemContext("测试代码已保存到本地缓存，并上传为我的脚本草稿 #" + result.draft.scriptId);
    }
    persistChatHistory();
  } catch (err) {
    addSystemContext(T("generateTestCodeFailed", { error: String(err && err.message || err) }));
  } finally {
    setAgentBusy(false);
  }
}

function isInjectableTargetUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

async function getCurrentNormalWindowHttpTab() {
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const focused = (windows || []).find(win => win.focused);
    const ordered = focused ? [focused].concat((windows || []).filter(win => win !== focused)) : (windows || []);
    for (const win of ordered) {
      const tab = (win.tabs || []).find(t => t.active && t.id && isInjectableTargetUrl(t.url));
      if (tab) return tab;
    }
  } catch (_) {}
  return null;
}

async function getCaptureTargetTabId() {
  try {
    const resp = await send("popup.networkCapture.status");
    const st = resp && resp.result ? resp.result : {};
    return Number(st.tab_id || 0) || 0;
  } catch (_) {
    return 0;
  }
}

async function getCaptureStatus() {
  try {
    const resp = await send("popup.networkCapture.status");
    return resp && resp.result ? resp.result : {};
  } catch (_) {
    return {};
  }
}

async function getStartTargetTabId() {
  const currentTab = await getCurrentNormalWindowHttpTab();
  if (currentTab && currentTab.id) {
    await setActiveTargetTabId(currentTab.id).catch(() => {});
    return Number(currentTab.id);
  }
  throw new Error("找不到可抓包的当前目标页面");
}

async function getPreferredTargetTabId() {
  const selected = getSelectedEvent();
  if (selected && selected.tab_id) return Number(selected.tab_id);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] && events[i].tab_id) return Number(events[i].tab_id);
  }
  const captureTabId = await getCaptureTargetTabId();
  if (captureTabId) return captureTabId;
  if (activeTargetTabId) {
    try {
      const tab = await chrome.tabs.get(activeTargetTabId);
      if (tab && tab.id && isInjectableTargetUrl(tab.url)) return tab.id;
    } catch (_) {}
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs && tabs[0];
  if (tab && tab.id && isInjectableTargetUrl(tab.url)) return tab.id;
  throw new Error(T("targetInjectableNotFound"));
}

async function getGeneratedTestTargetTabId() {
  const st = await getCaptureStatus();
  const captureTabId = Number(st.tab_id || 0) || 0;
  if ((st.running || st.paused) && captureTabId) {
    try {
      const tab = await chrome.tabs.get(captureTabId);
      if (tab && tab.id && isInjectableTargetUrl(tab.url)) return tab.id;
      throw new Error(T("targetUnavailable"));
    } catch (err) {
      throw new Error(String(err && err.message || err || T("targetUnavailable")));
    }
  }

  const currentTab = await getCurrentNormalWindowHttpTab();
  if (currentTab && currentTab.id && isInjectableTargetUrl(currentTab.url)) {
    await setActiveTargetTabId(currentTab.id).catch(() => {});
    return Number(currentTab.id);
  }
  throw new Error(T("targetInjectableNotFound"));
}

async function runGeneratedTestForAgent(input = {}) {
  if (!generatedTestCode.trim()) {
    try {
      const got = await chrome.storage.local.get([TEST_STORAGE_KEYS.generatedCode]);
      if (typeof got[TEST_STORAGE_KEYS.generatedCode] === "string") generatedTestCode = got[TEST_STORAGE_KEYS.generatedCode];
    } catch (_) {}
  }
  if (!generatedTestCode.trim()) return { ok: false, error: "generated test code is empty" };
  const baseConfig = parseTestConfigFromUi();
  const inputConfig = input && typeof input.config === "object" && !Array.isArray(input.config) ? input.config : {};
  const legacyConfig = {};
  if (input.referenceImageUrl != null) legacyConfig.referenceImageUrl = String(input.referenceImageUrl || "");
  if (input.prompt != null) legacyConfig.prompt = String(input.prompt || "");
  const config = { ...baseConfig, ...inputConfig, ...legacyConfig };
  if (input.saveConfig !== false) {
    setTestConfigUi(config);
    await saveTestConfig();
  }
  const tabId = Number(input.tabId || 0) || await getGeneratedTestTargetTabId();
  const resp = await send("popup.analysis.runGeneratedTest", {
    tabId,
    code: generatedTestCode,
    config
  });
  if (!(resp && resp.ok)) return { ok: false, tabId, config, error: (resp && resp.error) || "unknown error" };
  return { ok: true, tabId, config, result: resp.result };
}

function buildTargetPageSnapshotExpression(input = {}) {
  const maxText = Math.max(1000, Math.min(20000, Number(input.maxText || 6000)));
  const maxLinks = Math.max(0, Math.min(200, Number(input.maxLinks || 80)));
  const maxForms = Math.max(0, Math.min(50, Number(input.maxForms || 20)));
  return `
(function() {
  function txt(v, n) { v = String(v || "").replace(/\\s+/g, " ").trim(); return v.length > n ? v.slice(0, n) + "...[truncated]" : v; }
  function attr(el, name) { try { return el.getAttribute(name) || ""; } catch (_) { return ""; } }
  var links = Array.prototype.slice.call(document.querySelectorAll("a[href]"), 0, ${maxLinks}).map(function(a) {
    return { text: txt(a.innerText || a.textContent || "", 120), href: a.href || attr(a, "href") };
  });
  var forms = Array.prototype.slice.call(document.forms || [], 0, ${maxForms}).map(function(f) {
    return {
      id: f.id || "",
      name: f.name || "",
      action: f.action || attr(f, "action"),
      method: f.method || "get",
      fields: Array.prototype.slice.call(f.elements || [], 0, 80).map(function(el) {
        return { tag: (el.tagName || "").toLowerCase(), type: el.type || "", name: el.name || "", id: el.id || "", placeholder: attr(el, "placeholder") };
      })
    };
  });
  var scripts = Array.prototype.slice.call(document.scripts || [], 0, 80).map(function(s) { return s.src || "[inline]"; });
  return {
    ok: true,
    url: location.href,
    title: document.title || "",
    readyState: document.readyState,
    lang: document.documentElement && document.documentElement.lang || "",
    bodyText: txt(document.body && document.body.innerText || "", ${maxText}),
    links: links,
    forms: forms,
    scripts: scripts,
    localStorageKeys: (function(){ try { return Object.keys(localStorage || {}).slice(0, 120); } catch (_) { return []; } })(),
    sessionStorageKeys: (function(){ try { return Object.keys(sessionStorage || {}).slice(0, 120); } catch (_) { return []; } })()
  };
})()
`;
}

async function evaluateTargetPageForAgent(input = {}) {
  const tabId = Number(input.tabId || 0) || await getPreferredTargetTabId();
  const expression = String(input.expression || "");
  if (!expression.trim()) return { ok: false, error: "expression is empty" };
  const resp = await send("popup.analysis.evaluateTargetPage", {
    tabId,
    expression,
    options: {
      awaitPromise: input.awaitPromise !== false,
      returnByValue: input.returnByValue !== false,
      userGesture: input.userGesture !== false,
      timeout: Math.max(1000, Math.min(120000, Number(input.timeout || 60000)))
    }
  });
  if (!(resp && resp.ok)) return { ok: false, tabId, error: (resp && resp.error) || "evaluate failed" };
  return { ok: true, tabId, result: resp.result };
}

async function runGeneratedTestCode() {
  if (agentRunning) return;
  if (!generatedTestCode.trim()) {
    try {
      const got = await chrome.storage.local.get([TEST_STORAGE_KEYS.generatedCode]);
      if (typeof got[TEST_STORAGE_KEYS.generatedCode] === "string") generatedTestCode = got[TEST_STORAGE_KEYS.generatedCode];
    } catch (_) {}
  }
  if (!generatedTestCode.trim()) {
    addSystemContext(T("generateTestCodeFirst"));
    return;
  }
  if (/\?\.|\?\?/.test(generatedTestCode)) {
    addSystemContext(T("legacySyntaxWarning"));
  }
  setAgentBusy(true);
  try {
    await saveTestConfig();
    const config = parseTestConfigFromUi();
    const tabId = await getGeneratedTestTargetTabId();
    addSystemContext(T("executingTestCode", { tabId }));
    const resp = await send("popup.analysis.runGeneratedTest", {
      tabId,
      code: generatedTestCode,
      config
    });
    if (!(resp && resp.ok)) {
      addSystemContext(T("testExecutionFailed", { error: (resp && resp.error) || "unknown error" }));
      return;
    }
    addToolContext(T("testResult"), resp.result);
  } catch (err) {
    addSystemContext(T("testExecutionFailed", { error: String(err && err.message || err) }));
  } finally {
    setAgentBusy(false);
  }
}

// 鈹€鈹€ tool executor 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function executeTool(name, input) {
  if (name === "get_network_log") {
    const q = (input.filter || "").toLowerCase();
    const limit = input.limit || 50;
    let list = events.filter(e => !deletedSeqs.has(Number(e.seq)));
    if (q) list = list.filter(e => {
      const url = (e.url || "").toLowerCase();
      const method = (e.method || "").toLowerCase();
      return url.includes(q) || method.includes(q);
    });
    list = list.slice(0, limit);
    return list.map(e => ({
      seq: e.seq,
      method: e.method,
      url: e.url,
      status: e.status,
      duration: e.duration_ms,
      hasStack: !!(e.initiator_stack)
    }));
  }
  if (name === "get_request_detail") {
    const evt = events.find(x => Number(x.seq) === Number(input.seq) && !deletedSeqs.has(Number(x.seq)));
    if (!evt) return { error: `seq ${input.seq} not found` };
    return evt;
  }
  if (name === "fetch_script_fragment") {
    const resp = await send("popup.analysis.fetchScriptFragment", {
      url: input.url, line: input.line, column: input.column
    });
    if (!(resp && resp.ok)) return { error: (resp && resp.error) || "fetch failed" };
    return { fragment: resp.fragment, cursorOffset: resp.cursorOffset };
  }
  if (name === "get_target_page_snapshot") {
    return await evaluateTargetPageForAgent({
      tabId: input.tabId,
      expression: buildTargetPageSnapshotExpression(input || {}),
      timeout: input.timeout || 60000
    });
  }
  if (name === "evaluate_target_page") {
    return await evaluateTargetPageForAgent(input || {});
  }
  if (name === "cleanup_network_logs") {
    return await cleanupNetworkLogsBatched({
      fromAgent: true,
      batchSize: Math.min(100, Math.max(1, Number((input && input.batchSize) || 100))),
      maxBatches: Math.max(0, Number((input && input.maxBatches) || 0))
    });
  }
  if (name === "search_events") {
    const kw = (input.keyword || "").toLowerCase();
    const limit = input.limit || 20;
    const results = [];
    for (const e of events) {
      if (results.length >= limit) break;
      if (deletedSeqs.has(Number(e.seq))) continue;
      const url = (e.url || "").toLowerCase();
      const reqBody = (e.request_payload || "").toLowerCase();
      const resBody = (e.response_body || "").toLowerCase();
      if (url.includes(kw) || reqBody.includes(kw) || resBody.includes(kw)) {
        results.push({ seq: e.seq, method: e.method, url: e.url, status: e.status });
      }
    }
    return results;
  }
  if (name === "generate_test_code") {
    return await generateTestCodeViaInterface(input || {});
  }
  if (name === "save_generated_test_code") {
    const code = extractJavaScriptCode(input.code || "");
    if (!code.trim()) return { ok: false, error: "code is empty" };
    const config = input.config && typeof input.config === "object" && !Array.isArray(input.config)
      ? input.config
      : (() => { try { return parseTestConfigFromUi(); } catch (_) { return DEFAULT_TEST_CONFIG; } })();
    generatedTestCode = annotateGeneratedTestCode(code, config);
    const draft = await persistGeneratedCodeFromAgent(generatedTestCode, {
      title: "AI 修订测试代码",
      description: "由智能体对话中的 save_generated_test_code 自动创建。",
      script_params: jsonText(config)
    });
    return { ok: true, chars: generatedTestCode.length, entry_detected: /runGeneratedTest\s*\(/.test(generatedTestCode), draft };
  }
  if (name === "get_generated_test_code") {
    if (!generatedTestCode.trim()) {
      try {
        const got = await chrome.storage.local.get([TEST_STORAGE_KEYS.generatedCode]);
        if (typeof got[TEST_STORAGE_KEYS.generatedCode] === "string") generatedTestCode = got[TEST_STORAGE_KEYS.generatedCode];
      } catch (_) {}
    }
    return { ok: true, code: generatedTestCode, chars: generatedTestCode.length };
  }
  if (name === "run_generated_test") {
    return await runGeneratedTestForAgent(input || {});
  }
  return { error: `unknown tool: ${name}` };
}

// 鈹€鈹€ AI agent loop 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function runAgent(userMessage) {
  if (agentRunning) return;
  setAgentBusy(true);
  chatHistory.push({ role: "user", content: userMessage });
  appendChatContentMsg("user", userMessage, chatHistory.length - 1);
  persistChatHistory();
  try {
    let missingToolUseRepairCount = 0;
    for (let turn = 0; turn < 20; turn++) {
      if (agentStopRequested) break;
      const resp = await sendAiChat({
        model: activeModel,
        max_tokens: MAX_TOKENS,
        system: AGENT_SYSTEM_PROMPT,
        tools: AI_TOOLS,
        messages: chatMessagesForApi(chatHistory)
      });
      if (resp && resp.stopped) break;
      if (!(resp && resp.ok)) {
        addSystemContext(T("requestFailed", { error: (resp && resp.error) || "unknown error" }));
        break;
      }
      const msg = resp.result;
      chatHistory.push({ role: "assistant", content: msg.content });
      const assistantHistoryIndex = chatHistory.length - 1;
      persistChatHistory();
      const textBlocks = (msg.content || []).filter(b => b.type === "text");
      if (textBlocks.length) appendChatMsg("assistant", textBlocks.map(b => b.text).join("\n"), assistantHistoryIndex);
      if (msg.stop_reason === "end_turn") break;
      if (msg.stop_reason !== "tool_use") {
        addSystemContext(T("stopReason", { reason: msg.stop_reason }));
        break;
      }
      const toolUseBlocks = (msg.content || []).filter(b => b.type === "tool_use");
      if (!toolUseBlocks.length) {
        const assistantText = textBlocks.map(b => b.text).join("\n");
        if (await handleMissingToolUseFromAssistantText(assistantText)) {
          missingToolUseRepairCount = 0;
          continue;
        }
        missingToolUseRepairCount += 1;
        if (missingToolUseRepairCount > 2) {
          addSystemContext("AI repeatedly requested tool use without tool parameters. Please send a new instruction or retry.");
          break;
        }
        const repairText = "You ended with stop_reason=tool_use but did not include any tool_use block. Continue now: if you need to inspect or modify the generated test code, call the appropriate tool (get_generated_test_code, save_generated_test_code, or run_generated_test). If no tool is needed, answer directly without requesting a tool.";
        chatHistory.push({ role: "user", content: `[system]\n${repairText}` });
        persistChatHistory();
        addSystemNotice("AI requested a tool but did not provide tool parameters; asking it to continue with a valid tool call.");
        continue;
      }
      missingToolUseRepairCount = 0;
      const toolResults = [];
      const toolDisplayTexts = [];
      for (const tb of toolUseBlocks) {
        if (agentStopRequested) break;
        addSystemNotice(`调用工具: ${tb.name}(${JSON.stringify(tb.input)})`);
        let result;
        try { result = await executeTool(tb.name, tb.input); }
        catch (err) { result = { error: String(err) }; }
        if (agentStopRequested) break;
        const resultText = stringifyToolResult(result);
        const displayText = formatToolResultForDisplay(tb, resultText);
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: resultText, display_text: displayText });
        toolDisplayTexts.push(displayText);
      }
      if (agentStopRequested) break;
      if (!toolResults.length) {
        addSystemContext("Tool execution ended without any result blocks.");
        break;
      }
      chatHistory.push({ role: "user", content: toolResults });
      appendChatMsg("tool", toolDisplayTexts.join("\n\n---\n\n") || chatContentToText(toolResults) || "(empty tool result)", chatHistory.length - 1);
      persistChatHistory();
    }
  } catch (err) {
    addSystemContext(`寮傚父: ${String(err)}`);
  } finally {
    setAgentBusy(false);
  }
}

// 鈹€鈹€ AI tool definitions 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const AI_TOOLS = [
  {
    name: "get_network_log",
    description: "获取当前捕获的网络请求列表，可按 URL/方法过滤，返回 seq/method/url/status/duration 摘要。",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional keyword to filter URL or method" },
        limit: { type: "integer", description: "Max rows to return, default 50" }
      }
    }
  },
  {
    name: "get_request_detail",
    description: "获取指定 seq 的请求完整详情，包含请求头/体、响应头/体和调用栈。",
    input_schema: {
      type: "object",
      properties: {
        seq: { type: "integer", description: "Network event seq" }
      },
      required: ["seq"]
    }
  },
  {
    name: "fetch_script_fragment",
    description: "从 JS 文件指定 line:col 位置抓取约 4KB 代码片段，用于分析混淆或压缩 JS 逻辑。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "JavaScript file URL" },
        line: { type: "integer", description: "0-based line number" },
        column: { type: "integer", description: "0-based column number" }
      },
      required: ["url", "line", "column"]
    }
  },
  {
    name: "get_target_page_snapshot",
    description: "Inspect the live target web page opened/captured by the extension. Returns URL, title, visible text, links, forms, scripts, and storage keys. Use this when the user asks about the page itself, DOM, UI, forms, state, or page capabilities.",
    input_schema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Optional target tab id; omit to use selected/captured tab" },
        maxText: { type: "integer", description: "Max visible body text chars, default 6000" },
        maxLinks: { type: "integer", description: "Max links, default 80" },
        maxForms: { type: "integer", description: "Max forms, default 20" }
      }
    }
  },
  {
    name: "evaluate_target_page",
    description: "Run focused JavaScript in the live target page and return a serializable value. Use for safe diagnostics or page analysis. Prefer read-only expressions unless the user explicitly asks to act.",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression or async IIFE to evaluate in the target page" },
        tabId: { type: "integer", description: "Optional target tab id; omit to use selected/captured tab" },
        timeout: { type: "integer", description: "Timeout in ms, default 60000" },
        awaitPromise: { type: "boolean", description: "Await promise results, default true" },
        returnByValue: { type: "boolean", description: "Return serializable value, default true" },
        userGesture: { type: "boolean", description: "Evaluate with user gesture, default true" }
      },
      required: ["expression"]
    }
  },
  {
    name: "cleanup_network_logs",
    description: "Clean irrelevant Network Log entries when the user asks to clean, prune, reduce, or remove unrelated requests. Internally pauses capture, syncs logs, then asks AI in multiple batches of at most 100 records per request, so it will not send more than 100 records to AI at once.",
    input_schema: {
      type: "object",
      properties: {
        batchSize: { type: "integer", description: "Records per AI cleanup batch. Max 100, default 100." },
        maxBatches: { type: "integer", description: "Optional maximum number of batches to process. 0 or omitted means all batches." }
      }
    }
  },
  {
    name: "search_events",
    description: "Search captured events by keyword in URL, request body, or response body.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Search keyword" },
        limit: { type: "integer", description: "Max rows to return, default 20" }
      },
      required: ["keyword"]
    }
  },
  {
    name: "generate_test_code",
    description: "Generate runnable JavaScript test code using the same interface as the Generate Test Code button, save it to local cache, and create a new My Scripts draft on the server when possible. The code must expose async function runGeneratedTest(config), use the single JSON config object, and include a comment block listing every config parameter even if unused.",
    input_schema: {
      type: "object",
      properties: {
        config: { type: "object", description: "Optional full JSON config object passed to runGeneratedTest(config). If omitted, the Test Config JSON box is used." },
        instruction: { type: "string", description: "Optional extra instruction for what the generated test should do." },
        taskGoal: { type: "string", description: "Optional task goal override." },
        networkLimit: { type: "integer", description: "Recent network log rows to include, default 80." },
        saveConfig: { type: "boolean", description: "Whether to persist config into the Test Config JSON box, default true." }
      }
    }
  },
  {
    name: "save_generated_test_code",
    description: "Save runnable JavaScript test code for the target page to local cache and a new My Scripts server draft when possible. Use this before run_generated_test when you manually revise code. The code must expose async function runGeneratedTest(config), use the single JSON config object, and include/receive an auto-added parameter comment block.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code or a fenced javascript code block" },
        config: { type: "object", description: "Optional full JSON config object used to build the parameter comment block. If omitted, the Test Config JSON box is used." }
      },
      required: ["code"]
    }
  },
  {
    name: "get_generated_test_code",
    description: "Read the currently cached generated test code.",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "run_generated_test",
    description: "Run the cached generated test code in the target browser tab through the debugger. Returns the structured result or an execution error. Use after save_generated_test_code.",
    input_schema: {
      type: "object",
      properties: {
        config: { type: "object", description: "Optional full JSON config object merged into runGeneratedTest(config). Use this for arbitrary custom parameters." },
        referenceImageUrl: { type: "string", description: "Optional reference image URL passed as config.referenceImageUrl" },
        prompt: { type: "string", description: "Optional test prompt passed as config.prompt" },
        tabId: { type: "integer", description: "Optional target tab id; omit to use the selected/captured tab" },
        saveConfig: { type: "boolean", description: "Whether to persist the merged config JSON, default true" }
      }
    }
  }
];

// 鈹€鈹€ single-event payload for token analysis 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function buildSingleEventPayload(ev) {
  const LIMIT = 8000;
  const trim = (s) => { s = String(s || ""); return s.length > LIMIT ? s.slice(0, LIMIT) + "鈥truncated]" : s; };
  return {
    seq: ev.seq, method: ev.method, url: ev.url, path: ev.path, status: ev.status,
    request_headers: ev.request_headers || {},
    request_payload: trim(ev.request_payload || ""),
    response_headers: ev.response_headers || {},
    response_body: trim(ev.response_body || ""),
    initiator_stack: ev.initiator_stack || "",
  };
}

// 鈹€鈹€ init + event wiring 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function init() {
  await waitForI18nReady();
  try {
    const gotTarget = await chrome.storage.local.get([ANALYSIS_TARGET_TAB_STORAGE_KEY]);
    const storedTargetTabId = Number(gotTarget[ANALYSIS_TARGET_TAB_STORAGE_KEY] || 0) || 0;
    if (storedTargetTabId) activeTargetTabId = storedTargetTabId;
  } catch (_) {}
  await refreshTargetPageInfo();

  await loadPromptCache();
  await restoreChatPaneHeight();
  await loadNetworkLogCache();

  // fetch initial status and seed event list
  const snap = await send("popup.networkCapture.snapshot", { since_seq: 0, limit: 1000 });
  const initialEvents = snap && snap.ok && snap.result && Array.isArray(snap.result.events)
    ? snap.result.events.filter(e => !deletedSeqs.has(Number(e.seq)))
    : [];
  if (initialEvents.length) {
    events = mergeNetworkEvents(events, initialEvents);
    sinceSeq = initialEvents[initialEvents.length - 1].seq + 1;
    applyFilter();
    renderLogList();
    persistNetworkLogCache();
  }
  startPolling();
  refreshCaptureControls().catch(() => {});
  window.addEventListener("fpb-language-changed", () => {
    renderTaskGoalSelect();
    renderLogList();
    renderDetail();
    renderChatHistory({ scroll: false });
    renderNetworkReferences();
    refreshTargetPageInfo().catch(() => {});
    refreshCaptureControls().catch(() => {});
  });
  setInterval(() => refreshCaptureControls().catch(() => {}), 1000);
  setInterval(() => refreshTargetPageInfo().catch(() => {}), 3000);

  // 鈹€鈹€ analysis config UI 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const modelSelect = $("analysisModelSelect");

  // eye-icon toggle for API key visibility
  const toggleApiKeyBtn = $("toggleApiKeyBtn");
  if (toggleApiKeyBtn) toggleApiKeyBtn.addEventListener("click", () => {
    const inp = $("analysisApiKey");
    if (!inp) return;
    inp.type = inp.type === "password" ? "text" : "password";
  });
  const applyKeyBtn = $("applyKeyBtn");
  if (applyKeyBtn) applyKeyBtn.addEventListener("click", () => {
    const url = "https://api.newtoken.club";
    try {
      chrome.tabs.create({ url });
    } catch (_) {
      window.open(url, "_blank", "noopener");
    }
  });

  // populate model select from remote; fallback to preset list on error
  async function loadModels(savedModel) {
    if (!modelSelect) return;
    const apiKeyInput = $("analysisApiKey");
    const apiKey = apiKeyInput ? apiKeyInput.value.trim() : "";
    modelSelect.disabled = true;
      modelSelect.innerHTML = `<option value="">${esc(T("loadingModels"))}</option>`;
    try {
      const resp = await fetch("https://api.newtoken.club/v1/models", {
        headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const ids = (data.data || []).map(m => typeof m === "string" ? m : String(m.id || m.name || "")).filter(Boolean);
      modelSelect.innerHTML = "";
      ids.forEach(id => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id;
        modelSelect.appendChild(opt);
      });
      // add custom option at end
      const customOpt = document.createElement("option");
      customOpt.value = "__custom__";
      customOpt.textContent = T("custom");
      modelSelect.appendChild(customOpt);
      // restore saved selection
      if (savedModel) {
        if ([...modelSelect.options].some(o => o.value === savedModel)) {
          modelSelect.value = savedModel;
        } else if (savedModel !== "__custom__") {
          const opt = document.createElement("option");
          opt.value = savedModel;
          opt.textContent = savedModel;
          modelSelect.insertBefore(opt, modelSelect.firstChild);
          modelSelect.value = savedModel;
        }
      }
    } catch (_) {
      // fallback to preset list
      modelSelect.innerHTML = "";
      PRESET_MODELS.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      });
      if (savedModel) {
        const isPreset = PRESET_MODELS.some(m => m.id === savedModel && m.id !== "__custom__");
        if (isPreset) {
          modelSelect.value = savedModel;
        } else {
          modelSelect.value = "__custom__";
          const custom = $("analysisModelCustom");
          if (custom) { custom.value = savedModel; custom.style.display = ""; }
        }
      }
    } finally {
      modelSelect.disabled = false;
    }
  }

  // trigger model load when dropdown is opened
  if (modelSelect) modelSelect.addEventListener("mousedown", () => {
    // only reload if showing placeholder
    const firstOption = modelSelect.options[0];
    if (modelSelect.options.length <= 1 && (!firstOption || firstOption.value === "" || firstOption.value === "__custom__")) {
      loadModels(activeModel);
    }
  });
  if (modelSelect) modelSelect.addEventListener("focus", () => {
    if (modelSelect.options.length <= 1) loadModels(activeModel);
  });

  if (modelSelect) modelSelect.addEventListener("change", () => {
    const custom = $("analysisModelCustom");
    if (modelSelect.value === "__custom__") {
      if (custom) { custom.style.display = ""; custom.focus(); }
    } else {
      if (custom) custom.style.display = "none";
      if (modelSelect.value) activeModel = modelSelect.value;
    }
  });

  // load saved config
  try {
    const cfgResp = await send("popup.analysis.getConfig");
    if (cfgResp && cfgResp.ok) {
      const c = cfgResp.result || {};
      if (c.apiKey) $("analysisApiKey").value = c.apiKey;
      if (c.model) {
        activeModel = c.model;
        await loadModels(c.model);
      }
    }
  } catch (_) {}

  const saveAnalysisConfigBtn = $("saveAnalysisConfigBtn");
  if (saveAnalysisConfigBtn) saveAnalysisConfigBtn.addEventListener("click", async () => {
    const apiKeyInput = $("analysisApiKey");
    const apiKey = apiKeyInput ? apiKeyInput.value.trim() : "";
    const selVal = (modelSelect && modelSelect.value) || "claude-sonnet-4-6";
    const model = selVal === "__custom__"
      ? (($("analysisModelCustom") && $("analysisModelCustom").value.trim()) || "claude-sonnet-4-6")
      : selVal;
    activeModel = model;
    const btn = $("saveAnalysisConfigBtn");
    const origText = btn.textContent;
    try {
      await send("popup.analysis.saveConfig", { config: { apiKey, model } });
      btn.textContent = T("saved");
    } catch (_) {
      btn.textContent = T("saveFailed");
    }
    setTimeout(() => { btn.textContent = origText; }, 1200);
  });

  const tbClearBtn = $("tbClearBtn");
  if (tbClearBtn) tbClearBtn.addEventListener("click", async () => {
    await clearNetworkLogList();
  });
  const refreshLogBtn = $("refreshLogBtn");
  if (refreshLogBtn) refreshLogBtn.addEventListener("click", async () => {
    const oldText = refreshLogBtn.textContent;
    refreshLogBtn.disabled = true;
    refreshLogBtn.textContent = T("refreshing");
    try {
      await refreshNetworkLogSnapshot();
      await refreshCaptureControls().catch(() => {});
    } finally {
      refreshLogBtn.disabled = false;
      refreshLogBtn.textContent = oldText;
    }
  });
  const captureToggleBtn = $("captureToggleBtn");
  if (captureToggleBtn) captureToggleBtn.addEventListener("click", async () => {
    const resp = await send("popup.networkCapture.status");
    const st = resp && resp.result ? resp.result : {};
    if (!st.running && !st.paused) await captureAction("start");
    else if (st.paused) await captureAction("resume");
    else await captureAction("pause");
    await refreshNetworkLogSnapshot().catch(() => {});
  });
  const captureStopBtn = $("captureStopBtn");
  if (captureStopBtn) captureStopBtn.addEventListener("click", async () => {
    await captureAction("stop");
    await refreshNetworkLogSnapshot().catch(() => {});
  });
  // log list click
  const logList = $("logList");
  if (logList) logList.addEventListener("click", e => {
    const target = e.target;
    const delBtn = target && target.closest ? target.closest(".li-del") : null;
    if (delBtn) {
      e.stopPropagation();
      const seq = Number(delBtn.dataset.delSeq);
      deleteNetworkEvents([seq]).catch(err => addSystemContext(`删除 Network Log 失败：${String(err && err.message || err)}`));
      return;
    }
    const item = target && target.closest ? target.closest(".log-item") : null;
    if (!item) return;
    const idx = Number(item.dataset.idx);
    selectedIdx = idx;
    document.querySelectorAll(".log-item").forEach((el, i) => el.classList.toggle("selected", i === idx));
    addNetworkReference(filteredEvents[idx]);
    renderDetail();
  });

  // filter input
  const filterInput = $("filterInput");
  if (filterInput) filterInput.addEventListener("input", e => {
    filterText = e.target.value;
    selectedIdx = null;
    applyFilter();
    renderLogList();
    renderDetail();
  });

  // detail tab buttons
  document.querySelectorAll(".detail-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeDetailTab = btn.dataset.tab;
      document.querySelectorAll(".detail-tab").forEach(b => b.classList.toggle("active", b === btn));
      renderDetail();
    });
  });
  const editLogBtn = $("editLogBtn");
  if (editLogBtn) editLogBtn.addEventListener("click", openNetworkLogEditor);

  // chat send button
  const sendBtn = $("sendBtn");
  if (sendBtn) sendBtn.addEventListener("click", () => {
    if (agentRunning) {
      stopAgentRun();
      return;
    }
    const input = $("chatInput");
    const text = input ? input.value.trim() : "";
    if (!text && !pendingImages.length && !getReferencedEvents().length) return;
    const images = pendingImages.slice();
    const content = withReferencedNetworkContext(buildUserContent(text, images));
    if (input) input.value = "";
    pendingImages = [];
    renderPendingImages();
    resizeChatInput(input);
    runAgent(content);
  });
  const chatInput = $("chatInput");
  if (chatInput) {
    resizeChatInput(chatInput);
    chatInput.addEventListener("input", () => resizeChatInput(chatInput));
    chatInput.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const btn = $("sendBtn");
        if (btn) btn.click();
      }
    });
    chatInput.addEventListener("paste", e => {
      const files = [];
      const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
      items.forEach(item => {
        if (item && /^image\//i.test(item.type || "")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      });
      if (files.length) addPendingImageFiles(files);
    });
  }
  const imageUploadInput = $("imageUploadInput");
  const attachImageBtn = $("attachImageBtn");
  if (attachImageBtn) attachImageBtn.addEventListener("click", () => {
    if (agentRunning) return;
    if (imageUploadInput) imageUploadInput.click();
  });
  if (imageUploadInput) imageUploadInput.addEventListener("change", e => {
    addPendingImageFiles(e.target.files).finally(() => { e.target.value = ""; });
  });
  const networkReferenceBar = $("networkReferenceBar");
  if (networkReferenceBar) networkReferenceBar.addEventListener("click", e => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-ref-remove-seq]") : null;
    if (!btn) return;
    referencedSeqs.delete(Number(btn.dataset.refRemoveSeq));
    renderNetworkReferences();
  });
  const clearNetworkRefsBtn = $("clearNetworkRefsBtn");
  if (clearNetworkRefsBtn) clearNetworkRefsBtn.addEventListener("click", () => {
    referencedSeqs = new Set();
    renderNetworkReferences();
  });
  const chatPaneDrop = $("chatPane");
  if (chatPaneDrop) {
    chatPaneDrop.addEventListener("dragover", e => {
      const hasFile = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
      if (!hasFile) return;
      e.preventDefault();
    });
    chatPaneDrop.addEventListener("drop", e => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault();
      addPendingImageFiles(files);
    });
  }
  const chatMessages = $("chatMessages");
  if (chatMessages) chatMessages.addEventListener("click", e => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-chat-action]") : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const index = Number(btn.dataset.historyIndex);
    if (btn.dataset.chatAction === "delete-one") deleteChatHistoryAt(index);
    else if (btn.dataset.chatAction === "delete-from") deleteChatHistoryFrom(index);
  });

  const taskGoalSelect = $("taskGoalSelect");
  if (taskGoalSelect) taskGoalSelect.addEventListener("change", () => {
    if (taskGoalSelect.value === "__add_custom__") {
      addCustomTaskGoal().catch(err => appendChatMsg("system-note", `淇濆瓨浠诲姟鐩爣澶辫触: ${String(err && err.message || err)}`));
      return;
    }
    activeTaskGoal = taskGoalSelect.value;
    saveTaskGoalState().catch(err => appendChatMsg("system-note", `淇濆瓨浠诲姟鐩爣澶辫触: ${String(err && err.message || err)}`));
  });

  const editAllPromptBtn = $("editAllPromptBtn");
  if (editAllPromptBtn) editAllPromptBtn.addEventListener("click", e => {
    e.stopPropagation();
    openPromptEditor("all");
  });
  const editTokenPromptBtn = $("editTokenPromptBtn");
  if (editTokenPromptBtn) editTokenPromptBtn.addEventListener("click", e => {
    e.stopPropagation();
    openPromptEditor("token");
  });
  const editCleanupPromptBtn = $("editCleanupPromptBtn");
  if (editCleanupPromptBtn) editCleanupPromptBtn.addEventListener("click", e => {
    e.stopPropagation();
    openPromptEditor("cleanup");
  });
  const editTestCodePromptBtn = $("editTestCodePromptBtn");
  if (editTestCodePromptBtn) editTestCodePromptBtn.addEventListener("click", e => {
    e.stopPropagation();
    openPromptEditor("testCode");
  });
  const promptCloseBtn = $("promptCloseBtn");
  if (promptCloseBtn) promptCloseBtn.addEventListener("click", closePromptEditor);
  const promptResetBtn = $("promptResetBtn");
  if (promptResetBtn) promptResetBtn.addEventListener("click", resetPromptEditor);
  const promptSaveBtn = $("promptSaveBtn");
  if (promptSaveBtn) promptSaveBtn.addEventListener("click", () => {
    savePromptEditor().catch(err => {
      setPromptSaveStatus(T("saveFailed") + ": " + String(err && err.message || err), true);
      appendChatMsg("system-note", `淇濆瓨 Prompt 澶辫触: ${String(err && err.message || err)}`);
    });
  });
  const promptTextarea = $("promptTextarea");
  if (promptTextarea) {
    promptTextarea.addEventListener("input", () => {
      updatePromptLineNumbers();
      const bar = $("promptFindBar");
      if (bar && bar.classList.contains("active")) runPromptFind(0, false);
    });
    promptTextarea.addEventListener("scroll", updatePromptLineNumbers);
  }
  const promptFindInput = $("promptFindInput");
  if (promptFindInput) {
    promptFindInput.addEventListener("input", () => runPromptFind(0, false));
    promptFindInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        runPromptFind(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setPromptFindBarActive(false);
        const textarea = $("promptTextarea");
        if (textarea) textarea.focus();
      }
    });
  }
  const promptFindPrevBtn = $("promptFindPrevBtn");
  if (promptFindPrevBtn) promptFindPrevBtn.addEventListener("click", () => runPromptFind(-1));
  const promptFindNextBtn = $("promptFindNextBtn");
  if (promptFindNextBtn) promptFindNextBtn.addEventListener("click", () => runPromptFind(1));
  const promptFindCloseBtn = $("promptFindCloseBtn");
  if (promptFindCloseBtn) promptFindCloseBtn.addEventListener("click", () => {
    setPromptFindBarActive(false);
    const textarea = $("promptTextarea");
    if (textarea) textarea.focus();
  });
  document.addEventListener("keydown", handlePromptEditorKeydown);
  const promptModal = $("promptModal");
  if (promptModal) promptModal.addEventListener("click", e => {
    if (e.target === promptModal) closePromptEditor();
  });

  // analyze all button
  const analyzeAllBtn = $("analyzeAllBtn");
  if (analyzeAllBtn) analyzeAllBtn.addEventListener("click", () => {
    if (agentRunning) return;
    const BODY_LIMIT = 4000;
    const trimmedEvents = (filteredEvents.length ? filteredEvents : events)
      .filter(ev => !deletedSeqs.has(Number(ev.seq)))
      .map(ev => {
      const e = { ...ev };
      if (typeof e.request_payload === "string" && e.request_payload.length > BODY_LIMIT)
        e.request_payload = e.request_payload.slice(0, BODY_LIMIT) + "鈥truncated]";
      if (typeof e.response_body === "string" && e.response_body.length > BODY_LIMIT)
        e.response_body = e.response_body.slice(0, BODY_LIMIT) + "鈥truncated]";
      return e;
    });
    const label = "共 " + trimmedEvents.length + " 条";
    const MAX_MSG = 180000;
    let payloadJson = jsonText(trimmedEvents);
    if (payloadJson.length > MAX_MSG) payloadJson = payloadJson.slice(0, MAX_MSG) + "\n...[内容过长已截断]";
    const prompt = withTaskGoal(analysisAllPrompt) + "\n\n网络抓包数据（" + label + "）：\n\n```json\n" + payloadJson + "\n```";
    runAgent(prompt);
  });

  // analyze token button
  const analyzeTokenBtn = $("analyzeTokenBtn");
  if (analyzeTokenBtn) analyzeTokenBtn.addEventListener("click", () => {
    if (agentRunning) return;
    const ev = getSelectedEvent();
    if (!ev) return;
    const payload = buildSingleEventPayload(ev);
    const prompt = withTaskGoal(tokenAnalysisPrompt) + "\n\n璇锋眰璇︽儏锛歕n\n```json\n" + jsonText(payload) + "\n```";
    runAgent(prompt);
  });

  const cleanupLogsBtn = $("cleanupLogsBtn");
  if (cleanupLogsBtn) cleanupLogsBtn.addEventListener("click", () => {
    cleanupIrrelevantLogs();
  });

  const generateTestCodeBtn = $("generateTestCodeBtn");
  if (generateTestCodeBtn) generateTestCodeBtn.addEventListener("click", () => {
    generateTestCode();
  });

  const runGeneratedTestBtn = $("runGeneratedTestBtn");
  if (runGeneratedTestBtn) runGeneratedTestBtn.addEventListener("click", () => {
    runGeneratedTestCode();
  });

  const editGeneratedCodeBtn = $("editGeneratedCodeBtn");
  if (editGeneratedCodeBtn) editGeneratedCodeBtn.addEventListener("click", e => {
    e.stopPropagation();
    openPromptEditor("generatedCode");
  });

  setupScriptManagerLayout();
  const scriptManagerTabs = $("scriptManagerTabs");
  if (scriptManagerTabs) scriptManagerTabs.addEventListener("click", e => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-script-manager-tab]") : null;
    if (!btn) return;
    setScriptManagerTab(btn.dataset.scriptManagerTab);
  });
  const openScriptSquareBtn = $("openScriptSquareBtn");
  if (openScriptSquareBtn) openScriptSquareBtn.addEventListener("click", () => {
    const url = "https://www.newtoken.club/scripts";
    try {
      chrome.tabs.create({ url });
    } catch (_) {
      window.open(url, "_blank", "noopener");
    }
  });

  const refreshMyScriptsBtn = $("refreshMyScriptsBtn");
  if (refreshMyScriptsBtn) refreshMyScriptsBtn.addEventListener("click", () => {
    loadMyScriptsForPanel().catch(err => setScriptManagerStatus(String(err && err.message || err), true));
  });
  const myScriptSelect = $("myScriptSelect");
  if (myScriptSelect) myScriptSelect.addEventListener("change", () => {
    loadSelectedMyScript().catch(err => setScriptManagerStatus(String(err && err.message || err), true));
  });
  const newScriptDraftBtn = $("newScriptDraftBtn");
  if (newScriptDraftBtn) newScriptDraftBtn.addEventListener("click", () => {
    resetScriptDraftPanel();
    setScriptManagerStatus("已切换为新脚本草稿");
  });
  const loadSquareScriptBtn = $("loadSquareScriptBtn");
  if (loadSquareScriptBtn) loadSquareScriptBtn.addEventListener("click", () => {
    loadSquareScriptToEditor().catch(err => setScriptManagerStatus(String(err && err.message || err), true));
  });
  const editScriptParamsBtn = $("editScriptParamsBtn");
  if (editScriptParamsBtn) editScriptParamsBtn.addEventListener("click", () => {
    toggleScriptParamsExpanded();
  });

  const testConfigJson = $("testConfigJson");
  if (testConfigJson) {
    testConfigJson.addEventListener("change", () => saveTestConfig().catch(() => {}));
    testConfigJson.addEventListener("blur", () => saveTestConfig().catch(() => {}));
  }
  const resetTestConfigBtn = $("resetTestConfigBtn");
  if (resetTestConfigBtn) resetTestConfigBtn.addEventListener("click", () => {
    resetTestConfig().catch(err => appendChatMsg("system-note", String(err && err.message || err)));
  });
  const editTestConfigBtn = $("editTestConfigBtn");
  if (editTestConfigBtn) editTestConfigBtn.addEventListener("click", () => {
    openPromptEditor("testConfig");
  });

  // clear chat button
  const clearChatBtn = $("clearChatBtn");
  if (clearChatBtn) clearChatBtn.addEventListener("click", clearChat);

  // drag-to-resize between detailArea and chatPane
  const handle = $("resizeHandle");
  const chatPane = $("chatPane");
  const rightPane = $("rightPane");
  if (handle && chatPane && rightPane) {
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener("mousedown", e => {
      dragging = true;
      startY = e.clientY;
      startHeight = chatPane.offsetHeight;
      handle.classList.add("dragging");
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", e => {
      if (!dragging) return;
      const delta = startY - e.clientY; // dragging up 鈫?positive 鈫?chat grows
      const rightH = rightPane.offsetHeight;
      const minChat = 120;
      const minDetail = 80;
      let newChat = Math.min(rightH - minDetail - handle.offsetHeight, Math.max(minChat, startHeight + delta));
      chatPane.style.height = newChat + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistChatPaneHeight(chatPane.offsetHeight);
    });
  }
}

async function cleanupNetworkLogsBatched(options = {}) {
  const fromAgent = options.fromAgent === true;
  if (!fromAgent && agentRunning) return { ok: false, error: "agent is running" };
  if (!fromAgent) setAgentBusy(true);
  const batchSize = Math.max(1, Math.min(100, Number(options.batchSize || 100)));
  const maxBatches = Math.max(0, Number(options.maxBatches || 0));
  const result = {
    ok: true,
    total: 0,
    auto_deleted: 0,
    ai_candidates: 0,
    ai_batches: 0,
    deleted: 0,
    stopped: false,
    reasons: []
  };
  try {
    addSystemContext("正在暂停抓取并同步 Network Log 列表...");
    stopPolling();
    await send("popup.networkCapture.pause").catch(() => null);
    await refreshNetworkLogSnapshot();
    const source = (filteredEvents.length ? filteredEvents : events).filter(e => !deletedSeqs.has(Number(e.seq)));
    result.total = source.length;
    if (!source.length) {
      addSystemContext("娌℃湁鍙竻鐞嗙殑 Network Log");
      return result;
    }

    const useFastPreclean = source.length > 200;
    const classified = useFastPreclean
      ? splitCleanupCandidates(source)
      : { autoDelete: [], aiCandidates: source, keep: [] };
    const autoSeqs = classified.autoDelete.map(e => Number(e.seq)).filter(n => Number.isFinite(n));
    if (autoSeqs.length) {
      await deleteNetworkEvents(autoSeqs);
      result.auto_deleted = autoSeqs.length;
      addSystemContext("已快速清理 " + autoSeqs.length + " 条");
    }

    let aiSource = classified.aiCandidates.filter(e => !deletedSeqs.has(Number(e.seq)));
    if (!aiSource.length) aiSource = source.filter(e => !deletedSeqs.has(Number(e.seq))).slice(0, batchSize);
    result.ai_candidates = aiSource.length;
    if (!aiSource.length) {
      persistNetworkLogCache();
      applyFilter();
      renderLogList();
      renderDetail();
      addSystemContext("清理完成：没有需要提交 AI 判断的剩余请求");
      return result;
    }

    const aiList = useFastPreclean
      ? aiSource.slice().sort((a, b) => cleanupEventScore(b) - cleanupEventScore(a))
      : aiSource;
    let batches = chunkArray(aiList, batchSize);
    if (maxBatches > 0) batches = batches.slice(0, maxBatches);
    const existing = new Set(source.map(e => Number(e.seq)));
    const deleteSeqSet = new Set();
    addSystemContext("开始 AI 分批清理：候选 " + aiList.length + " 条，每批最多 " + batchSize + " 条，共 " + batches.length + " 批");

    for (let bi = 0; bi < batches.length; bi++) {
      if (agentStopRequested) {
        result.stopped = true;
        break;
      }
      addSystemContext("AI 清理第 " + (bi + 1) + "/" + batches.length + " 批，" + batches[bi].length + " 条");
      const parsed = await askAiCleanupBatch(batches[bi], bi, batches.length, aiList.length);
      if (parsed && parsed.stopped) {
        result.stopped = true;
        break;
      }
      result.ai_batches += 1;
      parsed.deleteSeqs.filter(seq => existing.has(seq)).forEach(seq => deleteSeqSet.add(seq));
      if (parsed.reason) result.reasons.push(parsed.reason);
    }

    const seqs = Array.from(deleteSeqSet);
    if (!seqs.length) {
      persistNetworkLogCache();
      addSystemContext(result.stopped ? "清理已停止，尚未删除 AI 判断项" : "AI 判断没有需要删除的请求");
      return result;
    }
    await deleteNetworkEvents(seqs);
    result.deleted = seqs.length;
    if (selectedIdx !== null && filteredEvents[selectedIdx] && deletedSeqs.has(Number(filteredEvents[selectedIdx].seq))) selectedIdx = null;
    applyFilter();
    renderLogList();
    renderDetail();
    addSystemContext("已清理 " + seqs.length + " 条无关请求");
    return result;
  } catch (err) {
    result.ok = false;
    result.error = String(err && err.message || err);
    addSystemContext("清理无关请求失败: " + result.error);
    return result;
  } finally {
    if (!fromAgent) setAgentBusy(false);
  }
}

init();
