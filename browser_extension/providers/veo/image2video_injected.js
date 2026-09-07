/*
runGeneratedTest(config) parameter contract:
The JSON in the Test Config box is passed as config. Keep this list even when some fields are unused.
- config.prompt: string - 视频生成的提示词
- config.referenceImageUrls: array - 参考图片URL数组（1-4张）
- config.aspectRatio: string - 视频横竖比例，可选值："9:16"（竖版）或 "16:9"（横版），默认 "16:9"
*/

async function runGeneratedTest(config) {
  const startTime = Date.now();
  
  const prompt = String(config.prompt || "").trim();
  const referenceImageUrls = Array.isArray(config.referenceImageUrls) ? config.referenceImageUrls : [];
  const aspectRatio = String(config.aspectRatio || "16:9").trim();
  
  if (!prompt) {
    return { ok: false, error: "缺少必需参数: config.prompt" };
  }
  
  if (referenceImageUrls.length === 0) {
    return { ok: false, error: "缺少必需参数: config.referenceImageUrls（至少需要1张参考图）" };
  }
  
  if (referenceImageUrls.length > 9) {
    return { ok: false, error: "参考图片数量超过限制（最多4张）" };
  }
  
  // 验证并转换 aspectRatio
  let aspectRatioCode;
  if (aspectRatio === "9:16") {
    aspectRatioCode = 1; // 竖版
  } else if (aspectRatio === "16:9") {
    aspectRatioCode = 2; // 横版
  } else {
    return { 
      ok: false, 
      error: `无效的 aspectRatio 参数: "${aspectRatio}"，仅支持 "9:16" 或 "16:9"` 
    };
  }
  
  console.log("🚀 开始多图生视频测试");
  console.log("  - 提示词:", prompt);
  console.log("  - 参考图数量:", referenceImageUrls.length);
  console.log("  - 视频比例:", aspectRatio, `(代码: ${aspectRatioCode})`);
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

  function extractVideoUrl(responseText) {
    const decoded = decodeBatchExecuteResponse(responseText);
    const match = decoded.match(/https:\/\/flow-content\.google\/video\/[0-9a-f-]+\?[^\s"'\\\]]+/i);
    if (!match) {
      return { videoUrl: null, decodedResponse: decoded };
    }
    return {
      videoUrl: match[0].replace(/[),]+$/, ""),
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
    const recaptchaToken = await getRecaptchaToken("VIDEO_GENERATION");
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
    
    // 步骤3: 创建多图生视频任务 (rpcids: MZZa6b)
    console.log("📤 创建多图生视频任务...");
    
    const uuid1 = generateUUID().toUpperCase();
    const uuid2 = generateUUID().toUpperCase();
    
    // 构建图片引用数组
    const imageReferences = imageUUIDs.map(uuid => [null, uuid]);
    
    console.log("  - 图片引用数组:", JSON.stringify(imageReferences));
    console.log("  - 横竖比例代码:", aspectRatioCode);
    console.log("  - UUID1:", uuid1);
    console.log("  - UUID2:", uuid2);
    
    // 按照你提供的原始例子的精确结构构建
    // 原始: [[[[null,null,[[[\"竖版：在跑\"]]]],[[null,\"uuid\"]],\"abra_r2v_10s\",1,null,[null,null,null,null,\"UUID1\",\"UUID2\"]]],[null,22,...],[\"UUID2\",2]]
    // 注意：最外层需要再包一层数组
    const createPayloadArray = [
      [
        [
          [
            null,
            null,
            [[[prompt]]]
          ],
          imageReferences,
          "abra_r2v_10s",
          aspectRatioCode,  // 1=竖版(9:16), 2=横版(16:9)
          null,
          [null, null, null, null, uuid1, uuid2]
        ]
      ],
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
      [uuid2, 2]
    ];
    
    console.log("  - 完整payload预览:", JSON.stringify(createPayloadArray).substring(0, 200) + "...");

    const createResponse = await sendBatchExecute("MZZa6b", createPayloadArray, params, projectId);
    
    console.log("📋 原始响应:", createResponse.substring(0, 500));
    
    const createParsed = parseBatchExecuteResponse(createResponse);
    
    if (!createParsed || createParsed.length === 0) {
      return { 
        ok: false, 
        error: "创建视频任务失败：响应为空",
        rawResponse: createResponse.substring(0, 1000)
      };
    }
    
    let mediaUUID = null;
    
    // 从 MZZa6b 响应中提取 mediaUUID（第二个 UUID）
    for (const item of createParsed) {
      if (item && item[0] === "wrb.fr" && item[1] === "MZZa6b" && item[2]) {
        const responseStr = String(item[2]);
        const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        const allUUIDs = responseStr.match(uuidPattern);
        
        if (allUUIDs && allUUIDs.length >= 2) {
          mediaUUID = allUUIDs[1];
          console.log("✅ 成功提取视频媒体UUID:", mediaUUID);
          console.log("  - 找到的所有UUID:", allUUIDs.slice(0, 6));
        }
        break;
      }
    }
    
    if (!mediaUUID) {
      return { 
        ok: false, 
        error: "创建视频任务失败：无法提取媒体UUID",
        createParsed: JSON.stringify(createParsed),
        rawResponse: createResponse
      };
    }
    
    console.log("✅ 多图生视频任务创建成功！");
    console.log("  - 媒体UUID:", mediaUUID);
    
    // 步骤4: 轮询任务状态 (rpcids: jwpduf)
    console.log("⏳ 开始轮询任务状态...");
    
    const maxPolls = 60;
    const pollInterval = 5000;
    let pollCount = 0;
    let taskStatus = null;
    let isComplete = false;
    
    while (pollCount < maxPolls && !isComplete) {
      pollCount++;
      console.log(`🔄 轮询第 ${pollCount}/${maxPolls} 次...`);
      
      const pollPayloadArray = [null, null, [[mediaUUID]]];
      const pollResponse = await sendBatchExecute("jwpduf", pollPayloadArray, params, projectId);
      const pollParsed = parseBatchExecuteResponse(pollResponse);
      
      if (pollParsed && pollParsed.length > 0) {
        for (const item of pollParsed) {
          if (item && item[0] === "wrb.fr" && item[1] === "jwpduf" && item[2]) {
            try {
              const data = JSON.parse(item[2]);
              if (data && data[2] && data[2][0] && data[2][0][5] && data[2][0][5][8]) {
                const statusInfo = data[2][0][5][8];
                
                // statusInfo 可能是数字或数组
                // 成功: 3 或 6
                // 失败: [4, [3, "ERROR_CODE"], ["DETAIL"]]
                if (Array.isArray(statusInfo)) {
                  taskStatus = statusInfo[0];
                  
                  // 检查是否有错误信息（状态码为 4 表示失败）
                  if (taskStatus === 4 && statusInfo[1] && Array.isArray(statusInfo[1])) {
                    const errorCode = statusInfo[1][1] || "UNKNOWN_ERROR";
                    const errorDetails = statusInfo[2] ? statusInfo[2].join(", ") : "";
                    const errorMessage = errorDetails ? 
                      `${errorCode}: ${errorDetails}` : 
                      errorCode;
                    
                    console.error("❌ 视频生成失败:", errorMessage);
                    
                    return {
                      ok: false,
                      error: `视频生成失败: ${errorMessage}`,
                      errorCode,
                      errorDetails: statusInfo[2] || [],
                      mediaUUID,
                      pollCount
                    };
                  }
                } else {
                  taskStatus = statusInfo;
                }
                
                console.log("  - 当前状态:", taskStatus);
                
                // 状态 3 表示完成
                if (taskStatus === 3) {
                  isComplete = true;
                  console.log("✅ 任务完成！");
                  break;
                }
                
                // 状态 6 表示处理中
                if (taskStatus === 6) {
                  console.log("  - 任务处理中...");
                }
              }
            } catch (e) {
              console.warn("⚠️ 解析轮询响应失败:", e.message);
            }
          }
        }
      }
      
      if (!isComplete && pollCount < maxPolls) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }
    
    if (!isComplete) {
      return {
        ok: false,
        error: `任务超时：轮询 ${maxPolls} 次后仍未完成`,
        mediaUUID,
        lastStatus: taskStatus
      };
    }
    
    // 步骤5: 等待5秒让视频地址准备完成
    console.log("⏳ 等待视频地址准备...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 步骤6: 获取视频URL (rpcids: as29s)
    console.log("🎬 获取视频URL...");
    
    const maxUrlAttempts = 3;
    let videoUrl = null;
    
    for (let attempt = 1; attempt <= maxUrlAttempts; attempt++) {
      console.log(`🔍 正在读取视频地址，第 ${attempt}/${maxUrlAttempts} 次`);
      
      const urlPayloadArray = [mediaUUID];
      const urlResponse = await sendBatchExecute("as29s", urlPayloadArray, params, projectId);
      
      const parsed = extractVideoUrl(urlResponse);
      if (parsed.videoUrl) {
        videoUrl = parsed.videoUrl;
        console.log("✅ 视频地址获取成功！");
        console.log("🎬 视频地址:", videoUrl);
        break;
      }
      
      if (attempt < maxUrlAttempts) {
        console.log("⚠️ 未找到视频地址，5秒后重试...");
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    if (!videoUrl) {
      return {
        ok: false,
        error: "无法获取视频URL",
        mediaUUID
      };
    }
    
    const elapsedMs = Date.now() - startTime;
    
    return {
      ok: true,
      message: "多图生视频任务完成",
      elapsedMs,
      elapsedFormatted: `${Math.floor(elapsedMs / 1000)}秒`,
      input: { 
        prompt,
        referenceImageCount: referenceImageUrls.length,
        referenceImageUrls,
        aspectRatio,
        aspectRatioCode
      },
      result: {
        projectId,
        imageUUIDs,
        mediaUUID,
        videoUrl,
        pollCount,
        finalStatus: taskStatus
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
globalThis.runGeneratedTest = runGeneratedTest;
