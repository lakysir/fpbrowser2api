# FPBrowser2API

基于 RoxyBrowser 指纹浏览器的 AI 视频/图片自动化任务框架。项目通过指纹浏览器保活账号、隔离环境，并在真实页面上下文中执行插件自动化逻辑，把 Sora、Google Flow/Veo、Seedance、Grok、ChatGPT 图片等站点能力封装成可管理、可调度、可对外调用的 API。

> QQ 交流群：1035463132
> 操作视频：<https://www.bilibili.com/video/BV1vL5r65EzE/?vd_source=7fa3ff8dba916183629a05529aa18af2>

## 重要声明

- 本项目只供技术研究、学习验证、私有测试环境使用。
- 请勿用于商业化运营、批量滥用、违反目标站点条款或任何违法违规用途。
- 使用者应自行承担账号、额度、风控、合规和数据安全风险。
- 本项目不保证任何第三方站点长期稳定可用，也不承诺规避风控的成功率。

## 当前能力

- 指纹浏览器账号保活：每个窗口有独立 Cookie、LocalStorage、UA、代理和浏览器指纹。
- 后台管理：项目、浏览器服务器、空间、窗口、任务类型、任务队列、日志和用户管理。
- 任务调度：按任务类型绑定窗口，支持窗口池、额度判断、并发控制和任务进度回写。
- 插件执行：通过 Playwright/CDP 连接真实浏览器窗口，在页面上下文中执行 fetch、上传、轮询和结果提取。
- NewAPI/OpenAI 风格接口：提供 `/v1/models`、`/v1/videos`、`/v1/videos/{task_id}`，方便中转站或上层系统接入。

主要适配方向：

| 方向 | 处理器/入口 | 说明 |
|---|---|---|
| Google Flow / Veo | `veo_workflow` | Veo 3.1、Veo Omni Flash、Nana Banana 2/Pro 图片生成 |
| Seedance 2.0 / 即梦国际站 | `dreamina_workflow` | 文生视频、首尾帧、多参考图视频 |
| ChatGPT 图片 | `gpt_workflow` | `gpt-image2-1k` / `2k` / `4k` 图片生成 |
| Sora | `sora_gen_video` | Sora 视频、草稿发布、角色创建、额度等辅助能力 |
| Grok | `grok_workflow` | Grok 工作流自动化 - 正在进行中....

## 和纯协议逆向的区别

`fpbrowser2api` 的核心思路不是复刻第三方站点的所有私有协议，而是把真实浏览器窗口作为任务运行环境。这样做的重点收益是：

| 维度 | 纯协议逆向 | FPBrowser2API |
|---|---|---|
| 登录态 | 通常依赖 token、cookie 或私有鉴权参数 | 复用指纹浏览器中的真实登录态 |
| 环境隔离 | 多账号容易共享运行环境和请求特征 | 每个窗口可独立代理、指纹和存储 |
| 维护成本 | 目标站点接口、加密、字段变化后经常需要重写 | 网页可正常使用时，插件和页面上下文逻辑更容易维护 |
| 模型扩展 | 新模型往往需要重新分析协议 | 可按站点工作流扩展新的执行器或插件 provider |
| 调度管理 | 常见脚本需要自行实现队列、窗口和额度 | 后台统一管理任务类型、窗口池、并发和日志 |

## 为什么使用指纹浏览器

本框架不是传统裸 HTTP 调用脚本，而是复用真实浏览器环境：

1. 每个任务可以绑定一个独立浏览器窗口，隔离 Cookie、LocalStorage、UA、代理和指纹。
2. 用户先在指纹浏览器中手动登录目标站点、完成验证或订阅准备。
3. 后端通过 RoxyBrowser 暴露的 CDP 地址连接到该窗口。
4. 执行器在页面上下文中调用接口、上传文件、轮询状态、读取结果。
5. 遇到 Cloudflare/Turnstile 等挑战页时，执行器会尝试等待放行、点击验证控件，必要时重启窗口自愈。

推荐使用 RoxyBrowser：<https://roxybrowser.com?code=0416Z62A>

<img width="1919" height="914" alt="RoxyBrowser screenshot" src="https://github.com/user-attachments/assets/34238cc6-66c0-41eb-97b0-405014ea467c" />

## 快速启动

```bash
cd fpbrowser2api

# 创建虚拟环境
python -m venv venv

# Windows 激活
venv\Scripts\activate

# Linux / macOS 激活
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 启动服务
python main.py
```

默认监听地址：

```text
http://127.0.0.1:8002
```

首次默认后台账号：

| 字段 | 值 |
|---|---|
| 用户名 | `admin` |
| 密码 | `admin` |

基础配置位于 `config/setting.toml`，可参考 `config/setting_example.toml`。服务启动后会把关键配置写入数据库，并支持在管理后台修改，重启后仍生效。

## 服务脚本

Linux/macOS 或 Git Bash：

```bash
cd fpbrowser2api
chmod +x ./fpbrowser2api_service.sh
./fpbrowser2api_service.sh start
./fpbrowser2api_service.sh status
./fpbrowser2api_service.sh restart
./fpbrowser2api_service.sh stop
```

Windows PowerShell：

```powershell
cd fpbrowser2api
powershell -ExecutionPolicy Bypass -File .\fpbrowser2api_service.ps1 start
powershell -ExecutionPolicy Bypass -File .\fpbrowser2api_service.ps1 status
powershell -ExecutionPolicy Bypass -File .\fpbrowser2api_service.ps1 restart
powershell -ExecutionPolicy Bypass -File .\fpbrowser2api_service.ps1 stop
```

## 管理后台

| 页面 | 路径 |
|---|---|
| 登录页 | `/login` |
| 系统配置 | `/admin/system` |
| 项目管理 | `/admin/projects` |
| 任务类型管理 | `/admin/task-types` |
| 任务列表 | `/admin/tasks` |
| 测试页面 | `/admin/test` |
| 请求日志 | `/admin/logs` |
| 用户管理 | `/admin/users` |

## RoxyBrowser 配置流程

### 1. RoxyBrowser 侧准备

1. 下载并登录 RoxyBrowser：<https://roxybrowser.com?code=0416Z62A>。
2. 创建空间 Workspace、项目和浏览器窗口。
3. 为窗口配置代理、账号信息和目标站点登录态。
4. 启用 RoxyBrowser 本地 API 或局域网 API。
5. 记录 API 地址、API token、`workspaceId` 和窗口 `dirId`。

### 2. FPBrowser2API 后台配置

1. 在「项目管理」创建本地项目。
2. 在「浏览器服务器」填写 RoxyBrowser API：
   - `vendor`: `roxy`
   - `lan_addr`: RoxyBrowser API base URL
   - `access_key`: RoxyBrowser token，可为空
3. 在「空间」填写 RoxyBrowser `workspaceId`。
4. 同步窗口，后台会调用 RoxyBrowser 的 `GET /browser/list_v3` 和 `GET /browser/detail`。
5. 创建任务类型并绑定窗口，常见处理器：
   - `veo_workflow`
   - `dreamina_workflow`
   - `gpt_workflow`
   - `sora_gen_video`
   - `grok_workflow`

## 运行链路

```text
管理后台配置浏览器服务器
  -> FPBrowserClient 调用 RoxyBrowser API
  -> 同步 workspaceId / projectIds / dirId
  -> 任务类型绑定具体窗口
  -> TaskService 选择窗口并控制并发
  -> PlaywrightBrowserContext 打开或复用窗口并连接 CDP
  -> 站点执行器在页面上下文中 fetch / 上传 / 轮询 / 读取结果
  -> 任务结果写回数据库并通过 API 查询
```

主要代码位置：

| 文件 | 作用 |
|---|---|
| `src/api/routes.py` | 公开 API：任务提交、任务查询、模型列表 |
| `src/services/task_service.py` | 任务调度、窗口池、额度和并发控制 |
| `src/services/fp_browser_client.py` | RoxyBrowser API 适配 |
| `src/services/playwright_broswer_context.py` | Playwright/CDP 浏览器连接 |
| `src/services/veo_workflow_executor.py` | Google Flow / Veo / Nana Banana 执行器 |
| `src/services/jimeng_task_executor.py` | Seedance / 即梦执行器 |
| `src/services/gpt_task_executor.py` | ChatGPT / gpt-image2 执行器 |
| `src/services/sora_task_executor.py` | Sora 执行器 |
| `browser_extension/providers/*.js` | 浏览器插件侧执行逻辑 |

## 公开 API

所有公开接口都需要请求头：

```http
Authorization: Bearer YOUR_API_KEY
```

本地默认 base URL：

```text
http://127.0.0.1:8002
```

### 模型列表

```bash
curl http://127.0.0.1:8002/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

返回 OpenAI 兼容模型列表，包含 `/v1/videos` 可用模型和 NewAPI 测试/扣费用模型。

### 提交视频/图片任务

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "veo-3-1",
    "prompt": "a cinematic drone shot over a futuristic city at sunrise",
    "duration": 8,
    "aspect_ratio": "16:9"
  }'
```

提交成功后立即返回异步任务：

```json
{
  "id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "task_id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "object": "video",
  "created_at": 1714200000000,
  "status": "queued",
  "progress": 0,
  "model": "veo-3-1",
  "video_url": null,
  "metadata": {
    "result_urls": []
  },
  "seconds": "8",
  "duration": 8,
  "aspect_ratio": "16:9",
  "prompt": "a cinematic drone shot over a futuristic city at sunrise"
}
```

### 查询任务

```bash
curl http://127.0.0.1:8002/v1/videos/8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

处理中：

```json
{
  "id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "task_id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "object": "video",
  "created_at": 1714200000000,
  "status": "processing",
  "state": "processing",
  "task_status": "processing",
  "progress": 45,
  "model": "veo-3-1",
  "video_url": null,
  "metadata": {
    "result_urls": []
  },
  "success": false,
  "final": false
}
```

视频完成：

```json
{
  "id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "task_id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "object": "video",
  "created_at": 1714200000000,
  "status": "completed",
  "state": "completed",
  "task_status": "completed",
  "progress": 100,
  "model": "veo-3-1",
  "video_url": "https://example.com/generated/video.mp4",
  "url": "https://example.com/generated/video.mp4",
  "metadata": {
    "result_urls": ["https://example.com/generated/video.mp4"]
  },
  "success": true,
  "final": true,
  "completed_at": 1714200180000
}
```

图片完成：

```json
{
  "id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "task_id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "object": "video",
  "created_at": 1714200000000,
  "status": "completed",
  "state": "completed",
  "task_status": "completed",
  "progress": 100,
  "model": "gpt-image2-2k",
  "video_url": null,
  "image_url": "https://example.com/generated/image.png",
  "url": "https://example.com/generated/image.png",
  "metadata": {
    "result_urls": ["https://example.com/generated/image.png"]
  },
  "success": true,
  "final": true,
  "completed_at": 1714200180000
}
```

失败：

```json
{
  "id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "task_id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "object": "video",
  "created_at": 1714200000000,
  "status": "failed",
  "state": "failed",
  "task_status": "failed",
  "progress": 0,
  "model": "veo-3-1",
  "video_url": null,
  "metadata": {
    "result_urls": []
  },
  "success": false,
  "final": true,
  "error": {
    "message": "任务失败原因",
    "code": "task_failed"
  }
}
```

状态含义：

| `status` | 含义 |
|---|---|
| `queued` | 已入队，等待执行 |
| `processing` | 生成中，继续轮询 |
| `completed` | 已完成，读取 `video_url` / `image_url` / `url` |
| `failed` | 失败，查看 `error.message` |

## `/v1/videos` 支持模型

以下列表来自 `src/api/routes.py` 的 `OPENAI_COMPAT_VIDEO_MODELS` 和模型归一化逻辑。

| 模型 | 输出 | 内部处理器 | 必填/限制 | 说明 |
|---|---|---|---|---|
| `seedance-2` | 视频 | `dreamina_workflow` | 建议 `duration`: `10` 或 `15` | Seedance 2.0，支持文生视频、首尾帧、多参考图 |
| `seedance-2-fast` | 视频 | `dreamina_workflow` | 建议 `duration`: `10` 或 `15` | Seedance 2.0 快速模型 |
| `veo-3-1` | 视频 | `veo_workflow` | 必须 `duration`: `8` | Veo 3.1 视频生成 |
| `veo-omni-flash` | 视频 | `veo_workflow` | 必须 `duration`: `10` | Omni Flash 文生视频，内部 `n_frames=300` |
| `veo-omni-flash-video-edit` | 视频/编辑 | `veo_workflow` | 必须 `duration`: `8` | Omni Flash 视频编辑入口，内部映射为 `veo-omni-flash` |
| `nana-banana-2` | 图片 | `veo_workflow` | `duration` 自动设为 `1` | 默认 `resolution=1k`；传 `4k` 会降为 `1k`，如需 4K 用专用模型 |
| `nana-banana-pro` | 图片 | `veo_workflow` | `duration` 自动设为 `1` | 默认 `resolution=1k`；传 `4k` 会降为 `1k`，如需 4K 用专用模型 |
| `nana-banana-2-4k` | 图片 | `veo_workflow` | `duration` 自动设为 `1` | Nana Banana 2 的 4K 图片入口 |
| `nana-banana-pro-4k` | 图片 | `veo_workflow` | `duration` 自动设为 `1` | Nana Banana Pro 的 4K 图片入口 |
| `gpt-image2-1k` | 图片 | `gpt_workflow` | `duration` 可省略；如传只能为 `1` | ChatGPT `gpt-image-2` 1K 图片 |
| `gpt-image2-2k` | 图片 | `gpt_workflow` | `duration` 可省略；如传只能为 `1` | ChatGPT `gpt-image-2` 2K 图片 |
| `gpt-image2-4k` | 图片 | `gpt_workflow` | `duration` 可省略；如传只能为 `1` | ChatGPT `gpt-image-2` 4K 图片 |

额外模型：

| 模型 | 接口 | 说明 |
|---|---|---|
| `fpbrowser-use` | `/v1/chat/completions` | NewAPI 测试/按次扣费用 no-op 模型，不创建真实任务 |

## 请求字段

`CreateVideoRequest` 允许额外字段透传，所以除下表字段外，也可以传入执行器支持的高级参数。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 见上方模型表 |
| `prompt` | string | 是 | 生成提示词 |
| `duration` | integer | 视频通常必填 | `veo-3-1=8`，`veo-omni-flash=10`，`veo-omni-flash-video-edit=8`，图片模型只能为 `1` 或省略 |
| `aspect_ratio` | string | 否 | 常用 `16:9`、`9:16`、`1:1`、`4:3`、`3:4` |
| `resolution` | string | 否 | Seedance 常用 `480p`、`720p`、`1080p`；图片常用 `1k`、`2k`、`4k` |
| `image` | string | 否 | 单张参考图 URL |
| `images` | array | 否 | 参考图 URL 数组；Veo 首尾帧按顺序取首图/尾图 |
| `first_image_url` | string | 否 | 首帧图或单张参考图 URL，作为额外字段透传 |
| `last_image_url` | string | 否 | 尾帧图 URL，作为额外字段透传 |
| `Ingredients_images` | array | 否 | Veo 多参考图视频使用，通常最多 3 张 |
| `function_mode` | string | 否 | Seedance 可用，例如 `first_last_frames`、`omni_reference` |
| `negative_prompt` | string | 否 | 负向提示词，按执行器支持情况透传 |
| `seed` | integer | 否 | 随机种子，按执行器支持情况透传 |
| `n` | integer | 否 | 生成数量，范围 `1` 到 `4` |
| `size` / `quality` | string | 否 | OpenAI 兼容字段，按执行器支持情况透传 |

响应字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `task_id` | string | 任务 ID |
| `object` | string | 固定为 `video`，图片任务也沿用该兼容对象名 |
| `created_at` | integer | 毫秒时间戳 |
| `status` | string | `queued` / `processing` / `completed` / `failed` |
| `state` / `task_status` | string | 与 `status` 同步，兼容部分中转站 |
| `progress` | integer | 任务进度，0 到 100 |
| `model` | string | 请求模型 |
| `video_url` | string/null | 视频结果地址 |
| `image_url` | string/null | 图片结果地址 |
| `url` | string/null | 最终结果地址，视频/图片通用 |
| `metadata.result_urls` | array | 最终结果地址数组 |
| `success` | boolean | 是否成功 |
| `final` | boolean | 是否终态 |
| `error.message` | string | 失败原因 |
| `error.code` | string | 失败代码 |

## curl 示例

### Seedance 2 文生视频

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2",
    "prompt": "a fashion film of a model walking through neon Tokyo at night",
    "duration": 10,
    "aspect_ratio": "16:9",
    "resolution": "720p"
  }'
```

### Seedance 2 快速模型

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2-fast",
    "prompt": "a golden retriever puppy running through sunflowers, cinematic slow motion",
    "duration": 10,
    "aspect_ratio": "16:9",
    "resolution": "720p"
  }'
```

### Seedance 2 首尾帧

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2",
    "prompt": "animate naturally from the first frame to the final frame",
    "duration": 10,
    "aspect_ratio": "9:16",
    "function_mode": "first_last_frames",
    "images": [
      "https://your-cdn.com/first.jpg",
      "https://your-cdn.com/last.jpg"
    ]
  }'
```

### Seedance 2 多参考图

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2",
    "prompt": "use the character, outfit and product references to make a fashion commercial",
    "duration": 15,
    "aspect_ratio": "16:9",
    "function_mode": "omni_reference",
    "images": [
      "https://your-cdn.com/character.jpg",
      "https://your-cdn.com/outfit.jpg",
      "https://your-cdn.com/product.jpg"
    ]
  }'
```

### Veo 3.1 文生视频

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "veo-3-1",
    "prompt": "a cinematic drone shot over a futuristic city at sunrise",
    "duration": 8,
    "aspect_ratio": "16:9"
  }'
```

### Veo 3.1 首尾帧

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "veo-3-1",
    "prompt": "animate smoothly from the first frame to the last frame",
    "duration": 8,
    "aspect_ratio": "9:16",
    "images": [
      "https://your-cdn.com/first.jpg",
      "https://your-cdn.com/last.jpg"
    ]
  }'
```

### Veo 3.1 多参考图

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "veo-3-1",
    "prompt": "combine these references into a cinematic product launch video",
    "duration": 8,
    "aspect_ratio": "16:9",
    "Ingredients_images": [
      "https://your-cdn.com/ref-1.jpg",
      "https://your-cdn.com/ref-2.jpg",
      "https://your-cdn.com/ref-3.jpg"
    ]
  }'
```

### Veo Omni Flash

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "veo-omni-flash",
    "prompt": "a handheld cinematic shot of a robot cooking in a tiny apartment kitchen",
    "duration": 10,
    "aspect_ratio": "16:9"
  }'
```

### Veo Omni Flash 视频编辑

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "veo-omni-flash-video-edit",
    "prompt": "turn this clip into a dramatic rainy cyberpunk scene",
    "duration": 8,
    "aspect_ratio": "16:9",
    "video_url": "https://your-cdn.com/input.mp4"
  }'
```

### Nana Banana 2 图片

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nana-banana-2",
    "prompt": "a cute banana mascot wearing sunglasses, studio lighting, high detail",
    "aspect_ratio": "1:1",
    "resolution": "1k"
  }'
```

### Nana Banana Pro 图片

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nana-banana-pro",
    "prompt": "premium editorial product photo, luxury magazine style",
    "aspect_ratio": "16:9",
    "resolution": "2k"
  }'
```

### Nana Banana 2 / Pro 4K 图片

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nana-banana-pro-4k",
    "prompt": "a high-end perfume bottle on black glass, premium campaign image",
    "aspect_ratio": "16:9"
  }'
```

### Nana Banana 多参考图

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nana-banana-2",
    "prompt": "make a poster using the character style and product reference",
    "aspect_ratio": "4:3",
    "resolution": "1k",
    "images": [
      "https://your-cdn.com/character.jpg",
      "https://your-cdn.com/product.jpg"
    ]
  }'
```

### GPT Image 2 图片

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image2-2k",
    "prompt": "a clean product render of a transparent mechanical keyboard, white background",
    "aspect_ratio": "16:9"
  }'
```

### GPT Image 2 图片编辑

传入 `image`、`image_url` 或 `images` 时，接口会自动把 GPT Image 2 任务标记为 `operation=edit`。

```bash
curl -X POST http://127.0.0.1:8002/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image2-4k",
    "prompt": "replace the background with a luxury studio set, keep the product shape",
    "aspect_ratio": "1:1",
    "images": [
      "https://your-cdn.com/product.png"
    ]
  }'
```

### NewAPI 测试/扣费模型

`fpbrowser-use` 只用于 `/v1/chat/completions`，不创建真实任务：

```bash
curl -X POST http://127.0.0.1:8002/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fpbrowser-use",
    "messages": [
      {"role": "user", "content": "ping"}
    ]
  }'
```

## 通用任务接口

除 `/v1/videos` 外，也可以使用更底层的任务接口直接指定任务类型：

```bash
curl -X POST http://127.0.0.1:8002/v1/tasks \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task_type_code": "veo_workflow",
    "json": {
      "prompt": "a cinematic robot walking in the rain",
      "duration": 8,
      "aspect_ratio": "16:9"
    }
  }'
```

查询：

```bash
curl http://127.0.0.1:8002/v1/tasks/TASK_ID \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## 常见问题

### `400 veo-3-1 only supports duration=8`

`/v1/videos` 中 `veo-3-1` 做了显式校验，必须传：

```json
{"duration": 8}
```

### `400 veo-omni-flash only supports duration=10`

`veo-omni-flash` 必须传：

```json
{"duration": 10}
```

### `400 gpt-image2-* only supports duration=1`

GPT Image 2 是图片模式。`duration` 可以不传；如果传，只能传 `1`。

### 图片任务为什么接口还是 `/v1/videos`

这是为了兼容 NewAPI 异步视频通道和上游调用方式。图片任务完成后会返回 `image_url` 和通用 `url`。

### `nana-banana-2` 传 `resolution=4k` 为什么不是 4K

普通 `nana-banana-2` / `nana-banana-pro` 会把 `4k` 归一为 `1k`。4K 请使用：

```text
nana-banana-2-4k
nana-banana-pro-4k
```

## 更新记录

### 2026-05-20

- Flow：支持 Nana Banana 2 1K/2K/4K、Nana Banana Pro 1K/2K/4K 图片生成。
- Flow：支持 `veo-3-1`、`veo-omni-flash` 视频生成。
- ChatGPT：支持 `gpt-image2-1k`、`gpt-image2-2k`、`gpt-image2-4k` 图片生成。
- Jimeng/Seedance：支持 Seedance 2.0 视频生成。

### 2026-05-11

- Google Flow 纯净模式：生成的视频和图片会归档，保持页面干净，减少资源消耗。
- Seedance 2.0 国际站上线，已适配美国、土耳其、加拿大等区域。
