"""Task scheduling + dispatch service."""

from __future__ import annotations

import asyncio
import json
import time
import unicodedata
import uuid
from datetime import datetime
from collections import deque
from dataclasses import dataclass
from typing import Any, Dict, Optional

from ..core.database import Database
from ..core.logger import logger
from ..core.models import Task
from ..core.public_api_limits import DEFAULT_PUBLIC_CREATE_TASK_MAX_INFLIGHT, calc_public_browser_pool_limit
from ..core.config import config as app_config
from .image_task_executor import simulate_image_task
from .playwright_broswer_context import (
    acquire_browser_open_slot,
    get_or_create_ctx as get_or_create_playwright_ctx,
)
from .video_task_executor import simulate_video_task
from .sora_task_executor import (
    get_or_create_sora_session,
    sora_gen_video,
    refresh_sora_balance_best_effort,
    force_refresh_sora_access_token,
    window_pool_guard_unknown_handler_page,
)
from .task_executor_types import NonPenalizedTaskError
from .video_upscale_client import upscale_1080p_enabled, upscale_video_to_1080p

def _sora_task_error_needs_forced_access_token_refresh(exc: BaseException) -> bool:
    """sora_gen_video 失败时：在 exception 路径触发一次窗口内重抓 token，供后续队列重试用。"""
    msg = str(exc or "")
    ml = msg.lower()
    if "token_expired" in ml or "token is expired" in ml:
        return True
    return False


def _apply_upscaled_video_url(result: Dict[str, Any], upscaled_url: str, *, source_url: str, upscale_task_id: Optional[str]) -> Dict[str, Any]:
    """把 result 里的视频地址替换为超分地址，并留下超分前的地址便于排查。"""
    out = dict(result or {})
    for key in ("video_url", "share_url", "url"):
        if key in out or key == "video_url":
            out[key] = upscaled_url
    result_urls = out.get("result_urls")
    if isinstance(result_urls, list) and result_urls:
        out["result_urls"] = [upscaled_url if str(item or "").strip() == source_url else item for item in result_urls]
        if upscaled_url not in out["result_urls"]:
            out["result_urls"].insert(0, upscaled_url)
    else:
        out["result_urls"] = [upscaled_url]
    out["upscaled_1080p"] = True
    out["upscaled_1080p_url"] = upscaled_url
    out["pre_upscale_video_url"] = source_url
    if upscale_task_id:
        out["upscale_task_id"] = upscale_task_id
    return out


async def _maybe_upscale_result_to_1080p(
    result: Any,
    *,
    payload: Dict[str, Any],
    task_id: str,
    progress_cb: Any,
) -> Any:
    """`*-1080p` 模型：视频生成成功后再做一次 1080p 超分。

    整段是尽力而为——开关关闭、取不到视频地址、超分失败或超时，都保留超分前的
    地址并把原因写进 result，任务照常算成功。超分耗时可能超过 10 分钟，因此这里
    刻意放在 `asyncio.wait_for(veo_workflow, ...)` 之外，不受生成超时约束。
    """
    if not isinstance(result, dict):
        return result
    if not (payload or {}).get("upscale_1080p"):
        return result
    try:
        return await _upscale_result_to_1080p_impl(
            result, task_id=task_id, progress_cb=progress_cb
        )
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001 - 超分永不影响任务成功
        logger.warning("task %s 1080p upscale raised (keep original video): %s", task_id, e)
        out = dict(result)
        out["upscaled_1080p"] = False
        out["upscale_error"] = f"{e.__class__.__name__}: {e}"
        return out


async def _upscale_result_to_1080p_impl(
    result: Dict[str, Any],
    *,
    task_id: str,
    progress_cb: Any,
) -> Dict[str, Any]:
    if not upscale_1080p_enabled():
        out = dict(result)
        out["upscaled_1080p"] = False
        out["upscale_skipped"] = True
        out["upscale_error"] = "1080p upscale is disabled by config video_postprocess.upscale_1080p"
        return out

    source_url = _veo_pick_result_video_url(result)
    if not source_url:
        out = dict(result)
        out["upscaled_1080p"] = False
        out["upscale_error"] = "no public video url in result"
        return out

    upscaled = await upscale_video_to_1080p(source_url, progress_cb=progress_cb)
    if upscaled.ok:
        logger.info("task %s upscaled to 1080p: %s", task_id, upscaled.video_url)
        return _apply_upscaled_video_url(
            result,
            str(upscaled.video_url),
            source_url=source_url,
            upscale_task_id=upscaled.task_id,
        )

    logger.warning("task %s 1080p upscale failed (keep original video): %s", task_id, upscaled.error)
    out = dict(result)
    out["upscaled_1080p"] = False
    out["upscale_error"] = upscaled.error or "upscale failed"
    if upscaled.task_id:
        out["upscale_task_id"] = upscaled.task_id
    return out


def _db_bool(value: Any, *, default: bool = False) -> bool:
    """Parse sqlite/mysql-ish boolean values without treating string "0" as True."""
    if value is None:
        return bool(default)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    s = str(value).strip().lower()
    if s in ("1", "true", "yes", "y", "on"):
        return True
    if s in ("0", "false", "no", "n", "off", ""):
        return False
    return bool(value)


def _effective_browser_pure_mode_from_context(ctx: Dict[str, Any]) -> bool:
    """窗口池 browser_open 的 pure_mode：使用绑定 pure_mode 列；缺省保持旧行为 True。"""
    return _db_bool(ctx.get("pure_mode"), default=True)


from .sora_wm_remove_executor import sora_wm_remove
from .sora_plus_register_executor import sora_plus_register
from .grok_workflow_executor import (
    DEFAULT_GROK_TARGET,
    get_or_create_grok_session,
    grok_ref_url_count,
    grok_workflow,
)
from .veo_workflow_executor import (
    _veo_pick_result_video_url,
    _veo_resolve_n_frames,
    _veo_payload_video_model_is_omni,
    _veo_payload_image_model_4k,
    VeoAccessKeepaliveRefresher,
    get_or_create_veo_session,
    refresh_veo_balance_via_extension,
    veo_fetch_access_tokens_via_extension,
    veo_workflow,
    _veo_project_page_url,
)
from .jimeng_task_executor import (
    DEFAULT_DREAMINA_TARGET,
    DreaminaBalanceRefresher,
    get_or_create_dreamina_session,
    refresh_dreamina_balance_best_effort,
    dreamina_workflow,
    _DREAMINA_MIN_CREDIT,
    _DREAMINA_GIFT_CREDIT,
)
from .gpt_task_executor import (
    gpt_workflow, 
    refresh_gpt_balance_via_extension, 
    DEFAULT_GPT_TARGET,
    _gpt_payload_image_model_2k_4k,
)


@dataclass
class PickedWindow:
    mapping_id: int
    window_pk: int
    window_key: str
    task_code: str
    task_concurrency: int
    threshold: int
    close_window_threshold: int
    timeout_seconds: int
    create_task_handler: Optional[str]
    browser_vendor: str
    browser_base_url: str
    browser_access_key: Optional[str]
    space_id: str
    sora_access_token: Optional[str] = None
    sora_access_expires: Optional[str] = None
    default_target_url: Optional[str] = None
    window_ip: Optional[str] = None
    headless: bool = False
    pure_mode: bool = True
    error_retry_count: int = 0
    project_id: Optional[str] = None

@dataclass
class QueuedTask:
    task_id: str
    task_type_code: str
    payload: Dict[str, Any]
    enqueued_at: float
    retry_attempt: int = 0
    required_window_pk: Optional[int] = None
    is_dedicated_window: bool = False

def _remaining_quota_exclusive_floor_for_pick(
    task_type_code: str, payload: Optional[Dict[str, Any]]
) -> int:
    credit_threthold = 1;
    plan_type = 0
    """与 pick 时 remaining_quota >= floor 及预扣额度对齐（见 _consume_quota_after_window_pick）。"""
    code = (task_type_code or "").strip()
    if code == "sora_gen_video":
        return 3, credit_threthold,plan_type
    if code == "veo_workflow":
        credit_threthold = 0;
        if payload is None:
            return 0,credit_threthold,plan_type
        elif _veo_payload_image_model_4k(payload or {}): #4k图片，0积分 至少pro账号
            plan_type = 1
            return 0,credit_threthold,plan_type
        #elif _veo_payload_video_model_is_omni(payload or {}): #参考视频，20积分 任意账号
        #    return 20,credit_threthold,plan_type
        elif _veo_resolve_n_frames(payload or {}) == 300: #视频，20积分 任意账号
            return 15,15,plan_type
        elif _veo_resolve_n_frames(payload or {}) == 240: #视频，20积分 任意账号
            return 20,20,plan_type
        else:
            return 0,credit_threthold,plan_type #普通图片，0积分 任意账号
    if code == "grok_workflow":
        if _veo_resolve_n_frames(payload or {}) > 1:
            return 30,credit_threthold,plan_type
        else:
            return 10,credit_threthold,plan_type
    if code == "dreamina_workflow":
        credit_threthold = _DREAMINA_MIN_CREDIT - _DREAMINA_GIFT_CREDIT;
        return _DREAMINA_MIN_CREDIT,credit_threthold, plan_type
    if code == "gpt_workflow":
        if _gpt_payload_image_model_2k_4k(payload or {}):
            return 1, 0, 1
        return 1, 0, 0
    return 3,credit_threthold, plan_type


class TaskService:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._browser_pool_limit: int = calc_public_browser_pool_limit(DEFAULT_PUBLIC_CREATE_TASK_MAX_INFLIGHT)
        # 任务 payload 仍保留一份内存副本供执行器使用；DB 侧仅保存一个“可查看/可检索”的 prompt 字符串
        self._task_payloads: dict[str, Dict[str, Any]] = {}
        # 1) payload["prompt"] 本身的长度上限（便于查看，也避免超长文本撑爆 DB）
        self._payload_prompt_max_chars: int = 1024
        # 2) 最终落库到 tasks.prompt 的总长度上限（兼容某些历史/自定义 schema 的较短字段）
        self._prompt_max_chars: int = 2500
        # Hard character caps still protect DB/admin pages from very long unspaced input.
        self._payload_prompt_hard_max_chars: int = 20000
        self._prompt_hard_max_chars: int = 20000

        # ---- 专用窗口并发控制（generation_id + head_url 类任务） ----
        self._dedicated_window_inflight: int = 0
        self._dedicated_window_lock = asyncio.Lock()
        self._browser_open_concurrency: int = 3

        # ---- 排队机制：窗口满载时入队等待，窗口释放时自动派发 ----
        self._pending_queue: deque[QueuedTask] = deque()
        self._queue_lock = asyncio.Lock()
        self._dispatch_event = asyncio.Event()
        self._dispatcher_task: Optional[asyncio.Task] = None
        self._queue_max_size: int = 1000
        self._queue_timeout_seconds: float = 300.0
        self._dispatch_poll_interval: float = 5.0
        # 从 DB 缓存读取排队配置（避免频繁读库）
        self._queue_config_cache: tuple[float, int, float] = (0.0, 1000, 300.0)
        self._queue_config_ttl: float = 30.0

        # ---- 窗口池（按任务类型 code 维护应预热的 mapping_id；不占 inflight_slots） ----
        self._window_pool_stop = asyncio.Event()
        self._window_pool_task: Optional[asyncio.Task] = None
        self._window_pool_lock = asyncio.Lock()
        self._window_pool_reconcile_serial = asyncio.Lock()
        self._window_pool_wake = asyncio.Event()
        self._window_pool_force_reconcile = False
        self._window_pool_targets: dict[str, set[int]] = {}
        # Cloudflare 巡检周期（较长，默认 30 分钟）
        self._window_pool_cf_interval: float = 1800.0
        # 与 DB 对齐窗口池目标的 reconcile 周期（较短，默认 10 分钟）
        self._window_pool_reconcile_interval: float = 600.0
        # supervisor 单次休眠上限，避免 stop 后长时间无响应
        self._window_pool_supervisor_poll_cap: float = 60.0
        # Dreamina 余额刷新独立对象：不放在 _window_pool_supervisor_loop，避免被 reconcile/wait 阻塞。
        # TaskService 只负责生命周期；Dreamina 候选查询/刷新业务在 jimeng_task_executor + database 内维护。
        self._dreamina_balance_refresher = DreaminaBalanceRefresher(
            db=self.db,
            stop_event=self._window_pool_stop,
            signal_window_pool_replenish=self._signal_window_pool_replenish,
            refresh_timeout_seconds=60.0,
            scan_interval_seconds=300.0,
        )
        # VEO token 到期前文生图保活/过期后 token 刷新由 VEO 执行器维护；
        # TaskService 只负责按窗口池开关启动/停止该辅助任务。
        self._veo_keepalive_refresher = VeoAccessKeepaliveRefresher(
            db=self.db,
            stop_event=self._window_pool_stop,
            signal_window_pool_replenish=self._signal_window_pool_replenish,
        )

    def set_browser_pool_limit(self, limit: int) -> None:
        """Hot-update scheduling candidate pool size."""
        try:
            self._browser_pool_limit = max(1, int(limit))
        except Exception:
            pass

    def start_window_pool_maintainer(self) -> None:
        """在进程内启动窗口池协程（幂等）。"""
        if self._window_pool_task is not None and not self._window_pool_task.done():
            return
        try:
            self._window_pool_stop.clear()
        except Exception:
            pass
        self._window_pool_task = asyncio.create_task(
            self._window_pool_supervisor_loop(), name="window_pool_maintainer"
        )

    def start_dreamina_balance_refresher(self) -> None:
        """启动 Dreamina 余额刷新独立协程（幂等）。

        注意：该方法只负责启动；是否需要启动由窗口池 reconcile 根据
        dreamina_workflow 的 window_pool_enabled=true 决定。
        """
        try:
            self._window_pool_stop.clear()
        except Exception:
            pass
        self._dreamina_balance_refresher.start()

    def start_veo_access_keepalive_refresher(self) -> None:
        """启动 VEO access_expires 到期前文生图保活独立协程（幂等）。"""
        try:
            self._window_pool_stop.clear()
        except Exception:
            pass
        self._veo_keepalive_refresher.start()

    async def _sync_window_pool_auxiliary_tasks(self, active_handlers: set[str]) -> None:
        """根据开启 window_pool 的任务类型，启动/停止辅助后台任务。"""
        if "dreamina_workflow" in active_handlers:
            self.start_dreamina_balance_refresher()
        else:
            await self._dreamina_balance_refresher.stop()

        if "veo_workflow" in active_handlers:
            self.start_veo_access_keepalive_refresher()
        else:
            await self._veo_keepalive_refresher.stop()

    async def refresh_window_pool_targets_now(self) -> None:
        """任务类型窗口池开关等变更后立即与 DB 对齐（不等 supervisor 周期）。"""
        self.start_window_pool_maintainer()
        try:
            await self._window_pool_reconcile_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("window_pool refresh_window_pool_targets_now failed")

    async def stop_window_pool_maintainer(self) -> None:
        """停止窗口池协程并尽量关闭池内会话。"""
        self._window_pool_stop.set()
        await self._dreamina_balance_refresher.stop()
        await self._veo_keepalive_refresher.stop()
        t = self._window_pool_task
        self._window_pool_task = None
        if t is not None and not t.done():
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        async with self._window_pool_lock:
            codes = list(self._window_pool_targets.keys())
            all_mids: set[int] = set()
            for c in codes:
                all_mids |= set(self._window_pool_targets.get(c, set()))
            self._window_pool_targets.clear()
        for mid in all_mids:
            try:
                await self._window_pool_close_mapping(mid)
            except Exception:
                pass

    def _signal_window_pool_replenish(self) -> None:
        """空闲关闭等导致缺窗时唤醒 supervisor 尽快 reconcile；正在 reconcile 时忽略。"""
        try:
            if self._window_pool_reconcile_serial.locked():
                return
        except Exception:
            return
        self.start_window_pool_maintainer()
        try:
            self._window_pool_wake.set()
        except Exception:
            pass

    async def _window_pool_wait_interruptible(self, timeout: float) -> bool:
        """休眠最多 timeout 秒；若 stop 则返回 True。期间收到 wake 则清除事件并在未占用 reconcile 锁时置 force。"""
        if timeout <= 0:
            return self._window_pool_stop.is_set()
        deadline = time.monotonic() + timeout
        while True:
            if self._window_pool_stop.is_set():
                return True
            if self._window_pool_wake.is_set():
                self._window_pool_wake.clear()
                try:
                    if not self._window_pool_reconcile_serial.locked():
                        self._window_pool_force_reconcile = True
                except Exception:
                    pass
                return False
            rem = deadline - time.monotonic()
            if rem <= 0:
                return False
            try:
                await asyncio.wait_for(self._window_pool_stop.wait(), timeout=min(1.0, rem))
                return True
            except asyncio.TimeoutError:
                pass

    async def _window_pool_supervisor_loop(self) -> None:
        # 首轮尽快 reconcile 一次以预热池；之后按 _window_pool_reconcile_interval
        last_reconcile = time.monotonic() - self._window_pool_reconcile_interval
        while not self._window_pool_stop.is_set():
            try:
                r_sec, c_sec = await self.db.get_window_pool_maintainer_intervals_seconds()
                self._window_pool_reconcile_interval = float(r_sec)
                self._window_pool_cf_interval = float(c_sec)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            now = time.monotonic()
            reconcile_due = self._window_pool_force_reconcile or (
                now - last_reconcile >= self._window_pool_reconcile_interval
            )
            if reconcile_due:
                self._window_pool_force_reconcile = False
                last_reconcile = now
                try:
                    await self._window_pool_reconcile_once()
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.exception("window_pool reconcile: %s", e)
            now = time.monotonic()
            due_r = max(0.0, last_reconcile + self._window_pool_reconcile_interval - now)
            wait = min(due_r, self._window_pool_supervisor_poll_cap)
            wait = max(0.1, wait)
            if await self._window_pool_wait_interruptible(wait):
                break

    async def _window_pool_reconcile_once(self) -> None:
        """
        try:
            if not self._window_pool_reconcile_serial.locked():
                return
        except Exception:
            return
        """

        async with self._window_pool_reconcile_serial:
            await self._window_pool_reconcile_once_impl()

    async def _window_pool_task_type_still_enabled(self, task_type_code: str) -> bool:
        code = (task_type_code or "").strip()
        if not code:
            return False
        if self._window_pool_stop.is_set():
            return False
        try:
            t = await self.db.get_task_type_by_code(code)
        except Exception as e:
            logger.warning("window_pool check task_type=%s enabled failed: %s", code, e)
            return True
        if t is None:
            return False
        return bool(t.enabled) and bool(getattr(t, "window_pool_enabled", False))

    async def _window_pool_sleep_between_opens(self, task_type_code: str, timeout: float) -> bool:
        """Return True when opening should stop for this task type."""
        deadline = time.monotonic() + max(0.0, float(timeout or 0.0))
        while True:
            if self._window_pool_stop.is_set():
                return True
            if not await self._window_pool_task_type_still_enabled(task_type_code):
                return True
            rem = deadline - time.monotonic()
            if rem <= 0:
                return False
            try:
                await asyncio.wait_for(self._window_pool_stop.wait(), timeout=min(1.0, rem))
                return True
            except asyncio.TimeoutError:
                pass

    async def _window_pool_reconcile_once_impl(self) -> None:
        try:
            all_types = await self.db.list_task_types()
        except Exception as e:
            logger.warning("window_pool list_task_types: %s", e)
            return
        if self._window_pool_stop.is_set():
            return

        new_targets: dict[str, set[int]] = {}
        active_window_pool_handlers: set[str] = set()
        # 任务类型仍存在、但被禁用或关闭了窗口池时，只应从窗口池管理集合中移除，
        # 不能主动关闭已经由窗口池/用户打开的指纹浏览器窗口。
        #
        # 之前这里把这类 code 直接从 new_targets 里略过，后面的 diff 逻辑会把
        # prev[code] 全部视为「需要关闭」，导致后台保存“关闭窗口池”后整批窗口
        # 被 _window_pool_close_mapping 调度 idle close。
        inactive_existing_codes: set[str] = set()

        for t in all_types:
            if self._window_pool_stop.is_set():
                return
            code = (t.code or "").strip()
            if not code:
                continue
            if not t.enabled or not bool(getattr(t, "window_pool_enabled", False)):
                inactive_existing_codes.add(code)
                continue
            handler = (t.create_task_handler or "").strip()
            if handler:
                active_window_pool_handlers.add(handler)
            floor,credit_threthold,plan_type = _remaining_quota_exclusive_floor_for_pick(code, None)
            try:
                ids = await self.db.list_window_pool_target_mapping_ids(
                    code, self._browser_pool_limit, floor, credit_threthold, plan_type
                )
                mids = sorted(int(x) for x in ids)
                logger.info(
                    "window_pool new_targets task_type=%s floor=%s credit_threshold=%s count=%d mids=%s",
                    code,
                    floor,
                    credit_threthold,
                    len(mids),
                    mids,
                )
            except Exception as e:
                logger.warning("window_pool targets %s: %s", code, e)
                continue
            new_targets[code] = set(mids)

        await self._sync_window_pool_auxiliary_tasks(active_window_pool_handlers)

        async with self._window_pool_lock:
            prev = {k: set(v) for k, v in self._window_pool_targets.items()}
            self._window_pool_targets = {k: set(v) for k, v in new_targets.items()}

        to_close: list[int] = []
        for code, old_set in prev.items():
            if code not in new_targets:
                if code in inactive_existing_codes:
                    logger.info(
                        "window_pool disabled for task_type=%s; detach %d managed windows without closing",
                        code,
                        len(old_set),
                    )
                    continue
                to_close.extend(old_set)
            else:
                to_close.extend(old_set - new_targets[code])
        logger.info(
            "window_pool to_close mappings: count=%d mids=%s",
            len(to_close),
            sorted(to_close),
        )
        for mid in to_close:
            if self._window_pool_stop.is_set():
                return
            logger.info(
                "_window_pool_close_mapping: mapping=%s",
                mid,
            )
            await self._window_pool_close_mapping(mid)
            await asyncio.sleep(0)

        to_open: list[tuple[str, int]] = []
        for code, new_set in new_targets.items():
            old_set = prev.get(code, set())
            for mid in new_set - old_set:
                to_open.append((code, mid))
        logger.info(
            "window_pool to_open mappings: count=%d mids=%s",
            len(to_open),
            [mid for _, mid in to_open],
        )
        disabled_open_codes: set[str] = set()
        for code, mid in to_open:
            if self._window_pool_stop.is_set():
                return
            if code in disabled_open_codes:
                continue
            if not await self._window_pool_task_type_still_enabled(code):
                disabled_open_codes.add(code)
                async with self._window_pool_lock:
                    self._window_pool_targets.pop(code, None)
                logger.info(
                    "window_pool open stopped because task_type=%s disabled window_pool",
                    code,
                )
                continue
            ok = await self._window_pool_open_mapping(mid)
            if not ok:
                async with self._window_pool_lock:
                    s = self._window_pool_targets.get(code)
                    if s is not None:
                        s.discard(mid)
                logger.warning(
                    "window_pool open mapping=%s failed; keep mapping enabled", mid
                )
            if await self._window_pool_sleep_between_opens(code, 1):
                disabled_open_codes.add(code)
                async with self._window_pool_lock:
                    self._window_pool_targets.pop(code, None)
                logger.info(
                    "window_pool open sleep interrupted because task_type=%s disabled/stopped",
                    code,
                )

    async def _window_pool_open_mapping(self, mapping_id: int) -> bool:
        if self._window_pool_stop.is_set():
            return True
        ctx = await self.db.get_task_type_window_context(mapping_id)
        if not ctx:
            return True
        handler = (ctx.get("create_task_handler") or "").strip()
        base_url = str(ctx.get("lan_addr") or "").strip()
        window_key = str(ctx.get("window_key") or "").strip()
        if not base_url or not window_key:
            return True
        vendor = str(ctx.get("vendor") or "generic")
        access_key = ctx.get("access_key")
        space_id = str(ctx.get("space_id") or "")
        headless = bool(ctx.get("headless"))
        pure_mode = _effective_browser_pure_mode_from_context(ctx)
        target_url = (str(ctx.get("default_target_url") or "").strip() or None)

        try:
            async with acquire_browser_open_slot(base_url):
                if handler == "veo_workflow":
                    picked_pid = await self.db.get_random_veo_flow_project_id(mapping_id)
                    tu = target_url or "https://labs.google/fx"
                    if picked_pid is not None:
                        tu = f"https://labs.google/fx/tools/flow/project/{picked_pid}"

                    sess = get_or_create_veo_session(
                        vendor=vendor,
                        base_url=base_url,
                        access_key=access_key,
                        space_id=space_id,
                        window_key=window_key,
                    )
                    sess.browser_headless = headless
                    sess.browser_pure_mode = pure_mode
                    sess.idle_close_disabled = True
                    sess._cancel_idle_close()

                    try:
                        # VEO 窗口池只打开/唤起目标窗口，不连接 CDP，降低 Playwright 暴露面。
                        await sess.pw_ctx.open_fingerprint_window_only(
                            args=[tu],
                            force_open=sess.browser_force_open,
                            headless=headless,
                            pure_mode=pure_mode,
                        )
                        await asyncio.sleep(3.0)
                    except Exception as e:
                        logger.warning("window_pool open VEO mapping=%s by open-only failed: %s", mapping_id, e)
                        return False

                    token_info = None
                    try:
                        token_info = await veo_fetch_access_tokens_via_extension(
                            sess=sess,
                            target_url=tu,
                            space_id=space_id,
                            window_key=window_key,
                            connect_wait_seconds=8.0,
                            token_timeout_seconds=45.0,
                            log_file=sess._log_file,
                        )
                    except Exception as e:
                        logger.warning("window_pool VEO extension token mapping=%s failed: %s", mapping_id, e)
                        try:
                            await self.db.update_task_type_window(mapping_id=mapping_id, enabled=False)
                        except Exception:
                            pass
                        return True

                    long_session_token = str((token_info or {}).get("session_token") or (token_info or {}).get("access_token") or "").strip()
                    if long_session_token:
                        await self.db.update_task_type_window(
                            mapping_id=mapping_id,
                            sora_access_token=long_session_token,
                            sora_access_expires=str((token_info or {}).get("expires") or "").strip() or None,
                        )
                        self._veo_keepalive_refresher.wake_up()
                    return True
                elif handler == "grok_workflow":
                    tu = target_url or DEFAULT_GROK_TARGET
                    gs = get_or_create_grok_session(
                        vendor=vendor,
                        base_url=base_url,
                        access_key=access_key,
                        space_id=space_id,
                        window_key=window_key,
                    )
                    gs.browser_headless = headless
                    gs.browser_pure_mode = pure_mode
                    gs.idle_close_disabled = True
                    gs._cancel_idle_close()
                    await gs.ensure_open(
                        args=gs.browser_open_args,
                        force_open=gs.browser_force_open,
                        headless=headless,
                        pure_mode=pure_mode,
                    )
                    await gs._bring_target_page_to_front(refresh_target=False, drafts_url=tu)
                    try:
                        await gs.disconnect_playwright_under_bring_lock()
                    except Exception:
                        pass
                    return True
                elif handler == "dreamina_workflow":
                    tu = target_url or DEFAULT_DREAMINA_TARGET
                    ds = get_or_create_dreamina_session(
                        vendor=vendor,
                        base_url=base_url,
                        access_key=access_key,
                        space_id=space_id,
                        window_key=window_key,
                    )
                    ds.browser_headless = headless
                    ds.browser_pure_mode = pure_mode
                    ds.idle_close_disabled = True
                    ds._cancel_idle_close()
                    await ds.ensure_open(
                        args=ds.browser_open_args,
                        force_open=ds.browser_force_open,
                        headless=headless,
                        pure_mode=pure_mode,
                    )
                    await ds._bring_target_page_to_front(refresh_target=False, drafts_url=tu)
                    try:
                        await ds.disconnect_playwright_under_bring_lock()
                    except Exception:
                        pass
                    return True
                elif handler == "gpt_workflow":
                    from .gpt_task_executor import DEFAULT_GPT_TARGET, gpt_fetch_access_token_in_window  # type: ignore

                    tu = target_url or DEFAULT_GPT_TARGET
                    sess = get_or_create_veo_session(
                        vendor=vendor,
                        base_url=base_url,
                        access_key=access_key,
                        space_id=space_id,
                        window_key=window_key,
                    )
                    sess.browser_headless = headless
                    sess.browser_pure_mode = pure_mode
                    sess.idle_close_disabled = True
                    sess._cancel_idle_close()
                    await sess.ensure_open(args=[], force_open=False, headless=headless, pure_mode=pure_mode)
                    await sess._bring_target_page_to_front(refresh_target=False, drafts_url=tu)
                    try:
                        tok_info = await gpt_fetch_access_token_in_window(
                            browser_vendor=vendor,
                            browser_base_url=base_url,
                            browser_access_key=access_key,
                            space_id=space_id,
                            window_key=window_key,
                            target_url=tu,
                            headless=headless,
                            pure_mode=pure_mode,
                            timeout_seconds=45.0,
                        )
                        access_token = str((tok_info or {}).get("access_token") or "").strip()
                        if access_token:
                            await self.db.update_task_type_window(
                                mapping_id=mapping_id,
                                sora_access_token=access_token,
                                sora_access_expires=str((tok_info or {}).get("expires") or "").strip() or None,
                            )
                    except Exception as e:
                        logger.warning("window_pool gpt token refresh mapping=%s failed: %s", mapping_id, e)
                    try:
                        await sess.disconnect_playwright_under_bring_lock()
                    except Exception:
                        pass
                    return True
                elif handler in ("sora_gen_video", "sora_wm_remove", "sora_plus_register"):
                    tu = target_url or "https://sora.chatgpt.com/drafts"
                    sess = get_or_create_sora_session(
                        vendor=vendor,
                        base_url=base_url,
                        access_key=access_key,
                        space_id=space_id,
                        window_key=window_key,
                    )
                    tok = str(ctx.get("sora_access_token") or "").strip()
                    if tok:
                        sess.set_access_token(tok, str(ctx.get("sora_access_expires") or "").strip() or None)
                    sess.browser_headless = headless
                    sess.browser_pure_mode = pure_mode
                    sess.idle_close_disabled = True
                    sess._cancel_idle_close()
                    await sess.ensure_open(
                        args=sess.browser_open_args,
                        force_open=sess.browser_force_open,
                        headless=headless,
                        pure_mode=pure_mode,
                    )
                    await sess._bring_sora_drafts_to_front(refresh_target=False, drafts_url=tu)
                    try:
                        await sess.disconnect_playwright_under_bring_lock()
                    except Exception:
                        pass
                    return True
                else:
                    tu = target_url
                    if not tu:
                        return True
                    pw = get_or_create_playwright_ctx(
                        vendor=vendor,
                        base_url=base_url,
                        access_key=access_key,
                        space_id=space_id,
                        window_key=window_key,
                    )
                    await pw.ensure_open(
                        args=[],
                        force_open=False,
                        headless=headless,
                        require_page=False,
                        pure_mode=pure_mode,
                    )
                    try:
                        async with pw.driver_lock:
                            if pw.context is None:
                                return True
                            if pw.page is None:
                                try:
                                    pages = list(getattr(pw.context, "pages", []) or [])
                                except Exception:
                                    pages = []
                                pw.page = pages[0] if pages else await pw.context.new_page()
                            try:
                                await pw.page.goto(tu, wait_until="domcontentloaded", timeout=60_000)
                            except Exception:
                                pass
                    finally:
                        try:
                            await pw.disconnect_playwright_only_under_driver_lock()
                        except Exception:
                            pass
                    return True
        except Exception as e:
            logger.warning("window_pool open mapping=%s err=%s", mapping_id, e)
            return False

    async def _window_pool_close_mapping(self, mapping_id: int) -> None:
        ctx = await self.db.get_task_type_window_context(mapping_id)
        if not ctx:
            return
        handler = (ctx.get("create_task_handler") or "").strip()
        base_url = str(ctx.get("lan_addr") or "").strip()
        window_key = str(ctx.get("window_key") or "").strip()
        if not base_url or not window_key:
            return
        vendor = str(ctx.get("vendor") or "generic")
        access_key = ctx.get("access_key")
        space_id = str(ctx.get("space_id") or "")
        try:
            if handler == "veo_workflow":
                sess = get_or_create_veo_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                sess.idle_close_disabled = False
                sess._schedule_idle_close()
            elif handler == "grok_workflow":
                gs = get_or_create_grok_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                gs.idle_close_disabled = False
                gs._schedule_idle_close()
            elif handler == "dreamina_workflow":
                ds = get_or_create_dreamina_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                ds.idle_close_disabled = False
                ds._schedule_idle_close()
            elif handler in ("sora_gen_video", "sora_wm_remove", "sora_plus_register"):
                sess = get_or_create_sora_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                sess.idle_close_disabled = False
                sess._schedule_idle_close()
            else:
                pw = get_or_create_playwright_ctx(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                await pw.close_and_drop()
        except Exception as e:
            logger.debug("window_pool close mapping=%s err=%s", mapping_id, e)

    async def _window_pool_drop_sessions_for_mapping(self, mapping_id: int) -> None:
        """CF 仍失败时丢弃会话，由下次 reconcile 重新打开。"""
        ctx = await self.db.get_task_type_window_context(mapping_id)
        if not ctx:
            return
        handler = (ctx.get("create_task_handler") or "").strip()
        base_url = str(ctx.get("lan_addr") or "").strip()
        window_key = str(ctx.get("window_key") or "").strip()
        if not base_url or not window_key:
            return
        vendor = str(ctx.get("vendor") or "generic")
        access_key = ctx.get("access_key")
        space_id = str(ctx.get("space_id") or "")
        try:
            if handler == "veo_workflow":
                sess = get_or_create_veo_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                await sess.close_and_drop()
            elif handler == "grok_workflow":
                gs = get_or_create_grok_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                await gs.close_and_drop()
            elif handler == "dreamina_workflow":
                ds = get_or_create_dreamina_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                await ds.close_and_drop()
            elif handler in ("sora_gen_video", "sora_wm_remove", "sora_plus_register"):
                sess = get_or_create_sora_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                await sess.close_and_drop()
            else:
                pw = get_or_create_playwright_ctx(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                await pw.close_and_drop()
        except Exception as e:
            logger.debug("window_pool drop mapping=%s err=%s", mapping_id, e)

    async def _window_pool_cloudflare_tick(self) -> None:
        async with self._window_pool_lock:
            snapshot = {k: set(v) for k, v in self._window_pool_targets.items()}
        for _code, mids in snapshot.items():
            for mid in mids:
                if self._window_pool_stop.is_set():
                    return
                try:
                    await self._window_pool_cloudflare_one(mid)
                except Exception as e:
                    logger.warning("window_pool cf mapping=%s err=%s", mid, e)

    async def _window_pool_cloudflare_one(self, mapping_id: int) -> None:
        ctx = await self.db.get_task_type_window_context(mapping_id)
        if not ctx:
            return
        handler = (ctx.get("create_task_handler") or "").strip()
        base_url = str(ctx.get("lan_addr") or "").strip()
        window_key = str(ctx.get("window_key") or "").strip()
        if not base_url or not window_key:
            return
        vendor = str(ctx.get("vendor") or "generic")
        access_key = ctx.get("access_key")
        space_id = str(ctx.get("space_id") or "")
        target_url = (str(ctx.get("default_target_url") or "").strip() or None)

        try:
            if handler == "veo_workflow":
                picked_pid = await self.db.get_random_veo_flow_project_id(mapping_id)
                tu = target_url or "https://labs.google/fx"
                if picked_pid is not None:
                    tu = f"https://labs.google/fx/tools/flow/project/{picked_pid}"
                sess = get_or_create_veo_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                if not sess.idle_close_disabled:
                    return
                wpk = int(ctx.get("window_pk") or 0)
                try:
                    gl_ms = int(float(ctx.get("task_timeout_seconds") or 120) * 1000)
                except Exception:
                    gl_ms = 120_000
                gl_ms = max(45_000, min(gl_ms, 240_000))
                page = getattr(sess.pw_ctx, "page", None)
                await sess.raise_if_cloudflare_page_nonpenalized(
                    page,
                    stage="window_pool",
                    target_url=tu,
                    window_pool_google_relogin_db=self.db if wpk > 0 else None,
                    window_pool_google_relogin_window_pk=wpk if wpk > 0 else None,
                    window_pool_google_relogin_timeout_ms=gl_ms,
                )
                try:
                    await sess.disconnect_playwright_under_bring_lock()
                except Exception:
                    pass
            elif handler == "grok_workflow":
                tu = target_url or DEFAULT_GROK_TARGET
                gs = get_or_create_grok_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                if not gs.idle_close_disabled:
                    return
                page = getattr(gs.pw_ctx, "page", None)
                await window_pool_guard_unknown_handler_page(page, stage="window_pool", target_url=tu)
                try:
                    await gs.disconnect_playwright_under_bring_lock()
                except Exception:
                    pass
            elif handler == "dreamina_workflow":
                tu = target_url or DEFAULT_DREAMINA_TARGET
                ds = get_or_create_dreamina_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                if not ds.idle_close_disabled:
                    return
                page = getattr(ds.pw_ctx, "page", None)
                await window_pool_guard_unknown_handler_page(page, stage="window_pool", target_url=tu)
                try:
                    await ds.disconnect_playwright_under_bring_lock()
                except Exception:
                    pass
            elif handler in ("sora_gen_video", "sora_wm_remove", "sora_plus_register"):
                tu = target_url or "https://sora.chatgpt.com/drafts"
                sess = get_or_create_sora_session(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                if not sess.idle_close_disabled:
                    return
                page = getattr(sess.pw_ctx, "page", None)
                await sess._raise_if_cloudflare_page_nonpenalized(
                    page, stage="window_pool", drafts_url=tu
                )
                try:
                    await sess.disconnect_playwright_under_bring_lock()
                except Exception:
                    pass
            else:
                tu = target_url
                if not tu:
                    return
                pw = get_or_create_playwright_ctx(
                    vendor=vendor,
                    base_url=base_url,
                    access_key=access_key,
                    space_id=space_id,
                    window_key=window_key,
                )
                page = getattr(pw, "page", None)
                await window_pool_guard_unknown_handler_page(
                    page, stage="window_pool", target_url=tu
                )
                try:
                    await pw.disconnect_playwright_only_under_driver_lock()
                except Exception:
                    pass
        except NonPenalizedTaskError:
            logger.warning(
                "window_pool cloudflare persists, reset session mapping_id=%s", mapping_id
            )
            await self._window_pool_drop_sessions_for_mapping(mapping_id)
        except Exception:
            pass

    def _truncate_text(self, s: str, max_chars: int, *, label: str) -> str:
        s = str(s or "")
        max_chars = int(max_chars or 0)
        if max_chars <= 0:
            return ""
        if len(s) <= max_chars:
            return s
        suffix = f"…({label} truncated, orig_chars={len(s)}, max_chars={max_chars})"
        keep = max(0, max_chars - len(suffix))
        if keep <= 0:
            return suffix[:max_chars]
        return s[:keep] + suffix

    @staticmethod
    def _prompt_length_units(s: str) -> int:
        """Count prompt text by words where possible and by chars for no-space scripts."""
        text = str(s or "")
        if not text:
            return 0

        def _char_script(ch: str) -> str:
            name = unicodedata.name(ch, "")
            for script in (
                "CJK",
                "HIRAGANA",
                "KATAKANA",
                "HANGUL",
                "THAI",
                "LAO",
                "KHMER",
                "MYANMAR",
            ):
                if script in name:
                    return script
            return ""

        def _is_word_char(ch: str) -> bool:
            if _char_script(ch):
                return False
            return ch.isalnum()

        def _word_units(token: str) -> int:
            # Long unspaced strings should not count as a single harmless word.
            return max(1, (len(token) + 15) // 16)

        units = 0
        token: list[str] = []
        for ch in text:
            if ch.isspace():
                if token:
                    units += _word_units("".join(token))
                    token.clear()
                continue
            script = _char_script(ch)
            if script:
                if token:
                    units += _word_units("".join(token))
                    token.clear()
                units += 1
            elif _is_word_char(ch):
                token.append(ch)
            else:
                if token:
                    units += _word_units("".join(token))
                    token.clear()
                units += 1
        if token:
            units += _word_units("".join(token))
        return units

    def _truncate_prompt_text(self, s: str, max_units: int, *, label: str) -> str:
        s = str(s or "")
        max_units = int(max_units or 0)
        if max_units <= 0:
            return ""
        orig_units = self._prompt_length_units(s)
        if orig_units <= max_units:
            return s

        suffix = f"...({label} truncated, orig_units={orig_units}, max_units={max_units})"
        keep_units = max(0, max_units - self._prompt_length_units(suffix))
        if keep_units <= 0:
            return self._truncate_text(suffix, max_units, label=label)

        used = 0
        out: list[str] = []
        word_len = 0

        def _char_script(ch: str) -> str:
            name = unicodedata.name(ch, "")
            for script in (
                "CJK",
                "HIRAGANA",
                "KATAKANA",
                "HANGUL",
                "THAI",
                "LAO",
                "KHMER",
                "MYANMAR",
            ):
                if script in name:
                    return script
            return ""

        for ch in s:
            if ch.isspace():
                token_units = 0
                next_word_len = 0
            elif _char_script(ch):
                token_units = 1
                next_word_len = 0
            elif ch.isalnum():
                before = 0 if word_len <= 0 else (word_len + 15) // 16
                next_word_len = word_len + 1
                after = (next_word_len + 15) // 16
                token_units = after - before
            else:
                token_units = 1
                next_word_len = 0
            if used + token_units > keep_units:
                break
            out.append(ch)
            word_len = next_word_len
            used += token_units
        return "".join(out).rstrip() + suffix

    @staticmethod
    def _task_created_at_for_sql(v: Any) -> Optional[str]:
        """将任务行的 created_at 转为 SQLite 可接受的本地时间字符串（用于 INSERT 覆盖）。"""
        if v is None:
            return None
        if isinstance(v, datetime):
            return v.strftime("%Y-%m-%d %H:%M:%S")
        s = str(v).strip()
        return s or None

    def _payload_to_prompt_text(self, payload: Dict[str, Any]) -> str:
        """把 payload 序列化成可落库的 prompt 文本（尽量是 JSON，且控制长度）。"""

        def _dumps(obj: Any) -> str:
            return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)

        def _looks_like_base64_image(s: str) -> bool:
            text = (s or "").strip()
            if not text:
                return False
            lower = text[:64].lower()
            if lower.startswith("data:image/") and ";base64," in lower:
                return True
            if text.startswith(("http://", "https://", "file://")):
                return False
            if len(text) < 512:
                return False
            sample = text[:1024]
            allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n"
            return all(ch in allowed for ch in sample)

        def _summarize_image_value(value: Any, *, label: str) -> Any:
            if isinstance(value, str):
                text = value.strip()
                if _looks_like_base64_image(text):
                    return {
                        "omitted": "base64_image",
                        "orig_chars": len(value),
                        "preview": self._truncate_text(text, 80, label=label),
                    }
                if len(text) > 400:
                    return self._truncate_text(text, 400, label=label)
                return value
            if isinstance(value, dict):
                summarized = dict(value)
                for k in ("url", "src", "data", "base64", "image", "image_url"):
                    if k in summarized:
                        summarized[k] = _summarize_image_value(summarized[k], label=f"{label}.{k}")
                return summarized
            return value

        def _summarize_image_field(value: Any, *, field: str) -> Any:
            if isinstance(value, list):
                return [
                    _summarize_image_value(item, label=f"{field}[{idx}]")
                    for idx, item in enumerate(value)
                ]
            return _summarize_image_value(value, label=field)

        total_max = max(64, int(self._prompt_max_chars or 0))
        prompt_max = max(0, int(self._payload_prompt_max_chars or 0))
        total_hard_max = max(total_max, int(getattr(self, "_prompt_hard_max_chars", 0) or 0))
        prompt_hard_max = max(prompt_max, int(getattr(self, "_payload_prompt_hard_max_chars", 0) or 0))

        base_payload: Dict[str, Any]
        if isinstance(payload, dict):
            base_payload = dict(payload or {})
        else:
            base_payload = {"payload": payload}

        # 先对 payload["prompt"] 做“字段级”限长（<=1000）
        orig_prompt = str(base_payload.get("prompt") or "")
        if "prompt" in base_payload or orig_prompt:
            prompt_text = self._truncate_prompt_text(orig_prompt, prompt_max, label="prompt")
            base_payload["prompt"] = self._truncate_text(prompt_text, prompt_hard_max, label="prompt_chars")

        for image_field in ("images", "Ingredients_images", "ingredients_images","first_image_url","last_image_url"):
            if image_field in base_payload:
                base_payload[image_field] = _summarize_image_field(
                    base_payload[image_field], field=image_field
                )

        try:
            s = _dumps(base_payload)
        except Exception:
            # 极端兜底：保证永远能落库
            s = self._truncate_text(str(payload or {}), total_max, label="payload")

        if len(s) > total_hard_max:
            s = self._truncate_text(s, total_hard_max, label="payload_chars")

        if self._prompt_length_units(s) <= total_max:
            return s
        raise RuntimeError(f"参数长度超过{total_max}（中文按字、英文按词统计）")

    async def submit_task(
        self,
        task_type_code: str,
        payload: Dict[str, Any],
        *,
        mapping_id: Optional[int] = None,
        window_pk: Optional[int] = None,
    ) -> str:
        task_type_code = (task_type_code or "").strip()
        if not task_type_code:
            raise ValueError("task_type_code 不能为空")
        payload = payload or {}

        # Sora 角色创建分支：payload.generation_id + payload.head_url
        # 需求：若能走该分支，则优先复用 generation_id 对应历史任务的窗口
        payload_generation_id = str(payload.get("generation_id") or "").strip() or None
        payload_head_url = str(payload.get("head_url") or "").strip() or None

        picked: Optional[PickedWindow] = None
        _is_dedicated_window = False
        # 指定窗口优先级：mapping_id > window_pk > 默认自动挑选
        if mapping_id is not None:
            picked = await self._pick_window_by_mapping(
                task_type_code, mapping_id=int(mapping_id), payload=payload
            )
        elif window_pk is not None:
            picked = await self._pick_window_by_window_pk(
                task_type_code, window_pk=int(window_pk), payload=payload
            )
        else:
            # 若 payload 满足“基于 generation_id 创建角色”分支，则尝试按 generation_id 绑定窗口
            if payload_generation_id and payload_head_url:
                try:
                    win_pk = await self.db.get_task_window_pk_by_generation_id(payload_generation_id)
                except Exception:
                    win_pk = None

                if win_pk is None:
                    raise RuntimeError("该视频不属于我们的账号，请先生成视频再使用返回的generation_id创建角色")

                # 并发控制：专用窗口任务受 browser_open_concurrency 限制
                await self._refresh_queue_config()
                _over_limit = False
                async with self._dedicated_window_lock:
                    if self._dedicated_window_inflight >= self._browser_open_concurrency:
                        _over_limit = True
                    else:
                        self._dedicated_window_inflight += 1
                if _over_limit:
                    return await self._enqueue_task(
                        task_type_code, payload,
                        required_window_pk=win_pk,
                        is_dedicated_window=True,
                    )
                _is_dedicated_window = True

                picked = await self._pick_window_by_window_pk(task_type_code, win_pk, payload=payload)
                if not picked:
                    async with self._dedicated_window_lock:
                        self._dedicated_window_inflight = max(0, self._dedicated_window_inflight - 1)
                    raise RuntimeError("该视频不属于我们的账号，请先生成视频再使用返回的generation_id创建角色")
            if not picked:
                picked = await self._pick_window(task_type_code, payload=payload)
        if not picked:
            if mapping_id is not None or window_pk is not None:
                raise RuntimeError("指定窗口不可用：请确认该窗口已绑定该任务类型、未删除、已启用")
            return await self._enqueue_task(task_type_code, payload)

        task_id = uuid.uuid4().hex
        try:
            # 把 payload 序列化落库到 prompt 里，便于管理台查看/检索（控制长度，避免字段溢出）
            prompt_text = self._payload_to_prompt_text(payload)
            await self.db.create_task(
                Task(
                    task_id=task_id,
                    task_type_code=task_type_code,
                    generation_id=None,
                    status="queued",
                    progress=0,
                    prompt=prompt_text,
                    image_path=None,
                    window_pk=picked.window_pk,
                    window_ip=picked.window_ip,
                )
            )
            self._task_payloads[task_id] = payload
            asyncio.create_task(self._run_task(task_id, picked, _is_dedicated_window=_is_dedicated_window))
            return task_id
        except Exception:
            if _is_dedicated_window:
                async with self._dedicated_window_lock:
                    self._dedicated_window_inflight = max(0, self._dedicated_window_inflight - 1)
            # 兜底：若创建任务失败，释放预占槽位避免泄漏，并撤销挑选时标记的 window_status=1
            try:
                await self.db.release_mapping_slot(picked.mapping_id)
            except Exception:
                pass
            raise

    async def _consume_quota_after_window_pick(
        self, picked: PickedWindow, payload: Optional[Dict[str, Any]] = None
    ) -> None:
        """挑选窗口成功后按 handler 预扣 mapping 额度（与真实消耗对齐）。"""
        handler = (picked.create_task_handler or "").strip()
        if handler == "sora_gen_video":
            try:
                await self.db.consume_mapping_quota(picked.mapping_id, amount=2)
            except Exception:
                pass
        elif handler == "veo_workflow":
            try:
                if _veo_resolve_n_frames(payload or {}) > 1:
                    await self.db.consume_mapping_quota(picked.mapping_id, amount=20)
            except Exception:
                pass
        elif handler == "grok_workflow":
            try:
                n = grok_ref_url_count(payload or {})
                if n > 1:
                    await self.db.consume_mapping_quota(picked.mapping_id, amount=20)
                elif n == 1:
                    await self.db.consume_mapping_quota(picked.mapping_id, amount=10)
            except Exception:
                pass

    async def _finalize_picked_window(
        self, r: Dict[str, Any], payload: Optional[Dict[str, Any]] = None
    ) -> Optional[PickedWindow]:
        """由 reserve / pick 返回的行构造 PickedWindow，并处理 window_key 缺失与预扣额度。"""
        mid = int(r["id"])
        picked = PickedWindow(
            mapping_id=mid,
            window_pk=int(r["window_pk"]),
            window_key=str(r.get("window_key") or "").strip(),
            task_code=str(r["task_code"]),
            task_concurrency=int(r.get("task_concurrency") or 1),
            threshold=int(r.get("continuous_error_threshold") or 3),
            close_window_threshold=int(r.get("continuous_error_close_window_threshold") or 3),
            timeout_seconds=int(r.get("timeout_seconds") or 600),
            create_task_handler=(str(r.get("create_task_handler") or "").strip() or None),
            window_ip=(str(r.get("window_ip") or "").strip() or None),
            browser_vendor=str(r.get("vendor") or "generic"),
            browser_base_url=str(r.get("lan_addr") or ""),
            browser_access_key=r.get("access_key"),
            space_id=str(r.get("space_id") or ""),
            sora_access_token=(str(r.get("sora_access_token") or "").strip() or None),
            sora_access_expires=(str(r.get("sora_access_expires") or "").strip() or None),
            default_target_url=(str(r.get("default_target_url") or "").strip() or None),
            headless=bool(r.get("headless")),
            pure_mode=_effective_browser_pure_mode_from_context(r),
            error_retry_count=int(r.get("error_retry_count") or 0),
            project_id=str(r.get("current_project_id") or 0)
        )
        if not picked.window_key:
            try:
                await self.db.release_mapping_slot(mid)
            except Exception:
                pass
            return None
        await self._consume_quota_after_window_pick(picked, payload)
        return picked

    async def _window_pool_pin_selected_mapping(self, task_type_code: str, mapping_id: int) -> None:
        """显式选窗成功后钉入窗口池集合（与 DB 推导目标合并），便于 reconcile / CF 统一管理。"""
        code = (task_type_code or "").strip()
        if not code:
            return
        try:
            tt = await self.db.get_task_type_by_code(code)
        except Exception:
            return
        if not tt or not bool(getattr(tt, "window_pool_enabled", False)):
            return
        mid = int(mapping_id)
        async with self._window_pool_lock:
            self._window_pool_targets.setdefault(code, set()).add(mid)

    async def _pick_window(self, task_type_code: str, payload: Optional[Dict[str, Any]] = None) -> Optional[PickedWindow]:
        """从 DB 候选中挑选窗口，并在 DB 中原子预占并发槽位。

        说明：
        - 预占由 DB 字段 inflight_slots 完成（支持多进程/多实例，避免超卖）
        - 预占成功同时将 windows.window_status 置 1，使单浏览器窗口池上限在打开指纹前即计数
        - 挑选排序由 DB 决定（consecutive_errors 最低优先，其次 remaining_quota 最少优先）
        - 若任务类型开启窗口池：仅从 `_window_pool_targets` 内由 DB 单事务 `pick_and_reserve_window_from_pool` 原子挑选（与全局 pick 相同：+60s error_cooldown_until，避免高并发下多任务盯上同一 mapping）；池为空或无可用则返回 None（不回退全局 pick）
        """
        try:
            tt = await self.db.get_task_type_by_code(task_type_code)
        except Exception:
            tt = None
        if tt:
            total_limit = max(1, int(getattr(tt, "total_concurrency", 100) or 100))
            try:
                current_total = await self.db.get_task_type_inflight_total(task_type_code)
            except Exception as e:
                logger.warning("task_type total concurrency check failed code=%s err=%s", task_type_code, e)
                current_total = 0
            if current_total >= total_limit:
                logger.info(
                    "_pick_window total concurrency limit reached task_type_code=%s current=%s limit=%s",
                    task_type_code,
                    current_total,
                    total_limit,
                )
                return None

        floor, credit_threthold, plan_type = _remaining_quota_exclusive_floor_for_pick(task_type_code, payload)
        logger.info(
            "_pick_window floor=%s credit_threthold=%s plan_type=%s task_type_code=%s",
            floor,
            credit_threthold,
            plan_type,
            task_type_code,
        )
        if tt and bool(getattr(tt, "window_pool_enabled", False)):
            async with self._window_pool_lock:
                pool_ids = list(self._window_pool_targets.get(task_type_code, set()))
            if not pool_ids:
                return None
            r = await self.db.pick_and_reserve_window_from_pool(
                task_type_code,
                pool_ids,
                remaining_quota_exclusive_floor=floor,
                credit_threthold=credit_threthold,
                plan_type=plan_type,
            )
            if not r:
                return None
            return await self._finalize_picked_window(r, payload)

        r = await self.db.pick_and_reserve_window_for_task(
            task_type_code=task_type_code,
            browser_pool_limit=self._browser_pool_limit,
            remaining_quota_exclusive_floor=floor,
            credit_threthold=credit_threthold,
            plan_type=plan_type,
        )
        if not r:
            return None
        return await self._finalize_picked_window(r, payload)

    async def _pick_window_by_mapping(
        self, task_type_code: str, mapping_id: int, payload: Optional[Dict[str, Any]] = None
    ) -> Optional[PickedWindow]:
        """指定 mapping_id（task_type_windows.id）预占并发槽位并返回窗口上下文。"""
        # 显式指定窗口：不按“额度/冷却/熔断/并发上限”等资源约束拒绝，直接选中该窗口
        r = await self.db.force_reserve_mapping_for_task(task_type_code=task_type_code, mapping_id=int(mapping_id))
        if not r:
            return None
        # 复用字段解析逻辑：与 _pick_window 保持一致
        mid = int(r["id"])
        picked = PickedWindow(
            mapping_id=mid,
            window_pk=int(r["window_pk"]),
            window_key=str(r.get("window_key") or "").strip(),
            task_code=str(r["task_code"]),
            task_concurrency=int(r.get("task_concurrency") or 1),
            threshold=int(r.get("continuous_error_threshold") or 3),
            close_window_threshold=int(r.get("continuous_error_close_window_threshold") or 3),
            timeout_seconds=int(r.get("timeout_seconds") or 600),
            create_task_handler=(str(r.get("create_task_handler") or "").strip() or None),
            window_ip=(str(r.get("window_ip") or "").strip() or None),
            browser_vendor=str(r.get("vendor") or "generic"),
            browser_base_url=str(r.get("lan_addr") or ""),
            browser_access_key=r.get("access_key"),
            space_id=str(r.get("space_id") or ""),
            sora_access_token=(str(r.get("sora_access_token") or "").strip() or None),
            sora_access_expires=(str(r.get("sora_access_expires") or "").strip() or None),
            default_target_url=(str(r.get("default_target_url") or "").strip() or None),
            headless=bool(r.get("headless")),
            pure_mode=_effective_browser_pure_mode_from_context(r),
            error_retry_count=int(r.get("error_retry_count") or 0),
            project_id=str(r.get("current_project_id") or 0),
        )
        if not picked.window_key:
            try:
                await self.db.release_mapping_slot(mid)
            except Exception:
                pass
            return None
        await self._consume_quota_after_window_pick(picked, payload)
        await self._window_pool_pin_selected_mapping(task_type_code, mid)
        return picked

    async def _pick_window_by_window_pk(
        self, task_type_code: str, window_pk: int, payload: Optional[Dict[str, Any]] = None
    ) -> Optional[PickedWindow]:
        """指定 window_pk 预占并发槽位并返回窗口上下文。"""
        # 显式指定窗口：不按“额度/冷却/熔断/并发上限”等资源约束拒绝，直接选中该窗口
        r = await self.db.force_reserve_window_for_task(task_type_code=task_type_code, window_pk=int(window_pk))
        if not r:
            return None
        mid = int(r["id"])
        picked = PickedWindow(
            mapping_id=mid,
            window_pk=int(r["window_pk"]),
            window_key=str(r.get("window_key") or "").strip(),
            task_code=str(r["task_code"]),
            task_concurrency=int(r.get("task_concurrency") or 1),
            threshold=int(r.get("continuous_error_threshold") or 3),
            close_window_threshold=int(r.get("continuous_error_close_window_threshold") or 3),
            timeout_seconds=int(r.get("timeout_seconds") or 600),
            create_task_handler=(str(r.get("create_task_handler") or "").strip() or None),
            window_ip=(str(r.get("window_ip") or "").strip() or None),
            browser_vendor=str(r.get("vendor") or "generic"),
            browser_base_url=str(r.get("lan_addr") or ""),
            browser_access_key=r.get("access_key"),
            space_id=str(r.get("space_id") or ""),
            sora_access_token=(str(r.get("sora_access_token") or "").strip() or None),
            sora_access_expires=(str(r.get("sora_access_expires") or "").strip() or None),
            default_target_url=(str(r.get("default_target_url") or "").strip() or None),
            headless=bool(r.get("headless")),
            pure_mode=_effective_browser_pure_mode_from_context(r),
            error_retry_count=int(r.get("error_retry_count") or 0),
            project_id=str(r.get("current_project_id") or 0),
        )
        if not picked.window_key:
            try:
                await self.db.release_mapping_slot(mid)
            except Exception:
                pass
            return None
        await self._consume_quota_after_window_pick(picked, payload)
        await self._window_pool_pin_selected_mapping(task_type_code, mid)
        return picked

    # ---- 排队与调度 ----

    def _ensure_dispatcher(self) -> None:
        if self._dispatcher_task is None or self._dispatcher_task.done():
            self._dispatcher_task = asyncio.create_task(self._dispatcher_loop())

    async def _refresh_queue_config(self) -> None:
        now = time.monotonic()
        expire_at, _, _ = self._queue_config_cache
        if now < expire_at:
            return
        try:
            syscfg = await self.db.get_system_config()
            max_size = max(1, int(getattr(syscfg, "task_queue_max_size", 0) or 1000))
            timeout = max(10.0, float(getattr(syscfg, "task_queue_timeout_seconds", 0) or 300.0))
            browser_open_concurrency = max(1, int(getattr(syscfg, "browser_open_concurrency", 0) or 3))
        except Exception:
            max_size, timeout = self._queue_max_size, self._queue_timeout_seconds
            browser_open_concurrency = self._browser_open_concurrency
        self._queue_config_cache = (now + self._queue_config_ttl, max_size, timeout)
        self._queue_max_size = max_size
        self._queue_timeout_seconds = timeout
        self._browser_open_concurrency = browser_open_concurrency

    async def _enqueue_task(
        self,
        task_type_code: str,
        payload: Dict[str, Any],
        *,
        required_window_pk: Optional[int] = None,
        is_dedicated_window: bool = False,
    ) -> str:
        self._ensure_dispatcher()
        await self._refresh_queue_config()

        if len(self._pending_queue) >= self._queue_max_size:
            raise RuntimeError("任务队列已满，请稍后重试")

        task_id = uuid.uuid4().hex
        prompt_text = self._payload_to_prompt_text(payload)
        await self.db.create_task(
            Task(
                task_id=task_id,
                task_type_code=task_type_code,
                generation_id=None,
                status="queued",
                progress=0,
                prompt=prompt_text,
                image_path=None,
                window_pk=None,
                window_ip=None,
            )
        )
        self._task_payloads[task_id] = payload

        async with self._queue_lock:
            self._pending_queue.append(
                QueuedTask(
                    task_id=task_id,
                    task_type_code=task_type_code,
                    payload=payload,
                    enqueued_at=time.monotonic(),
                    required_window_pk=required_window_pk,
                    is_dedicated_window=is_dedicated_window,
                )
            )
        self._dispatch_event.set()
        logger.info(
            "task queued: %s type=%s queue_size=%d",
            task_id,
            task_type_code,
            len(self._pending_queue),
        )
        return task_id

    async def _dispatcher_loop(self) -> None:
        while True:
            try:
                try:
                    await asyncio.wait_for(
                        self._dispatch_event.wait(),
                        timeout=self._dispatch_poll_interval,
                    )
                except asyncio.TimeoutError:
                    pass
                self._dispatch_event.clear()

                if not self._pending_queue:
                    continue

                await self._refresh_queue_config()
                await self._try_dispatch_all()
            except Exception as e:
                logger.exception("dispatcher_loop error: %s", e)
                await asyncio.sleep(1.0)

    async def _try_dispatch_all(self) -> None:
        async with self._queue_lock:
            still_pending: deque[QueuedTask] = deque()
            exhausted_types: set[str] = set()
            now = time.monotonic()

            while self._pending_queue:
                item = self._pending_queue.popleft()

                if now - item.enqueued_at > self._queue_timeout_seconds:
                    try:
                        await self.db.update_task(
                            item.task_id,
                            status="failed",
                            error_message="排队超时，请稍后重试",
                            set_completed=True,
                        )
                    except Exception:
                        pass
                    self._task_payloads.pop(item.task_id, None)
                    logger.warning("task queue timeout: %s", item.task_id)
                    continue

                if item.task_type_code in exhausted_types and item.required_window_pk is None:
                    still_pending.append(item)
                    continue

                # 专用窗口任务：先检查并发限制
                _dedicated_acquired = False
                if item.is_dedicated_window:
                    async with self._dedicated_window_lock:
                        if self._dedicated_window_inflight >= self._browser_open_concurrency:
                            still_pending.append(item)
                            continue
                        self._dedicated_window_inflight += 1
                        _dedicated_acquired = True

                if item.required_window_pk is not None:
                    picked = await self._pick_window_by_window_pk(
                        item.task_type_code, item.required_window_pk, payload=item.payload
                    )
                else:
                    picked = await self._pick_window(item.task_type_code, payload=item.payload)
                if picked:
                    try:
                        await self.db.update_task(
                            item.task_id,
                            window_pk=picked.window_pk,
                            window_ip=picked.window_ip,
                        )
                    except Exception:
                        pass
                    asyncio.create_task(self._run_task(
                        item.task_id, picked,
                        _retry_attempt=item.retry_attempt,
                        _is_dedicated_window=item.is_dedicated_window,
                    ))
                    logger.info(
                        "task dispatched from queue: %s type=%s window=%s retry=%d (waited %.1fs)",
                        item.task_id,
                        item.task_type_code,
                        picked.window_pk,
                        item.retry_attempt,
                        now - item.enqueued_at,
                    )
                else:
                    if _dedicated_acquired:
                        async with self._dedicated_window_lock:
                            self._dedicated_window_inflight = max(0, self._dedicated_window_inflight - 1)
                    exhausted_types.add(item.task_type_code)
                    still_pending.append(item)

            self._pending_queue = still_pending

    async def get_queue_info(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "queue_size": len(self._pending_queue),
            "queue_max_size": self._queue_max_size,
            "queue_timeout_seconds": self._queue_timeout_seconds,
            "dispatcher_running": self._dispatcher_task is not None and not self._dispatcher_task.done(),
        }
        try:
            info["task_stats"] = await self.db.task_status_summary()
        except Exception:
            info["task_stats"] = {}
        return info

    async def _run_task(self, task_id: str, picked: PickedWindow, *, _retry_attempt: int = 0, _is_dedicated_window: bool = False) -> None:
        _need_retry = False
        _retry_error_msg = ""
        try:
            await self.db.update_task(task_id, status="running", progress=0, set_started=True)
            logger.info("task started: %s type=%s window=%s mapping=%s attempt=%d", task_id, picked.task_code, picked.window_pk, picked.mapping_id, _retry_attempt)

            _last_saved_progress = -1

            async def progress_cb(p: int, _payload: Optional[Dict[str, Any]]):
                nonlocal _last_saved_progress
                pi = int(p)
                if pi == _last_saved_progress:
                    return
                # 只在关键节点或变化 >=5 时写库，大幅减少写频率
                if pi not in (0,1,2,3,4,5,6,7,8,9,10, 100) and abs(pi - _last_saved_progress) < 5:
                    return
                try:
                    await self.db.update_task(task_id, progress=pi)
                    _last_saved_progress = pi
                except Exception:
                    pass

            payload = self._task_payloads.get(task_id) or {}
            prompt = str(payload.get("prompt") or "").strip()
            target_url = str(payload.get("sora_url") or "https://sora.chatgpt.com/drafts").strip()
            is_veo_image_task = (
                picked.create_task_handler == "veo_workflow"
                and _veo_resolve_n_frames(payload) == 1
            )
            try:
                refresh_timeout_seconds = max(1.0, float(payload.get("sora_balance_refresh_timeout_seconds") or 60.0))
            except Exception:
                refresh_timeout_seconds = 60.0

            try:
                # 执行分发：优先按 task_type 配置的 create_task_handler 决定执行器
                if picked.create_task_handler == "sora_gen_video":
                    result = await asyncio.wait_for(
                        sora_gen_video(
                            payload,
                            progress_cb,
                            browser_vendor=picked.browser_vendor,
                            browser_base_url=picked.browser_base_url,
                            browser_access_key=picked.browser_access_key,
                            space_id=picked.space_id,
                            window_key=picked.window_key,
                            timeout_seconds=float(picked.timeout_seconds),
                            access_token=picked.sora_access_token,
                            access_expires=picked.sora_access_expires,
                            headless=picked.headless,
                        ),
                        timeout=float(picked.timeout_seconds),
                    )
                elif picked.create_task_handler == "veo_workflow":
                    veo_payload = dict(payload or {})
                    if picked.default_target_url and not str(
                        veo_payload.get("veo_url") or veo_payload.get("target_url") or ""
                    ).strip():
                        veo_payload["veo_url"] = picked.default_target_url
                    project_id = picked.project_id
                    project_page = _veo_project_page_url(project_id=project_id, hint_url=picked.default_target_url)
                    picked.default_target_url = project_page;
                    result,project_page = await asyncio.wait_for(
                        veo_workflow(
                            veo_payload,
                            progress_cb,
                            browser_vendor=picked.browser_vendor,
                            browser_base_url=picked.browser_base_url,
                            browser_access_key=picked.browser_access_key,
                            space_id=picked.space_id,
                            window_key=picked.window_key,
                            timeout_seconds=float(picked.timeout_seconds),
                            access_token=picked.sora_access_token,
                            access_expires=picked.sora_access_expires,
                            headless=picked.headless,
                            pure_mode=picked.pure_mode,
                            db=self.db,
                            task_type_window_id=picked.mapping_id,
                        ),
                        timeout=float(picked.timeout_seconds),
                    )
                    picked.default_target_url = project_page;
                    print(f"default_target_url:{project_page}");
                elif picked.create_task_handler == "grok_workflow":
                    grok_payload = dict(payload or {})
                    result = await asyncio.wait_for(
                        grok_workflow(
                            grok_payload,
                            progress_cb,
                            browser_vendor=picked.browser_vendor,
                            browser_base_url=picked.browser_base_url,
                            browser_access_key=picked.browser_access_key,
                            space_id=picked.space_id,
                            window_key=picked.window_key,
                            timeout_seconds=float(picked.timeout_seconds),
                            default_target_url=picked.default_target_url,
                            headless=picked.headless,
                            access_token=picked.sora_access_token,
                            access_expires=picked.sora_access_expires,
                            db=self.db,
                            task_type_window_id=picked.mapping_id,
                        ),
                        timeout=float(picked.timeout_seconds),
                    )
                elif picked.create_task_handler == "dreamina_workflow":
                    dreamina_payload = dict(payload or {})
                    result = await asyncio.wait_for(
                        dreamina_workflow(
                            dreamina_payload,
                            progress_cb,
                            browser_vendor=picked.browser_vendor,
                            browser_base_url=picked.browser_base_url,
                            browser_access_key=picked.browser_access_key,
                            space_id=picked.space_id,
                            window_key=picked.window_key,
                            timeout_seconds=float(picked.timeout_seconds),
                            default_target_url=picked.default_target_url,
                            headless=picked.headless,
                            access_token=picked.sora_access_token,
                            access_expires=picked.sora_access_expires,
                            pure_mode=picked.pure_mode,
                            db=self.db,
                            task_type_window_id=picked.mapping_id,
                        ),
                        timeout=float(picked.timeout_seconds),
                    )
                elif picked.create_task_handler == "gpt_workflow":
                    gpt_payload = dict(payload or {})
                    result = await asyncio.wait_for(
                        gpt_workflow(
                            gpt_payload,
                            progress_cb,
                            browser_vendor=picked.browser_vendor,
                            browser_base_url=picked.browser_base_url,
                            browser_access_key=picked.browser_access_key,
                            space_id=picked.space_id,
                            window_key=picked.window_key,
                            timeout_seconds=float(picked.timeout_seconds),
                            access_token=picked.sora_access_token,
                            access_expires=picked.sora_access_expires,
                            default_target_url=picked.default_target_url,
                            headless=picked.headless,
                            pure_mode=picked.pure_mode,
                            db=self.db,
                            task_type_window_id=picked.mapping_id,
                        ),
                        timeout=float(picked.timeout_seconds),
                    )
                elif picked.create_task_handler == "sora_wm_remove":
                    result = await asyncio.wait_for(
                        sora_wm_remove(
                            payload,
                            progress_cb,
                            browser_vendor=picked.browser_vendor,
                            browser_base_url=picked.browser_base_url,
                            browser_access_key=picked.browser_access_key,
                            space_id=picked.space_id,
                            window_key=picked.window_key,
                            timeout_seconds=float(picked.timeout_seconds),
                        ),
                        timeout=float(picked.timeout_seconds),
                    )
                elif picked.create_task_handler == "sora_plus_register":
                    result = await asyncio.wait_for(
                        sora_plus_register(
                            payload,
                            progress_cb,
                            db=self.db,
                            window_pk=picked.window_pk,
                            browser_vendor=picked.browser_vendor,
                            browser_base_url=picked.browser_base_url,
                            browser_access_key=picked.browser_access_key,
                            space_id=picked.space_id,
                            window_key=picked.window_key,
                            timeout_seconds=float(picked.timeout_seconds),
                        ),
                        timeout=float(picked.timeout_seconds),
                    )
                elif picked.task_code == "gen_video":
                    result = await asyncio.wait_for(simulate_video_task(prompt, None, progress_cb), timeout=float(picked.timeout_seconds))
                else:
                    # 默认按图片模拟（包括 gen_image 以及其它未实现类型）
                    result = await asyncio.wait_for(simulate_image_task(prompt, None, progress_cb), timeout=float(picked.timeout_seconds))

                # Sora：单独把 generation_id 落库（用于后续按 generation_id 绑定窗口）
                try:
                    if isinstance(result, dict):
                        gid = str(result.get("generation_id") or "").strip() or None
                        if gid:
                            await self.db.update_task(task_id, generation_id=gid)
                except Exception:
                    pass

                if picked.create_task_handler == "veo_workflow" and not is_veo_image_task:
                    await refresh_veo_balance_via_extension(
                        db=self.db,
                        picked=picked,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        force_refresh_token=False,
                    )
                    self._veo_keepalive_refresher.wake_up()
                elif picked.create_task_handler == "gpt_workflow":
                    await refresh_gpt_balance_via_extension(
                        db=self.db,
                        picked=picked,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        auto_triger_connection=False,
                    )
                elif picked.create_task_handler == "dreamina_workflow":
                    await refresh_dreamina_balance_best_effort(
                        db=self.db,
                        picked=picked,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        task_id=task_id,
                    )
                elif picked.create_task_handler == "grok_workflow":
                    pass
                elif picked.create_task_handler == "sora_gen_video":
                    await refresh_sora_balance_best_effort(
                        db=self.db,
                        picked=picked,
                        target_url=target_url,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        task_id=task_id,
                    )
                try:
                    if isinstance(result, dict) and result.get("drafts_count") is not None:
                        await self.db.update_task_type_window(
                            mapping_id=picked.mapping_id,
                            sora_drafts_count=int(result.get("drafts_count") or 0),
                        )
                except Exception:
                    pass
                # 清空一下result中的nf_check，避免敏感信息泄露
                if isinstance(result, dict):
                    result["nf_check"] = None
                # `*-1080p` 模型：生成成功后串行做一次超分。窗口名额会一并被占用到超分
                # 结束，这正好当作窗口冷却；失败不影响任务成功。
                if picked.create_task_handler == "veo_workflow":
                    result = await _maybe_upscale_result_to_1080p(
                        result,
                        payload=payload,
                        task_id=task_id,
                        progress_cb=progress_cb,
                    )
                await self.db.update_task(task_id, status="completed", progress=100, result=result, set_completed=True)
                #await self.db.consume_mapping_quota(picked.mapping_id, amount=1)
                await self.db.mark_mapping_success(picked.mapping_id)
                logger.info("task completed: %s", task_id)
            except Exception as e:
                if picked.create_task_handler == "veo_workflow" and not is_veo_image_task:
                    await refresh_veo_balance_via_extension(
                        db=self.db,
                        picked=picked,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        auto_triger_connection=False,
                    )
                    self._veo_keepalive_refresher.wake_up()
                elif picked.create_task_handler == "gpt_workflow":
                    await refresh_gpt_balance_via_extension(
                        db=self.db,
                        picked=picked,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        auto_triger_connection=False,
                    )
                elif picked.create_task_handler == "dreamina_workflow":
                    await refresh_dreamina_balance_best_effort(
                        db=self.db,
                        picked=picked,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        task_id=task_id,
                    )
                elif picked.create_task_handler == "grok_workflow":
                    await refresh_gpt_balance_via_extension(
                        db=self.db,
                        picked=picked,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        auto_triger_connection=False,
                    )
                elif picked.create_task_handler == "sora_gen_video":
                    await refresh_sora_balance_best_effort(
                        db=self.db,
                        picked=picked,
                        target_url=target_url,
                        refresh_timeout_seconds=refresh_timeout_seconds,
                        signal_window_pool_replenish=self._signal_window_pool_replenish,
                        task_id=task_id,
                    )
                    if _sora_task_error_needs_forced_access_token_refresh(e):
                        await force_refresh_sora_access_token(
                            db=self.db,
                            picked=picked,
                            target_url=target_url,
                            refresh_timeout_seconds=refresh_timeout_seconds,
                            task_id=task_id,
                        )
                # 失败：尽量把“是否不扣罚(no_penalty)”等信息写入 result_json，便于上游做退款/分类。
                no_penalty = bool(getattr(e, "no_penalty", False))
                status_code = getattr(e, "status_code", None)
                err_result: Dict[str, Any] = {
                    "error_type": e.__class__.__name__,
                    "no_penalty": no_penalty,
                }
                if status_code is not None:
                    try:
                        err_result["status_code"] = int(status_code)
                    except Exception:
                        err_result["status_code"] = str(status_code)
                _err_lower = str(e).lower()
                _is_violation = int(
                    "sora_content_violation" in _err_lower
                    or "media_generation_status_failed" in _err_lower
                    or "cameo_not_found" in _err_lower
                    or "cameo_permission_denied" in _err_lower
                    or "包含违禁画面" in str(e)
                    or "包含违规内容" in str(e)
                    or "参考图中包含未成年" in str(e)
                    or "分辨率过高" in str(e)
                    or "不能超过 4k" in _err_lower
                    or "不能超过4k" in _err_lower
                    or bool(getattr(e, "content_violation", False))
                )
                # ---- 错误重试逻辑 ----
                max_retries = picked.error_retry_count
                can_retry = (
                    max_retries > 0
                    and _retry_attempt < max_retries
                    and not _is_violation
                )
                if can_retry:
                    archive_id = uuid.uuid4().hex
                    try:
                        _orig_row = await self.db.get_task(task_id)
                        _archive_created_at = self._task_created_at_for_sql(
                            getattr(_orig_row, "created_at", None) if _orig_row else None
                        )
                        prompt_text = self._payload_to_prompt_text(payload)
                        await self.db.create_task(
                            Task(
                                task_id=archive_id,
                                task_type_code=picked.task_code,
                                generation_id=None,
                                status="failed",
                                progress=0,
                                prompt=prompt_text,
                                image_path=None,
                                window_pk=picked.window_pk,
                                window_ip=picked.window_ip,
                            ),
                            insert_created_at=_archive_created_at,
                        )
                        await self.db.update_task(
                            archive_id,
                            status="failed",
                            error_message=f"[{_retry_attempt + 1}|{max_retries}]{e}",
                            result=err_result,
                            content_violation=_is_violation if _is_violation else None,
                            set_completed=True,
                        )
                    except Exception:
                        pass
                    try:
                        await self.db.update_task(
                            task_id, status="queued", progress=0, touch_created_at=True
                        )
                    except Exception:
                        pass
                    _need_retry = True
                    _retry_error_msg = str(e)
                    logger.warning(
                        "task will retry %d/%d: %s err=%s, enqueue for dispatch",
                        _retry_attempt + 1, max_retries, task_id, e,
                    )
                else:
                    await self.db.update_task(
                        task_id,
                        status="failed",
                        error_message=str(e),
                        result=err_result,
                        content_violation=_is_violation if _is_violation else None,
                        set_completed=True,
                    )
                # 某些错误不应计入“窗口连续错误”（例如：Sora create 400 invalid_request、未抓到 POST 等环境/请求错误）
                # 执行器侧会抛出带 no_penalty=true 的异常（或同名属性），这里做兼容判断。
                if not no_penalty and not picked.create_task_handler == "sora_wm_remove":
                    await self.db.mark_mapping_error(
                        picked.mapping_id,
                        threshold=picked.threshold,
                        cooldown_seconds=3600,
                        reset_on_threshold=False,
                    )
                    # 连续错误达到“关闭窗口阈值”的整数倍时，启动倒计时关闭窗口（不重置连续错误）
                    try:
                        st = await self.db.get_mapping_runtime_state(mapping_id=picked.mapping_id)
                        ce = int((st or {}).get("consecutive_errors") or 0)
                    except Exception:
                        ce = 0
                    close_thr = max(1, int(getattr(picked, "close_window_threshold", 1) or 1))
                    should_close = ce > 0 and (ce % close_thr == 0)
                    # Sora / Veo 等真实浏览器会话：达阈值后调度空闲关闭，窗口池协程会再补开
                    if should_close:
                        try:
                            if (picked.create_task_handler or "").strip() == "veo_workflow":
                                v_sess = get_or_create_veo_session(
                                    vendor=picked.browser_vendor,
                                    base_url=picked.browser_base_url,
                                    access_key=picked.browser_access_key,
                                    space_id=picked.space_id,
                                    window_key=picked.window_key,
                                )
                                v_sess._schedule_idle_close()
                            elif (picked.create_task_handler or "").strip() == "grok_workflow":
                                g_sess = get_or_create_grok_session(
                                    vendor=picked.browser_vendor,
                                    base_url=picked.browser_base_url,
                                    access_key=picked.browser_access_key,
                                    space_id=picked.space_id,
                                    window_key=picked.window_key,
                                )
                                g_sess._schedule_idle_close()
                            elif (picked.create_task_handler or "").strip() == "dreamina_workflow":
                                d_sess = get_or_create_dreamina_session(
                                    vendor=picked.browser_vendor,
                                    base_url=picked.browser_base_url,
                                    access_key=picked.browser_access_key,
                                    space_id=picked.space_id,
                                    window_key=picked.window_key,
                                )
                                d_sess._schedule_idle_close()
                            else:
                                sess = get_or_create_sora_session(
                                    vendor=picked.browser_vendor,
                                    base_url=picked.browser_base_url,
                                    access_key=picked.browser_access_key,
                                    space_id=picked.space_id,
                                    window_key=picked.window_key,
                                )
                                sess._schedule_idle_close()
                        except Exception:
                            pass
                        self._signal_window_pool_replenish()
                if not _need_retry:
                    logger.exception("task failed: %s err=%s", task_id, e)
            finally:
                # 专用窗口任务：无论成败都调度关闭窗口
                if _is_dedicated_window:
                    try:
                        sess = get_or_create_sora_session(
                            vendor=picked.browser_vendor,
                            base_url=picked.browser_base_url,
                            access_key=picked.browser_access_key,
                            space_id=picked.space_id,
                            window_key=picked.window_key,
                        )
                        sess._schedule_idle_close()
                    except Exception:
                        pass
                    self._signal_window_pool_replenish()
                if not _need_retry:
                    self._task_payloads.pop(task_id, None)
        finally:
            try:
                await self.db.release_mapping_slot(picked.mapping_id)
            except Exception:
                pass
            # 专用窗口任务：释放并发计数（重试时也先释放，重新派发时再获取）
            if _is_dedicated_window:
                async with self._dedicated_window_lock:
                    self._dedicated_window_inflight = max(0, self._dedicated_window_inflight - 1)
            self._dispatch_event.set()

            if _need_retry:
                try:
                    payload = self._task_payloads.get(task_id) or {}
                    _retry_gen_id = str(payload.get("generation_id") or "").strip() or None
                    _retry_head_url = str(payload.get("head_url") or "").strip() or None
                    _bind_window_pk: Optional[int] = None
                    if _retry_gen_id and _retry_head_url:
                        _bind_window_pk = picked.window_pk

                    self._ensure_dispatcher()
                    await self._refresh_queue_config()
                    _retry_enqueued = False
                    _retry_queue_size = 0
                    async with self._queue_lock:
                        if len(self._pending_queue) >= self._queue_max_size:
                            try:
                                await self.db.update_task(
                                    task_id,
                                    status="failed",
                                    error_message=f"任务重试时队列已满，请稍后重试。原错误: {_retry_error_msg}",
                                    set_completed=True,
                                )
                            except Exception:
                                pass
                            self._task_payloads.pop(task_id, None)
                            logger.warning(
                                "task retry dropped (queue full): %s attempt=%d/%d",
                                task_id,
                                _retry_attempt + 1,
                                picked.error_retry_count,
                            )
                        else:
                            self._pending_queue.append(
                                QueuedTask(
                                    task_id=task_id,
                                    task_type_code=picked.task_code,
                                    payload=payload,
                                    enqueued_at=time.monotonic(),
                                    retry_attempt=_retry_attempt + 1,
                                    required_window_pk=_bind_window_pk,
                                    is_dedicated_window=_is_dedicated_window,
                                )
                            )
                            _retry_queue_size = len(self._pending_queue)
                            _retry_enqueued = True
                    if _retry_enqueued:
                        self._dispatch_event.set()
                        logger.info(
                            "task retry enqueued: %s attempt=%d/%d queue_size=%d bind_window=%s",
                            task_id,
                            _retry_attempt + 1,
                            picked.error_retry_count,
                            _retry_queue_size,
                            _bind_window_pk,
                        )
                except Exception as retry_err:
                    try:
                        await self.db.update_task(
                            task_id,
                            status="failed",
                            error_message=f"retry exception ({_retry_attempt + 1}/{picked.error_retry_count}): {retry_err}. original error: {_retry_error_msg}",
                            set_completed=True,
                        )
                    except Exception:
                        pass
                    self._task_payloads.pop(task_id, None)
                    logger.exception("task retry error: %s err=%s", task_id, retry_err)

