import { ensureTab, compactErrorResponse } from "./common.js";

const API_US = "https://dreamina-api.us.capcut.com";
const API_SG = "https://mweb-api-sg.capcut.com";
const IMAGEX_US = "https://imagex16-normal-us-ttp.capcutapi.us";
const IMAGEX_SG = "https://imagex-normal-sg.capcutapi.com";
const GENERATE_PATH = "/mweb/v1/aigc_draft/generate";
const UPLOAD_TOKEN_PATH = "/mweb/v1/get_upload_token";
const HISTORY_PATH = "/mweb/v1/get_history_by_ids";
const REMOVE_HISTORY_PATH = "/mweb/v1/remove_history";
const GET_LOCAL_ITEM_LIST_PATH = "/mweb/v1/get_local_item_list";
const UPDATE_SETTINGS_PATH = "/mweb/v1/update_settings";
const AID = 513641;
const APPVR = "8.4.0";
const WEB_VERSION = "7.5.0";
const DRAFT_VERSION = "3.3.17";
const DRAFT_MIN_VERSION = "3.0.5";
const DA_VERSION = "3.3.9";
const FEATURES = "app_lip_sync";
const AWS_REGION = "ap-singapore-1";
const IMAGE_SERVICE_FALLBACK = "wopfjsm1ax";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function sha256Hex(s) {
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof s === "string" ? enc.encode(s) : s,
    ),
  );
}
async function hmacBytes(key, msg) {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      k,
      typeof msg === "string" ? enc.encode(msg) : msg,
    ),
  );
}
async function hmacHex(key, msg) {
  return hex(await hmacBytes(key, msg));
}

// WebCrypto 不支持 MD5；Jimeng/Dreamina 普通 API Sign 仍需要 MD5。
function md5Hex(str) {
  function cmn(q, a, b, x, s, t) {
    a = (a + q + x + t) | 0;
    return (((a << s) | (a >>> (32 - s))) + b) | 0;
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  const bytes = Array.from(enc.encode(str));
  const origLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((origLen >>> (8 * i)) & 255);
  let a = 0x67452301,
    b = 0xefcdab89 | 0,
    c = 0x98badcfe | 0,
    d = 0x10325476;
  for (let i = 0; i < bytes.length; i += 64) {
    const x = [];
    for (let j = 0; j < 16; j++)
      x[j] =
        bytes[i + 4 * j] |
        (bytes[i + 4 * j + 1] << 8) |
        (bytes[i + 4 * j + 2] << 16) |
        (bytes[i + 4 * j + 3] << 24);
    const oa = a,
      ob = b,
      oc = c,
      od = d;
    a = ff(a, b, c, d, x[0], 7, -680876936);
    d = ff(d, a, b, c, x[1], 12, -389564586);
    c = ff(c, d, a, b, x[2], 17, 606105819);
    b = ff(b, c, d, a, x[3], 22, -1044525330);
    a = ff(a, b, c, d, x[4], 7, -176418897);
    d = ff(d, a, b, c, x[5], 12, 1200080426);
    c = ff(c, d, a, b, x[6], 17, -1473231341);
    b = ff(b, c, d, a, x[7], 22, -45705983);
    a = ff(a, b, c, d, x[8], 7, 1770035416);
    d = ff(d, a, b, c, x[9], 12, -1958414417);
    c = ff(c, d, a, b, x[10], 17, -42063);
    b = ff(b, c, d, a, x[11], 22, -1990404162);
    a = ff(a, b, c, d, x[12], 7, 1804603682);
    d = ff(d, a, b, c, x[13], 12, -40341101);
    c = ff(c, d, a, b, x[14], 17, -1502002290);
    b = ff(b, c, d, a, x[15], 22, 1236535329);
    a = gg(a, b, c, d, x[1], 5, -165796510);
    d = gg(d, a, b, c, x[6], 9, -1069501632);
    c = gg(c, d, a, b, x[11], 14, 643717713);
    b = gg(b, c, d, a, x[0], 20, -373897302);
    a = gg(a, b, c, d, x[5], 5, -701558691);
    d = gg(d, a, b, c, x[10], 9, 38016083);
    c = gg(c, d, a, b, x[15], 14, -660478335);
    b = gg(b, c, d, a, x[4], 20, -405537848);
    a = gg(a, b, c, d, x[9], 5, 568446438);
    d = gg(d, a, b, c, x[14], 9, -1019803690);
    c = gg(c, d, a, b, x[3], 14, -187363961);
    b = gg(b, c, d, a, x[8], 20, 1163531501);
    a = gg(a, b, c, d, x[13], 5, -1444681467);
    d = gg(d, a, b, c, x[2], 9, -51403784);
    c = gg(c, d, a, b, x[7], 14, 1735328473);
    b = gg(b, c, d, a, x[12], 20, -1926607734);
    a = hh(a, b, c, d, x[5], 4, -378558);
    d = hh(d, a, b, c, x[8], 11, -2022574463);
    c = hh(c, d, a, b, x[11], 16, 1839030562);
    b = hh(b, c, d, a, x[14], 23, -35309556);
    a = hh(a, b, c, d, x[1], 4, -1530992060);
    d = hh(d, a, b, c, x[4], 11, 1272893353);
    c = hh(c, d, a, b, x[7], 16, -155497632);
    b = hh(b, c, d, a, x[10], 23, -1094730640);
    a = hh(a, b, c, d, x[13], 4, 681279174);
    d = hh(d, a, b, c, x[0], 11, -358537222);
    c = hh(c, d, a, b, x[3], 16, -722521979);
    b = hh(b, c, d, a, x[6], 23, 76029189);
    a = hh(a, b, c, d, x[9], 4, -640364487);
    d = hh(d, a, b, c, x[12], 11, -421815835);
    c = hh(c, d, a, b, x[15], 16, 530742520);
    b = hh(b, c, d, a, x[2], 23, -995338651);
    a = ii(a, b, c, d, x[0], 6, -198630844);
    d = ii(d, a, b, c, x[7], 10, 1126891415);
    c = ii(c, d, a, b, x[14], 15, -1416354905);
    b = ii(b, c, d, a, x[5], 21, -57434055);
    a = ii(a, b, c, d, x[12], 6, 1700485571);
    d = ii(d, a, b, c, x[3], 10, -1894986606);
    c = ii(c, d, a, b, x[10], 15, -1051523);
    b = ii(b, c, d, a, x[1], 21, -2054922799);
    a = ii(a, b, c, d, x[8], 6, 1873313359);
    d = ii(d, a, b, c, x[15], 10, -30611744);
    c = ii(c, d, a, b, x[6], 15, -1560198380);
    b = ii(b, c, d, a, x[13], 21, 1309151649);
    a = ii(a, b, c, d, x[4], 6, -145523070);
    d = ii(d, a, b, c, x[11], 10, -1120210379);
    c = ii(c, d, a, b, x[2], 15, 718787259);
    b = ii(b, c, d, a, x[9], 21, -343485551);
    a = (a + oa) | 0;
    b = (b + ob) | 0;
    c = (c + oc) | 0;
    d = (d + od) | 0;
  }
  return [a, b, c, d]
    .map((n) =>
      [0, 8, 16, 24]
        .map((s) => ((n >>> s) & 255).toString(16).padStart(2, "0"))
        .join(""),
    )
    .join("");
}

async function headersFor(uri, extra = {}, loc = "US", hasBody = true) {
  const dt = Math.floor(Date.now() / 1000);
  const path = new URL(uri, "https://x").pathname;
  const sign = md5Hex(`9e2c|${path.slice(-7)}|7|${APPVR}|${dt}||11ac`);
  const storeCountry = await getCookie("store-country-code", target);
  return {
    Accept: "application/json, text/plain, */*",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    Lan: "en",
    "app-sdk-version": "48.0.0",
    Appid: String(AID),
    Appvr: APPVR,
    "Device-Time": String(dt),
    Sign: sign,
    "Sign-Ver": "1",
    Pf: "7",
    loc: loc || "US",
    tdid: "",
    ...extra,
  };
}
function regionConfig(country) {
  const cc = String(country || "")
    .trim()
    .toLowerCase();
  const sg = cc === "ca" || cc === "tr";
  return {
    country: cc,
    apiBase: sg ? API_SG : API_US,
    imagexBase: sg ? IMAGEX_SG : IMAGEX_US,
    loc: cc ? cc.toUpperCase() : "US",
  };
}
async function getCookie(name, target) {
  try {
    return await chrome.cookies.get({ url: dreaminaCookieUrl(target), name });
  } catch {
    return null;
  }
}
async function resolveRegion(p, target) {
  const c = await getCookie("store-country-code", target);
  return regionConfig(p.store_country_code || (c && c.value) || "us");
}
function dreaminaCookieUrl(targetUrl) {
  try {
    const u = new URL(targetUrl || "https://dreamina.capcut.com");
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return "https://dreamina.capcut.com";
  }
}
async function fetchSessionId(target) {
  const c = await getCookie("sessionid", target);
  if (!c?.value) throw new Error("Cookies 中缺少 sessionid");
  return {
    access_token: c.value,
    sessionid: c.value,
    expires: c.expirationDate
      ? new Date(c.expirationDate * 1000).toISOString()
      : null,
    cookie_name: "sessionid",
    store_country_code: storeCountry?.value || "",
  };
}

async function pageFetchJson(
  tabId,
  url,
  { method = "GET", headers = {}, body = null } = {},
) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url, { method, headers, body }],
    func: async (u, o) => {
      const init = {
        method: o.method || "GET",
        headers: o.headers || {},
        credentials: "include",
      };
      if (o.body !== null && o.body !== undefined)
        init.body = JSON.stringify(o.body);
      const r = await fetch(u, init);
      const text = await r.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return {
        status: r.status,
        text,
        json,
        url: r.url,
        headers: Object.fromEntries(r.headers.entries()),
      };
    },
  });
  const tx = Array.isArray(frames) && frames[0] ? frames[0].result : null;
  if (!tx) throw new Error(`pageFetchJson empty: ${method} ${url}`);
  return tx;
}
async function pageXhrJson(
  tabId,
  url,
  { method = "GET", headers = {}, body = null } = {},
) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url, { method, headers, body }],
    func: async (u, o) =>
      await new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open(o.method || "GET", u, true);
        x.withCredentials = false;
        for (const [k, v] of Object.entries(o.headers || {})) {
          try {
            x.setRequestHeader(k, String(v));
          } catch {}
        }
        x.onload = () => {
          let json = null;
          try {
            json = x.responseText ? JSON.parse(x.responseText) : null;
          } catch {}
          resolve({ status: x.status, text: x.responseText || "", json });
        };
        x.onerror = () =>
          resolve({
            status: x.status || 0,
            text: x.responseText || "",
            json: null,
            error: "xhr network error",
          });
        x.timeout = 120000;
        x.ontimeout = () =>
          resolve({
            status: x.status || 0,
            text: x.responseText || "",
            json: null,
            error: "xhr timeout",
          });
        x.send(
          o.body === null || o.body === undefined
            ? null
            : JSON.stringify(o.body),
        );
      }),
  });
  const tx = frames?.[0]?.result;
  if (!tx || tx.error)
    throw new Error(
      `ImageX XHR JSON failed: ${tx?.error || "empty"}; ${method} ${url}; ${tx?.text || ""}`,
    );
  return tx;
}
function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(s);
}
async function pageXhrBinary(tabId, url, headers, bytes) {
  const b64 = bytesToBase64(bytes);
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url, headers, b64],
    func: async (u, h, b64) =>
      await new Promise((resolve, reject) => {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const x = new XMLHttpRequest();
        x.open("POST", u, true);
        x.withCredentials = false;
        for (const [k, v] of Object.entries(h || {})) {
          try {
            x.setRequestHeader(k, String(v));
          } catch {}
        }
        x.onload = () =>
          resolve({ status: x.status, text: x.responseText || "" });
        x.onerror = () =>
          reject(new Error("ImageX binary upload network error"));
        x.timeout = 300000;
        x.ontimeout = () => reject(new Error("ImageX binary upload timeout"));
        x.send(arr);
      }),
  });
  const tx = frames?.[0]?.result;
  if (!tx || tx.status < 200 || tx.status >= 300)
    throw new Error(
      `ImageX upload failed status=${tx?.status} body=${String(tx?.text || "").slice(0, 300)}`,
    );
}

function crc32Hex(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c >>> 0).toString(16).padStart(8, "0");
}
function amzTimestamp() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}
async function imagexSignature(
  method,
  url,
  headers,
  ak,
  sk,
  token = "",
  payload = "",
) {
  // 这里必须字节级复刻 Python 版 _dreamina_create_imagex_signature：
  //   parsed = urlparse(url)
  //   query_pairs = sorted(parse_qsl(parsed.query, keep_blank_values=True), key=lambda kv: kv[0])
  //   canonical_query = "&".join(f"{k}={v}" for k, v in query_pairs)
  //
  // 注意不能直接依赖 URLSearchParams 的序列化，也不能用 localeCompare。
  // ImageX 这个接口服务端按非常朴素的 query 解码后排序来验签；只要大小写排序、
  // percent 编码、空值处理有一点不同，就会 SignatureDoesNotMatch。
  const raw = String(url || "");
  const qIndex = raw.indexOf("?");
  const pathStart = raw.indexOf("/", raw.indexOf("://") >= 0 ? raw.indexOf("://") + 3 : 0);
  const pathEnd = qIndex >= 0 ? qIndex : raw.length;
  const canonicalUri = pathStart >= 0 ? (raw.slice(pathStart, pathEnd) || "/") : "/";
  const rawQuery = qIndex >= 0 ? raw.slice(qIndex + 1).split("#", 1)[0] : "";
  const pyUnquotePlus = (s) => {
    try {
      return decodeURIComponent(String(s || "").replace(/\+/g, " "));
    } catch (_) {
      return String(s || "").replace(/\+/g, " ");
    }
  };
  const pairs = rawQuery
    ? rawQuery.split("&").map((part) => {
        const eq = part.indexOf("=");
        if (eq < 0) return [pyUnquotePlus(part), ""];
        return [pyUnquotePlus(part.slice(0, eq)), pyUnquotePlus(part.slice(eq + 1))];
      })
    : [];
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const cq = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const ts = headers["x-amz-date"];
  const date = ts.slice(0, 8);
  const payloadHash = await sha256Hex(
    method.toUpperCase() === "POST" && payload ? payload : "",
  );
  const hs = { "x-amz-date": ts };
  if (token) hs["x-amz-security-token"] = token;
  if (method.toUpperCase() === "POST" && payload)
    hs["x-amz-content-sha256"] = payloadHash;
  const names = Object.keys(hs).sort();
  const signed = names.join(";");
  const ch = names.map((k) => `${k}:${String(hs[k]).trim()}\n`).join("");
  const creq = [
    method.toUpperCase(),
    canonicalUri,
    cq,
    ch,
    signed,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${AWS_REGION}/imagex/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", ts, scope, await sha256Hex(creq)].join("\n");
  const kd = await hmacBytes(enc.encode("AWS4" + sk), date);
  const kr = await hmacBytes(kd, AWS_REGION);
  const ks = await hmacBytes(kr, "imagex");
  const ksign = await hmacBytes(ks, "aws4_request");
  const sig = await hmacHex(ksign, sts);
  return `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
}
async function maybeJpegUnder1mb(bytes) {
  if (bytes.length <= 1024 * 1024) return bytes;
  if (!globalThis.createImageBitmap || !globalThis.OffscreenCanvas)
    return bytes;
  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  for (const q of [
    0.92, 0.86, 0.8, 0.72, 0.64, 0.56, 0.48, 0.4, 0.32, 0.24, 0.16, 0.1,
  ]) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: q });
    const out = new Uint8Array(await blob.arrayBuffer());
    if (out.length <= 1024 * 1024) return out;
  }
  return new Uint8Array(
    await (
      await canvas.convertToBlob({ type: "image/jpeg", quality: 0.1 })
    ).arrayBuffer(),
  );
}
async function uploadOneImage(
  tabId,
  ref,
  tokenData,
  imagexBase,
  runtime,
  index,
  total,
) {
  const ak = tokenData.access_key_id || "",
    sk = tokenData.secret_access_key || "",
    st = tokenData.session_token || "",
    serviceId = tokenData.service_id || IMAGE_SERVICE_FALLBACK;
  if (!ak || !sk || !st)
    throw new Error(
      `Dreamina get_upload_token 缺字段: ${JSON.stringify(tokenData).slice(0, 300)}`,
    );
  const src = ref.url || ref.image_url || ref.source || ref.imageUrl;
  if (!src) throw new Error("Dreamina reference image source is empty");
  await runtime.progress(3, {
    stage: "upload_image_fetch",
    index: index + 1,
    total,
  });
  const fr = await fetch(src, { credentials: "omit", cache: "no-store" });
  if (!fr.ok)
    throw new Error(
      `Dreamina reference image fetch failed: ${fr.status} ${src}`,
    );
  let bytes = new Uint8Array(await fr.arrayBuffer());
  if (bytes.length > 30 * 1024 * 1024)
    throw new Error("Dreamina 图片大小超过 30MB");
  bytes = await maybeJpegUnder1mb(bytes);
  const crc = crc32Hex(bytes);
  const ts = amzTimestamp();
  const s = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  // Python 版这里直接拼 ServiceId，不做 encodeURIComponent；签名 URL 与实际 URL
  // 必须完全一致，否则 canonical query 会和原实现不同。
  const applyUrl = `${imagexBase}/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${serviceId}&FileSize=${bytes.length}&s=${s}&device_platform=web`;
  const ah = { "x-amz-date": ts, "x-amz-security-token": st };
  const applyHeaders = {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    authorization: await imagexSignature("GET", applyUrl, ah, ak, sk, st),
    ...ah,
  };
  const ax = await pageXhrJson(tabId, applyUrl, {
    method: "GET",
    headers: applyHeaders,
  });
  const addr = ax.json?.Result?.UploadAddress || {};
  const si = (addr.StoreInfos || [])[0];
  const host = (addr.UploadHosts || [])[0];
  if (!si || !host)
    throw new Error(
      `Dreamina ApplyImageUpload missing UploadAddress: ${String(ax.text).slice(0, 500)}`,
    );
  const uploadUrl = `https://${host}/upload/v1/${si.StoreUri}`;
  await runtime.progress(4, {
    stage: "upload_image_binary",
    index: index + 1,
    total,
    bytes: bytes.length,
  });
  await pageXhrBinary(
    tabId,
    uploadUrl,
    {
      Accept: "*/*",
      Authorization: si.Auth || "",
      "Content-CRC32": crc,
      "Content-Disposition": 'attachment; filename="image.jpg"',
      "Content-Type": "image/jpeg",
    },
    bytes,
  );
  const payload = JSON.stringify({
    SessionKey: addr.SessionKey,
    SuccessActionStatus: "200",
  });
  const cts = amzTimestamp();
  const ph = await sha256Hex(payload);
  const chb = {
    "x-amz-date": cts,
    "x-amz-security-token": st,
    "x-amz-content-sha256": ph,
  };
  const commitUrl = `${imagexBase}/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${serviceId}&device_platform=web`;
  const commitHeaders = {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    authorization: await imagexSignature(
      "POST",
      commitUrl,
      chb,
      ak,
      sk,
      st,
      payload,
    ),
    ...chb,
  };
  const cx = await pageXhrJson(tabId, commitUrl, {
    method: "POST",
    headers: commitHeaders,
    body: { SessionKey: addr.SessionKey, SuccessActionStatus: "200" },
  });
  const result = cx.json?.Result || {};
  const plugin = (result.PluginResult || [])[0] || {};
  let uri = plugin.ImageUri || ((result.Results || [])[0] || {}).Uri || "";
  if (!uri)
    throw new Error(
      `Dreamina CommitImageUpload missing Uri: ${String(cx.text).slice(0, 500)}`,
    );
  return {
    uri,
    width: plugin.ImageWidth || ref.width || 0,
    height: plugin.ImageHeight || ref.height || 0,
  };
}
async function uploadImageRefs(tabId, refs, cfg, runtime) {
  const out = [];
  for (let i = 0; i < refs.length; i++) {
    const tx = await pageFetchJson(
      tabId,
      `${cfg.apiBase}${UPLOAD_TOKEN_PATH}`,
      {
        method: "POST",
        headers: await headersFor(UPLOAD_TOKEN_PATH, {}, cfg.loc),
        body: { scene: 2 },
      },
    );
    if (tx.status >= 400 || (tx.json?.ret && String(tx.json.ret) !== "0"))
      throw new Error(
        `Dreamina get_upload_token failed: ${compactErrorResponse(tx)}`,
      );
    const td = tx.json?.data || tx.json || {};
    const up = await uploadOneImage(
      tabId,
      refs[i],
      td,
      cfg.imagexBase,
      runtime,
      i,
      refs.length,
    );
    out.push({
      ...refs[i],
      uri: up.uri,
      width: up.width || refs[i].width,
      height: up.height || refs[i].height,
    });
    await runtime.progress(5, {
      stage: "upload_image_done",
      index: i + 1,
      total: refs.length,
      uri: up.uri,
    });
  }
  return out;
}

function imageInfo(uri, w, h) {
  return {
    format: "",
    height: Number(h || 720),
    id: crypto.randomUUID(),
    image_uri: uri,
    name: "",
    platform_type: 1,
    source_from: "upload",
    type: "image",
    uri,
    width: Number(w || 1280),
    source: 2,
    aigc_image: { type: "", id: crypto.randomUUID() },
    title: "test",
  };
}
function frameImageInfo(uri, w, h) {
  return {
    ...imageInfo(uri, w, h),
    source_from: "produced",
    aigc_image: { type: "", id: crypto.randomUUID() },
  };
}
function subjectMaterial(uri, ref, w, h) {
  const r = ref && typeof ref === "object" ? ref : {};
  const name = String(
    r.subject_name || r.alias || r.name || "reference image",
  ).trim();
  const mainImage = {
    ...imageInfo(uri, r.width || w, r.height || h),
    title: String(r.title || ""),
    source_from: String(r.source_from || "upload"),
  };
  return {
    type: "",
    id: crypto.randomUUID(),
    material_type: "subject",
    subject_data: {
      type: "",
      id: crypto.randomUUID(),
      uid: String(r.uid || ""),
      subject_id: String(r.subject_id || r.subjectId || ""),
      data_id: String(r.data_id || r.dataId || ""),
      content: {
        type: "",
        id: crypto.randomUUID(),
        name,
        description: String(r.description || ""),
        main_image: mainImage,
      },
      subject_control: {
        type: "",
        id: crypto.randomUUID(),
        status: 0,
        enabled: true,
        deletable: true,
        editable: true,
      },
    },
  };
}
function materialUri(material) {
  if (!material || typeof material !== "object") return "";
  const ii = material.image_info || {};
  let uri = String(ii.uri || ii.image_uri || "").trim();
  if (uri) return uri;
  const mi = material.subject_data?.content?.main_image || {};
  return String(mi.uri || mi.image_uri || "").trim();
}
function buildMetaList(prompt, count) {
  const out = [];
  const s = String(prompt || "");
  let last = 0;
  const re = /@(?:图|image)?(\d+)/gi;
  for (const m of s.matchAll(re)) {
    if (m.index > last && s.slice(last, m.index).trim()) {
      out.push({
        type: "",
        id: crypto.randomUUID(),
        meta_type: "text",
        text: s.slice(last, m.index),
      });
    }
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < count) {
      out.push({
        type: "",
        id: crypto.randomUUID(),
        meta_type: "image",
        text: "",
        material_ref: { material_idx: idx },
      });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length && s.slice(last).trim()) {
    out.push({
      type: "",
      id: crypto.randomUUID(),
      meta_type: "text",
      text: s.slice(last),
    });
  }
  if (!out.length) {
    for (let i = 0; i < count; i++) {
      if (i === 0)
        out.push({ type: "", id: crypto.randomUUID(), meta_type: "text", text: "使用" });
      out.push({
        type: "",
        id: crypto.randomUUID(),
        meta_type: "image",
        text: "",
        material_ref: { material_idx: i },
      });
      if (i < count - 1)
        out.push({ type: "", id: crypto.randomUUID(), meta_type: "text", text: "和" });
    }
    out.push({
      type: "",
      id: crypto.randomUUID(),
      meta_type: "text",
      text: s.trim() ? `素材，${s}` : "素材生成视频",
    });
  }
  return out;
}
function bindPromptMaterials(parts, subjectRefs, externalRefs, width, height) {
  const materials = [];
  const metaList = [];
  const kinds = [];
  const cleaned = [];
  let si = 0,
    ei = 0,
    imageIdx = 0;
  for (const part of Array.isArray(parts) ? parts : []) {
    const type = String(part?.type || "");
    if (type === "text") {
      const text = String(part?.text || "").trim();
      if (text) {
        cleaned.push(text);
        metaList.push({ type: "", id: crypto.randomUUID(), meta_type: "text", text });
      }
      continue;
    }
    if (type === "subject") {
      const ref = subjectRefs[si++];
      const uri = String(ref?.uri || ref?.image_uri || "").trim();
      if (!uri) throw new Error('@"数字"未找到图片');
      materials.push(subjectMaterial(uri, ref, ref.width || width, ref.height || height));
      kinds.push("subject");
      metaList.push({
        type: "",
        id: crypto.randomUUID(),
        meta_type: "subject",
        text: "",
        material_ref: { type: "", id: crypto.randomUUID(), material_idx: imageIdx },
      });
      imageIdx++;
      continue;
    }
    if (type === "image") {
      const ref = externalRefs[ei++];
      const uri = String(ref?.uri || ref?.image_uri || "").trim();
      if (!uri) throw new Error('多余的那几个非数字"@xxx"找不到');
      materials.push({
        type: "",
        id: crypto.randomUUID(),
        material_type: "image",
        image_info: imageInfo(uri, ref.width || width, ref.height || height),
      });
      kinds.push("image");
      metaList.push({
        type: "",
        id: crypto.randomUUID(),
        meta_type: "image",
        text: "",
        material_ref: { material_idx: imageIdx },
      });
      imageIdx++;
    }
  }
  if (si < subjectRefs.length) throw new Error('@"数字"未找到图片');
  if (ei < externalRefs.length) throw new Error('多余的那几个非数字"@xxx"找不到');
  if (!metaList.length)
    metaList.push({ type: "", id: crypto.randomUUID(), meta_type: "text", text: "" });
  return { prompt: cleaned.join("").trim(), materials, metaList, kinds };
}
function buildGenerateBody(payload) {
  const submitId = crypto.randomUUID(),
    componentId = crypto.randomUUID();
  const model =
    payload.model_key ||
    payload.model_name ||
    payload.model ||
    "dreamina_seedance_40";
  const ratio = payload.aspect_ratio || "16:9",
    resolution = payload.resolution || "720p",
    duration = Number(payload.duration || 15),
    prompt = String(
      payload.prompt || payload.promp || payload.text || payload.query || "",
    );
  const mode = String(payload.reference_mode || "")
    .toLowerCase()
    .includes("first")
    ? "first_last_frames"
    : "omni_reference";
  const imageRefs = Array.isArray(payload.image_refs) ? payload.image_refs : [];
  const subjectRefs = Array.isArray(payload.prompt_subject_refs)
    ? payload.prompt_subject_refs
    : [];
  const hasPromptRefs =
    subjectRefs.length ||
    (Array.isArray(payload.prompt_image_tokens) && payload.prompt_image_tokens.length);
  let promptForBody = prompt,
    materials = [],
    metaList = [];
  if (hasPromptRefs) {
    const bound = bindPromptMaterials(
      payload.prompt_parts || [],
      subjectRefs,
      imageRefs,
      payload.width,
      payload.height,
    );
    promptForBody = bound.prompt;
    materials = bound.materials;
    metaList = bound.metaList;
  } else {
    materials = imageRefs
      .map((r) => {
        const uri = String(r.uri || r.image_uri || "").trim();
        if (!uri) return null;
        const isSubject =
          String(r.material_type || "").toLowerCase() === "subject" ||
          !!r.subject_id ||
          !!r.subjectId ||
          !!r.data_id ||
          !!r.dataId ||
          !!r.uid;
        return isSubject
          ? subjectMaterial(uri, r, r.width || payload.width, r.height || payload.height)
          : {
              type: "",
              id: crypto.randomUUID(),
              material_type: "image",
              image_info: imageInfo(
                uri,
                r.width || payload.width,
                r.height || payload.height,
              ),
            };
      })
      .filter(Boolean);
    if (materials.length) metaList = buildMetaList(promptForBody, materials.length);
  }
  const functionMode = mode;
  const external = materials.filter(
      (m) => m.material_type !== "subject",
    ).length,
    hasSubject = materials.some((m) => m.material_type === "subject");
  const sceneOption = {
    type: "video",
    scene: "BasicVideoGenerateButton",
    modelReqKey: model,
    videoDuration: duration,
    resolution,
    inputVideoDuration: 0,
    reportParams: {
      enterSource: "generate",
      vipSource: "generate",
      extraVipFunctionKey: `${model}-${resolution}`,
      useVipFunctionDetailsReporterHoc: true,
    },
    materialTypes: Array(external).fill(1),
  };
  const metricsExtra = JSON.stringify({
    ...(functionMode === "first_last_frames" ? { promptSource: "custom" } : {}),
    isDefaultSeed: 1,
    originSubmitId: submitId,
    isRegenerate: false,
    enterFrom: "click",
    position: "page_bottom_box",
    functionMode,
    sceneOptions: JSON.stringify([sceneOption]),
  });
  const minv = hasSubject
    ? "3.3.12"
    : !materials.length || functionMode === "first_last_frames"
      ? DRAFT_MIN_VERSION
      : DA_VERSION;
  const videoInput = {
    type: "",
    id: crypto.randomUUID(),
    min_version: minv,
    prompt:
      functionMode === "first_last_frames"
        ? promptForBody
        : materials.length
          ? ""
          : promptForBody,
    video_mode: 2,
    fps: 24,
    duration_ms: duration * 1000,
    resolution,
    idip_meta_list: [],
  };
  if (functionMode === "first_last_frames") {
    const u0 = materialUri(materials[0]),
      u1 = materialUri(materials[1]);
    videoInput.first_frame_image = u0
      ? frameImageInfo(u0, payload.width, payload.height)
      : null;
    videoInput.end_frame_image = u1
      ? frameImageInfo(u1, payload.width, payload.height)
      : null;
  } else if (materials.length) {
    videoInput.unified_edit_input = {
      type: "",
      id: crypto.randomUUID(),
      material_list: materials,
      meta_list: metaList,
    };
  }
  const draft = {
    type: "draft",
    id: crypto.randomUUID(),
    min_version: minv,
    min_features: hasSubject
      ? ["AIGC_Video_UnifiedEdit", "AIGC_UnifiedEditSubject"]
      : !materials.length || functionMode === "first_last_frames"
        ? []
        : ["AIGC_Video_UnifiedEdit"],
    is_from_tsn: true,
    version: DRAFT_VERSION,
    main_component_id: componentId,
    component_list: [
      {
        type: "video_base_component",
        id: componentId,
        min_version: "1.0.0",
        aigc_mode: "workbench",
        metadata: {
          type: "",
          id: crypto.randomUUID(),
          created_platform: 3,
          created_platform_version: "",
          created_time_in_ms: String(Date.now()),
          created_did: "",
        },
        generate_type: "gen_video",
        abilities: {
          type: "",
          id: crypto.randomUUID(),
          gen_video: {
            type: "",
            id: crypto.randomUUID(),
            text_to_video_params: {
              type: "",
              id: crypto.randomUUID(),
              video_gen_inputs: [videoInput],
              video_aspect_ratio: ratio,
              seed: 1 + Math.floor(Math.random() * 999999999),
              model_req_key: model,
              priority: 0,
            },
            video_task_extra: metricsExtra,
          },
        },
        process_type: 1,
      },
    ],
  };
  const benefit = model.includes("40_pro")
    ? "seedance_20_pro_720p_output"
    : "seedance_20_fast_720p_output";
  const commerce = {
    benefit_type: benefit,
    resource_id: "generate_video",
    resource_id_type: "str",
    resource_sub_type: "aigc",
    amount: duration,
  };
  return {
    submitId,
    functionMode,
    body: {
      extend: {
        root_model: model,
        m_video_commerce_info: commerce,
        workspace_id: 0,
        m_video_commerce_info_list: [{ ...commerce }],
      },
      submit_id: submitId,
      metrics_extra: metricsExtra,
      draft_content: JSON.stringify(draft),
      http_common_info: { aid: AID },
    },
  };
}
function extractHistoryData(obj, submitId) {
  const data = obj?.data || obj || {};
  if (!data || typeof data !== "object") return {};
  if (submitId && data[submitId] && typeof data[submitId] === "object") {
    return data[submitId];
  }
  const values = Object.values(data).filter(
    (v) => v && typeof v === "object",
  );
  if (submitId) {
    for (const v of values) {
      if (!v || typeof v !== "object") continue;
      if (
        String(v.submit_id || v.capflow_id || v.task?.submit_id || "") ===
        String(submitId)
      ) {
        return v;
      }
    }
  }
  // get_history_by_ids 正常返回 {"data": {"<submit_id>": history_data}}。
  // 如果本地 submitId 与返回 key 因重试/恢复等原因不一致，也不能漏掉失败状态；
  // 单任务查询时 data 只有一个 history 对象，直接使用它。
  if (values.length === 1) return values[0];
  // 再兜底：优先返回明确失败/完成/进行中的 history 对象，避免继续无意义轮询。
  for (const v of values) {
    const st = v.status ?? v.task?.status;
    if (String(st) === "30") return v;
  }
  for (const v of values) {
    const st = v.status ?? v.task?.status;
    if (String(st) && String(st) !== "20") return v;
  }
  for (const v of values) {
    const st = v.status ?? v.task?.status;
    if (String(st) === "20") return v;
  }
  if (data.history_record_id || data.task || data.status || data.item_list) {
    return data;
  }
  return {};
}

function firstStrPath(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const key of path) {
      if (!cur || typeof cur !== "object" || !(key in cur)) {
        ok = false;
        break;
      }
      cur = cur[key];
    }
    if (ok && typeof cur === "string" && cur.trim()) return cur.trim();
  }
  return "";
}

function decodeBase64Url(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  try {
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    const url = decodeURIComponent(
      Array.from(atob(padded), (c) =>
        `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
      ).join(""),
    ).trim();
    return /^https?:\/\//i.test(url) ? url : "";
  } catch (_) {
    try {
      const url = atob(s + "=".repeat((4 - (s.length % 4)) % 4)).trim();
      return /^https?:\/\//i.test(url) ? url : "";
    } catch (_) {
      return "";
    }
  }
}

function extractVideoModelUrlFromItem(item) {
  if (!item || typeof item !== "object") return "";
  const video = item.video && typeof item.video === "object" ? item.video : {};
  const commonAttr =
    item.common_attr && typeof item.common_attr === "object"
      ? item.common_attr
      : {};
  const commonVideo =
    commonAttr.video && typeof commonAttr.video === "object"
      ? commonAttr.video
      : {};
  const candidates = [video.video_model, item.video_model, commonVideo.video_model];
  for (const raw of candidates) {
    let model = raw;
    if (typeof raw === "string") {
      try {
        model = JSON.parse(raw);
      } catch (_) {
        continue;
      }
    }
    if (!model || typeof model !== "object" || !model.video_list) continue;
    const entries = Object.values(model.video_list || {}).sort((a, b) => {
      const ao = a && typeof a === "object" && String(a.definition || "") === "origin" ? 0 : 1;
      const bo = b && typeof b === "object" && String(b.definition || "") === "origin" ? 0 : 1;
      return ao - bo;
    });
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      for (const key of ["main_url", "backup_url_1", "backup_url_2", "backup_url_3"]) {
        const url = decodeBase64Url(entry[key]);
        if (url) return url;
      }
    }
  }
  return "";
}

function extractVideoUrlFromItem(item) {
  return (
    extractVideoModelUrlFromItem(item) ||
    firstStrPath(item, [
      ["video", "transcoded_video", "origin", "video_url"],
      ["common_attr", "video", "transcoded_video", "origin", "video_url"],
      ["video", "download_url"],
      ["video", "play_url"],
      ["video", "url"],
      ["common_attr", "video", "download_url"],
      ["common_attr", "video", "play_url"],
      ["common_attr", "video", "url"],
      ["video_url"],
      ["download_url"],
      ["play_url"],
      ["url"],
    ])
  );
}

function extractPreviewUrlFromItem(item) {
  return firstStrPath(item, [
    ["cover", "url"],
    ["cover", "image_url"],
    ["common_attr", "cover_url"],
    ["common_attr", "cover", "url"],
    ["common_attr", "cover", "image_url"],
    ["cover_url"],
    ["cover_image_url"],
    ["image", "url"],
    ["image", "image_url"],
    ["video", "cover", "url"],
    ["video", "cover_url"],
    ["common_attr", "video", "cover", "url"],
    ["common_attr", "video", "cover_url"],
    ["video", "thumbnail_url"],
    ["video", "poster_url"],
    ["common_attr", "video", "thumbnail_url"],
    ["common_attr", "video", "poster_url"],
    ["thumbnail_url"],
    ["poster_url"],
    ["preview_url"],
  ]);
}

function parseHistory(obj, submitId) {
  const data = extractHistoryData(obj, submitId);
  const arr =
    data.history_list ||
    data.histories ||
    data.item_list ||
    data.itemList ||
    [];
  const item = Array.isArray(arr) ? arr[0] || {} : {};
  const videoUrl = extractVideoUrlFromItem(item);
  const thumbUrl = extractPreviewUrlFromItem(item);
  return {
    item,
    videoUrl,
    thumbUrl,
    itemId: item.item_id || item.id || "",
    status: data.status ?? data.task?.status ?? item.status ?? item.task_status ?? "",
    fail:
      data.fail_code ??
      data.task?.fail_code ??
      item.fail_code ??
      item.error_code ??
      "",
    failMsg:
      data.fail_starling_message ||
      data.fail_msg ||
      data.task?.fail_msg ||
      data.task?.resp_ret?.errmsg ||
      "",
    historyRecordId:
      data.history_record_id ||
      data.task?.history_id ||
      data.task?.task_id ||
      "",
    raw: data,
  };
}

function historyFailureInfo(obj, submitId) {
  const h = extractHistoryData(obj, submitId);
  if (!h || typeof h !== "object") {
    return { failed: false, status: "", failCode: "", failMsg: "", historyRecordId: "" };
  }
  const status = h.status ?? h.task?.status ?? "";
  const failCode =
    h.fail_code ??
    h.task?.fail_code ??
    h.error_code ??
    "";
  const failMsg =
    h.fail_starling_message ||
    h.fail_msg ||
    h.task?.fail_msg ||
    h.task?.resp_ret?.errmsg ||
    "";
  const historyRecordId =
    h.history_record_id ||
    h.task?.history_id ||
    h.task?.task_id ||
    "";
  const itemList = Array.isArray(h.item_list) ? h.item_list : [];
  // Python 版明确以 status == 30 判断失败。这里再兜底：
  // US 区有时很快返回 fail_code/fail_msg + finish_time + 空 item_list，
  // 即使上层解析遗漏 status，也不能继续轮询。
  const failed =
    String(status) === "30" ||
    (!!failCode && !!(h.finish_time || h.task?.finish_time) && itemList.length === 0);
  return {
    failed,
    status,
    failCode,
    failMsg,
    historyRecordId,
    raw: h,
  };
}

async function removeDreaminaHistory(tabId, cfg, target, historyId) {
  if (!historyId) return;
  const rmUrl = `${cfg.apiBase}${REMOVE_HISTORY_PATH}?aid=${AID}&web_version=${WEB_VERSION}&da_version=${DRAFT_VERSION}&aigc_features=${FEATURES}`;
  await pageFetchJson(tabId, rmUrl, {
    method: "POST",
    headers: await headersFor(
      REMOVE_HISTORY_PATH,
      { Referer: target },
      cfg.loc,
    ),
    body: { id_list: [historyId] },
  });
}

async function fetchHqVideoUrl(tabId, itemId, cfg, target) {
  if (!itemId) return "";
  const queryUrl = `${cfg.apiBase}${GET_LOCAL_ITEM_LIST_PATH}?aid=${AID}&device_platform=web&region=US&da_version=${DRAFT_VERSION}&web_version=${WEB_VERSION}&aigc_features=${FEATURES}`;
  const tx = await pageFetchJson(tabId, queryUrl, {
    method: "POST",
    headers: await headersFor(
      GET_LOCAL_ITEM_LIST_PATH,
      { Referer: target },
      cfg.loc,
    ),
    body: {
      item_id_list: [itemId],
      pack_item_opt: { scene: 1, need_data_integrity: true },
      is_for_video_download: true,
    },
  });
  const data = tx.json?.data && typeof tx.json.data === "object" ? tx.json.data : tx.json;
  const items = data?.item_list || data?.local_item_list || [];
  if (Array.isArray(items) && items.length) {
    const url = extractVideoUrlFromItem(items[0] && typeof items[0] === "object" ? items[0] : {});
    if (url) return url;
  }
  const text = JSON.stringify(tx.json || {});
  for (const re of [
    /https:\/\/v[0-9]+-dreamnia\.jimeng\.com\/[^"'\s\\]+/,
    /https:\/\/v[0-9]+-[^"'\\]*\.jimeng\.com\/[^"'\s\\]+/,
    /https:\/\/v[0-9]+-[^"'\\]*\.(?:vlabvod|jimeng)\.com\/[^"'\s\\]+/,
    /https:\/\/[^"'\s\\]+\.(?:capcutapi|capcut|byteoversea|ibyteimg)\.[^"'\s\\]+/,
  ]) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return "";
}

export async function runDreaminaTask(msg, runtime) {
  const p = msg.payload || {};
  const target =
    p.target_page || "https://dreamina.capcut.com/ai-tool/video/generate";
  await runtime.progress(2, { stage: "ensure_tab", url: target });
  const tabId = await ensureTab("https://dreamina.capcut.com/", target);
  const action = String(p.action || p.workflow_kind || "")
    .trim()
    .toLowerCase();
  if (
    ["fetch_sessionid", "fetch_access_token", "get_sessionid"].includes(action)
  ) {
    const info = await fetchSessionId(target);
    await runtime.progress(100, {
      stage: "sessionid",
      cookie_name: info.cookie_name,
      expires: info.expires,
    });
    return info;
  }
  const cfg = await resolveRegion(p, target);
  await runtime.progress(2, {
    stage: "region",
    country: cfg.country,
    api_base: cfg.apiBase,
    imagex_base: cfg.imagexBase,
    loc: cfg.loc,
  });
  try {
    await pageFetchJson(tabId, `${cfg.apiBase}${UPDATE_SETTINGS_PATH}`, {
      method: "POST",
      headers: await headersFor(
        UPDATE_SETTINGS_PATH,
        { Referer: target },
        cfg.loc,
      ),
      body: { custom_settings: { aigc_compliance_confirmed: true } },
    });
  } catch (e) {
    await runtime.progress(2, {
      stage: "update_settings_ignored",
      error: String(e.message || e).slice(0, 200),
    });
  }
  const refs = Array.isArray(p.image_refs) ? p.image_refs : [];
  if (refs.length) {
    p.image_refs = await uploadImageRefs(tabId, refs, cfg, runtime);
  }
  const { submitId, body, functionMode } = buildGenerateBody(p);
  const generateUrl = `${cfg.apiBase}${GENERATE_PATH}?aid=${AID}&device_platform=web&region=US&da_version=${DRAFT_VERSION}&os=windows&web_component_open_flag=0&commerce_with_input_video=1&web_version=${WEB_VERSION}&aigc_features=${FEATURES}`;
  await runtime.progress(6, {
    stage: "submit_api",
    function_mode: functionMode,
  });
  const tx = await pageFetchJson(tabId, generateUrl, {
    method: "POST",
    headers: await headersFor(GENERATE_PATH, { Referer: target }, cfg.loc),
    body,
  });
  if (tx.status >= 400 || (tx.json?.ret && String(tx.json.ret) !== "0"))
    throw new Error(`Dreamina submit failed: ${compactErrorResponse(tx)}`);
  const aigc = tx.json?.data?.aigc_data || tx.json?.aigc_data || {};
  const taskId = aigc.history_record_id || aigc.task?.task_id || "";
  if (!taskId)
    throw new Error(
      `Dreamina submit missing task id: ${JSON.stringify(tx.json).slice(0, 500)}`,
    );
  await runtime.progress(10, {
    stage: "submitted",
    task_id: taskId,
    submit_id: submitId,
  });
  await sleep(30000);
  const deadline =
    Date.now() + Math.max(60000, Number(p.timeout_seconds || 600) * 1000);
  let videoUrl = "",
    thumbUrl = "",
    itemId = "";
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const histUrl = `${cfg.apiBase}${HISTORY_PATH}?aid=${AID}&device_platform=web&region=US&da_version=${DRAFT_VERSION}&web_version=${WEB_VERSION}&aigc_features=${FEATURES}`;
    const hx = await pageFetchJson(tabId, histUrl, {
      method: "POST",
      headers: await headersFor(HISTORY_PATH, { Referer: target }, cfg.loc),
      body: { submit_ids: [submitId] },
    });
    const failure = historyFailureInfo(hx.json, submitId);
    const parsed = parseHistory(hx.json, submitId);
    videoUrl = parsed.videoUrl;
    thumbUrl = parsed.thumbUrl;
    itemId = parsed.itemId;
    const effectiveStatus = failure.status !== "" ? failure.status : parsed.status;
    const parsedStatus = String(effectiveStatus ?? "");
    const isFailed = failure.failed || parsedStatus === "30";
    await runtime.progress(Math.min(95, 35 + attempt), {
      stage: isFailed ? "failed" : videoUrl ? "result_found" : "polling",
      task_id: taskId,
      submit_id: submitId,
      status: effectiveStatus,
      fail_code: failure.failCode || parsed.fail,
      fail_msg: failure.failMsg || parsed.failMsg,
      history_record_id: failure.historyRecordId || parsed.historyRecordId,
    });
    // 与 Python 版保持一致：status == 30 表示生成失败，不能继续轮询。
    // 例如 fail_code=4011 / fail_msg=RejectFace / fail_starling_message=Face detected...
    if (isFailed) {
      try {
        await removeDreaminaHistory(
          tabId,
          cfg,
          target,
          failure.historyRecordId || parsed.historyRecordId || taskId,
        );
      } catch {}
      const msg =
        failure.failMsg ||
        parsed.failMsg ||
        failure.failCode ||
        parsed.fail ||
        "内容被过滤";
      throw new Error(`Dreamina generation failed: ${msg}`);
    }
    if (videoUrl) break;
    // Python 版：status != 20 就跳出，后面按缺少 video_url 处理，避免无意义轮询。
    if (parsedStatus !== "" && parsedStatus !== "20") break;
    await sleep(5000);
  }
  if (!videoUrl)
    throw new Error("Dreamina polling timeout or missing video_url");
  if (itemId) {
    try {
      const hqUrl = await fetchHqVideoUrl(tabId, itemId, cfg, target);
      if (hqUrl) {
        videoUrl = hqUrl;
        await runtime.progress(96, {
          stage: "hq_video_url",
          item_id: itemId,
        });
      }
    } catch (e) {
      await runtime.progress(96, {
        stage: "hq_video_url_fallback",
        item_id: itemId,
        error: String(e?.message || e).slice(0, 300),
      });
    }
  }
  try {
    await removeDreaminaHistory(tabId, cfg, target, taskId);
  } catch {}
  await runtime.progress(100, {
    stage: "done",
    task_id: taskId,
    video_url: videoUrl,
  });
  return {
    type: "dreamina_workflow_video",
    message: "Dreamina 视频完成",
    share_url: videoUrl,
    thumb_url: thumbUrl,
    video_type:
      (p.image_refs || []).length || (p.prompt_subject_refs || []).length
        ? "i2v"
        : "t2v",
    model_key: p.model_key || p.model_name || "",
    workflow_kind: "video",
    function_mode: functionMode,
    reference_mode: p.reference_mode || "",
    model_name: p.model_name || p.model_key || "",
    aspect_ratio: p.aspect_ratio || "",
    duration: Number(p.duration || 15),
    task_id: taskId,
    history_id: taskId,
    submit_id: submitId,
    image_count:
      (p.image_refs || []).length + (p.prompt_subject_refs || []).length,
    item_id: itemId,
  };
}
