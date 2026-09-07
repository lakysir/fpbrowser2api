"""FastAPI application initialization."""

from __future__ import annotations

import asyncio
import mimetypes
import os
import signal
from contextlib import asynccontextmanager
from pathlib import Path
import re

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from .api import admin, analyze, routes
from .core.config import config
from .core.database import Database
from .core.logger import logger, setup_logging
from .core.paths import STATIC_DIR, ensure_runtime_dirs
from .services import browser_extension_bridge


db = Database()


def _install_window_pool_stop_on_signals() -> None:
    """Ctrl+C / SIGTERM 时尽早置位窗口池停止标志，使 reconcile 在两次开窗之间可退出。"""
    from .api import routes as routes_mod

    def _set_pool_stop() -> None:
        try:
            ts = getattr(routes_mod, "task_service", None)
            if ts is not None:
                ts._window_pool_stop.set()
        except Exception:
            pass

    def _chain(prev_handler, signum: int):
        def _wrapped(sig: int, frame, p=prev_handler, sn=signum) -> None:
            _set_pool_stop()
            if callable(p):
                p(sig, frame)
            elif p is signal.SIG_DFL:
                try:
                    signal.raise_signal(sn)
                except (AttributeError, OSError, RuntimeError):
                    if sn == signal.SIGINT:
                        signal.default_int_handler(sig, frame)

        return _wrapped

    for name in ("SIGINT", "SIGTERM"):
        if not hasattr(signal, name):
            continue
        num = getattr(signal, name)
        try:
            prev = signal.getsignal(num)
        except OSError:
            continue
        if prev is signal.SIG_IGN:
            continue
        try:
            signal.signal(num, _chain(prev, num))
        except OSError:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_runtime_dirs()

    # 1) 先按文件配置初始化日志（DB 可能尚未可用）
    setup_logging()

    logger.info("=" * 60)
    logger.info("FPBrowser2API Starting...")
    logger.info("=" * 60)

    config_dict = config.get_raw_config()
    is_first_startup = not db.db_exists()

    # 2) 初始化/迁移数据库（参考 flow2api：启动即建库/补列）
    await db.init_db()
    if is_first_startup:
        logger.info("🎉 首次启动：初始化数据库并写入默认配置/管理员...")
    else:
        logger.info("🔄 检测到已有数据库：检查缺失表/字段并补齐...")
    await db.check_and_migrate_db(config_dict)

    # 2.5) 启动清理：把上次异常退出遗留的 queued/running 任务统一置为 failed
    #      同时重置窗口映射的 inflight_slots，避免并发槽位“泄漏”导致无法继续派单
    try:
        r = await db.fail_running_and_queued_tasks_on_startup()
        if (r.get("tasks_failed") or 0) > 0 or (r.get("mapping_slots_reset") or 0) > 0:
            logger.warning(
                "启动清理完成：tasks_failed=%s mapping_slots_reset=%s",
                r.get("tasks_failed"),
                r.get("mapping_slots_reset"),
            )
    except Exception as e:
        # 不阻断启动：即便清理失败，也让服务起来方便排查
        logger.exception("启动清理失败（忽略）：%s", e)

    # 不在启动时清空 request_logs：避免重启即丢失审计/排查数据；需清理请走管理端清空接口。

    # 3) DB 配置回写到内存 config（API key / proxy / debug / log_to_file）
    syscfg = await db.reload_config_to_memory()
    # 4) 按 DB 配置重置日志（特别是 log_to_file）
    setup_logging()
    logger.info(
        "✓ 配置加载完成：proxy_enabled=%s debug=%s log_to_file=%s",
        syscfg.proxy_enabled,
        syscfg.debug_enabled,
        syscfg.log_to_file,
    )

    # 5) 依赖注入
    admin.set_dependencies(db)
    routes.set_dependencies(db)
    analyze.set_dependencies(db)
    _install_window_pool_stop_on_signals()

    # 窗口池预热会连续 await 指纹/Playwright，若在 set_dependencies 里立刻启动会饿死事件循环，
    # 管理页（含关闭「开启窗口池」的保存）可能长时间无响应。延迟启动并可在关机前取消。
    try:
        pool_delay_sec = float(os.getenv("WINDOW_POOL_START_DELAY_SEC", "45"))
    except ValueError:
        pool_delay_sec = 45.0
    pool_delay_sec = max(0.0, pool_delay_sec)

    async def _deferred_window_pool_maintainer() -> None:
        await asyncio.sleep(0)
        if pool_delay_sec > 0:
            try:
                await asyncio.sleep(pool_delay_sec)
            except asyncio.CancelledError:
                raise
        try:
            ts = getattr(routes, "task_service", None)
            if ts is not None and not ts._window_pool_stop.is_set():
                ts.start_window_pool_maintainer()
                logger.info(
                    "窗口池维护协程已启动（延迟 %.1fs）",
                    pool_delay_sec,
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("延迟启动窗口池维护协程失败")

    window_pool_defer_task = asyncio.create_task(_deferred_window_pool_maintainer())

    logger.info("✓ Server running on http://%s:%s", config.server_host, config.server_port)
    logger.info(
        "窗口池约 %.0fs 后启动（WINDOW_POOL_START_DELAY_SEC，0=尽快）；保存任务类型仍会立即触发对齐",
        pool_delay_sec,
    )
    logger.info("=" * 60)

    yield

    if not window_pool_defer_task.done():
        window_pool_defer_task.cancel()
        try:
            await window_pool_defer_task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("取消窗口池延迟启动任务时出错（忽略）")

    logger.info("FPBrowser2API Shutting down...")
    try:
        from .api import routes as routes_mod

        ts = getattr(routes_mod, "task_service", None)
        if ts is not None:
            await ts.stop_window_pool_maintainer()
    except Exception:
        logger.exception("stop_window_pool_maintainer failed (ignored)")


app = FastAPI(
    title="FPBrowser2API",
    description="FPB管理与任务调用服务",
    version="0.1.0",
    lifespan=lifespan,
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_logger(request: Request, call_next):
    """管理台写操作权限校验。

    说明：不再将每条请求写入 SQLite 的 request_logs 表，避免高频 API（如轮询任务状态）
    导致数据库体积快速增长；需要排查时可依赖 log_to_file / 应用日志。
    """
    # 与原先一致：JSON 请求预读 body 以便 Starlette 缓存，供下游路由重复读取
    content_type = (request.headers.get("content-type") or "").lower()
    if "application/json" in content_type:
        try:
            await request.body()
        except Exception:
            pass

    path = request.url.path
    method = (request.method or "").upper()
    if path.startswith("/api/admin") and method in {"POST", "PUT", "PATCH", "DELETE"}:
        bypass_paths = {
            "/api/admin/login",
            "/api/login",
            "/api/admin/logout",
            "/api/logout",
            "/api/admin/change-password",
        }
        non_admin_write_allow_patterns = [
            r"^/api/admin/task-types/\d+/windows$",
            r"^/api/admin/task-type-windows/\d+$",
            r"^/api/admin/spaces/\d+/windows/[^/]+/set-proxy$",
            r"^/api/admin/spaces/\d+/windows/[^/]+/set-core-version$",
            r"^/api/admin/spaces/\d+/windows/[^/]+/move$",
            r"^/api/admin/spaces/\d+/windows/[^/]+/remark$",
            r"^/api/admin/ai-agent/chat$",
            r"^/api/admin/ai-agent/windows/\d+/run$",
            r"^/api/admin/network-capture/(start|pause|resume|stop|clear)$",
            r"^/api/admin/paypal/windows/\d+/(open|login|register)$",
        ]
        allow_non_admin_write = any(re.match(p, path) for p in non_admin_write_allow_patterns)
        if path not in bypass_paths and not allow_non_admin_write:
            authorization = request.headers.get("authorization") or ""
            if not authorization.startswith("Bearer "):
                return Response(content='{"detail":"Missing authorization"}', media_type="application/json", status_code=401)
            token = authorization[7:]
            username = admin.active_admin_tokens.get(token)
            if not username:
                return Response(content='{"detail":"Invalid or expired admin token"}', media_type="application/json", status_code=401)
            user = await db.get_admin_user(username)
            if not user or not bool(getattr(user, "is_admin", False)):
                return Response(content='{"detail":"仅管理员可执行此操作"}', media_type="application/json", status_code=403)

    return await call_next(request)


app.include_router(routes.router)
app.include_router(admin.router)
app.include_router(analyze.router)
app.include_router(browser_extension_bridge.router)


# 静态资源（js/css/img）
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")
static_dir = STATIC_DIR
assets_dir = static_dir / "assets"
assets_dir.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")


def _page(path: Path) -> Response:
    if path.exists():
        return FileResponse(str(path))
    return HTMLResponse(content=f"<h1>页面不存在</h1><p>{path.name}</p>", status_code=404)


@app.get("/", response_class=HTMLResponse)
async def index():
    return _page(static_dir / "login.html")


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    return _page(static_dir / "login.html")


@app.get("/admin/system", response_class=HTMLResponse)
async def admin_system_page():
    return _page(static_dir / "system.html")


@app.get("/admin/projects", response_class=HTMLResponse)
async def admin_projects_page():
    return _page(static_dir / "projects.html")


@app.get("/admin/task-types", response_class=HTMLResponse)
async def admin_task_types_page():
    return _page(static_dir / "task_types.html")


@app.get("/admin/tasks", response_class=HTMLResponse)
async def admin_tasks_page():
    return _page(static_dir / "tasks.html")


@app.get("/admin/watermark-tasks", response_class=HTMLResponse)
async def admin_watermark_tasks_page():
    return _page(static_dir / "watermark_tasks.html")


@app.get("/admin/test", response_class=HTMLResponse)
async def admin_test_page():
    return _page(static_dir / "test.html")


@app.get("/admin/network-capture", response_class=HTMLResponse)
async def admin_network_capture_page():
    return _page(static_dir / "network_capture.html")



@app.get("/admin/paypal", response_class=HTMLResponse)
async def admin_paypal_page():
    return _page(static_dir / "paypal.html")


@app.get("/admin/image-resources", response_class=HTMLResponse)
async def admin_image_resources_page():
    return _page(static_dir / "image_resources.html")


@app.get("/admin/card-keys", response_class=HTMLResponse)
async def admin_card_keys_page():
    return _page(static_dir / "card_keys.html")


@app.get("/admin/totp", response_class=HTMLResponse)
async def admin_totp_page():
    return _page(static_dir / "totp.html")


@app.get("/admin/logs", response_class=HTMLResponse)
async def admin_logs_page():
    return _page(static_dir / "logs.html")


@app.get("/admin/users", response_class=HTMLResponse)
async def admin_users_page():
    return _page(static_dir / "users.html")
