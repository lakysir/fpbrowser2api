# FPBrowser2API：逆向插件+Python账号保活管理方案

> 项目主题：逆向框架，支持veo3.1、seedance2.0、omni flash、grok、nana banana、sora2、gpt-image2，QQ交流群：1035463132
> 利用指纹浏览器管理账号保活 + 插件逆向注入/页面上下文代码执行，实现高并发自动化 AI 视频 & AI 图片生成。当前框架已围绕 Sora、veo3.1 / VEO/Google Flow、Grok、banana2/pro、Seedance2.0 国际站等方向设计；理论上可扩展到任意网站的自动化与接口逆向研究。

### 操作视频https://www.bilibili.com/video/BV1vL5r65EzE/?vd_source=7fa3ff8dba916183629a05529aa18af2

## 最新情人节奉献功能2026-5-20：
##### 1.Flow: Nana Banana2 1k/2k/4k(图片生成)、Banana Pro 1k/2k/4k(图片生成)、veo-3-1(视频生成)、Veo-omni-flash(视频生成)
##### 2.ChatGPT: gpt-image2-1k/2k/4k(图片生成)
##### 3.Jimeng:seedance2.0(视频生成)

## 最新更新-2026-5-11
##### 1.google Flow纯净模式，生成的视频和图片都会归档，保证页面干净，减少资源消耗，支持香蕉2/Pro和Veo3.1
##### 2.国际站seedance2.0上线,支持美国、土耳其、加拿大，其它的自己改代码吧

## 重要声明

- 本项目**只供技术研究、学习验证、私有测试环境使用**，请勿用于商业化运营、批量滥用、违反目标站点条款或任何违法违规用途。
- 使用者应自行承担账号、额度、风控、合规和数据安全风险。

## 为什么需要指纹浏览器
本框架不是传统的裸 HTTP 调用脚本，而是通过指纹浏览器维持一个更接近真人使用的浏览器环境：
1. 每个任务绑定一个独立的浏览器窗口、Cookie、LocalStorage、UA、代理和浏览器指纹。
2. 用户可以先在指纹浏览器中手动登录目标站点、完成必要验证或订阅准备。
3. 后端再通过指纹浏览器暴露的 CDP 地址连接到该窗口，在页面上下文中执行 `fetch`、上传文件、轮询状态、读取结果。
4. 当遇到 Cloudflare/Turnstile 等挑战页时，执行器会检测页面、等待自动放行、尝试点击验证控件，必要时关闭并重开指纹窗口进行自愈。

推荐使用 RoxyBrowser：请到 <https://roxybrowser.com?code=0416Z62A> 下载客户端，注册并登录后创建空间、项目和浏览器窗口。
<img width="1919" height="914" alt="ScreenShot_2026-04-30_185638_945" src="https://github.com/user-attachments/assets/34238cc6-66c0-41eb-97b0-405014ea467c" />


## 快速启动
```bash
cd fpbrowser2api

# 创建虚拟环境
python -m venv venv

# 激活虚拟环境
# Windows
venv\Scripts\activate
# Linux/Mac
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 启动服务
python main.py
```

默认监听：`http://127.0.0.1:8002`

首次默认账号：

- 用户名：`admin`
- 密码：`admin`

基础配置使用本地文件 `config/setting.toml`。首次部署时先复制示例配置：

```bash
cp config/setting_example.toml config/setting.toml
```

服务启动后会把关键配置写入数据库，并支持在管理后台中修改，重启后仍生效。`config/setting.toml` 和 `data/fpbrowser.db` 属于本地运行状态，不提交到仓库。

## 启动 / 停止 / 重启（服务脚本）

Linux/Mac（或 Git Bash）：

```bash
cd fpbrowser2api
chmod +x ./fpbrowser2api_service.sh
./fpbrowser2api_service.sh start|stop|restart|status
```

Windows PowerShell：

```powershell
cd fpbrowser2api
powershell -ExecutionPolicy Bypass -File .\fpbrowser2api_service.ps1 start|stop|restart|status
```

## 管理后台

- 登录页：`/login`
- 系统配置：`/admin/system`
- 项目管理：`/admin/projects`
- 任务类型管理：`/admin/task-types`
- 任务列表：`/admin/tasks`
- 测试页面：`/admin/test`
- 请求日志：`/admin/logs`
- 用户管理：`/admin/users`

## 如何连接指纹浏览器

本项目当前以 RoxyBrowser 为主要适配对象，核心链路如下：

```text
管理后台配置浏览器服务器
  -> FPBrowserClient 调 RoxyBrowser 本地/局域网 API
  -> 同步空间(workspaceId)、项目(projectIds)、窗口(dirId)
  -> 任务类型绑定具体窗口
  -> TaskService 根据任务类型和额度选择窗口
  -> PlaywrightBrowserContext 打开/复用窗口并连接 CDP
  -> 站点执行器在页面上下文中 fetch / 上传 / 轮询 / 读取结果
```

### 1. RoxyBrowser 侧准备

1. 下载并登录 RoxyBrowser：<https://roxybrowser.com?code=0416Z62A>。
2. 在 RoxyBrowser 中创建空间（Workspace）、项目和浏览器窗口。
3. 为窗口配置代理、账号信息、目标站点登录态，并确保窗口可以正常访问目标站点。
4. 启用 RoxyBrowser 的本地 API / 局域网 API，并记录：
   - API 地址，例如 `http://127.0.0.1:xxxxx` 或局域网地址。
   - API token（如 RoxyBrowser 侧开启了 token 校验）。
   - `workspaceId`：本项目中对应 `space_id`，必须是纯数字。
   - `dirId`：本项目中对应 `window_key`，代表具体浏览器窗口。

### 2. FPBrowser2API 侧配置

在管理后台中按顺序配置：

1. **项目管理**：创建一个本地项目。
2. **浏览器服务器**：填写 RoxyBrowser API 地址：
   - `vendor`：`roxy`
   - `lan_addr`：RoxyBrowser API base URL
   - `access_key`：RoxyBrowser token，可为空
3. **空间**：填写 RoxyBrowser `workspaceId`，可选填写 Roxy 项目 ID 过滤条件。
4. **同步窗口**：后台会调用：
   - `GET /browser/list_v3` 获取窗口列表。
   - `GET /browser/detail` 获取窗口明细。
   - 提取 `dirId`、窗口名称、平台账号、代理 IP、国家、内核版本等信息写入本地数据库。
5. **任务类型绑定窗口**：创建任务类型并选择处理器，例如：
   - `sora_gen_video`
   - `veo_workflow`
   - `grok_workflow`
   - `dreamina_workflow`

### 3. 运行时连接过程

连接逻辑主要在以下文件中：

- `src/services/fp_browser_client.py`：RoxyBrowser API 适配层。
- `src/services/playwright_broswer_context.py`：通用 Playwright + 指纹浏览器上下文。
- `src/services/task_service.py`：任务调度、窗口池、额度和并发控制。

运行时会先查询窗口是否已经打开：

1. 调用 RoxyBrowser `GET /browser/connection_info` 获取已打开窗口的 `http/ws` 调试地址。
2. 若窗口未打开，则调用 `POST /browser/open`，传入 `workspaceId`、`dirId`、启动参数、headless/pure_mode 等。
3. RoxyBrowser 返回 `data.http` 或 `data.ws` 后，框架会规范化为 CDP endpoint。
4. 使用 `playwright.chromium.connect_over_cdp(endpoint)` 连接到真实指纹浏览器窗口。
5. 执行器选择可用页面或打开目标页面，并通过页面上下文执行 `fetch`、文件上传、Cookie/Token 读取等操作。
6. 任务完成后通常只断开本地 Playwright/CDP 连接，不立即关闭指纹窗口，以便保留登录态并降低频繁开关窗口带来的风控风险。

## 核心服务一：`src/services/sora_task_executor.py`

`sora_task_executor.py` 是 Sora 站点侧执行器，入口函数是 `sora_gen_video`，由 `task_service.py` 根据任务类型分发调用。

### 职责边界

- 不负责管理 RoxyBrowser API 细节，这部分由 `fp_browser_client.py` 和 `playwright_broswer_context.py` 处理。
- 专注 Sora 站点逻辑：鉴权抓取、任务创建、进度轮询、草稿发布、余额检查、邀请码读取、角色创建等。

### 关键能力

- **窗口级会话缓存**：`SoraSession` 按 `vendor + base_url + space_id + window_key` 缓存，复用同一个指纹窗口和 CDP 连接。
- **登录态/Token 获取**：在指纹窗口页面上下文中访问 `/api/auth/session`，读取 `accessToken` 和过期时间。
- **页面内接口调用**：使用页面上下文 `fetch` 调 Sora 后端接口，继承窗口 Cookie、UA、代理和指纹。
- **生成任务提交**：调用 `/backend/nf/create` 创建视频生成任务，支持 prompt、首帧图、比例/方向、时长帧数等参数。
- **进度轮询**：轮询 pending / drafts 等接口，持续回写任务进度。
- **草稿发布与结果提取**：任务完成后从 drafts 中找到对应生成结果，发布并返回 `share_url`、`watermark_free_url`、`thumb_url` 等。
- **角色创建**：支持通过 `video_url` 或 `generation_id + head_url` 创建 Sora 角色，包含上传、状态轮询、头像处理、finalize、公开设置等步骤。
- **额度/会员辅助**：支持 `nf_check`、订阅信息、邀请码、清空 drafts 等管理端操作。
- **Cloudflare 自愈**：检测 “Just a moment”、`/cdn-cgi/`、Turnstile 等页面特征，等待放行、尝试 checkbox 点击，必要时重启指纹窗口。
- **并发保护**：创建任务使用会话级锁串行化，避免同一窗口同时提交多个创建请求；不同窗口可并发工作。

### 常见 Sora payload

```json
{
  "prompt": "a cinematic robot walking in the rain",
  "first_image_url": "https://example.com/first-frame.png",
  "size_ratio": "9:16",
  "duration": 300,
  "sora_url": "https://sora.chatgpt.com/drafts",
  "sora_pending_max_wait_seconds": 900
}
```

创建角色示例：

```json
{
  "video_url": "https://example.com/character.mp4",
  "character_video_timestamps": "0,3",
  "sora_url": "https://sora.chatgpt.com/drafts"
}
```

或基于已有生成结果创建角色：

```json
{
  "generation_id": "gen_xxx",
  "head_url": "https://example.com/avatar.png"
}
```

## 核心服务二：`src/services/veo_workflow_executor.py`

`veo_workflow_executor.py` 是 VEO / Google Labs / Flow 工作流执行器，入口函数是 `veo_workflow`，同样由 `task_service.py` 分发调用。

### 职责边界

- 使用通用指纹浏览器上下文打开或复用 Google Labs / Flow 页面。
- 在页面上下文中执行 Flow / aisandbox / media API 请求。
- 管理项目 ID、access token、reCAPTCHA token、图片上传、视频轮询、图片放大等 VEO 相关逻辑。

### 关键能力

- **VeoSession 会话缓存**：按窗口缓存，减少重复打开浏览器和重复登录。
- **Google 登录辅助**：管理端提供打开/连接窗口能力，可在 Google 登录页中辅助选择账号、输入凭据、进入 Flow。
- **Access Token 获取与复用**：从指纹窗口 Cookie / NextAuth 会话中换取 Labs access token，并可写回 `task_type_windows` 缓存。
- **Flow 项目管理**：支持从 payload 指定 `veo_project_id/project_id/current_project_id`，也支持从 `veo_url` 解析，或从绑定窗口的 `veo_flow_projects` 随机选择项目。
- **VEO 视频生成**：
  - T2V：文生视频。
  - I2V：首帧/首尾帧图生视频。
  - R2V / Ingredients：多图参考生成视频，最多按执行器逻辑处理多张参考图。
  - 支持横版/竖版模型、会员档位模型修正、任务提交重试与状态轮询。
- **AI 图片生成**：当 `n_frames` 显式为 `1` 时进入图片模式，支持文生图、图生图、多图参考图生图；默认 NARWHAL，也支持 GEM_PIX_2 / Banana 类图片模型路径。
- **2K 放大与 OSS**：当 `resolution` / `veo_image_resolution` 指定 2K 时调用 `flow/upsampleImage`，可将大图上传到 OSS，避免 base64 结果撑爆数据库。
- **额度刷新**：支持读取 aisandbox credits，并解析 Google AI 活动页中的下一次额度更新时间。
- **Cloudflare 自愈**：与 Sora 类似，具备挑战页检测、等待、点击、重启窗口和恢复目标页能力。

## 接口说明

# Seedance 2 / Nana Banana / VEO 3.1 · NewAPI 视频接口说明

> 对外统一使用 NewAPI 风格异步接口：  
> **提交任务：`POST /v1/videos`**  
> **查询任务：`GET /v1/videos/{task_id}`**

## 1. 调用流程

### Step 1 · 提交任务

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "veo-3-1",
    "prompt": "an astronaut surfing on a glowing ocean at night, cinematic camera movement",
    "duration": 8,
    "aspect_ratio": "16:9"
  }'
```

提交成功后立即返回任务信息：

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
  "prompt": "an astronaut surfing on a glowing ocean at night, cinematic camera movement"
}
```

### Step 2 · 查询任务

```bash
curl https://xxx.xxx.xxx/v1/videos/8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234 \
  -H "Authorization: Bearer api-key"
```

处理中：

```json
{
  "id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "task_id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "object": "video",
  "created_at": 1714200000000,
  "status": "in_progress",
  "progress": 45,
  "model": "veo-3-1",
  "video_url": null,
  "metadata": {
    "result_urls": []
  }
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
  "progress": 100,
  "model": "veo-3-1",
  "video_url": "https://xxx.xxx.xxx/generated/video.mp4",
  "url": "https://xxx.xxx.xxx/generated/video.mp4",
  "metadata": {
    "result_urls": ["https://xxx.xxx.xxx/generated/video.mp4"]
  },
  "completed_at": 1714200180000
}
```

图片完成（`nana-banana-2` / `nana-banana-pro`）：

```json
{
  "id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "task_id": "8c7e4b0e6f3b4b0a9e0a0d8f4f0c1234",
  "object": "video",
  "created_at": 1714200000000,
  "status": "completed",
  "progress": 100,
  "model": "nana-banana-2",
  "video_url": null,
  "image_url": "https://xxx.xxx.xxx/generated/image.jpg",
  "url": "https://xxx.xxx.xxx/generated/image.jpg",
  "metadata": {
    "result_urls": ["https://xxx.xxx.xxx/generated/image.jpg"]
  },
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
  "progress": 0,
  "model": "veo-3-1",
  "video_url": null,
  "metadata": {
    "result_urls": []
  },
  "error": {
    "message": "任务失败原因",
    "code": "task_failed"
  }
}
```

| `status` | 含义 |
|---|---|
| `queued` | 排队中 |
| `in_progress` | 生成中，继续轮询 |
| `completed` | 已完成，取 `video_url` / `image_url` / `url` |
| `failed` | 失败，查看 `error.message` |

## 2. 支持模型

| 模型 | 输出 | 说明 |
|---|---|---|
| `seedance-2` | 视频 | 支持文生视频、首尾帧视频、多参考图视频 |
| `veo-3-1` | 视频 | 支持文生视频、首尾帧视频、多参考图视频 |
| `nana-banana-2` | 图片 | 支持文生图片、多参考图生成图片 |
| `nana-banana-pro` | 图片 | 支持文生图片、多参考图生成图片 |

## 3. 视频模型示例

### 3.1 Seedance 2 · 文生视频

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2",
    "prompt": "a golden retriever puppy running through sunflowers, cinematic, slow motion",
    "duration": 10,
    "aspect_ratio": "16:9",
    "resolution": "720p"
  }'
```

### 3.2 Seedance 2 · 首尾帧生成视频

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
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

也可以使用：

```json
{
  "first_image_url": "https://your-cdn.com/first.jpg",
  "last_image_url": "https://your-cdn.com/last.jpg"
}
```

### 3.3 Seedance 2 · 多参考图生成视频

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
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

### 3.4 VEO 3.1 · 文生视频

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "veo-3-1",
    "prompt": "a cinematic drone shot over a futuristic city at sunrise",
    "duration": 8,
    "aspect_ratio": "16:9"
  }'
```

### 3.5 VEO 3.1 · 首尾帧生成视频

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
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

### 3.6 VEO 3.1 · 多参考图生成视频

> VEO 多参考图视频请使用 `Ingredients_images`，最多 3 张。

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
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

## 4. 图片模型示例

### 4.1 Nana Banana 2 · 文生图片

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nana-banana-2",
    "prompt": "a cute banana mascot wearing sunglasses, studio lighting, high detail",
    "aspect_ratio": "1:1",
    "resolution": "1k"
  }'
```

### 4.2 Nana Banana 2 · 多参考图生成图片

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
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

### 4.3 Nana Banana Pro · 文生图片

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nana-banana-pro",
    "prompt": "premium editorial product photo, luxury magazine style",
    "aspect_ratio": "16:9",
    "resolution": "2k"
  }'
```

### 4.4 Nana Banana Pro · 多参考图生成图片

```bash
curl -X POST https://xxx.xxx.xxx/v1/videos \
  -H "Authorization: Bearer api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nana-banana-pro",
    "prompt": "create a premium product campaign image using all references",
    "aspect_ratio": "16:9",
    "resolution": "2k",
    "images": [
      "https://your-cdn.com/product.jpg",
      "https://your-cdn.com/background-style.jpg"
    ]
  }'
```

## 5. 请求字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | ✅ | `seedance-2` / `veo-3-1` / `nana-banana-2` / `nana-banana-pro` |
| `prompt` | string | ✅ | 生成提示词 |
| `duration` | int | 视频必填 | `seedance-2` 支持 `10` / `15`；`veo-3-1` 固定传 `8` |
| `aspect_ratio` | string | ❌ | 视频常用 `16:9` / `9:16`；图片支持 `1:1` / `4:3` / `3:4` / `16:9` / `9:16` |
| `resolution` | string | ❌ | `seedance-2` 支持 `480p` / `720p` / `1080p`；图片支持 `1k` / `2k` |
| `images` | array | ❌ | 参考图 URL 数组。Seedance 多参考图最多 9 张；VEO 首尾帧最多 2 张；Nana Banana 图片最多 10 张 |
| `first_image_url` | string | ❌ | 首帧或单参考图 URL |
| `last_image_url` | string | ❌ | 尾帧 URL |
| `function_mode` | string | ❌ | `seedance-2` 可用：`first_last_frames` / `omni_reference` |
| `Ingredients_images` | array | ❌ | `veo-3-1` 多参考图视频使用，最多 3 张 |

## 6. 响应字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `task_id` | string | 任务 ID |
| `object` | string | 固定为 `video` |
| `created_at` | int | 创建时间戳，毫秒 |
| `status` | string | `queued` / `in_progress` / `completed` / `failed` |
| `progress` | int | 0–100 |
| `model` | string | 请求模型 |
| `video_url` | string\|null | 视频完成后返回视频地址 |
| `image_url` | string\|null | 图片模型完成后返回图片地址 |
| `url` | string\|null | 最终结果地址，视频/图片通用 |
| `metadata.result_urls` | array | 最终结果地址数组 |
| `error.message` | string | 失败时的错误信息 |


## 再次声明

本项目是技术研究框架，不保证任何站点的稳定可用性，也不承诺规避第三方风控的成功率。请勿商业化，请勿用于违规批量生成、账号滥用或绕过平台规则的生产用途。
