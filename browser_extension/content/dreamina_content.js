(() => {
  try {
    const u = new URL(location.href);
    const spaceId = u.searchParams.get("fpb_space_id") || u.hash.match(/fpb_space_id=([^&]+)/)?.[1];
    const windowKey = u.searchParams.get("fpb_window_key") || u.hash.match(/fpb_window_key=([^&]+)/)?.[1];
    const bridgeUrl = u.searchParams.get("fpb_bridge_url") || u.hash.match(/fpb_bridge_url=([^&]+)/)?.[1];
    const bridgeToken = u.searchParams.get("fpb_bridge_token") || u.hash.match(/fpb_bridge_token=([^&]+)/)?.[1];
    const patch = {};
    if (spaceId) patch.space_id = decodeURIComponent(spaceId);
    if (windowKey) patch.window_key = decodeURIComponent(windowKey);
    if (bridgeUrl) patch.bridge_url = decodeURIComponent(bridgeUrl);
    if (bridgeToken) patch.bridge_token = decodeURIComponent(bridgeToken);
    if (Object.keys(patch).length) {
      chrome.storage.local.set(patch);
      try {
        chrome.runtime.sendMessage({ type: "content.fpbConfig", config: patch });
      } catch (_) {}
    }
  } catch (_) {}
})();
