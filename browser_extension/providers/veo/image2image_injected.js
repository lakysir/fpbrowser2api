/*
runGeneratedTest(config) parameter contract:
The JSON in the Test Config box is passed as config. Keep this list even when some fields are unused.
- config.prompt: string - 文生图的提示词
- config.ratio: string - 图片比例，可选值："1:1"（方形）、"16:9"（横版）、"9:16"（竖版）
- config.referenceImageUrls: array - 参考图片URL数组
*/

async function runGeneratedTest(config) {
  const startTime = Date.now();
  
  const prompt = String(config.prompt || "").trim();
  const referenceImageUrls = Array.isArray(config.referenceImageUrls) ? config.referenceImageUrls : [];
  const ratio = String(config.ratio || "1:1").trim();
  const modelName = String(config.modelName || "GEM_PIX_2").trim().toUpperCase() === "NARWHAL" ? "NARWHAL" : "GEM_PIX_2";
  
  if (!prompt) {
    return { ok: false, error: "缺少必需参数: config.prompt" };
  }
  
  if (referenceImageUrls.length === 0) {
    return { ok: false, error: "缺少必需参数: config.referenceImageUrls（至少需要1张参考图）" };
  }
  
  // 验证并转换 ratio
  let ratioValue;
  if (ratio === "1:1") {
    ratioValue = 1; // 方形
  } else if (ratio === "16:9") {
    ratioValue = 3; // 横版
  } else if (ratio === "9:16") {
    ratioValue = 2; // 竖版
  } else if (ratio === "4:3") {
    ratioValue = 5;
  } else if (ratio === "3:4") {
    ratioValue = 4;
  } else {
    return { 
      ok: false, 
      error: `无效的 ratio 参数: "${ratio}"，仅支持 "1:1"、"16:9" 或 "9:16"` 
    };
  }
  
  console.log("🚀 开始多参考图生图测试");
  console.log("  - 提示词:", prompt);
  console.log("  - 参考图数量:", referenceImageUrls.length);
  console.log("  - 图片比例:", ratio, `(代码: ${ratioValue})`);
  referenceImageUrls.forEach((url, idx) => {
    console.log(`  - 参考图${idx + 1}:`, url);
  });
  
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
      params.bl = "boq_labs-ai-sandbox-frontend_20260903.13_p1";
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

  async function downloadAndConvertToJpeg(imageUrl) {
    console.log("📥 正在下载图片:", imageUrl);
    
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`图片下载失败: ${response.status}`);
    }
    
    const blob = await response.blob();
    console.log("✅ 图片下载成功，类型:", blob.type, "大小:", Math.floor(blob.size / 1024), "KB");
    
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
    
    console.log("✅ 图片加载完成，尺寸:", img.width, "x", img.height);
    
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    
    URL.revokeObjectURL(img.src);
    
    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const jpegBase64 = jpegDataUrl.split(',')[1];
    
    console.log("✅ 已转换为JPEG，大小:", Math.floor(jpegBase64.length / 1024), "KB");
    
    return jpegBase64;
  }

  async function uploadImage(imageUrl, params, projectId, recaptchaToken, index) {
    console.log(`📤 上传第 ${index + 1} 张图片...`);
    const imageBase64 = await downloadAndConvertToJpeg(imageUrl);
    
    const uuid1 = generateUUID();
    const uuid2 = generateUUID();
    
    const uploadPayloadArray = [
      [null, 22, null, null, null, projectId, null, null, null, null, [recaptchaToken, 1]],
      imageBase64,
      "image/jpeg",
      1,
      null,
      null,
      null,
      null,
      `image-${index + 1}.jpg`,
      null,
      uuid1,
      uuid2
    ];

    const uploadResponse = await sendBatchExecute("maseQ", uploadPayloadArray, params, projectId);
    const uploadParsed = parseBatchExecuteResponse(uploadResponse);
    
    if (!uploadParsed || uploadParsed.length === 0) {
      throw new Error(`❌ 上传第 ${index + 1} 张图片失败：响应为空`);
    }
    
    let mediaUUID = null;
    
    for (const item of uploadParsed) {
      if (item && item[0] === "wrb.fr" && item[1] === "maseQ" && item[2]) {
        try {
          const data = JSON.parse(item[2]);
          
          if (data && data[0] && data[0][0]) {
            mediaUUID = data[0][0];
            console.log(`✅ 第 ${index + 1} 张图片上传成功，UUID:`, mediaUUID);
          }
        } catch (e) {
          console.error(`❌ 解析第 ${index + 1} 张图片UUID失败:`, e.message);
        }
        break;
      }
    }
    
    if (!mediaUUID) {
      throw new Error(`❌ 上传第 ${index + 1} 张图片失败：无法提取媒体UUID`);
    }
    
    return mediaUUID;
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
    
    // 步骤2: 批量上传参考图片
    console.log(`📤 开始批量上传 ${referenceImageUrls.length} 张参考图片...`);
    const imageUUIDs = [];
    
    for (let i = 0; i < referenceImageUrls.length; i++) {
      const imageUrl = String(referenceImageUrls[i]).trim();
      if (!imageUrl) {
        throw new Error(`第 ${i + 1} 张图片URL为空`);
      }
      const uuid = await uploadImage(imageUrl, params, projectId, recaptchaToken, i);
      imageUUIDs.push(uuid);
    }
    
    console.log("✅ 所有图片上传完成！");
    console.log("  - 图片UUIDs:", imageUUIDs);
    
    // 步骤3: 创建多图生图任务 (rpcids: ogiZ0b)
    console.log("📤 创建多图生图任务...");
    
    const uuid1 = generateUUID().toUpperCase();
    const uuid2 = generateUUID().toUpperCase();
    const uuid3 = generateUUID().toUpperCase();
    
    // 构建图片引用数组，格式：[[uuid, null, null, null, 1], [uuid2, null, null, null, 1]]
    const imageReferences = imageUUIDs.map(uuid => [uuid, null, null, null, 1]);
    
    // 生成随机数（观察到的范围：1654995980）
    const randomNumber = Math.floor(Math.random() * 2000000000);
    
    console.log("  - 图片引用数组:", JSON.stringify(imageReferences));
    console.log("  - 比例代码:", ratioValue);
    console.log("  - 随机数:", randomNumber);
    console.log("  - UUID1:", uuid1);
    console.log("  - UUID2:", uuid2);
    console.log("  - UUID3:", uuid3);
    
    // 按照抓包的精确结构构建 payload
    // [null, [[null, null, [[uuid1, null, null, null, 1], [uuid2, ...]], randomNumber, ratioValue, "GEM_PIX_2", null, [recaptcha数组], [[[prompt]]], null, null, null, uuid1, uuid2]], 1, [recaptcha数组], [uuid3]]
    const createPayloadArray = [
      null,
      [
        [
          null,
          null,
          imageReferences,
          randomNumber,
          ratioValue,
          modelName,
          null,
          [null, 22, null, null, null, projectId, null, null, null, null, [recaptchaToken, 1]],
          [[[prompt]]],
          null,
          null,
          null,
          uuid1,
          uuid2
        ]
      ],
      1,
      [null, 22, null, null, null, projectId, null, null, null, null, [recaptchaToken, 1]],
      [uuid3]
    ];
    
    console.log("  - 完整payload预览:", JSON.stringify(createPayloadArray).substring(0, 200) + "...");

    const createResponse = await sendBatchExecute("ogiZ0b", createPayloadArray, params, projectId);
    
    console.log("📋 原始响应:", createResponse.substring(0, 500));
    
    const createParsed = parseBatchExecuteResponse(createResponse);
    
    if (!createParsed || createParsed.length === 0) {
      return { 
        ok: false, 
        error: "创建图片任务失败：响应为空",
        rawResponse: createResponse.substring(0, 1000)
      };
    }
    
    // 检查是否有错误响应
    for (const item of createParsed) {
      if (item && item[0] === "wrb.fr" && item[1] === "ogiZ0b") {
        // 检查是否包含错误信息
        if (item[5] && Array.isArray(item[5])) {
          const errorInfo = item[5];
          // errorInfo 格式: [7, null, [["type.googleapis.com/google.rpc.ErrorInfo", ["PUBLIC_ERROR_UNUSUAL_ACTIVITY"]]]]
          if (errorInfo[0] === 7 && errorInfo[2] && Array.isArray(errorInfo[2])) {
            const errorDetails = errorInfo[2];
            let errorCode = "UNKNOWN_ERROR";
            
            for (const detail of errorDetails) {
              if (Array.isArray(detail) && detail.length >= 2) {
                if (detail[0] === "type.googleapis.com/google.rpc.ErrorInfo" && Array.isArray(detail[1])) {
                  errorCode = detail[1][0] || errorCode;
                }
              }
            }
            
            console.error("❌ 图片生成失败:", errorCode);
            
            return {
              ok: false,
              error: `图片生成失败: ${errorCode}`,
              errorCode,
              errorDetails: errorInfo,
              elapsedMs: Date.now() - startTime,
              input: {
                prompt,
                referenceImageCount: referenceImageUrls.length,
                referenceImageUrls,
                ratio,
                ratioValue
              },
              timestamp: new Date().toISOString()
            };
          }
        }
      }
    }
    
    // 如果没有错误，尝试提取图片URL
    const { imageUrl, decodedResponse } = extractImageUrl(createResponse);
    
    if (!imageUrl) {
      return {
        ok: false,
        error: "无法从响应中提取图片URL",
        decodedResponse: decodedResponse.substring(0, 1000),
        rawResponse: createResponse.substring(0, 1000)
      };
    }
    
    console.log("✅ 图片生成成功！");
    console.log("🖼️ 图片地址:", imageUrl);
    
    const elapsedMs = Date.now() - startTime;
    
    return {
      ok: true,
      message: "多参考图生图任务完成",
      elapsedMs,
      elapsedFormatted: `${Math.floor(elapsedMs / 1000)}秒`,
      input: { 
        prompt,
        referenceImageCount: referenceImageUrls.length,
        referenceImageUrls,
        ratio,
        ratioValue
      },
      result: {
        projectId,
        imageUUIDs,
        imageUrl,
        uuid1,
        uuid2,
        uuid3
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
