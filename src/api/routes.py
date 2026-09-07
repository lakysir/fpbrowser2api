"""Public API routes (task submit + task status)."""

from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..core.auth import verify_api_key_header
from ..core.database import Database
from ..core.models import TaskStatusResponse
from ..core.public_api_limits import (
    DEFAULT_PUBLIC_CREATE_TASK_MAX_INFLIGHT,
    DEFAULT_SERVER_COUNT,
    calc_public_browser_pool_limit,
    normalize_public_create_task_max_inflight,
    normalize_server_count,
)
from ..services.task_service import TaskService
from ..services.task_handler_registry import CreateTaskContext, get_create_task_handler


router = APIRouter()

db: Database | None = None
task_service: TaskService | None = None

# ---- High-concurrency controls (public endpoints) ----
# 创建任务接口并发闸门，避免峰值时打爆 DB/线程资源。
_CREATE_TASK_MAX_INFLIGHT = DEFAULT_PUBLIC_CREATE_TASK_MAX_INFLIGHT
_SERVER_COUNT = DEFAULT_SERVER_COUNT
_CREATE_TASK_ACQUIRE_TIMEOUT_SEC = max(0.1, float(os.getenv("PUBLIC_CREATE_TASK_ACQUIRE_TIMEOUT_SEC", "3")))
_create_task_semaphore: asyncio.Semaphore | None = None
_create_task_gate_lock = asyncio.Lock()

# 高频查询缓存：轮询场景下减少重复读库。
_STATUS_CACHE_TTL_PENDING_SEC = max(0.05, float(os.getenv("TASK_STATUS_CACHE_TTL_PENDING_SEC", "2.0")))
_STATUS_CACHE_TTL_FINAL_SEC = max(1.0, float(os.getenv("TASK_STATUS_CACHE_TTL_FINAL_SEC", "20")))
_status_cache: dict[str, tuple[float, Dict[str, Any]]] = {}
_status_inflight: dict[str, asyncio.Future[Optional[Dict[str, Any]]]] = {}
_status_lock = asyncio.Lock()

# create_task 读前置配置的短缓存（降低热点读库）。
_SYSTEM_CONFIG_TTL_SEC = max(0.1, float(os.getenv("SYSTEM_CONFIG_CACHE_TTL_SEC", "5.0")))
_TASK_TYPE_TTL_SEC = max(0.1, float(os.getenv("TASK_TYPE_CACHE_TTL_SEC", "60.0")))
_system_config_cache: tuple[float, Optional[bool], Optional[int], Optional[int]] = (0.0, None, None, None)
_task_type_cache: dict[str, tuple[float, Any]] = {}
_IMAGE_GENERATION_SYNC_TIMEOUT_SEC = max(1.0, float(os.getenv("IMAGE_GENERATION_SYNC_TIMEOUT_SEC", "600")))
_IMAGE_GENERATION_SYNC_POLL_INTERVAL_SEC = max(0.2, float(os.getenv("IMAGE_GENERATION_SYNC_POLL_INTERVAL_SEC", "2.0")))


def set_dependencies(database: Database) -> None:
    global db, task_service, _create_task_semaphore
    db = database
    task_service = TaskService(database)
    _create_task_semaphore = asyncio.Semaphore(_CREATE_TASK_MAX_INFLIGHT)
    # 窗口池维护协程由 main lifespan 延迟启动，避免启动瞬间抢占事件循环导致管理页无法打开


class CreateTaskRequest(BaseModel):
    task_type_code: str = Field(min_length=2, max_length=64)
    json: Dict[str, Any] = Field(default_factory=dict)
    # 可选：指定执行窗口（仅用于调试/测试；不指定则走默认调度）
    mapping_id: Optional[int] = Field(default=None, ge=1)
    window_pk: Optional[int] = Field(default=None, ge=1)


class CreateVideoRequest(BaseModel):
    model: str = Field(min_length=1, max_length=128)
    prompt: str
    aspect_ratio: Optional[str] = None
    duration: Optional[int] = None
    image: Optional[str] = None
    images: Optional[List[Any]] = None
    n: Optional[int] = Field(default=None, ge=1, le=4)
    size: Optional[str] = None
    quality: Optional[str] = None
    negative_prompt: Optional[str] = None
    seed: Optional[int] = None
    # 允许透传未来新增的视频参数。
    model_config = {"extra": "allow"}


class CreateImageGenerationRequest(BaseModel):
    model: str = Field(min_length=1, max_length=128)
    prompt: str
    n: Optional[int] = Field(default=None, ge=1, le=4)
    size: Optional[str] = None
    quality: Optional[str] = None
    response_format: Optional[str] = None
    background: Optional[str] = None
    output_format: Optional[str] = None
    output_compression: Optional[int] = Field(default=None, ge=0, le=100)
    user: Optional[str] = None
    image: Optional[Any] = None
    images: Optional[List[Any]] = None
    mask: Optional[Any] = None
    negative_prompt: Optional[str] = None
    seed: Optional[int] = None
    aspect_ratio: Optional[str] = None
    # Allow compatible clients to pass provider-specific image parameters.
    model_config = {"extra": "allow"}


OPENAI_COMPAT_VIDEO_MODELS = (
    "seedance-2",
    "seedance-2-fast",
    "nana-banana-2",
    "nana-banana-pro",
    "nana-banana-2-4k",
    "nana-banana-pro-4k",
    "veo-3-1",
    "veo-omni-flash",
    "veo-omni-flash-video-edit",
    # `-1080p` 变体：与去掉后缀的同名模型完全一致，只是在视频生成成功后再做一次
    # 1080p 超分，成功则返回超分后的地址（超分失败不影响任务成功）。
    "veo-3-1-1080p",
    "veo-omni-flash-1080p",
    "veo-omni-flash-video-edit-1080p",
    "gpt-image2-1k",
    "gpt-image2-2k",
    "gpt-image2-4k",
)
OPENAI_COMPAT_VIDEO_MODEL_SET = set(OPENAI_COMPAT_VIDEO_MODELS)
OPENAI_COMPAT_IMAGE_MODELS = (
    "nana-banana-2",
    "nana-banana-pro",
    "nana-banana-2-4k",
    "nana-banana-pro-4k",
    "gpt-image2-1k",
    "gpt-image2-2k",
    "gpt-image2-4k",
)
OPENAI_COMPAT_IMAGE_MODEL_SET = set(OPENAI_COMPAT_IMAGE_MODELS)
OPENAI_COMPAT_SYNC_IMAGE_MODELS = tuple(f"{model}_sync" for model in OPENAI_COMPAT_IMAGE_MODELS)
OPENAI_COMPAT_SYNC_IMAGE_MODEL_SET = set(OPENAI_COMPAT_SYNC_IMAGE_MODELS)
OPENAI_COMPAT_NOOP_MODELS = (
    # 专用于 NewAPI 按次扣费：不创建真实任务，只返回一个合法的
    # OpenAI chat completion 响应，让 NewAPI 完成鉴权、日志和额度扣减。
    "fpbrowser-use",
)
OPENAI_COMPAT_NOOP_MODEL_SET = set(OPENAI_COMPAT_NOOP_MODELS)
OPENAI_COMPAT_MODEL_SET = OPENAI_COMPAT_VIDEO_MODEL_SET | OPENAI_COMPAT_SYNC_IMAGE_MODEL_SET | OPENAI_COMPAT_NOOP_MODEL_SET
GPT_IMAGE2_VIDEO_MODELS: Dict[str, str] = {
    "gpt-image2-1k": "1k",
    "gpt-image2-2k": "2k",
    "gpt-image2-4k": "4k",
}


def _public_image_model_from_sync_model(model: str) -> Optional[str]:
    raw = str(model or "").strip()
    if not raw.endswith("_sync"):
        return None
    base = raw[: -len("_sync")]
    return base if base in OPENAI_COMPAT_IMAGE_MODEL_SET else None


def _require_video_image_seconds_4(payload: Dict[str, Any], model: str) -> None:
    if model not in OPENAI_COMPAT_IMAGE_MODEL_SET:
        return
    if payload.get("seconds") is None:
        payload["seconds"] = 4
    elif _maybe_number(payload.get("seconds")) != 4:
        raise HTTPException(status_code=400, detail=f"{model} must set seconds=4 when used with /v1/videos")
    else:
        payload["seconds"] = 4

    if payload.get("duration") is not None and _maybe_number(payload.get("duration")) != 4:
        raise HTTPException(status_code=400, detail=f"{model} must set duration=4 when used with /v1/videos")


def _resolution_from_openai_image_size(size: Any) -> Optional[str]:
    raw = str(size or "").strip().lower()
    if not raw or raw == "auto":
        return None
    if raw in {"1k", "2k", "4k"}:
        return raw
    if "4096" in raw or raw.startswith("4k"):
        return "4k"
    if "2048" in raw or raw.startswith("2k"):
        return "2k"
    if "1024" in raw or raw.startswith("1k"):
        return "1k"
    return None


def _aspect_ratio_from_openai_image_size(size: Any) -> Optional[str]:
    raw = str(size or "").strip().lower()
    if "x" not in raw:
        return None
    left, right = raw.split("x", 1)
    try:
        width = int(left)
        height = int(right)
    except ValueError:
        return None
    if width <= 0 or height <= 0:
        return None
    if width == height:
        return "1:1"
    return f"{width}:{height}"


def _normalize_image_generation_task_payload(payload: Dict[str, Any]) -> tuple[str, Dict[str, Any]]:
    """Map OpenAI image generation requests to the existing async task payload."""

    payload = dict(payload or {})
    model = str(payload.get("model") or "").strip()
    public_model = _public_image_model_from_sync_model(model)
    if not public_model:
        raise HTTPException(
            status_code=400,
            detail=f"model {model or '<empty>'} is not supported by image generation endpoint; use *_sync image models",
        )
    payload["model"] = public_model

    if payload.get("n") not in (None, 1):
        raise HTTPException(status_code=400, detail="/v1/images/generations currently supports n=1")

    size = payload.get("size")
    resolution = _resolution_from_openai_image_size(size)
    ratio = _aspect_ratio_from_openai_image_size(size)
    if ratio and not str(payload.get("aspect_ratio") or payload.get("ratio") or "").strip():
        payload["aspect_ratio"] = ratio
        payload["ratio"] = ratio
    if resolution and not str(payload.get("resolution") or "").strip():
        payload["resolution"] = resolution

    payload["duration"] = 1
    task_type_code, normalized = _normalize_video_task_payload(payload, require_image_seconds_4=False)
    normalized["workflow_kind"] = "image"
    normalized["duration"] = 1
    if ratio and not str(normalized.get("ratio") or "").strip():
        normalized["ratio"] = ratio
    return task_type_code, normalized


UPSCALE_1080P_MODEL_SUFFIX = "-1080p"
UPSCALE_1080P_VIDEO_MODELS = (
    "veo-3-1-1080p",
    "veo-omni-flash-1080p",
    "veo-omni-flash-video-edit-1080p",
)
UPSCALE_1080P_VIDEO_MODEL_SET = set(UPSCALE_1080P_VIDEO_MODELS)


def _split_upscale_1080p_model(model: str) -> tuple[str, bool]:
    """Split a `<base>-1080p` public model name into its base name plus the upscale flag."""

    raw = str(model or "").strip()
    if raw in UPSCALE_1080P_VIDEO_MODEL_SET:
        return raw[: -len(UPSCALE_1080P_MODEL_SUFFIX)], True
    return raw, False


def _public_model_name(payload: Dict[str, Any]) -> str:
    """Public model name to echo back: the exact name the caller requested."""

    p = payload or {}
    return str(p.get("public_model") or p.get("model") or "").strip()


def _normalize_video_task_payload(payload: Dict[str, Any], *, require_image_seconds_4: bool = True) -> tuple[str, Dict[str, Any]]:
    """Map OpenAI-compatible public video model names to internal task types."""

    payload = dict(payload or {})
    model = str(payload.get("model") or "").strip()
    # `<base>-1080p` 走与 `<base>` 完全相同的生成分支：这里先剥掉后缀，让下面所有
    # 按 model 精确匹配的判断（含执行器内部）保持原样，只额外打上超分标记。
    # public_model 保留调用方请求的原始名字，供响应回显 / 上游按模型计费对账。
    base_model, want_upscale_1080p = _split_upscale_1080p_model(model)
    if want_upscale_1080p:
        payload["public_model"] = model
        payload["model"] = base_model
        payload["upscale_1080p"] = True
        model = base_model
    if require_image_seconds_4:
        _require_video_image_seconds_4(payload, model)
    if model in {"seedance-2", "seedance-2-fast"}:
        task_type_code = "dreamina_workflow"
    elif model in {"nana-banana-2"}:
        task_type_code = "veo_workflow"
        payload["n_frames"] = "1"
        payload["duration"] = 1
        payload["image_model_name"] = "NARWHAL"
        raw_resolution = payload.get("resolution")
        if raw_resolution is None:
            raw_resolution = "1k"
        else:
            raw_resolution = raw_resolution.lower()
            if raw_resolution == "4k":
                raw_resolution = "1k"
        payload["resolution"] = raw_resolution
    elif model in {"nana-banana-pro"}:
        task_type_code = "veo_workflow"
        payload["n_frames"] = "1"
        payload["duration"] = 1
        payload["image_model_name"] = "GEM_PIX_2"
        raw_resolution = payload.get("resolution")
        if raw_resolution is None:
            raw_resolution = "1k"
        else:
            raw_resolution = raw_resolution.lower()
            if raw_resolution == "4k":
                raw_resolution = "1k"
        payload["resolution"] = raw_resolution
    elif model in {"nana-banana-2-4k"}:
        task_type_code = "veo_workflow"
        payload["n_frames"] = "1"
        payload["duration"] = 1
        payload["image_model_name"] = "NARWHAL"
        payload["resolution"] = "4k"
    elif model in {"nana-banana-pro-4k"}:
        task_type_code = "veo_workflow"
        payload["n_frames"] = "1"
        payload["duration"] = 1
        payload["image_model_name"] = "GEM_PIX_2"
        payload["resolution"] = "4k"
    elif model in {"veo-3-1"}:
        task_type_code = "veo_workflow"
        duration = payload.get("duration")
        if duration != 8:
            raise HTTPException(status_code=400, detail="veo-3-1 only supports duration=8")
        payload["n_frames"] = 240
        payload.pop("video_model", None)
        payload.pop("video_url", None)
    elif model in {"veo-omni-flash"}:
        task_type_code = "veo_workflow"
        duration = payload.get("duration")
        if duration != 10:
            raise HTTPException(status_code=400, detail="veo-omni-flash only supports duration=10")
        payload["n_frames"] = 300
        payload["video_model"] = "abra_t2v_10s"
        payload.pop("video_url", None)
    elif model in {"veo-omni-flash-video-edit"}:
        task_type_code = "veo_workflow"
        duration = payload.get("duration")
        if duration != 10:
            raise HTTPException(status_code=400, detail="veo-omni-flash only supports duration=10")
        payload["n_frames"] = 240
        payload["video_model"] = "abra_t2v_10s"
        payload["model"] = "veo-omni-flash"
    elif model in GPT_IMAGE2_VIDEO_MODELS:
        task_type_code = "gpt_workflow"
        duration = payload.get("duration")
        if duration is not None and duration != 1:
            raise HTTPException(status_code=400, detail=f"{model} only supports duration=1 (image generation mode)")
        resolution = GPT_IMAGE2_VIDEO_MODELS[model]
        aspect_ratio = str(payload.get("aspect_ratio") or payload.get("ratio") or "").strip()
        payload["duration"] = 1
        payload["workflow_kind"] = "image"
        payload["model"] = model
        payload["model_code"] = "gpt-image-2"
        payload["image_model_name"] = "gpt-image-2"
        payload["gpt_image2_model"] = model
        payload["resolution"] = resolution
        payload["size_tier"] = resolution.upper()
        if aspect_ratio and not str(payload.get("ratio") or "").strip():
            payload["ratio"] = aspect_ratio
        if (payload.get("images") or payload.get("image") or payload.get("image_url")) and not payload.get("operation"):
            payload["operation"] = "edit"
    else:
        raise HTTPException(status_code=400, detail=f"model name is required!!")
    return task_type_code, payload


def _build_openai_chat_completion(model: str, content: str) -> Dict[str, Any]:
    now = int(time.time())
    return {
        "id": f"chatcmpl-fpbrowser2api-{now}",
        "object": "chat.completion",
        "created": now,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 1,
            "completion_tokens": 1,
            "total_tokens": 2,
        },
    }


def _timestamp_ms(value: Any = None) -> int:
    """Return a NewAPI/OpenAI-compatible millisecond timestamp."""

    if value is None:
        return int(time.time() * 1000)
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc)
        return int(dt.timestamp() * 1000)
    if isinstance(value, (int, float)):
        # 13-digit values are already milliseconds; 10-digit values are seconds.
        fv = float(value)
        return int(fv if fv > 10_000_000_000 else fv * 1000)
    raw = str(value or "").strip()
    if raw:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00").replace(" ", "T", 1))
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc)
            return int(dt.timestamp() * 1000)
        except Exception:
            pass
    return int(time.time() * 1000)


def _normalize_newapi_task_status(status: Any) -> str:
    s = str(status or "").strip().lower()
    # NewAPI/中转站实现对异步任务状态的解析不完全一致：
    # - 有的认 OpenAI-ish 的 in_progress
    # - 有的认 Midjourney/通用异步任务的 processing
    # 对外优先使用更常见的 processing，避免上游只在 processing/completed/failed
    # 分支里更新任务状态。
    if s in {"running", "in_progress", "processing"}:
        return "processing"
    if s in {"queued", "completed", "failed"}:
        return s
    return s or "queued"


def _parse_task_prompt_payload(prompt_text: Any) -> Dict[str, Any]:
    raw = str(prompt_text or "").strip()
    if not raw or not raw.startswith("{"):
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _maybe_number(v: Any) -> Any:
    if v is None:
        return None
    try:
        fv = float(v)
        iv = int(fv)
        return iv if fv == iv else fv
    except Exception:
        return v


def _public_aspect_ratio(payload: Dict[str, Any]) -> Optional[str]:
    for key in ("aspect_ratio", "ratio", "size_ratio", "image_aspect_ratio"):
        val = payload.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return None


def _public_duration(payload: Dict[str, Any]) -> Any:
    for key in ("duration", "seconds"):
        val = payload.get(key)
        if val is not None and str(val).strip():
            return _maybe_number(val)
    return None


def _build_newapi_video_create_response(task_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Build NewAPI-compatible response for POST /v1/videos."""

    p = dict(payload or {})
    model = _public_model_name(p)
    duration = 4 if model in OPENAI_COMPAT_IMAGE_MODEL_SET else _public_duration(p)
    aspect_ratio = _public_aspect_ratio(p)
    resp: Dict[str, Any] = {
        "id": task_id,
        "task_id": task_id,
        "object": "video",
        "created_at": _timestamp_ms(),
        "status": "queued",
        "progress": 0,
        "model": model,
        "video_url": None,
        "metadata": {"result_urls": []},
    }
    if duration is not None:
        resp["seconds"] = str(duration)
        resp["duration"] = duration
    if aspect_ratio:
        resp["aspect_ratio"] = aspect_ratio
    prompt = str(p.get("prompt") or "").strip()
    if prompt:
        resp["prompt"] = prompt
    return resp


def _extract_public_result_urls(result: Any) -> tuple[Optional[str], Optional[str], list[str]]:
    if not isinstance(result, dict):
        return None, None, []

    result_urls: list[str] = []

    def add_url(value: Any) -> None:
        if isinstance(value, str):
            u = value.strip()
            if u and u not in result_urls:
                result_urls.append(u)
        elif isinstance(value, dict):
            add_url(value.get("url") or value.get("image_url") or value.get("video_url"))

    for key in ("urls", "result_urls"):
        raw = result.get(key)
        if isinstance(raw, list):
            for item in raw:
                add_url(item)
    raw_assets = result.get("assets") or result.get("data")
    if isinstance(raw_assets, list):
        for item in raw_assets:
            add_url(item)
    for key in ("share_url", "video_url", "image_url", "url"):
        add_url(result.get(key))

    if not result_urls:
        return None, None, []
    share_url = result_urls[0]
    kind = str(result.get("workflow_kind") or result.get("type") or "").strip().lower()
    is_image = "image" in kind and "video" not in kind
    if is_image:
        return None, share_url, result_urls
    return share_url, None, result_urls


def _extract_openai_image_data(result: Any, response_format: Any) -> List[Dict[str, Any]]:
    if not isinstance(result, dict):
        return []

    fmt = str(response_format or "url").strip().lower()
    data: List[Dict[str, Any]] = []

    raw_data = result.get("data")
    if isinstance(raw_data, list):
        for item in raw_data:
            if not isinstance(item, dict):
                continue
            entry: Dict[str, Any] = {}
            b64 = str(item.get("b64_json") or item.get("base64") or "").strip()
            url = str(item.get("url") or item.get("image_url") or item.get("video_url") or "").strip()
            if fmt == "b64_json" and b64:
                entry["b64_json"] = b64
            elif url:
                entry["url"] = url
            elif b64:
                entry["b64_json"] = b64
            revised = str(item.get("revised_prompt") or "").strip()
            if revised:
                entry["revised_prompt"] = revised
            if entry:
                data.append(entry)

    if not data:
        b64 = str(result.get("b64_json") or result.get("base64") or "").strip()
        if fmt == "b64_json" and b64:
            data.append({"b64_json": b64})

    if not data:
        _video_url, image_url, result_urls = _extract_public_result_urls(result)
        for url in result_urls or ([image_url] if image_url else []):
            if url:
                data.append({"url": url})

    revised_prompt = str(result.get("revised_prompt") or "").strip()
    if revised_prompt:
        for entry in data:
            entry.setdefault("revised_prompt", revised_prompt)
    return data


def _build_openai_image_generation_response(task: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    data = _extract_openai_image_data(task.result if isinstance(task.result, dict) else None, payload.get("response_format"))
    if not data:
        raise HTTPException(status_code=502, detail="image generation completed without image data")
    return {
        "created": int(_timestamp_ms(getattr(task, "completed_at", None) or getattr(task, "created_at", None)) / 1000),
        "data": data,
    }


async def _wait_for_task_final(task_id: str, timeout_sec: float, poll_interval_sec: float) -> Any:
    if not db:
        raise HTTPException(status_code=500, detail="db not initialized")

    deadline = time.monotonic() + timeout_sec
    last_task = None
    while True:
        task = await db.get_task(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        last_task = task
        status = _normalize_newapi_task_status(task.status)
        if status == "completed":
            return task
        if status == "failed":
            result = task.result if isinstance(task.result, dict) else {}
            raise HTTPException(
                status_code=int(result.get("status_code") or 500),
                detail={
                    "message": task.error_message or "image generation failed",
                    "code": str(result.get("error_type") or "task_failed"),
                },
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HTTPException(
                status_code=504,
                detail={
                    "message": "image generation timed out",
                    "code": "task_timeout",
                    "task_id": getattr(last_task, "task_id", task_id),
                },
            )
        await asyncio.sleep(min(poll_interval_sec, remaining))


async def _get_newapi_video_status_response(task_id: str) -> JSONResponse:
    """NewAPI-compatible status response for GET /v1/videos/{task_id}."""

    if not db:
        raise HTTPException(status_code=500, detail="db not initialized")
    tid = (task_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="task_id 不能为空")

    task = await db.get_task(tid)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")


    payload = _parse_task_prompt_payload(getattr(task, "prompt", None))
    result = task.result if isinstance(task.result, dict) else None
    status = _normalize_newapi_task_status(task.status)
    video_url, image_url, result_urls = _extract_public_result_urls(result)
    original_watermarked_video_url = str((result or {}).get("original_watermarked_video_url") or "").strip() or None
    model = _public_model_name(payload) or str((result or {}).get("model") or "").strip()
    duration = 4 if model in OPENAI_COMPAT_IMAGE_MODEL_SET else _public_duration(payload)
    aspect_ratio = _public_aspect_ratio(payload)

    resp: Dict[str, Any] = {
        "id": task.task_id,
        "task_id": task.task_id,
        "object": "video",
        "created_at": _timestamp_ms(task.created_at),
        "status": status,
        # 兼容部分中转站/面板只读取 state 或 task_status 的实现。
        "state": status,
        "task_status": status,
        "progress": int(task.progress or 0),
        "model": model,
        "video_url": video_url,
        "original_watermarked_video_url": original_watermarked_video_url,
        "metadata": {
            "result_urls": result_urls,
            "original_watermarked_video_url": original_watermarked_video_url,
        },
        # 冗余标志，便于中转站判断是否终态。
        "success": status == "completed",
        "final": status in {"completed", "failed"},
    }

    
    if image_url:
        resp["image_url"] = image_url
    if video_url or image_url:
        resp["url"] = video_url or image_url
    if duration is not None:
        resp["seconds"] = str(duration)
        resp["duration"] = duration
    if aspect_ratio:
        resp["aspect_ratio"] = aspect_ratio
    if task.completed_at:
        resp["completed_at"] = _timestamp_ms(task.completed_at)
    if status == "failed":
        resp["error"] = {
            "message": task.error_message or "task failed",
            # code 使用字符串，避免上游 JSON 结构体按 string 解析失败或忽略。
            "code": str((result or {}).get("status_code") or (result or {}).get("error_type") or "task_failed"),
        }

    return JSONResponse(content=resp)


async def _get_public_runtime_limits_cached() -> tuple[bool, int, int]:
    if not db:
        return False, DEFAULT_PUBLIC_CREATE_TASK_MAX_INFLIGHT, DEFAULT_SERVER_COUNT
    now = time.monotonic()
    global _system_config_cache
    expire_at, cached_flag, cached_inflight, cached_sc = _system_config_cache
    if now < expire_at and cached_flag is not None and cached_inflight is not None and cached_sc is not None:
        return bool(cached_flag), int(cached_inflight), int(cached_sc)
    syscfg = await db.get_system_config()
    flag = bool(getattr(syscfg, "stop_accepting_tasks", False))
    inflight = normalize_public_create_task_max_inflight(getattr(syscfg, "public_create_task_max_inflight", None))
    sc = normalize_server_count(getattr(syscfg, "server_count", None))
    _system_config_cache = (now + _SYSTEM_CONFIG_TTL_SEC, flag, inflight, sc)
    return flag, inflight, sc


async def _ensure_create_task_gate_by_db_config() -> tuple[asyncio.Semaphore, bool]:
    """Apply cached DB limits to runtime gate and scheduler pool."""
    if not task_service:
        raise RuntimeError("task_service not initialized")
    stop_accepting, inflight, server_count = await _get_public_runtime_limits_cached()
    async with _create_task_gate_lock:
        global _CREATE_TASK_MAX_INFLIGHT, _SERVER_COUNT, _create_task_semaphore
        if _create_task_semaphore is None or inflight != _CREATE_TASK_MAX_INFLIGHT or server_count != _SERVER_COUNT:
            _CREATE_TASK_MAX_INFLIGHT = inflight
            _SERVER_COUNT = server_count
            _create_task_semaphore = asyncio.Semaphore(_CREATE_TASK_MAX_INFLIGHT)
            task_service.set_browser_pool_limit(calc_public_browser_pool_limit(_CREATE_TASK_MAX_INFLIGHT, _SERVER_COUNT))
    if _create_task_semaphore is None:
        raise RuntimeError("create task gate not initialized")
    return _create_task_semaphore, stop_accepting


async def _get_task_type_by_code_cached(task_type_code: str):
    if not db:
        return None
    tcode = (task_type_code or "").strip()
    if not tcode:
        return None
    now = time.monotonic()
    row = _task_type_cache.get(tcode)
    if row and now < row[0]:
        return row[1]
    task_type = await db.get_task_type_by_code(tcode)
    _task_type_cache[tcode] = (now + _TASK_TYPE_TTL_SEC, task_type)
    return task_type


async def _get_cached_task_status_payload(task_id: str) -> Optional[Dict[str, Any]]:
    now = time.monotonic()
    async with _status_lock:
        row = _status_cache.get(task_id)
        if not row:
            return None
        expire_at, payload = row
        if now >= expire_at:
            _status_cache.pop(task_id, None)
            return None
        return payload


async def _set_task_status_cache(task_id: str, payload: Dict[str, Any]) -> None:
    status = str(payload.get("status") or "").lower()
    ttl = _STATUS_CACHE_TTL_FINAL_SEC if status in {"completed", "failed"} else _STATUS_CACHE_TTL_PENDING_SEC
    async with _status_lock:
        _status_cache[task_id] = (time.monotonic() + ttl, payload)


async def _create_task_from_request(body: CreateTaskRequest) -> Dict[str, Any]:
    """Shared task creation implementation for /v1/tasks and compatible APIs.

    Authentication is intentionally kept on the route handlers to avoid
    duplicate Depends execution when one public endpoint adapts into this
    helper.
    """
    if not db or not task_service:
        raise HTTPException(status_code=500, detail="service not initialized")

    acquired = False
    gate: asyncio.Semaphore | None = None
    try:
        try:
            gate, stop_accepting = await _ensure_create_task_gate_by_db_config()
        except Exception:
            gate = _create_task_semaphore
            stop_accepting = False
        if gate is None:
            raise HTTPException(status_code=500, detail="service not initialized")

        try:
            await asyncio.wait_for(gate.acquire(), timeout=_CREATE_TASK_ACQUIRE_TIMEOUT_SEC)
            acquired = True
        except asyncio.TimeoutError:
            raise HTTPException(status_code=429, detail="请求过于繁忙，请稍后重试")

        # 系统维护：停止接收新任务
        if stop_accepting:
            raise HTTPException(status_code=503, detail="服务器稳定性&每日容量升级10分钟，请10分钟后再试...")

        tcode = (body.task_type_code or "").strip()
        payload = body.json or {}
        task_type = await _get_task_type_by_code_cached(tcode)
        if not task_type or task_type.deleted or not task_type.enabled:
            raise ValueError("task_type_code 不存在或未启用")

        try:
            handler = get_create_task_handler(task_type.create_task_handler)
        except KeyError as e:
            raise ValueError(str(e))
        tid = await handler(
            CreateTaskContext(
                task_type=task_type,
                payload=payload,
                mapping_id=body.mapping_id,
                window_pk=body.window_pk,
                db=db,
                task_service=task_service,
            )
        )
        await _set_task_status_cache(
            tid,
            TaskStatusResponse(
                task_id=tid,
                status="queued",
                progress=0,
                result=None,
                error_message=None,
            ).model_dump(),
        )
        return {"success": True, "task_id": tid}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if acquired and gate is not None:
            gate.release()


async def _get_task_status_response(task_id: str) -> JSONResponse:
    if not db:
        raise HTTPException(status_code=500, detail="db not initialized")
    tid = (task_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="task_id 不能为空")

    cached = await _get_cached_task_status_payload(tid)
    if cached is not None:
        return JSONResponse(content=cached)

    # 单飞：同一 task_id 的并发查询仅触发一次 DB 读取。
    leader = False
    async with _status_lock:
        fut = _status_inflight.get(tid)
        if fut is None:
            fut = asyncio.get_running_loop().create_future()
            _status_inflight[tid] = fut
            leader = True

    if not leader:
        payload = await fut
        if payload is None:
            raise HTTPException(status_code=404, detail="task not found")
        return JSONResponse(content=payload)

    payload: Optional[Dict[str, Any]] = None
    try:
        task = await db.get_task(tid)
        if task:
            payload = TaskStatusResponse(
                task_id=task.task_id,
                status=task.status,
                progress=int(task.progress or 0),
                result=task.result,
                error_message=task.error_message,
                content_violation=int(task.content_violation or 0),
            ).model_dump()
            await _set_task_status_cache(tid, payload)
        fut.set_result(payload)
    except Exception as e:
        fut.set_exception(e)
        raise
    finally:
        async with _status_lock:
            if _status_inflight.get(tid) is fut:
                _status_inflight.pop(tid, None)

    if payload is None:
        raise HTTPException(status_code=404, detail="task not found")
    return JSONResponse(content=payload)


@router.get("/v1/task-types")
async def list_task_types(api_key: str = Depends(verify_api_key_header)):
    if not db:
        raise HTTPException(status_code=500, detail="db not initialized")
    items = await db.list_task_types()
    return {"success": True, "task_types": [t.model_dump() for t in items]}

@router.get("/v1/task-types-public")
async def list_task_types(api_key: str = Depends(verify_api_key_header)):
    if not db:
        raise HTTPException(status_code=500, detail="db not initialized")
    items = await db.list_task_types_public()
    return {"success": True, "task_types": [t.model_dump() for t in items]}


@router.post("/v1/tasks")
async def create_task(
    api_key: str = Depends(verify_api_key_header),
    body: CreateTaskRequest = Body(...),
):
    return await _create_task_from_request(body)


@router.get("/v1/models")
async def list_openai_compatible_models(api_key: str = Depends(verify_api_key_header)):
    """OpenAI-compatible model list, mainly for NewAPI channel discovery/test."""

    now = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": model,
                "object": "model",
                "created": now,
                "owned_by": "fpbrowser2api",
            }
            for model in (*OPENAI_COMPAT_VIDEO_MODELS, *OPENAI_COMPAT_SYNC_IMAGE_MODELS, *OPENAI_COMPAT_NOOP_MODELS)
        ],
    }


@router.get("/v1/models/{model_id}")
async def get_openai_compatible_model(model_id: str, api_key: str = Depends(verify_api_key_header)):
    """OpenAI-compatible single model lookup."""

    model = (model_id or "").strip()
    if model not in OPENAI_COMPAT_MODEL_SET:
        raise HTTPException(status_code=404, detail="model not found")
    return {
        "id": model,
        "object": "model",
        "created": int(time.time()),
        "owned_by": "fpbrowser2api",
    }


@router.post("/v1/chat/completions")
async def create_chat_completion_for_newapi_test(
    api_key: str = Depends(verify_api_key_header),
    body: Dict[str, Any] = Body(...),
):
    """Minimal OpenAI chat-compatible endpoint for NewAPI channel tests/charging.

    NewAPI's OpenAI-channel "test" button probes `/v1/chat/completions`.
    The real video creation endpoint is `/v1/videos`; this endpoint only
    returns a lightweight success response.

    Special model:
    - `fpbrowser-use`: no-op charging model for NewAPI. It does not create any
      real task; NewAPI can configure this model as fixed-price / per-call so
      every successful request deducts quota.
    """

    model = str((body or {}).get("model") or "").strip()
    if model == "fpbrowser-use":
        return _build_openai_chat_completion(model, "ok")

    if model not in OPENAI_COMPAT_VIDEO_MODEL_SET:
        raise HTTPException(
            status_code=400,
            detail=f"model {model or '<empty>'} is not supported by chat test endpoint",
        )
    return _build_openai_chat_completion(
        model,
        f"fpbrowser2api channel test ok for {model}; use POST /v1/videos to create video tasks.",
    )


@router.post("/v1/videos")
async def create_video(
    api_key: str = Depends(verify_api_key_header),
    body: CreateVideoRequest = Body(...),
):
    task_type_code, payload = _normalize_video_task_payload(body.model_dump(exclude_none=True))
    created = await _create_task_from_request(
        CreateTaskRequest(
            task_type_code=task_type_code,
            json=payload,
        )
    )
    task_id = str(created.get("task_id") or "").strip()
    if not task_id:
        return created
    return _build_newapi_video_create_response(task_id, payload)


@router.post("/v1/images/generations")
async def create_image_generation(
    api_key: str = Depends(verify_api_key_header),
    body: CreateImageGenerationRequest = Body(...),
):
    task_type_code, payload = _normalize_image_generation_task_payload(body.model_dump(exclude_none=True))
    created = await _create_task_from_request(
        CreateTaskRequest(
            task_type_code=task_type_code,
            json=payload,
        )
    )
    task_id = str(created.get("task_id") or "").strip()
    if not task_id:
        return created
    task = await _wait_for_task_final(
        task_id,
        timeout_sec=_IMAGE_GENERATION_SYNC_TIMEOUT_SEC,
        poll_interval_sec=_IMAGE_GENERATION_SYNC_POLL_INTERVAL_SEC,
    )
    return _build_openai_image_generation_response(task, payload)


@router.get("/v1/tasks/{task_id}")
async def get_task_status(task_id: str, api_key: str = Depends(verify_api_key_header)):
    return await _get_task_status_response(task_id)


@router.get("/v1/videos/{task_id}")
async def get_video_status(task_id: str, api_key: str = Depends(verify_api_key_header)):
    return await _get_newapi_video_status_response(task_id)
