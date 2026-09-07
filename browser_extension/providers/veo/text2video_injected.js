/*
runGeneratedTest(config) parameter contract:
The JSON in the Test Config box is passed as config. Keep this list even when some fields are unused.
- config.prompt: string - 文生视频的提示词
- config.aspectRatio: string - 视频比例，"16:9" 横版 或 "9:16" 竖版，默认 "16:9"
*/

async function runGeneratedTest(config) {
  const startTime = Date.now();
  
  const prompt = String(config.prompt || "").trim();
  const aspectRatio = String(config.aspectRatio || "16:9").trim();
  
  if (!prompt) {
    return { ok: false, error: "缺少必需参数: config.prompt" };
  }
  
  // 将比例转换为 API 参数值
  // 2 = 横版 (16:9)
  // 1 = 竖版 (9:16)
  let aspectRatioValue;
  if (aspectRatio === "9:16" || aspectRatio === "竖版" || aspectRatio === "vertical") {
    aspectRatioValue = 1;
  } else if (aspectRatio === "16:9" || aspectRatio === "横版" || aspectRatio === "horizontal") {
    aspectRatioValue = 2;
  } else {
    return { 
      ok: false, 
      error: `不支持的视频比例: ${aspectRatio}，请使用 "16:9" 或 "9:16"` 
    };
  }
  
  console.log("🚀 开始文生视频测试");
  console.log("  - 提示词:", prompt);
  console.log("  - 视频比例:", aspectRatio, `(参数值: ${aspectRatioValue})`);
  
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
    
    // 步骤2: 创建文生视频任务 (rpcids: YhhmEf)
    console.log("📤 创建文生视频任务...");
    
    const uuid1 = generateUUID().toUpperCase();
    const uuid2 = generateUUID().toUpperCase();
    
    const createPayloadArray = [
      [
        [
          [
            null,
            null,
            [[[prompt]]]
          ],
          "abra_t2v_10s",
          aspectRatioValue,  // ← 唯一改动：原来是固定的 2，现在是变量
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

    const createResponse = await sendBatchExecute("YhhmEf", createPayloadArray, params, projectId);
    const createParsed = parseBatchExecuteResponse(createResponse);
    
    if (!createParsed || createParsed.length === 0) {
      return { 
        ok: false, 
        error: "创建视频任务失败：响应为空",
        rawResponse: createResponse.substring(0, 1000)
      };
    }
    
    let mediaUUID = null;
    
    // 从 YhhmEf 响应中提取 mediaUUID
    // 使用正则表达式从响应字符串中提取第二个 UUID（即 mediaUUID）
    for (const item of createParsed) {
      if (item && item[0] === "wrb.fr" && item[1] === "YhhmEf" && item[2]) {
        const responseStr = String(item[2]);
        // 提取所有 UUID
        const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        const allUUIDs = responseStr.match(uuidPattern);
        
        if (allUUIDs && allUUIDs.length >= 2) {
          // 第一个是任务ID，第二个是 mediaUUID
          mediaUUID = allUUIDs[1];
          console.log("✅ 成功提取媒体UUID:", mediaUUID);
          console.log("  - 找到的所有UUID:", allUUIDs.slice(0, 4));
        }
        break;
      }
    }
    
    if (!mediaUUID) {
      return { 
        ok: false, 
        error: "创建视频任务失败：无法提取媒体UUID",
        createParsed: JSON.stringify(createParsed).substring(0, 1000),
        rawResponse: createResponse.substring(0, 1000)
      };
    }
    
    console.log("✅ 视频任务创建成功！");
    console.log("  - 媒体UUID:", mediaUUID);
    
    // 步骤3: 轮询任务状态 (rpcids: jwpduf)
    console.log("⏳ 开始轮询任务状态...");
    
    const maxPolls = 60;
    const pollInterval = 5000;
    let pollCount = 0;
    let taskStatus = null;
    let isComplete = false;
    
    while (pollCount < maxPolls && !isComplete) {
      pollCount++;
      console.log(`🔄 轮询第 ${pollCount}/${maxPolls} 次...`);
      
      // jwpduf 请求格式: [null, null, [[mediaUUID]]]
      const pollPayloadArray = [null, null, [[mediaUUID]]];
      const pollResponse = await sendBatchExecute("jwpduf", pollPayloadArray, params, projectId);
      const pollParsed = parseBatchExecuteResponse(pollResponse);
      
      if (pollParsed && pollParsed.length > 0) {
        for (const item of pollParsed) {
          if (item && item[0] === "wrb.fr" && item[1] === "jwpduf" && item[2]) {
            try {
              const data = JSON.parse(item[2]);
              // 从响应中提取状态信息
              // 响应结构: data[2][0][5][8] 是状态信息
              if (data && data[2] && data[2][0] && data[2][0][5] && data[2][0][5][8]) {
                const statusInfo = data[2][0][5][8];
                
                // statusInfo 可能是数字或数组
                // 成功: 3 或 6 (数字)
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
    
    // 步骤4: 等待5秒让视频地址准备完成
    console.log("⏳ 等待视频地址准备...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 步骤5: 获取视频URL (rpcids: as29s)
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
      message: "文生视频任务完成",
      elapsedMs,
      elapsedFormatted: `${Math.floor(elapsedMs / 1000)}秒`,
      input: { 
        prompt,
        aspectRatio,
        aspectRatioValue
      },
      result: {
        projectId,
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
