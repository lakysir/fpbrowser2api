/*
runGeneratedTest(config) parameter contract:
The JSON in the Test Config box is passed as config. Keep this list even when some fields are unused.
- config.prompt: string - 文生图的提示词
- config.ratio: string - 图片比例，"1:1" 方形、"16:9" 横版 或 "9:16" 竖版，默认 "1:1"
*/

async function runGeneratedTest(config) {
  const startTime = Date.now();
  
  const prompt = String(config.prompt || "").trim();
  const ratio = String(config.ratio || "1:1").trim();
  const modelName = String(config.modelName || "GEM_PIX_2").trim().toUpperCase() === "NARWHAL" ? "NARWHAL" : "GEM_PIX_2";
  
  if (!prompt) {
    return { ok: false, error: "缺少必需参数: config.prompt" };
  }
  
  // 将比例转换为 API 参数值（根据实际抓包分析）
  // 1 = 方形 (1:1)
  // 2 = 竖版 (9:16)
  // 5 = 横版 (16:9)
  let ratioValue;
  if (ratio === "1:1" || ratio === "方形" || ratio === "square") {
    ratioValue = 1;
  } else if (ratio === "16:9" || ratio === "横版" || ratio === "horizontal") {
    ratioValue = 5;
  } else if (ratio === "9:16" || ratio === "竖版" || ratio === "vertical") {
    ratioValue = 2;
  } else if (ratio === "4:3") {
    ratioValue = 3;
  } else if (ratio === "3:4") {
    ratioValue = 4;
  } else {
    return { 
      ok: false, 
      error: `不支持的图片比例: ${ratio}，请使用 "1:1"、"16:9" 或 "9:16"` 
    };
  }
  
  console.log("🚀 开始文生图测试");
  console.log("  - 提示词:", prompt);
  console.log("  - 图片比例:", ratio, `(参数值: ${ratioValue})`);
  
  // ============ 工具函数 ============
  
  function getStableParams() {
    const params = { fSid: null, atToken: null, bl: null };

    if (window.WIZ_global_data) {
      for (const key in window.WIZ_global_data) {
        const value = window.WIZ_global_data[key];
        if (!params.fSid && typeof value === "string" && /^-?\d{15,20}$/.test(value)) {
          params.fSid = value;
        }
        if (!params.atToken && typeof value === "string" && /^AIQ-[A-Za-z0-9_-]+:\d+$/.test(value)) {
          params.atToken = value;
        }
        if (!params.bl && typeof value === "string" && /^boq[_-]/.test(value)) {
          params.bl = value;
        }
      }
    }

    if (!params.fSid || !params.bl) {
      try {
        const requests = performance.getEntriesByType("resource")
          .filter(entry => String(entry.name).includes("batchexecute"));
        if (requests.length > 0) {
          const requestUrl = new URL(requests[requests.length - 1].name);
          if (!params.fSid) params.fSid = requestUrl.searchParams.get("f.sid");
          if (!params.bl) params.bl = requestUrl.searchParams.get("bl");
        }
      } catch (error) {
        console.warn("⚠️ 无法从请求历史中提取参数:", error);
      }
    }

    if (!params.bl) {
      params.bl = "boq_labs-ai-sandbox-frontend_20260907.00_p0";
    }

    return params;
  }

  function getCurrentProjectId() {
    const match = window.location.pathname.match(/^\/project\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
  }

  function generateUUID() {
    if (crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  
  async function getRecaptchaToken(action) {
    if (!window.grecaptcha || !window.grecaptcha.enterprise) {
      throw new Error("grecaptcha.enterprise not found");
    }
    await new Promise(function(resolve) { 
      window.grecaptcha.enterprise.ready(resolve); 
    });
    return await window.grecaptcha.enterprise.execute(
      "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV", 
      { action: action }
    );
  }

  function buildBatchExecuteUrl(rpcids, params, projectId) {
    const reqid = Math.floor(Math.random() * 9000 + 1000) * 100000 + Math.floor(Math.random() * 100000);
    const hl = document.documentElement.lang || "en";
    const sourcePath = encodeURIComponent(`/project/${projectId}`);

    return (
      "https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?" +
      `rpcids=${rpcids}&` +
      `source-path=${sourcePath}&` +
      `bl=${encodeURIComponent(params.bl)}&` +
      `f.sid=${encodeURIComponent(params.fSid)}&` +
      `hl=${encodeURIComponent(hl)}&` +
      `_reqid=${reqid}&` +
      "rt=c"
    );
  }

  async function sendBatchExecute(rpcids, payloadArray, params, projectId) {
    const url = buildBatchExecuteUrl(rpcids, params, projectId);
    
    const payloadStr = JSON.stringify(payloadArray);
    const requestData = [[[rpcids, payloadStr, null, "generic"]]];
    const body =
      `f.req=${encodeURIComponent(JSON.stringify(requestData))}` +
      `&at=${encodeURIComponent(params.atToken)}&`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        "X-Same-Domain": "1"
      },
      body,
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  }

  function parseBatchExecuteResponse(responseText) {
    const lines = responseText.split('\n');
    for (const line of lines) {
      if (line.startsWith('[[')) {
        try {
          const parsed = JSON.parse(line);
          return parsed;
        } catch (e) {
          console.warn("解析失败:", e);
        }
      }
    }
    return null;
  }

  function decodeBatchExecuteResponse(responseText) {
    let decoded = String(responseText || "");
    for (let i = 0; i < 3; i++) {
      const next = decoded
        .replace(/\\\\/g, "\\")
        .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\\//g, "/");
      if (next === decoded) break;
      decoded = next;
    }
    return decoded;
  }

  function extractImageUrl(responseText) {
    const decoded = decodeBatchExecuteResponse(responseText);
    const match = decoded.match(/https:\/\/flow-content\.google\/image\/[0-9a-f-]+\?[^\s"'\\\]]+/i);
    if (!match) {
      return { imageUrl: null, decodedResponse: decoded };
    }
    return {
      imageUrl: match[0].replace(/[),]+$/, ""),
      decodedResponse: decoded
    };
  }

  // ============ 主流程 ============
  
  try {
    const params = getStableParams();
    const projectId = getCurrentProjectId();
    
    if (!params.fSid || !params.atToken) {
      return { ok: false, error: "无法获取必要的认证参数" };
    }
    
    if (!projectId) {
      return { ok: false, error: "无法获取项目 ID" };
    }
    
    console.log("✅ 参数准备完成");
    console.log("  - 项目ID:", projectId);
    
    // 步骤1: 获取 recaptcha token
    console.log("🔐 获取 reCAPTCHA token...");
    const recaptchaToken = await getRecaptchaToken("IMAGE_GENERATION");
    console.log("✅ reCAPTCHA token 获取成功");
    
    // 步骤2: 创建文生图任务 (rpcids: ogiZ0b)
    console.log("📤 创建文生图任务...");
    
    const uuid1 = generateUUID().toUpperCase();
    const uuid2 = generateUUID().toUpperCase();
    const randomNumber = Math.floor(Math.random() * 2000000000);
    
    // 根据抓包分析，ogiZ0b 请求的 payload 结构如下：
    // [null, [[null, null, null, randomNumber, ratioValue, "GEM_PIX_2", null, 
    //   [null, 22, null, null, null, projectId, null, null, null, null, [recaptchaToken, 1]], 
    //   [[[prompt]]], null, null, null, uuid1, uuid2]], 
    //  1, [null, 22, null, null, null, projectId, null, null, null, null, [recaptchaToken, 1]], 
    //  [uuid2]]
    const createPayloadArray = [
      null,
      [
        [
          null,
          null,
          null,
          randomNumber,
          ratioValue,
          modelName,
          null,
          [
            null,
            22,
            null,
            null,
            null,
            projectId,
            null,
            null,
            null,
            null,
            [recaptchaToken, 1]
          ],
          [[[prompt]]],
          null,
          null,
          null,
          uuid1,
          uuid2
        ]
      ],
      1,
      [
        null,
        22,
        null,
        null,
        null,
        projectId,
        null,
        null,
        null,
        null,
        [recaptchaToken, 1]
      ],
      [uuid2]
    ];

    const createResponse = await sendBatchExecute("ogiZ0b", createPayloadArray, params, projectId);
    
    // 从响应中提取图片信息
    const parsed = extractImageUrl(createResponse);
    
    if (!parsed.imageUrl) {
      const createParsed = parseBatchExecuteResponse(createResponse);
      return { 
        ok: false, 
        error: "创建图片任务失败：无法提取图片URL",
        createParsed: createParsed ? JSON.stringify(createParsed).substring(0, 1000) : null,
        rawResponse: createResponse.substring(0, 1000)
      };
    }
    
    const imageUrl = parsed.imageUrl;
    
    // 从响应中提取 mediaUUID (图片的唯一标识符)
    let mediaUUID = null;
    const createParsed = parseBatchExecuteResponse(createResponse);
    if (createParsed && createParsed.length > 0) {
      for (const item of createParsed) {
        if (item && item[0] === "wrb.fr" && item[1] === "ogiZ0b" && item[2]) {
          const responseStr = String(item[2]);
          const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
          const allUUIDs = responseStr.match(uuidPattern);
          
          if (allUUIDs && allUUIDs.length >= 1) {
            // 第一个 UUID 通常是 mediaUUID (图片ID)
            mediaUUID = allUUIDs[0];
            console.log("✅ 成功提取媒体UUID:", mediaUUID);
          }
          break;
        }
      }
    }
    
    console.log("✅ 图片生成成功！");
    console.log("🖼️  图片地址:", imageUrl);
    
    const elapsedMs = Date.now() - startTime;
    
    return {
      ok: true,
      message: "文生图任务完成",
      elapsedMs,
      elapsedFormatted: `${Math.floor(elapsedMs / 1000)}秒`,
      input: { 
        prompt,
        ratio,
        ratioValue
      },
      result: {
        projectId,
        mediaUUID: mediaUUID || uuid1,
        imageUrl,
        uuid1,
        uuid2
      },
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error("❌ 错误:", error);
    return {
      ok: false,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    };
  }
}
