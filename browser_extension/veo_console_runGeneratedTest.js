/* Paste this file into the labs.google DevTools console, then call:
 * await runGeneratedTest({ prompt: "...", referenceImageUrls: [...] })
 */
async function runGeneratedTest(config) {
  config = config || {};
  if (location.hostname !== "labs.google") throw new Error("Expected labs.google, current URL: " + location.href);
  const U = {
    session: ["/api/auth/session", "/fx/api/auth/session"],
    uploadImage: "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage",
    t2v: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText",
    i2v: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage",
    i2vStartEnd: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage",
    r2v: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages",
    edit: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoEditVideo",
    poll: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus"
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const headers = token => ({ Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + token });
  async function json(url, opt) {
    const r = await fetch(url, opt); const text = await r.text(); let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!r.ok) throw new Error("Request failed " + r.status + " " + url + ": " + text.slice(0, 1000));
    return data;
  }
  async function token() {
    for (const path of U.session) try {
      const j = await json(path, { credentials: "include" });
      const t = j && (j.accessToken || j.access_token || j.token); if (t) return t;
    } catch (_) {}
    throw new Error("VEO access token not found");
  }
  async function captcha() {
    if (!window.grecaptcha || !grecaptcha.enterprise) throw new Error("grecaptcha.enterprise not found");
    await new Promise(resolve => grecaptcha.enterprise.ready(resolve));
    return grecaptcha.enterprise.execute("6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV", { action: "VIDEO_GENERATION" });
  }
  function urls(value) { return (Array.isArray(value) ? value : (value ? [value] : [])).map(String).map(x => x.trim()).filter(Boolean); }
  function uniq(value) { return [...new Set(value)]; }
  async function imageUpload(url, at, projectId, index) {
    const r = await fetch(url, { credentials: "omit" }); if (!r.ok) throw new Error("Download reference image failed: " + r.status);
    const b = new Uint8Array(await (await r.blob()).arrayBuffer()); let bin = "";
    for (const x of b) bin += String.fromCharCode(x);
    const mime = (await fetch(url, { method: "HEAD", credentials: "omit" }).catch(() => null))?.headers.get("content-type") || "image/jpeg";
    const j = await json(U.uploadImage, { method: "POST", headers: headers(at), credentials: "include", body: JSON.stringify({
      clientContext: { tool: "PINHOLE", projectId: String(projectId) }, fileName: "console_ref_" + Date.now() + "_" + index + ".jpg",
      imageBytes: btoa(bin), isHidden: false, isUserUploaded: true, mimeType: mime
    }) });
    const media = j && j.media || {}; const id = media.name || (j.mediaGenerationId && (j.mediaGenerationId.mediaGenerationId || j.mediaGenerationId));
    if (!id) throw new Error("Upload image missing mediaId: " + JSON.stringify(j).slice(0, 500));
    return { mediaId: id, sourceUrl: url };
  }
  function firstString(o, key) {
    if (!o || typeof o !== "object") return "";
    if (typeof o[key] === "string" && o[key]) return o[key];
    for (const v of Object.values(o)) { const x = firstString(v, key); if (x) return x; }
    return "";
  }
  const projectId = String(config.project_id || config.projectId || ((location.pathname.match(/\/project\/([^/?#]+)/) || [])[1] || ""));
  if (!projectId) throw new Error("project_id required or open a Flow /project/{id} page");
  const prompt = String(config.prompt || "Generate a short cinematic test video.");
  const refs = uniq([
    ...urls(config.firstImageUrl || config.first_image_url || config.startImageUrl || config.start_image_url),
    ...urls(config.lastImageUrl || config.last_image_url || config.endImageUrl || config.end_image_url),
    ...urls(config.referenceImageUrl), ...urls(config.referenceImageUrls)
  ]);
  const videoRefs = uniq([...urls(config.referenceVideoUrl || config.reference_video_url), ...urls(config.videoUrl || config.video_url)]);
  const namedFrames = urls(config.firstImageUrl || config.first_image_url || config.startImageUrl || config.start_image_url).length === 1 && urls(config.lastImageUrl || config.last_image_url || config.endImageUrl || config.end_image_url).length === 1;
  const modeName = String(config.video_mode || config.mode || "").toLowerCase();
  const mode = videoRefs.length ? "r2v" : (modeName === "i2v" || namedFrames ? "i2v" : (modeName === "r2v" || refs.length >= 2 ? "r2v" : (refs.length ? "i2v" : "t2v")));
  const at = await token(); const uploaded = [];
  const model = String(config.model || (mode === "i2v" ? "veo_3_1_i2v_fast" : "veo_3_1_t2v_fast"));
  const aspectRatio = String(config.aspectRatio || "VIDEO_ASPECT_RATIO_LANDSCAPE");
  let endpoint = U.t2v; let item;
  if (mode === "i2v") {
    const ids = []; for (let i = 0; i < refs.length; i++) { const x = await imageUpload(refs[i], at, projectId, i); uploaded.push(x); ids.push(x.mediaId); }
    if (!ids.length) throw new Error("i2v requires an image URL");
    item = { aspectRatio, seed: 1 + Math.floor(Math.random() * 99999), textInput: { prompt }, videoModelKey: ids[1] ? model : model.replace("_fl_", "_").replace(/_fl$/, ""), startImage: { mediaId: ids[0] }, ...(ids[1] ? { endImage: { mediaId: ids[1] } } : {}), metadata: { sceneId: crypto.randomUUID() } };
    endpoint = ids[1] ? U.i2vStartEnd : U.i2v;
  } else if (mode === "r2v") {
    const ri = []; for (let i = 0; i < refs.length; i++) { const x = await imageUpload(refs[i], at, projectId, i); uploaded.push(x); ri.push({ imageUsageType: "IMAGE_USAGE_TYPE_ASSET", mediaId: x.mediaId }); }
    item = { aspectRatio, seed: 1 + Math.floor(Math.random() * 99999), textInput: { structuredPrompt: { parts: [{ text: prompt }] } }, videoModelKey: model, referenceImages: ri, metadata: { sceneId: crypto.randomUUID() } };
    if (config.videoMediaId) { endpoint = U.edit; item.videoInput = { mediaId: String(config.videoMediaId), startFrameIndex: Number(config.startFrameIndex || 0), endFrameIndex: Number(config.endFrameIndex || 0) || undefined }; }
  } else item = { aspectRatio, seed: 1 + Math.floor(Math.random() * 99999), textInput: { prompt }, videoModelKey: model, metadata: { sceneId: crypto.randomUUID() } };
  const body = { mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: "BLOCK_SILENCED_VIDEOS" }, clientContext: { recaptchaContext: { token: await captcha(), applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB" }, sessionId: ";" + Date.now(), projectId, tool: "PINHOLE" }, requests: [item] };
  if (mode === "r2v") body.useV2ModelConfig = true;
  const submit = await json(endpoint, { method: "POST", headers: headers(at), credentials: "include", body: JSON.stringify(body) });
  const media = Array.isArray(submit.media) ? submit.media : []; if (!media.length) throw new Error("Video submit missing poll media: " + JSON.stringify(submit).slice(0, 800));
  const pollMedia = media.map(x => { const n = String((x.operation && x.operation.name) || x.operation || x.name || x.mediaGenerationId || ""); return { name: n, projectId: String(x.projectId || projectId) }; }).filter(x => x.name);
  if (!pollMedia.length) throw new Error("Video submit missing operation name");
  const deadline = Date.now() + Number(config.maxWaitSeconds || 600) * 1000; let last = null;
  while (Date.now() < deadline) {
    await sleep(Number(config.pollIntervalSeconds || 5) * 1000);
    last = await json(U.poll, { method: "POST", headers: headers(at), credentials: "include", body: JSON.stringify({ media: pollMedia }) });
    const videoUrl = firstString(last, "fifeUrl"); if (videoUrl) return { ok: true, type: "flow_video", video_type: mode, model, project_id: projectId, video_url: videoUrl, share_url: videoUrl, uploadedReferences: uploaded, rawSubmit: submit };
  }
  return { ok: false, type: "flow_video", video_type: mode, error: "Video polling timeout", project_id: projectId, uploadedReferences: uploaded, last, rawSubmit: submit };
}
window.runGeneratedTest = runGeneratedTest;
