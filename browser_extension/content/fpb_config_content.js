(() => {
  function safeDecode(value) {
    const s = String(value || "");
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch (_) {
      return s;
    }
  }

  function readParam(url, name) {
    const fromSearch = url.searchParams.get(name);
    if (fromSearch !== null && fromSearch !== undefined) return fromSearch;

    const hash = String(url.hash || "").replace(/^#/, "");
    if (!hash) return "";
    try {
      const hp = new URLSearchParams(hash);
      const v = hp.get(name);
      if (v !== null && v !== undefined) return v;
    } catch (_) {}

    const m = hash.match(new RegExp(`(?:^|&)${name}=([^&]*)`));
    return m ? safeDecode(m[1]) : "";
  }

  function normalizeRedirect(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    try {
      const u = new URL(s);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) {}
    return "";
  }

  try {
    const u = new URL(location.href);
    const patch = {};
    const spaceId = readParam(u, "fpb_space_id");
    const windowKey = readParam(u, "fpb_window_key");
    const bridgeUrl = readParam(u, "fpb_bridge_url");
    const bridgeToken = readParam(u, "fpb_bridge_token");
    const googleAccount = readParam(u, "fpb_google_account");
    const googlePassword = readParam(u, "fpb_google_password");
    const googleEfa = readParam(u, "fpb_google_efa");
    const redirectUrl = normalizeRedirect(readParam(u, "redirect_url"));

    if (spaceId) patch.space_id = String(spaceId).trim();
    if (windowKey) patch.window_key = String(windowKey).trim();
    if (bridgeUrl) patch.bridge_url = String(bridgeUrl).trim();
    if (bridgeToken) patch.bridge_token = String(bridgeToken).trim();
    if (googleAccount) patch.google_account = String(googleAccount).trim();
    if (googlePassword) patch.google_password = String(googlePassword);
    if (googleEfa) patch.google_efa = String(googleEfa).trim();

    if (Object.keys(patch).length) {
      chrome.storage.local.set(patch);
      try {
        chrome.runtime.sendMessage({
          type: "content.fpbConfig",
          config: patch,
          redirect_url: redirectUrl
        });
      } catch (_) {
        if (redirectUrl && location.href !== redirectUrl) {
          setTimeout(() => {
            try { location.href = redirectUrl; } catch (_) {}
          }, 3000);
        }
      }
    }
  } catch (_) {}
})();
