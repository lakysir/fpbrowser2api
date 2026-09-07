"""`*-1080p` 模型的视频超分客户端。

超分由外部服务 `onnx_watermark_service` 提供（与去水印同一台机器、同一端口）：

- 创建：``POST {base}/v1/videos``，``{"model": ..., "video_url": ..., "seconds": 15}``
- 查询：``GET {base}/v1/videos/{task_id}``，终态为 ``completed`` / ``failed``

调用方（`task_service`）在 VEO 视频生成完成之后、把任务置为 completed 之前串行
调用本模块。超分整体是「尽力而为」：本模块的任何失败都以返回值表达，绝不抛异常，
也绝不让任务因超分而失败——失败时调用方保留超分前的视频地址。

外部服务的关键限制（见 `watermark_service/video_upscale.py`）：

- 输入视频 ≤ 30MB，且 ``max(width, height)`` ≤ 1300（720p 视频满足）；
- ``seconds`` 必须 ≥ 视频实际时长，因此这里固定传 15（覆盖 8s / 10s 的 VEO 视频）；
- 名额满时直接返回 HTTP 503（不排队），本模块按固定间隔重试提交。
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

import httpx

from ..core.config import config as app_config
from ..core.logger import logger
from .postprocess_dispatch import round_robin_order

# 外部服务里 max(width, height) 上限为 1300 的超分模型，适配 720p 输入。
UPSCALE_MODEL = "newtoken_720_upscale_1080"

# 外部服务按 seconds 计费/校验，且要求 seconds >= 视频实际时长。VEO 视频固定为
# 8s / 10s，统一传 15 即可，不需要为此再探测一次视频时长。
UPSCALE_SECONDS = 15

_CREATE_TIMEOUT_SECONDS = 120.0
_QUERY_TIMEOUT_SECONDS = 60.0
_POLL_INTERVAL_SECONDS = 10.0

LogCB = Callable[[str], None]
ProgressCB = Callable[[int, Optional[Dict[str, Any]]], Awaitable[None]]


class UpscaleResult:
    """超分结果。``video_url`` 有值即成功，否则 ``error`` 说明原因。"""

    __slots__ = ("video_url", "error", "task_id")

    def __init__(
        self,
        *,
        video_url: Optional[str] = None,
        error: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> None:
        self.video_url = video_url
        self.error = error
        self.task_id = task_id

    @property
    def ok(self) -> bool:
        return bool(self.video_url)


class _UpscaleServiceConnectionError(Exception):
    """No connection was established, so another endpoint can be tried."""


def upscale_1080p_enabled() -> bool:
    """超分是否可用：开关打开且配置了外部服务地址。"""
    return bool(app_config.video_upscale_1080p_enabled and app_config.video_upscale_service_base_urls)


def _log(log_cb: Optional[LogCB], message: str) -> None:
    logger.info("[upscale-1080p] %s", message)
    if log_cb is None:
        return
    try:
        log_cb(f"[upscale-1080p] {message}")
    except Exception:
        pass


async def _report(progress_cb: Optional[ProgressCB], progress: int, detail: Dict[str, Any]) -> None:
    if progress_cb is None:
        return
    try:
        await progress_cb(progress, detail)
    except Exception:
        pass


def _text(value: Any) -> str:
    return str(value or "").strip()


def _is_public_http_url(url: str) -> bool:
    return bool(re.match(r"^https?://", url or "", flags=re.I))


def _error_message(response: httpx.Response) -> str:
    """从外部服务的 NewAPI 风格错误体里取 message。"""
    try:
        body = response.json()
    except Exception:
        return _text(response.text)[:300] or f"HTTP {response.status_code}"
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            return _text(error.get("message")) or f"HTTP {response.status_code}"
    return _text(str(body))[:300] or f"HTTP {response.status_code}"


async def upscale_video_to_1080p(
    video_url: str,
    *,
    progress_cb: Optional[ProgressCB] = None,
    log_cb: Optional[LogCB] = None,
) -> UpscaleResult:
    """把 ``video_url`` 交给外部服务超分到 1080p。

    永不抛异常：成功返回带 ``video_url`` 的结果，其余情况返回带 ``error`` 的结果。
    """
    source_url = _text(video_url)
    if not source_url:
        return UpscaleResult(error="no source video url")
    if not _is_public_http_url(source_url):
        return UpscaleResult(error=f"source video url is not a public http url: {source_url[:120]}")
    if not app_config.video_upscale_1080p_enabled:
        return UpscaleResult(error="disabled by config video_postprocess.upscale_1080p")
    base_urls = app_config.video_upscale_service_base_urls
    if not base_urls:
        return UpscaleResult(error="video_postprocess upscale service url is not configured")

    try:
        return await _upscale_with_failover(
            source_url,
            base_urls=base_urls,
            progress_cb=progress_cb,
            log_cb=log_cb,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - 超分失败不能影响任务本身
        logger.exception("[upscale-1080p] unexpected failure")
        return UpscaleResult(error=f"{exc.__class__.__name__}: {_text(exc)[:300]}")


async def _upscale_with_failover(
    source_url: str,
    *,
    base_urls: list[str],
    progress_cb: Optional[ProgressCB],
    log_cb: Optional[LogCB],
) -> UpscaleResult:
    # Rotate the preferred endpoint for each new task, then fail over in the
    # same cyclic order if the selected service cannot be reached.
    ordered_urls = round_robin_order(base_urls)
    for index, base_url in enumerate(ordered_urls):
        try:
            return await _upscale_impl(
                source_url,
                base_url=base_url,
                progress_cb=progress_cb,
                log_cb=log_cb,
            )
        except _UpscaleServiceConnectionError as exc:
            message = _text(exc)[:300]
            if index + 1 >= len(ordered_urls):
                return UpscaleResult(error=message)
            _log(log_cb, f"service unavailable: {message}; switching to {ordered_urls[index + 1]}")

    return UpscaleResult(error="all upscale services are unreachable")


async def _upscale_impl(
    source_url: str,
    *,
    base_url: str,
    progress_cb: Optional[ProgressCB],
    log_cb: Optional[LogCB],
) -> UpscaleResult:
    total_timeout = app_config.video_upscale_timeout_seconds
    retry_interval = app_config.video_upscale_retry_interval_seconds
    deadline = time.monotonic() + total_timeout
    create_url = f"{base_url}/v1/videos"

    _log(
        log_cb,
        f"start source={source_url[:200]} service={create_url} "
        f"model={UPSCALE_MODEL} timeout={total_timeout:.0f}s",
    )
    await _report(progress_cb, 96, {"stage": "upscale_1080p_start", "video_url": source_url})

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(_CREATE_TIMEOUT_SECONDS, connect=20.0)
    ) as client:
        task_id, error = await _submit_with_retry(
            client,
            create_url=create_url,
            source_url=source_url,
            deadline=deadline,
            retry_interval=retry_interval,
            log_cb=log_cb,
        )
        if not task_id:
            _log(log_cb, f"submit failed: {error}")
            return UpscaleResult(error=error or "upscale submit failed")

        _log(log_cb, f"submitted task_id={task_id}")
        await _report(
            progress_cb,
            97,
            {"stage": "upscale_1080p_processing", "upscale_task_id": task_id},
        )
        return await _wait_for_result(
            client,
            base_url=base_url,
            task_id=task_id,
            deadline=deadline,
            progress_cb=progress_cb,
            log_cb=log_cb,
        )


async def _submit_with_retry(
    client: httpx.AsyncClient,
    *,
    create_url: str,
    source_url: str,
    deadline: float,
    retry_interval: float,
    log_cb: Optional[LogCB],
) -> Tuple[Optional[str], Optional[str]]:
    """提交超分任务；仅在名额满（503）时按固定间隔重试，其余错误立即返回。"""
    payload = {"model": UPSCALE_MODEL, "video_url": source_url, "seconds": UPSCALE_SECONDS}
    last_error: Optional[str] = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, last_error or "upscale submit timed out"
        try:
            response = await client.post(create_url, json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise _UpscaleServiceConnectionError(
                f"upscale service unreachable ({create_url}): "
                f"{exc.__class__.__name__}: {_text(exc)[:200]}"
            ) from exc
        except Exception as exc:  # noqa: BLE001 - 不确定是否已提交，不能切换后重复创建任务
            return None, f"upscale service request failed: {exc.__class__.__name__}: {_text(exc)[:200]}"

        if response.status_code == 503:
            # 名额满：外部服务立即拒绝、不排队，这里按固定间隔重试直到总超时。
            last_error = _error_message(response)
            if retry_interval <= 0:
                return None, last_error
            wait = min(retry_interval, max(0.0, deadline - time.monotonic()))
            if wait <= 0:
                return None, last_error
            _log(log_cb, f"capacity full, retry in {wait:.0f}s: {last_error}")
            await asyncio.sleep(wait)
            continue

        if response.status_code >= 400:
            return None, _error_message(response)

        try:
            body = response.json()
        except Exception:
            return None, f"upscale service returned non-json body: {_text(response.text)[:200]}"
        if not isinstance(body, dict):
            return None, f"upscale service returned unexpected body: {_text(str(body))[:200]}"
        task_id = _text(body.get("task_id") or body.get("id"))
        if not task_id:
            return None, f"upscale service returned no task_id: {_text(str(body))[:200]}"
        return task_id, None


async def _wait_for_result(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    task_id: str,
    deadline: float,
    progress_cb: Optional[ProgressCB],
    log_cb: Optional[LogCB],
) -> UpscaleResult:
    query_url = f"{base_url}/v1/videos/{task_id}"
    consecutive_query_errors = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _log(log_cb, f"timed out waiting for task_id={task_id}")
            return UpscaleResult(error="upscale timed out", task_id=task_id)

        try:
            response = await client.get(query_url, timeout=httpx.Timeout(_QUERY_TIMEOUT_SECONDS, connect=20.0))
            if response.status_code >= 400:
                raise RuntimeError(_error_message(response))
            body = response.json()
            if not isinstance(body, dict):
                raise RuntimeError(f"unexpected body: {_text(str(body))[:200]}")
            consecutive_query_errors = 0
        except Exception as exc:  # noqa: BLE001 - 查询抖动允许重试几次
            consecutive_query_errors += 1
            if consecutive_query_errors >= 5:
                return UpscaleResult(
                    error=f"upscale query failed {consecutive_query_errors} times: {_text(exc)[:200]}",
                    task_id=task_id,
                )
            await asyncio.sleep(min(_POLL_INTERVAL_SECONDS, max(0.0, deadline - time.monotonic())))
            continue

        status = _text(body.get("status")).lower()
        if status == "completed":
            upscaled_url = _text(body.get("video_url") or body.get("url"))
            if not upscaled_url:
                return UpscaleResult(error="upscale completed without video_url", task_id=task_id)
            _log(log_cb, f"done task_id={task_id} url={upscaled_url[:200]}")
            await _report(
                progress_cb,
                99,
                {
                    "stage": "upscale_1080p_done",
                    "upscale_task_id": task_id,
                    "video_url": upscaled_url,
                },
            )
            return UpscaleResult(video_url=upscaled_url, task_id=task_id)

        if status == "failed":
            error = body.get("error")
            message = _text(error.get("message")) if isinstance(error, dict) else ""
            return UpscaleResult(error=message or "upscale failed", task_id=task_id)

        wait = min(_POLL_INTERVAL_SECONDS, max(0.0, deadline - time.monotonic()))
        if wait <= 0:
            _log(log_cb, f"timed out waiting for task_id={task_id}")
            return UpscaleResult(error="upscale timed out", task_id=task_id)
        await asyncio.sleep(wait)
