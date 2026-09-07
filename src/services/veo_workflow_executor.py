"""VEO 视频生成工作流执行器。

职责边界：
- `playwright_broswer_context.py`：通用"指纹浏览器自动化层"（开窗/连CDP/挑页/page内fetch）
- `veo_workflow_executor.py`：VEO 站点侧逻辑（打开页面、提交生成任务、轮询进度、获取结果）

入口：
- `veo_workflow`（由 `task_service.py` 发起调用）
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import hashlib
import io
import json
import mimetypes
import os
import random
import shutil
import subprocess
import tempfile
import struct
from math import gcd
import re
import socket
import ssl
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse, urlunparse

import httpx
from ..core.config import config as app_config
from ..core.database import Database
from ..core.logger import logger
from ..core.paths import MONITOR_LOG_FILE, STATIC_DIR
from .playwright_broswer_context import (
    PlaywrightBrowserContext,
    acquire_browser_open_slot,
    append_log,
    get_or_create_ctx as get_or_create_playwright_ctx,
    page_fetch_json,
    safe_trim,
)
from .sora_task_executor import (
    _pick_n_frames,
)
from .r2_uploader import build_veo_upsample_object_key, r2_config_from_setting_section, upload_bytes_to_r2
from .task_executor_types import NonPenalizedTaskError, ProgressCB
from .browser_extension_bridge import should_use_extension_executor
from .browser_extension_interaction import (
    ensure_extension_connected_via_window,
    submit_extension_task,
    wait_extension_client,
)
from .postprocess_dispatch import round_robin_order


async def _noop_progress_cb(progress: int, data: Dict[str, Any]) -> None:
    return None


def _veo_rewrite_flow_content_url(value: str) -> str:
    raw = str(value or "")
    if not raw:
        return raw
    try:
        parsed = urlparse(raw)
    except Exception:
        return raw
    if (parsed.hostname or "").lower() != "flow-content.google":
        return raw
    netloc = "aoss.aimh8.com"
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def _veo_rewrite_flow_content_urls(value: Any) -> Any:
    if isinstance(value, str):
        return _veo_rewrite_flow_content_url(value)
    if isinstance(value, list):
        return [_veo_rewrite_flow_content_urls(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_veo_rewrite_flow_content_urls(item) for item in value)
    if isinstance(value, dict):
        return {key: _veo_rewrite_flow_content_urls(item) for key, item in value.items()}
    return value


def _veo_int_env(name: str, default: int, *, min_value: int, max_value: int) -> int:
    raw = os.getenv(name, "").strip()
    try:
        val = int(raw) if raw else int(default)
    except Exception:
        val = int(default)
    return max(min_value, min(max_value, val))


def _veo_float_env(name: str, default: float, *, min_value: float, max_value: float) -> float:
    raw = os.getenv(name, "").strip()
    try:
        val = float(raw) if raw else float(default)
    except Exception:
        val = float(default)
    return max(min_value, min(max_value, val))


def _veo_env_enabled(name: str, default: bool = True) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return bool(default)
    return raw not in {"0", "false", "no", "off", "disable", "disabled"}


_VEO_LOCAL_IMAGE_CACHE_SUBDIR = "veo_image_cache"
_VEO_LOCAL_IMAGE_CACHE_DIR = STATIC_DIR / "assets" / _VEO_LOCAL_IMAGE_CACHE_SUBDIR
_VEO_LOCAL_IMAGE_DOWNLOAD_SEMAPHORE = asyncio.Semaphore(
    _veo_int_env("VEO_LOCAL_IMAGE_DOWNLOAD_CONCURRENCY", 100, min_value=1, max_value=64)
)
_VEO_LOCAL_IMAGE_LOCKS: Dict[str, asyncio.Lock] = {}
_VEO_LOCAL_IMAGE_LOCKS_GUARD = asyncio.Lock()
_VEO_LOCAL_IMAGE_LAST_CLEANUP = 0.0
_VEO_OMNI_T2V_MODEL="abra_t2v_10s"
_VEO_OMNI_R2V_MODEL="abra_r2v_10s"
_VEO_OMNI_VEDIT_MODEL ="abra_edit"

def _veo_local_image_cache_ttl_seconds() -> float:
    return _veo_float_env("VEO_LOCAL_IMAGE_CACHE_TTL_SECONDS", 1 * 3600, min_value=0.0, max_value=30 * 86400)


def _veo_local_image_cache_max_bytes() -> int:
    return _veo_int_env("VEO_LOCAL_IMAGE_CACHE_MAX_BYTES", 20 * 1024 * 1024 * 1024, min_value=256 * 1024 * 1024, max_value=500 * 1024 * 1024 * 1024)


def _veo_local_image_max_bytes() -> int:
    return _veo_int_env("VEO_LOCAL_IMAGE_MAX_BYTES", 20 * 1024 * 1024, min_value=1 * 1024 * 1024, max_value=1024 * 1024 * 1024)


def _veo_local_video_max_bytes() -> int:
    return _veo_int_env("VEO_LOCAL_VIDEO_MAX_BYTES", 100 * 1024 * 1024, min_value=1 * 1024 * 1024, max_value=100 * 1024 * 1024)


def _veo_local_image_min_download_bps() -> float:
    """输入图本地化下载最低平均速度；<=0 表示不做慢速检测。"""
    return _veo_float_env("VEO_LOCAL_IMAGE_MIN_DOWNLOAD_BPS", 16 * 1024, min_value=0.0, max_value=1024 * 1024 * 1024)


def _veo_local_video_min_download_bps() -> float:
    """输入视频本地化下载最低平均速度；<=0 表示不做慢速检测。"""
    return _veo_float_env("VEO_LOCAL_VIDEO_MIN_DOWNLOAD_BPS", 16 * 1024, min_value=0.0, max_value=1024 * 1024 * 1024)


def _veo_local_download_speed_grace_seconds(kind: str) -> float:
    is_video = str(kind or "").lower() == "video"
    return _veo_float_env(
        "VEO_LOCAL_VIDEO_DOWNLOAD_SPEED_GRACE_SECONDS" if is_video else "VEO_LOCAL_IMAGE_DOWNLOAD_SPEED_GRACE_SECONDS",
        15.0 if is_video else 10.0,
        min_value=1.0,
        max_value=600.0,
    )


def _veo_raise_if_local_download_too_slow(
    *,
    kind: str,
    total: int,
    started_at: float,
    source_url: str,
) -> None:
    """按下载开始后的平均速度识别“持续很慢”的输入素材下载。"""
    is_video = str(kind or "").lower() == "video"
    min_bps = _veo_local_video_min_download_bps() if is_video else _veo_local_image_min_download_bps()
    if min_bps <= 0:
        return
    elapsed = max(0.0, time.monotonic() - float(started_at or 0.0))
    grace = _veo_local_download_speed_grace_seconds("video" if is_video else "image")
    if elapsed < grace:
        return
    avg_bps = float(total or 0) / max(elapsed, 0.001)
    if avg_bps < min_bps:
        label = "视频" if is_video else "图片"
        raise NonPenalizedTaskError(
            f"VEO 输入{label}本地下载过慢：avg_speed={avg_bps:.0f} B/s < min_speed={min_bps:.0f} B/s; "
            f"elapsed={elapsed:.1f}s; downloaded={int(total or 0)} bytes; url={safe_trim(source_url, 500)}",
            status_code=408,
            content_violation=True,
        )


def _veo_local_download_headers(kind: str, source_url: str) -> Dict[str, str]:
    """Headers for downloading user supplied media into the local VEO cache.

    Some public image CDNs (notably Wikimedia) reject malformed/generic bot-like
    user agents.  Use a normal browser UA by default, while still allowing ops to
    set a policy-compliant UA with contact information via environment variables.
    """
    is_video = str(kind or "").lower() == "video"
    default_ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
    )
    host = (urlparse(source_url).hostname or "").lower()
    is_wikimedia = host == "wikimedia.org" or host.endswith(".wikimedia.org")
    # Wikimedia 的 robot policy 拦截比较敏感；生产环境里如果配置了较短/像 bot 的 UA，
    # 仍可能被 403。对 Wikimedia 默认强制使用完整浏览器 UA；只有显式
    # VEO_LOCAL_WIKIMEDIA_USER_AGENT 才覆盖。
    if is_wikimedia:
        ua = os.getenv("VEO_LOCAL_WIKIMEDIA_USER_AGENT", "").strip() or default_ua
    else:
        ua = (
            os.getenv("VEO_LOCAL_VIDEO_USER_AGENT" if is_video else "VEO_LOCAL_IMAGE_USER_AGENT", "").strip()
            or os.getenv("VEO_LOCAL_DOWNLOAD_USER_AGENT", "").strip()
            or default_ua
        )
    headers = {
        "Accept": "video/*,application/octet-stream,*/*;q=0.8"
        if is_video
        else "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": ua,
    }
    referer = os.getenv("VEO_LOCAL_DOWNLOAD_REFERER", "").strip()
    if not referer and is_wikimedia:
        referer = "https://commons.wikimedia.org/"
    if referer:
        headers["Referer"] = referer
    if is_wikimedia:
        headers.setdefault("Accept-Language", "en-US,en;q=0.9")
    return headers


def _veo_ipv4_httpx_transport() -> httpx.AsyncHTTPTransport:
    """Use an IPv4 source socket for VEO media downloads.

    R2/Cloudflare IPv6 paths can intermittently stall while the IPv4 path is
    healthy. Binding the transport avoids relying on system address ordering
    (which is only a preference and can still allow IPv6 selection).
    """
    return httpx.AsyncHTTPTransport(local_address="0.0.0.0")


def _veo_payload_flag_is_false(v: Any) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return not v
    if isinstance(v, (int, float)):
        return v == 0
    return str(v or "").strip().lower() in {"0", "false", "no", "off", "disable", "disabled"}


def _veo_extension_local_image_cache_enabled(payload: Dict[str, Any]) -> bool:
    """插件模式输入图本地化开关，默认开启。

    背景：指纹浏览器经海外代理访问国内图片经常 `Failed to fetch`。Python 服务端先
    直连下载到 `/assets/veo_image_cache/`，插件再从配置的 base_url 读取本机白名单
    地址，避免图片下载走指纹浏览器代理。
    """
    if not _veo_env_enabled("VEO_LOCAL_IMAGE_CACHE_ENABLED", True):
        return False
    payload = payload or {}
    for key in (
        "localize_extension_images",
        "veo_localize_extension_images",
        "local_image_cache",
        "veo_local_image_cache",
    ):
        if key in payload and _veo_payload_flag_is_false(payload.get(key)):
            return False
    return True


def _veo_extension_http_base_url() -> str:
    """返回插件可访问的 HTTP(S) 服务根地址，来自 setting.toml 的 extension_executor.base_url。"""
    raw = str(getattr(app_config, "extension_launcher_url", "") or "").strip()
    if raw:
        p = urlparse(raw)
        if p.scheme in {"http", "https"} and p.netloc:
            return raw.rstrip("/")
    base_url = str((app_config.get_raw_config() or {}).get("extension_executor", {}).get("base_url") or "").strip()
    if not base_url:
        raise NonPenalizedTaskError(
            "VEO 输入图本地化失败：config/setting.toml [extension_executor].base_url 为空，无法生成插件可访问的本机图片 URL",
            status_code=500,
        )
    if not re.match(r"^https?://", base_url, flags=re.I):
        base_url = f"http://{base_url}"
    p = urlparse(base_url)
    if p.scheme not in {"http", "https"} or not p.netloc:
        raise NonPenalizedTaskError(
            f"VEO 输入图本地化失败：[extension_executor].base_url 无效：{base_url!r}",
            status_code=500,
        )
    return base_url.rstrip("/")


def _veo_local_asset_url(path: Path) -> str:
    return f"{_veo_extension_http_base_url()}/assets/{_VEO_LOCAL_IMAGE_CACHE_SUBDIR}/{quote(path.name)}"


def _veo_is_local_asset_url(raw: str) -> bool:
    try:
        u = urlparse(str(raw or "").strip())
        return u.path.startswith(f"/assets/{_VEO_LOCAL_IMAGE_CACHE_SUBDIR}/")
    except Exception:
        return False


def _veo_is_base64_media_value(raw: Any) -> bool:
    s = str(raw or "").strip()
    if not s:
        return False
    if re.match(r"^data:(image|video)/[a-zA-Z0-9.+-]+;base64,", s, flags=re.S):
        return True
    if s.lower().startswith("data:") and ";base64," in s[:128].lower():
        return True
    if len(s) < 256 or re.match(r"^https?://", s, flags=re.I):
        return False
    compact = re.sub(r"\s+", "", s)
    if len(compact) < 256 or len(compact) % 4 != 0:
        return False
    if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", compact):
        return False
    try:
        return bool(base64.b64decode(compact[:4096], validate=True))
    except Exception:
        return False


def _veo_local_asset_path_from_url(raw: str) -> Optional[Path]:
    """把 `/assets/veo_image_cache/<name>` 的本地化 URL 还原为缓存文件路径。"""
    try:
        u = urlparse(str(raw or "").strip())
        prefix = f"/assets/{_VEO_LOCAL_IMAGE_CACHE_SUBDIR}/"
        if not u.path.startswith(prefix):
            return None
        name = unquote(u.path[len(prefix) :]).strip()
        if not name or "/" in name or "\\" in name:
            return None
        p = (_VEO_LOCAL_IMAGE_CACHE_DIR / name).resolve()
        base = _VEO_LOCAL_IMAGE_CACHE_DIR.resolve()
        if base not in p.parents and p != base:
            return None
        return p if p.exists() else None
    except Exception:
        return None


def _veo_parse_ffprobe_rate(raw: Any) -> float:
    s = str(raw or "").strip()
    if not s or s in {"0/0", "N/A"}:
        return 0.0
    try:
        if "/" in s:
            a, b = s.split("/", 1)
            den = float(b)
            return (float(a) / den) if den else 0.0
        return float(s)
    except Exception:
        return 0.0


async def _veo_probe_local_video_metadata(path: Path) -> Dict[str, Any]:
    """用 ffprobe 读取本地参考视频元数据；只读本地缓存文件，通常几十毫秒，快于浏览器解码抽帧。"""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return {}

    def _run() -> Dict[str, Any]:
        cp = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=avg_frame_rate,r_frame_rate,nb_frames,duration:format=duration",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if cp.returncode != 0:
            return {}
        try:
            info = json.loads(cp.stdout or "{}")
        except Exception:
            return {}
        stream = (info.get("streams") or [{}])[0] or {}
        fmt = info.get("format") or {}
        duration = 0.0
        for v in (stream.get("duration"), fmt.get("duration")):
            try:
                duration = float(v)
                if duration > 0:
                    break
            except Exception:
                pass
        fps = _veo_parse_ffprobe_rate(stream.get("avg_frame_rate")) or _veo_parse_ffprobe_rate(stream.get("r_frame_rate"))
        frame_count = 0
        try:
            frame_count = int(float(stream.get("nb_frames") or 0))
        except Exception:
            frame_count = 0
        if frame_count <= 0 and duration > 0 and fps > 0:
            frame_count = int(round(duration * fps))
        out: Dict[str, Any] = {"duration_seconds": duration, "fps": fps, "frame_count": frame_count}
        if frame_count > 0:
            if frame_count > 241:
                frame_count = 241
            # VEO 的 videoInput 使用 0 起始 frame index，因此结束帧取最后一帧下标。
            out["end_frame_index"] = max(0, frame_count - 1)
        return out

    try:
        return await asyncio.to_thread(_run)
    except Exception:
        return {}


def _veo_assert_reference_video_duration(meta: Dict[str, Any], *, source: str) -> None:
    try:
        duration = float(meta.get("duration_seconds") or meta.get("duration") or 0)
    except Exception:
        duration = 0.0
    if duration > 30.0 + 1e-3:
        raise NonPenalizedTaskError(
            f"VEO 参考视频时长不能超过30秒，当前约 {duration:.3f} 秒，违规：{safe_trim(source, 300)}",
            status_code=400,
            content_violation=True,
        )


def _veo_image_ext_from_mime_or_url(content_type: str = "", source_url: str = "") -> str:
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    fixed = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
        "image/tiff": ".tiff",
        "image/avif": ".avif",
    }
    if ct in fixed:
        return fixed[ct]
    guessed = mimetypes.guess_extension(ct) if ct else ""
    if guessed:
        return ".jpg" if guessed in {".jpe", ".jpeg"} else guessed
    try:
        suffix = Path(urlparse(source_url or "").path).suffix.lower()
        if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}:
            return ".jpg" if suffix == ".jpeg" else suffix
    except Exception:
        pass
    return ".jpg"


def _veo_video_ext_from_mime_or_url(content_type: str = "", source_url: str = "") -> str:
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    fixed = {
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm",
        "video/x-matroska": ".mkv",
        "video/ogg": ".ogv",
        "video/x-msvideo": ".avi",
    }
    if ct in fixed:
        return fixed[ct]
    guessed = mimetypes.guess_extension(ct) if ct else ""
    if guessed:
        return ".mov" if guessed == ".qt" else guessed
    try:
        suffix = Path(urlparse(source_url or "").path).suffix.lower()
        if suffix in {".mp4", ".mov", ".webm", ".mkv", ".ogv", ".avi", ".m4v"}:
            return suffix
    except Exception:
        pass
    return ".mp4"


def _veo_sniff_image_mime(data: bytes) -> str:
    """根据常见图片 magic bytes 粗略识别下载结果，防止把 HTML/错误页当图片缓存。"""
    b = bytes(data or b"")[:64]
    if b.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if b.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if b.startswith(b"GIF87a") or b.startswith(b"GIF89a"):
        return "image/gif"
    if b.startswith(b"RIFF") and len(b) >= 12 and b[8:12] == b"WEBP":
        return "image/webp"
    if b.startswith(b"BM"):
        return "image/bmp"
    if b.startswith(b"II*\x00") or b.startswith(b"MM\x00*"):
        return "image/tiff"
    if len(b) >= 12 and b[4:8] == b"ftyp" and b[8:12] in {b"avif", b"avis"}:
        return "image/avif"
    return ""


def _veo_validate_image_bytes(head: bytes, *, content_type: str, source_label: str) -> str:
    declared = (content_type or "").split(";", 1)[0].strip().lower()
    sniffed = _veo_sniff_image_mime(head)
    if sniffed:
        return sniffed
    bad_declared = declared.startswith("text/") or declared in {
        "application/json",
        "application/xml",
        "application/xhtml+xml",
        "application/problem+json",
    }
    if bad_declared or not declared.startswith("image/"):
        sample = bytes(head or b"")[:32].hex()
        raise NonPenalizedTaskError(
            "VEO 输入图片本地下载失败：下载结果不像图片；"
            f"content_type={declared or 'unknown'}; first_bytes={sample}; source={safe_trim(source_label, 300)}",
            status_code=400,
            content_violation=True,
        )
    return declared


def _veo_wikimedia_original_url(source_url: str) -> str:
    """Convert Wikimedia thumbnail URLs to the original file URL when possible."""
    try:
        parsed = urlparse(source_url)
        host = (parsed.hostname or "").lower()
        if host != "upload.wikimedia.org":
            return ""
        m = re.match(r"^(/wikipedia/commons)/thumb/([0-9a-f]/[0-9a-f]{2}/[^/]+)/[^/]+$", parsed.path, flags=re.I)
        if not m:
            return ""
        original_path = f"{m.group(1)}/{m.group(2)}"
        return parsed._replace(path=original_path, query="", fragment="").geturl()
    except Exception:
        return ""


def _veo_special_filepath_url(source_url: str) -> str:
    """Build a commons.wikimedia.org Special:FilePath fallback URL from an upload URL."""
    try:
        parsed = urlparse(source_url)
        host = (parsed.hostname or "").lower()
        if host != "upload.wikimedia.org":
            return ""
        parts = [unquote(p) for p in parsed.path.split("/") if p]
        if not parts:
            return ""
        # thumb URLs end with ".../<original filename>/<thumbnail filename>".
        filename = parts[-2] if "thumb" in parts and len(parts) >= 2 else parts[-1]
        if not filename:
            return ""
        query = ""
        m = re.match(r"^(\d+)px-", parts[-1] or "", flags=re.I)
        if m:
            query = urlencode({"width": m.group(1)})
        return f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(filename)}" + (f"?{query}" if query else "")
    except Exception:
        return ""


def _veo_local_download_fallback_urls(source_url: str) -> List[str]:
    """Alternative URLs for public media hosts that may block a specific edge URL."""
    out: List[str] = []
    for candidate in (_veo_wikimedia_original_url(source_url), _veo_special_filepath_url(source_url)):
        if candidate and candidate != source_url and candidate not in out:
            out.append(candidate)
    return out


def _veo_sniff_video_mime(data: bytes) -> str:
    b = bytes(data or b"")[:64]
    if len(b) >= 12 and b[4:8] == b"ftyp":
        return "video/mp4"
    if b.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    if b.startswith(b"RIFF") and len(b) >= 12 and b[8:12] == b"AVI ":
        return "video/x-msvideo"
    if b.startswith(b"OggS"):
        return "video/ogg"
    return ""


def _veo_validate_video_bytes(head: bytes, *, content_type: str, source_label: str) -> str:
    declared = (content_type or "").split(";", 1)[0].strip().lower()
    sniffed = _veo_sniff_video_mime(head)
    if sniffed:
        return declared if declared.startswith("video/") else sniffed
    bad_declared = declared.startswith("text/") or declared in {
        "application/json",
        "application/xml",
        "application/xhtml+xml",
        "application/problem+json",
    }
    if bad_declared or (declared and not declared.startswith("video/") and declared != "application/octet-stream"):
        sample = bytes(head or b"")[:32].hex()
        raise NonPenalizedTaskError(
            "参考视频读取失败：请确保视频为mp4格式的视频；"
            f"content_type={declared or 'unknown'}; first_bytes={sample}; source={safe_trim(source_label, 300)}",
            status_code=400,
            content_violation=True,
        )
    return declared or "video/mp4"


def _veo_cached_image_for_key(cache_key: str) -> Optional[Path]:
    try:
        if not _VEO_LOCAL_IMAGE_CACHE_DIR.exists():
            return None
        ttl = _veo_local_image_cache_ttl_seconds()
        now = time.time()
        for p in _VEO_LOCAL_IMAGE_CACHE_DIR.glob(f"{cache_key}.*"):
            if not p.is_file() or p.name.endswith(".tmp"):
                continue
            if ttl > 0 and (now - p.stat().st_mtime) > ttl:
                continue
            return p
    except Exception:
        return None
    return None


def _veo_cleanup_local_image_cache_sync() -> None:
    try:
        cache_dir = _VEO_LOCAL_IMAGE_CACHE_DIR
        if not cache_dir.exists():
            return
        now = time.time()
        ttl = _veo_local_image_cache_ttl_seconds()
        files: List[tuple[Path, float, int]] = []
        for p in cache_dir.glob("*"):
            if not p.is_file():
                continue
            try:
                st = p.stat()
            except Exception:
                continue
            if p.name.endswith(".tmp") or (ttl > 0 and (now - st.st_mtime) > ttl):
                try:
                    p.unlink()
                except Exception:
                    pass
                continue
            files.append((p, st.st_mtime, int(st.st_size)))
        max_total = _veo_local_image_cache_max_bytes()
        total = sum(size for _, _, size in files)
        if total <= max_total:
            return
        for p, _mtime, size in sorted(files, key=lambda it: it[1]):
            if total <= max_total:
                break
            try:
                p.unlink()
                total -= size
            except Exception:
                pass
    except Exception:
        pass


async def _veo_maybe_cleanup_local_image_cache() -> None:
    global _VEO_LOCAL_IMAGE_LAST_CLEANUP
    now = time.time()
    if now - _VEO_LOCAL_IMAGE_LAST_CLEANUP < 300:
        return
    _VEO_LOCAL_IMAGE_LAST_CLEANUP = now
    await asyncio.to_thread(_veo_cleanup_local_image_cache_sync)


async def _veo_local_image_lock(cache_key: str) -> asyncio.Lock:
    async with _VEO_LOCAL_IMAGE_LOCKS_GUARD:
        lock = _VEO_LOCAL_IMAGE_LOCKS.get(cache_key)
        if lock is None:
            lock = asyncio.Lock()
            _VEO_LOCAL_IMAGE_LOCKS[cache_key] = lock
        return lock


async def _veo_write_bytes_to_local_image_cache(data: bytes, *, content_type: str, source_label: str) -> Path:
    max_bytes = _veo_local_image_max_bytes()
    if len(data) > max_bytes:
        raise NonPenalizedTaskError(
            f"VEO 输入图片过大：{len(data)} bytes > limit={max_bytes} source={safe_trim(source_label, 300)!r}",
            status_code=413,
            content_violation=True,
        )
    cache_key = hashlib.sha256(data).hexdigest()
    lock = await _veo_local_image_lock(f"bytes:{cache_key}")
    async with lock:
        cached = _veo_cached_image_for_key(cache_key)
        if cached:
            return cached
        _VEO_LOCAL_IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        effective_type = _veo_validate_image_bytes(data[:4096], content_type=content_type, source_label=source_label)
        ext = _veo_image_ext_from_mime_or_url(effective_type, source_label)
        final = _VEO_LOCAL_IMAGE_CACHE_DIR / f"{cache_key}{ext}"
        tmp = _VEO_LOCAL_IMAGE_CACHE_DIR / f"{cache_key}.{uuid.uuid4().hex}.tmp"
        try:
            await asyncio.to_thread(tmp.write_bytes, data)
            await asyncio.to_thread(tmp.replace, final)
        finally:
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass
        return final


async def _veo_download_url_to_local_image_cache(source_url: str) -> Path:
    cache_key = hashlib.sha256(source_url.encode("utf-8", "ignore")).hexdigest()
    lock = await _veo_local_image_lock(f"url:{cache_key}")
    async with lock:
        cached = _veo_cached_image_for_key(cache_key)
        if cached:
            return cached
        _VEO_LOCAL_IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        max_bytes = _veo_local_image_max_bytes()
        tmp = _VEO_LOCAL_IMAGE_CACHE_DIR / f"{cache_key}.{uuid.uuid4().hex}.tmp"
        final: Optional[Path] = None
        total = 0
        content_type = ""
        final_url = source_url
        head = bytearray()
        download_started_at = time.monotonic()
        timeout = httpx.Timeout(
            connect=_veo_float_env("VEO_LOCAL_IMAGE_CONNECT_TIMEOUT_SECONDS", 15.0, min_value=1.0, max_value=120.0),
            read=_veo_float_env("VEO_LOCAL_IMAGE_READ_TIMEOUT_SECONDS", 180.0, min_value=5.0, max_value=1800.0),
            write=30.0,
            pool=30.0,
        )
        headers = _veo_local_download_headers("image", source_url)
        try:
            async with _VEO_LOCAL_IMAGE_DOWNLOAD_SEMAPHORE:
                async with httpx.AsyncClient(
                    timeout=timeout,
                    follow_redirects=True,
                    trust_env=False,
                    transport=_veo_ipv4_httpx_transport(),
                ) as client:
                    async with client.stream("GET", source_url, headers=headers) as resp:
                        status = int(resp.status_code or 0)
                        if status >= 400:
                            body = ""
                            try:
                                body = (await resp.aread()).decode("utf-8", "ignore")[:300]
                            except Exception:
                                body = ""
                            raise NonPenalizedTaskError(
                                f"VEO 输入图片本地下载失败：Request Method: GET; url={safe_trim(source_url, 500)}; Status Code: {status}; response={body}",
                                status_code=400 if status < 500 else 502,
                                content_violation=True,
                            )
                        cl = str(resp.headers.get("content-length") or "").strip()
                        if cl.isdigit() and int(cl) > max_bytes:
                            raise NonPenalizedTaskError(
                                f"VEO 输入图片过大：content-length={cl} > limit={max_bytes}; url={safe_trim(source_url, 500)}",
                                status_code=413,
                                content_violation=True,
                            )
                        content_type = str(resp.headers.get("content-type") or "")
                        final_url = str(resp.url or source_url)
                        download_started_at = time.monotonic()
                        with tmp.open("wb") as f:
                            async for chunk in resp.aiter_bytes(chunk_size=1024 * 1024):
                                if not chunk:
                                    continue
                                total += len(chunk)
                                _veo_raise_if_local_download_too_slow(
                                    kind="image",
                                    total=total,
                                    started_at=download_started_at,
                                    source_url=source_url,
                                )
                                if total > max_bytes:
                                    raise NonPenalizedTaskError(
                                        f"VEO 输入图片过大：downloaded={total} > limit={max_bytes}; url={safe_trim(source_url, 500)}",
                                        status_code=413,
                                    )
                                if len(head) < 4096:
                                    head.extend(chunk[: 4096 - len(head)])
                                await asyncio.to_thread(f.write, chunk)
            if total <= 0:
                raise NonPenalizedTaskError(
                    f"VEO 输入图片本地下载失败：空响应；Request Method: GET; url={safe_trim(source_url, 500)}",
                    status_code=502,
                    content_violation=True,
                )
            effective_type = _veo_validate_image_bytes(bytes(head), content_type=content_type, source_label=source_url)
            ext = _veo_image_ext_from_mime_or_url(effective_type, final_url)
            final = _VEO_LOCAL_IMAGE_CACHE_DIR / f"{cache_key}{ext}"
            assert final is not None
            await asyncio.to_thread(tmp.replace, final)
            return final
        except NonPenalizedTaskError:
            raise
        except Exception as e:
            raise NonPenalizedTaskError(
                f"VEO 输入图片本地下载失败：Request Method: GET; url={safe_trim(source_url, 500)}; error={safe_trim(str(e), 500)}",
                status_code=502,
                content_violation=True,
            ) from e
        finally:
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass


async def _veo_write_bytes_to_local_video_cache(data: bytes, *, content_type: str, source_label: str) -> Path:
    max_bytes = _veo_local_video_max_bytes()
    if len(data) > max_bytes:
        raise NonPenalizedTaskError(
            f"VEO 输入视频过大：{len(data)} bytes > limit={max_bytes} source={safe_trim(source_label, 300)!r}",
            status_code=413,
            content_violation=True,
        )
    cache_key = hashlib.sha256(data).hexdigest()
    lock = await _veo_local_image_lock(f"video-bytes:{cache_key}")
    async with lock:
        cached = _veo_cached_image_for_key(cache_key)
        if cached:
            return cached
        _VEO_LOCAL_IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        effective_type = _veo_validate_video_bytes(data[:4096], content_type=content_type, source_label=source_label)
        ext = _veo_video_ext_from_mime_or_url(effective_type, source_label)
        final = _VEO_LOCAL_IMAGE_CACHE_DIR / f"{cache_key}{ext}"
        tmp = _VEO_LOCAL_IMAGE_CACHE_DIR / f"{cache_key}.{uuid.uuid4().hex}.tmp"
        try:
            await asyncio.to_thread(tmp.write_bytes, data)
            await asyncio.to_thread(tmp.replace, final)
        finally:
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass
        return final


async def _veo_download_url_to_local_video_cache(source_url: str) -> Path:
    cache_key = hashlib.sha256(source_url.encode("utf-8", "ignore")).hexdigest()
    lock = await _veo_local_image_lock(f"video-url:{cache_key}")
    async with lock:
        cached = _veo_cached_image_for_key(cache_key)
        if cached:
            return cached
        _VEO_LOCAL_IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        max_bytes = _veo_local_video_max_bytes()
        tmp = _VEO_LOCAL_IMAGE_CACHE_DIR / f"{cache_key}.{uuid.uuid4().hex}.tmp"
        total = 0
        content_type = ""
        final_url = source_url
        head = bytearray()
        download_started_at = time.monotonic()
        timeout = httpx.Timeout(
            connect=_veo_float_env("VEO_LOCAL_VIDEO_CONNECT_TIMEOUT_SECONDS", 15.0, min_value=1.0, max_value=120.0),
            read=_veo_float_env("VEO_LOCAL_VIDEO_READ_TIMEOUT_SECONDS", 600.0, min_value=5.0, max_value=3600.0),
            write=30.0,
            pool=30.0,
        )
        headers = _veo_local_download_headers("video", source_url)
        try:
            async with _VEO_LOCAL_IMAGE_DOWNLOAD_SEMAPHORE:
                async with httpx.AsyncClient(
                    timeout=timeout,
                    follow_redirects=True,
                    trust_env=False,
                    transport=_veo_ipv4_httpx_transport(),
                ) as client:
                    async with client.stream("GET", source_url, headers=headers) as resp:
                        status = int(resp.status_code or 0)
                        if status >= 400:
                            body = ""
                            try:
                                body = (await resp.aread()).decode("utf-8", "ignore")[:300]
                            except Exception:
                                body = ""
                            raise NonPenalizedTaskError(
                                f"VEO 输入视频本地下载失败：Request Method: GET; url={safe_trim(source_url, 500)}; Status Code: {status}; response={body}",
                                status_code=400 if status < 500 else 502,
                                content_violation=True,
                            )
                        cl = str(resp.headers.get("content-length") or "").strip()
                        if cl.isdigit() and int(cl) > max_bytes:
                            raise NonPenalizedTaskError(
                                f"VEO 输入视频过大：content-length={cl} > limit={max_bytes}; url={safe_trim(source_url, 500)}",
                                status_code=413,
                                content_violation=True,
                            )
                        content_type = str(resp.headers.get("content-type") or "")
                        final_url = str(resp.url or source_url)
                        download_started_at = time.monotonic()
                        with tmp.open("wb") as f:
                            async for chunk in resp.aiter_bytes(chunk_size=1024 * 1024):
                                if not chunk:
                                    continue
                                total += len(chunk)
                                _veo_raise_if_local_download_too_slow(
                                    kind="video",
                                    total=total,
                                    started_at=download_started_at,
                                    source_url=source_url,
                                )
                                if total > max_bytes:
                                    raise NonPenalizedTaskError(
                                        f"VEO 输入视频过大：downloaded={total} > limit={max_bytes}; url={safe_trim(source_url, 500)}",
                                        status_code=413,
                                    )
                                if len(head) < 4096:
                                    head.extend(chunk[: 4096 - len(head)])
                                await asyncio.to_thread(f.write, chunk)
            if total <= 0:
                raise NonPenalizedTaskError(
                    f"VEO 输入视频本地下载失败：空响应；Request Method: GET; url={safe_trim(source_url, 500)}",
                    status_code=502,
                    content_violation=True,
                )
            effective_type = _veo_validate_video_bytes(bytes(head), content_type=content_type, source_label=source_url)
            ext = _veo_video_ext_from_mime_or_url(effective_type, final_url)
            final = _VEO_LOCAL_IMAGE_CACHE_DIR / f"{cache_key}{ext}"
            await asyncio.to_thread(tmp.replace, final)
            return final
        except NonPenalizedTaskError:
            raise
        except Exception as e:
            raise NonPenalizedTaskError(
                f"VEO 输入视频本地下载失败：Request Method: GET; url={safe_trim(source_url, 500)}; error={safe_trim(str(e), 500)}",
                status_code=502,
                content_violation=True,
            ) from e
        finally:
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass


async def _veo_materialize_image_for_extension(
    source_url: str,
    *,
    kind: str,
    index: int,
    total: int,
    progress_cb: ProgressCB,
    log_file: Optional[Path],
) -> str:
    raw = str(source_url or "").strip()
    if not raw or _veo_is_local_asset_url(raw):
        return raw
    parsed = urlparse(raw)
    if parsed.scheme.lower() not in {"http", "https", "data"}:
        raise NonPenalizedTaskError(
            f"VEO 输入图片地址协议不支持：仅支持 http/https URL or base64数据，got={safe_trim(raw, 300)!r}",
            status_code=400,
            content_violation=True,
        )
    await _veo_maybe_cleanup_local_image_cache()
    try:
        await progress_cb(
            2,
            {
                "stage": "localize_input_image",
                "kind": kind,
                "index": index + 1,
                "total": total,
                "source_host": parsed.netloc if parsed.scheme != "data" else "data-url",
            },
        )
    except Exception:
        pass
    if parsed.scheme.lower() == "data":
        m = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$", raw, flags=re.S)
        if not m:
            raise NonPenalizedTaskError("VEO 输入图片 data URL 格式不支持：仅支持 data:image/...;base64,...", status_code=400,content_violation=True)
        mime = m.group(1)
        try:
            data = base64.b64decode(m.group(2), validate=False)
        except Exception as e:
            raise NonPenalizedTaskError(f"VEO 输入图片 data URL 解码失败：{safe_trim(str(e), 300)}", status_code=400,content_violation=True) from e
        max_data_image_bytes = 500 * 1024
        if len(data) > max_data_image_bytes:
            raise NonPenalizedTaskError(
                f"单张参考图base64数据不能超过500KB，当前约 {len(data) / 1024:.1f}KB，推荐上传到第三方[https://otc.mirrmart.com/dqc_play/fpOpenApi]接口后传递网址url",
                status_code=400,
                content_violation=True,
            )
        local_path = await _veo_write_bytes_to_local_image_cache(data, content_type=mime, source_label=f"data:{mime}")
    else:
        try:
            local_path = await _veo_download_url_to_local_image_cache(raw)
        except NonPenalizedTaskError as first_err:
            last_err = first_err
            for alt in _veo_local_download_fallback_urls(raw):
                append_log(
                    log_file,
                    f"[veo][extension][image-cache] primary download failed, try fallback "
                    f"source={safe_trim(raw, 220)!r} alt={safe_trim(alt, 220)!r} err={safe_trim(str(last_err), 220)!r}",
                )
                try:
                    local_path = await _veo_download_url_to_local_image_cache(alt)
                    break
                except NonPenalizedTaskError as e:
                    last_err = e
            else:
                raise first_err
    local_url = _veo_local_asset_url(local_path)
    append_log(
        log_file,
        f"[veo][extension][image-cache] localized kind={kind} index={index + 1}/{total} "
        f"source={safe_trim(raw, 260)!r} -> {local_url!r}",
    )
    try:
        await progress_cb(
            2,
            {
                "stage": "localize_input_image_ok",
                "kind": kind,
                "index": index + 1,
                "total": total,
                "url": local_url,
            },
        )
    except Exception:
        pass
    return local_url


async def _veo_materialize_image_urls_for_extension(
    urls: List[str],
    *,
    kind: str,
    payload: Dict[str, Any],
    progress_cb: ProgressCB,
    log_file: Optional[Path],
) -> List[str]:
    if not urls or not _veo_extension_local_image_cache_enabled(payload):
        return list(urls or [])
    srcs = [str(u or "").strip() for u in urls if str(u or "").strip()]
    if not srcs:
        return []
    tasks = [
        _veo_materialize_image_for_extension(
            u,
            kind=kind,
            index=i,
            total=len(srcs),
            progress_cb=progress_cb,
            log_file=log_file,
        )
        for i, u in enumerate(srcs)
    ]
    return list(await asyncio.gather(*tasks))


async def _veo_materialize_video_for_extension(
    source_url: str,
    *,
    kind: str,
    progress_cb: ProgressCB,
    log_file: Optional[Path],
) -> str:
    raw = str(source_url or "").strip()
    if not raw or _veo_is_local_asset_url(raw):
        return raw
    parsed = urlparse(raw)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise NonPenalizedTaskError(
            f"VEO 输入视频地址协议不支持：仅支持 http/https URL，got={safe_trim(raw, 300)!r}",
            status_code=400,
            content_violation=True,
        )
    await _veo_maybe_cleanup_local_image_cache()
    try:
        await progress_cb(
            2,
            {
                "stage": "localize_input_video",
                "kind": kind,
                "index": 1,
                "total": 1,
                "source_host": parsed.netloc,
            },
        )
    except Exception:
        pass
    local_path = await _veo_download_url_to_local_video_cache(raw)
    local_url = _veo_local_asset_url(local_path)
    append_log(
        log_file,
        f"[veo][extension][video-cache] localized kind={kind} source={safe_trim(raw, 260)!r} -> {local_url!r}",
    )
    try:
        await progress_cb(2, {"stage": "localize_input_video_ok", "kind": kind, "index": 1, "total": 1, "url": local_url})
    except Exception:
        pass
    return local_url


class _VeoMosaicServiceConnectionError(Exception):
    """A mosaic endpoint could not establish a connection."""


def _veo_mosaic_service_endpoint(value: Any) -> str:
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        return ""
    if raw.endswith("/process-media-face-grid"):
        return raw
    return f"{raw}/process-media-face-grid"


def _veo_reference_video_face_mosaic_service_urls(payload: Dict[str, Any]) -> List[str]:
    payload = payload or {}
    configured: Any = (
        payload.get("reference_video_face_mosaic_service_urls")
        or os.environ.get("VEO_REFERENCE_VIDEO_FACE_MOSAIC_SERVICE_URLS")
    )
    if configured:
        candidates = configured if isinstance(configured, list) else str(configured).split(",")
    else:
        explicit = (
            payload.get("reference_video_face_mosaic_service_url")
            or os.environ.get("VEO_REFERENCE_VIDEO_FACE_MOSAIC_SERVICE_URL")
            or os.environ.get("ONNX_WATERMARK_SERVICE_BASE_URL")
        )
        if explicit:
            candidates = [explicit]
        else:
            candidates = getattr(app_config, "video_postprocess_service_base_urls", None) or [
                getattr(app_config, "video_postprocess_service_base_url", "")
                or "http://127.0.0.1:8791"
            ]

    urls: List[str] = []
    for candidate in candidates:
        endpoint = _veo_mosaic_service_endpoint(candidate)
        if endpoint and endpoint not in urls:
            urls.append(endpoint)
    return urls or ["http://127.0.0.1:8791/process-media-face-grid"]


def _veo_reference_video_face_mosaic_service_url(payload: Dict[str, Any]) -> str:
    return _veo_reference_video_face_mosaic_service_urls(payload)[0]


async def _veo_mosaic_reference_video(
    source_url: str,
    *,
    payload: Dict[str, Any],
    progress_cb: ProgressCB,
    log_file: Optional[Path],
) -> str:
    service_url = _veo_reference_video_face_mosaic_service_url(payload)
    timeout_seconds = _veo_float_env(
        "VEO_REFERENCE_VIDEO_FACE_MOSAIC_TIMEOUT_SECONDS",
        900.0,
        min_value=30.0,
        max_value=7200.0,
    )
    request_payload = {
        "media_url": str(source_url or "").strip(),
        "mask_style": "mosaic_skin",
        "mosaic_expand_ratio": 0.01,
        "mosaic_size": 16,
        "mosaic_blur_radius": 2,
        "mosaic_strength": 1.0,
    }
    append_log(
        log_file,
        "[veo][reference-video-mosaic] start "
        f"source={safe_trim(source_url, 260)!r} service={service_url!r} timeout={timeout_seconds}s",
    )
    try:
        await progress_cb(
            4,
            {"stage": "reference_video_face_mosaic_start", "video_url": source_url, "service_url": service_url},
        )
    except Exception:
        pass
    try:
        timeout = httpx.Timeout(timeout_seconds, connect=20.0, read=timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=False) as client:
            response = await client.post(service_url, json=request_payload)
            try:
                data = response.json()
            except ValueError:
                data = {}
            if response.status_code >= 400:
                detail = data.get("detail") if isinstance(data, dict) else None
                if isinstance(detail, dict):
                    detail_message = detail.get("message") or detail.get("error") or ""
                else:
                    detail_message = detail or (data.get("message") if isinstance(data, dict) else "")
                message = str(detail_message or response.reason_phrase or "request failed").strip()
                if 400 <= response.status_code < 500:
                    raise NonPenalizedTaskError(
                        f"参考视频人脸预处理失败：{message}",
                        status_code=response.status_code,
                        content_violation=True,
                    )
                response.raise_for_status()
        if not isinstance(data, dict) or data.get("ok") is False:
            raise RuntimeError(f"reference video mosaic service returned failure: {safe_trim(str(data), 500)}")
        output_url = str(data.get("output_url") or "").strip()
        if not output_url:
            raise RuntimeError("reference video mosaic service returned no output_url")
        append_log(
            log_file,
            "[veo][reference-video-mosaic] done "
            f"source={safe_trim(source_url, 220)!r} output={safe_trim(output_url, 260)!r} "
            f"faces={data.get('face_count') or data.get('max_face_count') or 0}",
        )
        try:
            await progress_cb(
                5,
                {"stage": "reference_video_face_mosaic_done", "video_url": output_url},
            )
        except Exception:
            pass
        return output_url
    except asyncio.CancelledError:
        raise
    except NonPenalizedTaskError:
        raise
    except Exception as exc:
        append_log(log_file, f"[veo][reference-video-mosaic] failed: {exc}")
        raise RuntimeError(f"参考视频人脸预处理失败：{exc}") from exc


async def _veo_mosaic_reference_media(
    source_url: str,
    *,
    payload: Dict[str, Any],
    progress_cb: ProgressCB,
    log_file: Optional[Path],
    kind: str = "image",
    service_url: Optional[str] = None,
) -> tuple[str, int]:
    """Mask one reference, failing over only when a connection cannot be established."""
    candidates = (
        [_veo_mosaic_service_endpoint(service_url)]
        if service_url
        else round_robin_order(_veo_reference_video_face_mosaic_service_urls(payload))
    )
    last_error: Optional[_VeoMosaicServiceConnectionError] = None
    for index, candidate in enumerate(candidates):
        try:
            return await _veo_mosaic_reference_media_once(
                source_url,
                payload=payload,
                progress_cb=progress_cb,
                log_file=log_file,
                kind=kind,
                service_url=candidate,
            )
        except _VeoMosaicServiceConnectionError as exc:
            last_error = exc
            if index + 1 < len(candidates):
                append_log(
                    log_file,
                    f"[veo][reference-{kind}-mosaic] service unavailable; switching to {candidates[index + 1]!r}: {exc}",
                )
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"reference {kind} face mosaic has no configured service")


async def _veo_mosaic_reference_media_batch(
    source_urls: List[str],
    *,
    payload: Dict[str, Any],
    progress_cb: ProgressCB,
    log_file: Optional[Path],
    kind: str = "image",
) -> List[Tuple[str, int]]:
    """Process a whole batch on one endpoint, restarting it on failover."""
    # Keep one batch on one preferred endpoint, but rotate that preference
    # between tasks and continue cyclically when the endpoint is unreachable.
    candidates = round_robin_order(_veo_reference_video_face_mosaic_service_urls(payload))
    last_error: Optional[_VeoMosaicServiceConnectionError] = None
    for index, service_url in enumerate(candidates):
        results: List[Tuple[str, int]] = []
        try:
            for source_url in source_urls:
                results.append(
                    await _veo_mosaic_reference_media(
                        source_url,
                        payload=payload,
                        progress_cb=progress_cb,
                        log_file=log_file,
                        kind=kind,
                        service_url=service_url,
                    )
                )
            return results
        except _VeoMosaicServiceConnectionError as exc:
            last_error = exc
            if index + 1 < len(candidates):
                append_log(
                    log_file,
                    f"[veo][reference-{kind}-mosaic] batch connection failed after "
                    f"{len(results)}/{len(source_urls)} items; restarting entire batch on {candidates[index + 1]!r}",
                )
    if last_error is not None:
        raise last_error
    return []


async def _veo_mosaic_reference_media_once(
    source_url: str,
    *,
    payload: Dict[str, Any],
    progress_cb: ProgressCB,
    log_file: Optional[Path],
    kind: str,
    service_url: str,
) -> tuple[str, int]:
    """Mask faces in a reference image/video and return (URL, detected face count)."""
    source_url = str(source_url or "").strip()
    parsed_source = urlparse(source_url)
    if parsed_source.scheme.lower() not in {"http", "https"}:
        # The masking service accepts public URLs only; preserve data/local
        # references and let the existing uploader handle them.
        return source_url, 0
    timeout_seconds = _veo_float_env("VEO_REFERENCE_VIDEO_FACE_MOSAIC_TIMEOUT_SECONDS", 900.0, min_value=30.0, max_value=7200.0)
    request_payload = {"media_url": str(source_url or "").strip(), "mask_style": "mosaic_skin", "mosaic_expand_ratio": 0.01, "mosaic_size": 16, "mosaic_blur_radius": 2, "mosaic_strength": 1.0}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds, connect=20.0, read=timeout_seconds), follow_redirects=True, trust_env=False) as client:
            response = await client.post(service_url, json=request_payload)
            data = response.json() if response.content else {}
            if response.status_code >= 400:
                detail = data.get("detail") if isinstance(data, dict) else None
                if isinstance(detail, dict):
                    detail_message = detail.get("message") or detail.get("error") or detail.get("code") or ""
                else:
                    detail_message = detail or (data.get("message") if isinstance(data, dict) else "")
                message = str(detail_message or response.reason_phrase or "request failed").strip()
                if response.status_code == 422 and kind == "video" and (
                    not message or message.lower() == "unprocessable entity"
                ):
                    message = "video exceeds 1080P resolution"
                if 400 <= response.status_code < 500:
                    raise NonPenalizedTaskError(
                        f"参考{kind}人脸预处理失败：{message}",
                        status_code=response.status_code,
                        content_violation=True,
                    )
                response.raise_for_status()
        if not isinstance(data, dict) or data.get("ok") is False:
            raise RuntimeError(f"reference {kind} face mosaic failed: {safe_trim(str(data), 500)}")
        output_url = str(data.get("output_url") or source_url or "").strip()
        if not output_url:
            raise RuntimeError(f"reference {kind} face mosaic returned no output_url")
        try:
            face_count = int(data.get("face_count") or data.get("max_face_count") or 0)
        except (TypeError, ValueError):
            face_count = 0
        append_log(log_file, f"[veo][reference-{kind}-mosaic] source={safe_trim(source_url, 180)!r} output={safe_trim(output_url, 220)!r} faces={face_count}")
        return output_url, max(0, face_count)
    except asyncio.CancelledError:
        raise
    except NonPenalizedTaskError:
        raise
    except (httpx.NetworkError, httpx.ConnectTimeout) as exc:
        append_log(log_file, f"[veo][reference-{kind}-mosaic] unreachable service={service_url!r}: {exc}")
        raise _VeoMosaicServiceConnectionError(
            f"reference {kind} face mosaic service unreachable ({service_url}): {exc}"
        ) from exc
    except httpx.HTTPStatusError as exc:
        response = exc.response
        detail_message = ""
        try:
            error_data = response.json()
        except (ValueError, TypeError):
            error_data = {}
        if isinstance(error_data, dict):
            detail = error_data.get("detail")
            if isinstance(detail, dict):
                detail_message = str(detail.get("message") or detail.get("error") or detail.get("code") or "")
            else:
                detail_message = str(detail or error_data.get("message") or "")
        detail_message = detail_message.strip() or str(response.text or "").strip() or str(exc)
        if 400 <= response.status_code < 500:
            raise NonPenalizedTaskError(
                f"reference {kind} face mosaic failed: {detail_message}",
                status_code=response.status_code,
                content_violation=True,
            ) from exc
        raise
    except Exception as exc:
        append_log(log_file, f"[veo][reference-{kind}-mosaic] failed: {exc}")
        raise RuntimeError(f"reference {kind} face mosaic failed: {exc}") from exc


async def refresh_veo_balance_via_extension(
    *,
    db: Database,
    picked: Any,
    refresh_timeout_seconds: float,
    signal_window_pool_replenish: Optional[Callable[[], None]] = None,
    auto_triger_connection: Optional[bool] = True,
    force_refresh_token: Optional[bool] = False,
) -> Optional[Dict[str, Any]]:
    """Refresh VEO credits through the browser extension token/balance interfaces."""
    try:
        veo_target = str(picked.default_target_url or "").strip() or "https://labs.google/fx"
        veo_sess = get_or_create_veo_session(
            vendor=picked.browser_vendor,
            base_url=picked.browser_base_url,
            access_key=picked.browser_access_key,
            space_id=picked.space_id,
            window_key=picked.window_key,
        )
        veo_sess.browser_headless = bool(getattr(picked, "headless", False))
        veo_sess.browser_pure_mode = bool(getattr(picked, "pure_mode", True))

        access_token = ""
        access_expires = ""
        current_user_paygate_tier: Optional[str] = None

        try:
            mid = int(picked.mapping_id)
            if mid > 0:
                row = await db.get_task_type_window_context(mid)
                if row:
                    access_token = str(row.get("sora_access_token") or "").strip() or None
                    access_expires = str(row.get("sora_access_expires") or "").strip() or None
                    current_user_paygate_tier = str(row.get("sora_plan_title") or "").strip() or None
        except Exception as e:
            pass

        if force_refresh_token or not _veo_cached_access_still_valid(access_token, access_expires, margin_seconds=10):
            token_info = await veo_fetch_access_tokens_via_extension(
                sess=veo_sess,
                target_url=veo_target,
                space_id=picked.space_id,
                window_key=picked.window_key,
                connect_wait_seconds=8.0,
                token_timeout_seconds=min(45.0, max(10.0, float(refresh_timeout_seconds or 45.0))),
                log_file=MONITOR_LOG_FILE,
                auto_triger_connection = auto_triger_connection,
                access_token=access_token,
                access_expires=access_expires,
                short_access_token=access_token,
                short_expires=access_expires,
                force_fetch=True,
            )
            
            access_token = str((token_info or {}).get("short_access_token") or "").strip()
            access_expires = str((token_info or {}).get("short_expires") or "").strip() or None
        if not access_token:
            return None
        result = await asyncio.wait_for(
            submit_extension_task(
                space_id=picked.space_id,
                window_key=picked.window_key,
                provider="veo",
                payload={
                    "action": "refresh_balance",
                    "workflow_kind": "balance_refresh",
                    "project_page": veo_target,
                    "access_token": access_token,
                    "access_expires": access_expires,
                    "fetch_cooldown": False,
                },
                progress_cb=_noop_progress_cb,
                timeout_seconds=max(1.0, float(refresh_timeout_seconds or 45.0)),
            ),
            timeout=max(1.0, float(refresh_timeout_seconds or 45.0)) + 5.0,
        )
        if result is not None and result.get("credits") is not None:
            user_paygate_tier = (
                str(result.get("user_paygate_tier") or result.get("userPaygateTier") or "").strip()
                or current_user_paygate_tier
            )
            plan_title = veo_format_paygate_tier_label(user_paygate_tier)
            _kw: Dict[str, Any] = {
                "mapping_id": picked.mapping_id,
                "remaining_quota": int(result.get("credits") or 0),
                "sora_remaining_count": int(result.get("credits") or 0),
                "sora_access_token": access_token,
                "sora_access_expires": access_expires,
                "sora_plan_title": plan_title,
            }
            fallback_cooldown = _veo_local_next_paid_or_free_cooldown_str(user_paygate_tier)
            _kw["cooldown_until"] = str(result.get("cooldown_until") or fallback_cooldown)
            await db.update_task_type_window(**_kw)
            try:
                cur_q = int(result.get("credits") or 0)
                if cur_q < 30 and signal_window_pool_replenish is not None:
                    hi = await db.task_type_has_mapping_remaining_quota_above(picked.task_code, 30)
                    if hi:
                        signal_window_pool_replenish()
            except Exception:
                pass
            return result
        return None
    except Exception as e:
        logger.warning("refresh_veo_balance_via_extension skipped: mapping=%s err=%s", getattr(picked, "mapping_id", None), e)
        return None


def _veo_extension_r2_upload_config(payload: Dict[str, Any], *, resolution_label: str = "") -> Dict[str, Any]:
    """Build the one-task R2 upload configuration sent to the extension."""
    p = payload or {}
    if not _veo_env_enabled("VEO_EXTENSION_R2_UPLOAD_ENABLED", True):
        return {}
    if _veo_payload_flag_is_false(p.get("veo_image_r2_upload", p.get("extension_r2_upload", True))):
        return {}

    label = str(resolution_label or p.get("extension_image_resolution_label") or p.get("resolution") or p.get("image_resolution") or p.get("veo_image_resolution") or "").strip().lower()
    # AI Studio returns image data as a data URL for all resolutions. Upload
    # 1K as well as 2K/4K so the public task result never contains a large
    # base64 payload when R2 is configured.
    if label and label not in {"1k", "2k", "4k"}:
        return {}

    r2_cfg = r2_config_from_setting_section((app_config.get_raw_config() or {}).get("r2"))
    if not r2_cfg.enabled:
        return {}

    access_key_id = (r2_cfg.access_key_id or os.environ.get("R2_ACCESS_KEY_ID") or "").strip()
    access_key_secret = (r2_cfg.access_key_secret or os.environ.get("R2_ACCESS_KEY_SECRET") or "").strip()
    if not (r2_cfg.endpoint and r2_cfg.region and r2_cfg.bucket and access_key_id and access_key_secret):
        return {}

    normalized = label or "1k"
    object_key_prefix = (
        "veo_workflow/image/aistudio/1k"
        if normalized == "1k"
        else f"veo_workflow/image/upsample/{normalized}"
    )
    return {
        "enabled": True,
        "provider": "cloudflare_r2",
        "endpoint": r2_cfg.endpoint,
        "region": r2_cfg.region,
        "bucket": r2_cfg.bucket,
        "public_base_url": r2_cfg.public_base_url,
        "access_key_id": access_key_id,
        "access_key_secret": access_key_secret,
        "object_key_prefix": object_key_prefix,
        "required": True,
    }


async def _veo_extension_upload_upsample_data_url_to_r2(
    result: Dict[str, Any],
    *,
    project_id: str,
    log_file: Path,
) -> Dict[str, Any]:
    """插件模式：把插件返回的 2K/4K data:image/jpeg;base64 上传 R2，并将结果 URL 回填。

    非插件路径的 2K/4K 放大是在 Python 内直接拿到 base64 后上传 R2；插件路径的 base64
    由浏览器插件返回，这里对齐非插件行为，避免最终 API 返回大段 base64。
    """
    if not isinstance(result, dict):
        return result
    if str(result.get("type") or "") != "veo_workflow_image":
        return result
    if not result.get("upsample_ok"):
        return result
    share = str(result.get("share_url") or result.get("image_url") or "").strip()
    prefix = "data:image/"
    if not share.startswith(prefix) or ";base64," not in share:
        return result

    r2_cfg = r2_config_from_setting_section((app_config.get_raw_config() or {}).get("r2"))
    if not r2_cfg.enabled:
        append_log(log_file, "[veo][extension][image] upsample data URL kept because R2 disabled")
        return result

    try:
        b64 = share.split(";base64,", 1)[1].strip()
        raw = base64.b64decode(b64, validate=False)
        if not raw:
            raise ValueError("base64 解码后为空")
        media_name = str(result.get("generated_media_id") or "").strip() or None
        object_key = build_veo_upsample_object_key(project_id=str(project_id), media_name=media_name)
        url = await asyncio.to_thread(
            upload_bytes_to_r2,
            cfg=r2_cfg,
            data=raw,
            object_key=object_key,
            content_type="image/jpeg",
        )
        out = dict(result)
        out["share_url"] = url
        out["image_url"] = url
        out["upsample_url"] = url
        out["upsample_r2_object_key"] = object_key
        append_log(log_file, f"[veo][extension][image] uploaded upsample data URL to R2 object_key={object_key!r}")
        return out
    except Exception as e:
        out = dict(result)
        out["upsample_error"] = str(out.get("upsample_error") or f"R2 上传失败：{_short_err_msg(e, max_len=200)}")
        append_log(log_file, f"[veo][extension][image] upload upsample data URL to R2 failed, keep data URL: {e}")
        return out


def _veo_4k_use_2k_realesrgan(payload: Dict[str, Any]) -> bool:
    p = payload or {}
    for key in ("veo_4k_use_2k_realesrgan", "use_2k_realesrgan_4k", "veo_4k_external_upscale"):
        if key in p:
            return _veo_truthy_payload_flag(p.get(key))
    return _veo_env_enabled("VEO_4K_USE_2K_REALESRGAN", False)


def _veo_4k_external_upscaler_url() -> str:
    return os.getenv("VEO_4K_UPSCALER_URL", "").strip() or "http://192.168.1.12:18080/v1/upscale/2x/realesrgan"


def _veo_pick_external_upscale_source_image_url(result: Dict[str, Any]) -> str:
    for key in ("upsample_url", "share_url", "image_url", "url", "origin_image_url"):
        u = str((result or {}).get(key) or "").strip()
        if u and not u.startswith("data:"):
            return u
    return ""


async def _veo_external_upscale_2k_to_4k(
    result: Dict[str, Any],
    *,
    progress_cb: ProgressCB,
    log_file: Path,
) -> Dict[str, Any]:
    if not isinstance(result, dict) or str(result.get("type") or "") != "veo_workflow_image":
        return result

    source_url = _veo_pick_external_upscale_source_image_url(result)
    if not source_url:
        raise NonPenalizedTaskError("VEO 4K 放大失败：未获取到 2K 图片地址", status_code=502)

    endpoint = _veo_4k_external_upscaler_url()
    await progress_cb(99, {"stage": "external_4k_upscale", "image_url": source_url, "upscaler_url": endpoint})
    append_log(log_file, f"[veo][extension][image] external 2K->4K upscale start source={safe_trim(source_url, 260)!r}")

    data: Dict[str, Any] = {}
    upsample_ok = False
    upsample_error = ""
    try:
        timeout = httpx.Timeout(
            connect=_veo_float_env("VEO_4K_UPSCALER_CONNECT_TIMEOUT_SECONDS", 15.0, min_value=1.0, max_value=120.0),
            read=_veo_float_env("VEO_4K_UPSCALER_READ_TIMEOUT_SECONDS", 1800.0, min_value=5.0, max_value=3600.0),
            write=_veo_float_env("VEO_4K_UPSCALER_WRITE_TIMEOUT_SECONDS", 30.0, min_value=1.0, max_value=300.0),
            pool=_veo_float_env("VEO_4K_UPSCALER_POOL_TIMEOUT_SECONDS", 30.0, min_value=1.0, max_value=300.0),
        )
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(endpoint, json={"image_url": source_url})
        body = resp.text
        if resp.status_code >= 400:
            raise RuntimeError(f"status={resp.status_code}; response={safe_trim(body, 500)}")
        data = resp.json()
        upscaled_url = str((data or {}).get("image_url") or "").strip()
        if not upscaled_url:
            raise RuntimeError(f"missing image_url in response: {safe_trim(body, 500)}")
        upsample_ok = True
    except Exception as e:
        upscaled_url = source_url
        upsample_error = f"VEO 4K 放大失败，已返回 2K 图片：{safe_trim(str(e), 500)}"
        append_log(log_file, f"[veo][extension][image] external 2K->4K upscale failed, fallback to 2K: {e}")

    out = dict(result)
    out["origin_image_url"] = source_url
    out["share_url"] = upscaled_url
    out["image_url"] = upscaled_url
    out["url"] = upscaled_url
    out["resolution"] = "4K" if upsample_ok else "2K"
    out["upsample_ok"] = upsample_ok
    out["upsample_url"] = upscaled_url
    out["upsample_provider"] = "external_image_upscaler"
    if upsample_error:
        out["upsample_error"] = upsample_error
    if data:
        out["upscaler_response"] = data
    if data.get("width") is not None:
        out["width"] = data.get("width")
    if data.get("height") is not None:
        out["height"] = data.get("height")
    out["result_urls"] = [upscaled_url]
    append_log(
        log_file,
        (
            "[veo][extension][image] external 2K->4K upscale done "
            if upsample_ok
            else "[veo][extension][image] external 2K->4K upscale fallback "
        )
        + f"source={safe_trim(source_url, 180)!r} url={safe_trim(upscaled_url, 260)!r}",
    )
    await progress_cb(
        100,
        {
            "stage": "external_4k_upscale_done" if upsample_ok else "external_4k_upscale_failed_fallback_2k",
            "image_url": upscaled_url,
            "origin_2k_image_url": source_url,
            "width": data.get("width"),
            "height": data.get("height"),
            "upsample_error": upsample_error,
        },
    )
    return out


def _veo_video_watermark_remove_enabled(payload: Dict[str, Any]) -> bool:
    # 去水印依赖外部服务 onnx_watermark_service，默认关闭（见 config/setting.toml
    # 的 [video_postprocess]）。总开关关闭或未配置服务地址时，payload 里的
    # remove_watermark 也不能反向打开，避免未部署该服务时产生无谓的外部请求。
    if not app_config.video_remove_watermark_enabled:
        return False
    if not app_config.video_postprocess_service_base_url:
        return False
    p = payload or {}
    for key in (
        "remove_watermark",
        "veo_remove_watermark",
        "video_remove_watermark",
        "remove_video_watermark",
    ):
        if key in p:
            return not _veo_payload_flag_is_false(p.get(key))
    return _veo_env_enabled("VEO_REMOVE_VIDEO_WATERMARK", True)


def _veo_video_watermark_remove_required(payload: Dict[str, Any]) -> bool:
    p = payload or {}
    for key in ("remove_watermark_required", "veo_remove_watermark_required", "video_remove_watermark_required"):
        if key in p:
            return not _veo_payload_flag_is_false(p.get(key))
    return _veo_env_enabled("VEO_REMOVE_VIDEO_WATERMARK_REQUIRED", False)


def _veo_pick_result_video_url(result: Dict[str, Any]) -> str:
    if not isinstance(result, dict):
        return ""
    for key in ("video_url", "share_url", "url", "download_url", "videoUrl"):
        raw = str(result.get(key) or "").strip()
        if raw and not raw.startswith("data:") and re.match(r"^https?://", raw, flags=re.I):
            return raw
    result_urls = result.get("result_urls")
    if isinstance(result_urls, (list, tuple)):
        for item in result_urls:
            raw = str(item or "").strip()
            if raw and not raw.startswith("data:") and re.match(r"^https?://", raw, flags=re.I):
                return raw
    outputs = result.get("outputs")
    if isinstance(outputs, (list, tuple)):
        for item in outputs:
            raw = _veo_pick_result_video_url(item) if isinstance(item, dict) else str(item or "").strip()
            if raw and re.match(r"^https?://", raw, flags=re.I):
                return raw
    return ""


def _veo_set_result_video_url(result: Dict[str, Any], url: str, *, original_url: str, meta: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(result or {})
    clean_url = str(url or "").strip()
    if not clean_url:
        return out
    for key in ("video_url", "share_url", "url"):
        if key in out or key == "video_url":
            out[key] = clean_url
    result_urls = out.get("result_urls")
    if isinstance(result_urls, list) and result_urls:
        out["result_urls"] = [clean_url if str(item or "").strip() == original_url else item for item in result_urls]
        if clean_url not in out["result_urls"]:
            out["result_urls"].insert(0, clean_url)
    else:
        out["result_urls"] = [clean_url]
    out["watermark_removed"] = True
    out["watermark_removed_url"] = clean_url
    out["original_watermarked_video_url"] = original_url
    out["watermark_remove_meta"] = meta
    return out


async def _veo_remove_result_video_watermark(
    result: Dict[str, Any],
    *,
    payload: Dict[str, Any],
    project_id: str,
    model_key: str = "",
    progress_cb: ProgressCB,
    log_file: Path,
) -> Dict[str, Any]:
    if not _veo_video_watermark_remove_enabled(payload):
        return result
    if bool(getattr(app_config, "skip_video_watermark_remove", False)):
        append_log(log_file, "[veo][video-wm] skipped by admin switch; keep original video")
        if not isinstance(result, dict):
            return result
        out = dict(result)
        out["watermark_removed"] = False
        out["watermark_remove_skipped"] = True
        out["watermark_remove_error"] = "skipped by admin switch"
        return out

    total_timeout = _veo_float_env(
        "VEO_REMOVE_VIDEO_WATERMARK_TOTAL_TIMEOUT_SECONDS",
        120.0,
        min_value=1.0,
        max_value=7200.0,
    )
    try:
        return await asyncio.wait_for(
            _veo_remove_result_video_watermark_impl(
                result,
                payload=payload,
                project_id=project_id,
                model_key=model_key,
                progress_cb=progress_cb,
                log_file=log_file,
            ),
            timeout=total_timeout,
        )
    except asyncio.TimeoutError:
        append_log(log_file, f"[veo][video-wm] remove timed out after {total_timeout:.1f}s; keep original video")
        if not isinstance(result, dict):
            return result
        out = dict(result)
        out["watermark_removed"] = False
        out["watermark_remove_error"] = f"watermark remove timed out after {total_timeout:.1f}s"
        return out


async def _veo_remove_result_video_watermark_impl(
    result: Dict[str, Any],
    *,
    payload: Dict[str, Any],
    project_id: str,
    model_key: str = "",
    progress_cb: ProgressCB,
    log_file: Path,
) -> Dict[str, Any]:
    if not _veo_video_watermark_remove_enabled(payload):
        return result
    if not isinstance(result, dict):
        return result
    source_url = _veo_pick_result_video_url(result)
    if not source_url:
        return result

    required = _veo_video_watermark_remove_required(payload)
    download_url = _veo_rewrite_flow_content_url(source_url)
    service_url = str(
        payload.get("video_watermark_service_url")
        or os.environ.get("VEO_REMOVE_VIDEO_WATERMARK_SERVICE_URL")
        or f"{app_config.video_postprocess_service_base_url}/process-video"
    ).strip()
    process_timeout = _veo_float_env(
        "VEO_REMOVE_VIDEO_WATERMARK_PROCESS_TIMEOUT_SECONDS",
        1800.0,
        min_value=30.0,
        max_value=7200.0,
    )
    total_timeout = _veo_float_env(
        "VEO_REMOVE_VIDEO_WATERMARK_TOTAL_TIMEOUT_SECONDS",
        120.0,
        min_value=1.0,
        max_value=7200.0,
    )
    append_log(
        log_file,
        "[veo][video-wm] start "
        f"source={safe_trim(source_url, 260)!r} "
        f"download={safe_trim(download_url, 260)!r} "
        f"service={safe_trim(service_url, 260)!r} process_timeout={process_timeout}s total_timeout={total_timeout}s",
    )
    try:
        await progress_cb(98, {"stage": "remove_video_watermark_remote_start", "video_url": download_url, "service_url": service_url})
    except Exception:
        pass
    try:
        try:
            await progress_cb(99, {"stage": "remove_video_watermark_remote_process", "service_url": service_url})
        except Exception:
            pass
        form_data = {
            "video_url": download_url,
        }
        watermark_type = str(payload.get("watermark_type") or payload.get("video_watermark_type") or "").strip()
        if watermark_type:
            form_data["watermark_type"] = watermark_type
        async with httpx.AsyncClient(timeout=httpx.Timeout(process_timeout, connect=20.0, read=process_timeout)) as client:
            response = await client.post(service_url, data=form_data)
            response.raise_for_status()
            service_result = response.json()
        if not isinstance(service_result, dict) or service_result.get("ok") is False:
            raise RuntimeError(f"watermark service returned failure: {safe_trim(str(service_result), 500)}")
        clean_url = str(
            service_result.get("video_url")
            or service_result.get("watermark_removed_url")
            or ""
        ).strip()
        if not clean_url:
            raise RuntimeError(f"watermark service returned no video_url: {safe_trim(str(service_result), 500)}")
        meta = service_result.get("meta") if isinstance(service_result.get("meta"), dict) else {}
        meta = dict(meta)
        meta["service_url"] = service_url
        meta["service_response"] = {k: v for k, v in service_result.items() if k != "meta"}
        append_log(
            log_file,
            "[veo][video-wm] remote processed "
            f"frames={meta.get('frame_count') or meta.get('frames')} "
            f"roi={meta.get('roi')} margin=({meta.get('roi_margin_right')},{meta.get('roi_margin_bottom')}) "
            f"kind={meta.get('watermark_kind')} score={meta.get('detection_score')}",
        )
        if service_result.get("storage_object_key"):
            meta["storage_object_key"] = service_result.get("storage_object_key")
        append_log(log_file, f"[veo][video-wm] removed source={safe_trim(source_url, 220)!r} -> {safe_trim(clean_url, 260)!r}")
        try:
            await progress_cb(100, {"stage": "remove_video_watermark_done", "video_url": clean_url})
        except Exception:
            pass
        return _veo_set_result_video_url(result, clean_url, original_url=source_url, meta=meta)
    except Exception as e:
        append_log(log_file, f"[veo][video-wm] remove failed: {e}")
        if required:
            raise NonPenalizedTaskError(f"VEO 视频去水印失败：{safe_trim(str(e), 500)}", status_code=502) from e
        out = dict(result)
        out["watermark_removed"] = False
        out["watermark_remove_error"] = safe_trim(str(e), 500)
        return out

# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------
def _short_err_msg(err: Any, *, max_len: int = 120) -> str:
    try:
        s = str(err or "").strip()
    except Exception:
        s = ""
    if not s:
        return ""
    if len(s) <= max_len:
        return s
    return s[: max(10, max_len - 3)] + "..."

_VEO_CONTENT_VIOLATION_REASON_MESSAGES = {
    "PUBLIC_ERROR_UNSAFE_GENERATION": "生成失败，内容包含PUBLIC_ERROR_UNSAFE_GENERATION(不安全的)内容，请手动再试一次。",
    # Veo 轮询失败时插件会把 mediaStatus.status 写入错误文本；
    # 该状态包含音频/内容过滤等审核失败（例如 PUBLIC_ERROR_AUDIO_FILTERED）。
    "MEDIA_GENERATION_STATUS_FAILED": "视频生成失败，内容审核未通过[MEDIA_GENERATION_STATUS_FAILED]",
    # flow/uploadImage 在参考图疑似包含未成年人/儿童照片时返回此 reason。
    "PUBLIC_ERROR_MINOR_UPLOAD": "上传参考图失败，参考图中包含未成年人/儿童照片[PUBLIC_ERROR_MINOR_UPLOAD]",
    "PUBLIC_ERROR_SEXUAL": "上传参考图失败，参考图包含性相关违规内容[PUBLIC_ERROR_SEXUAL]",
    "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED": "上传参考图失败，参考图中包含公众人物/知名人物[PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED]",
    "VEO_REFERENCE_VIDEO_DURATION_VIOLATION": "参考视频时长不能超过30秒",
    # AI Studio（NARWHAL / nana-banana 图片模型）拒绝按提示词生成图片时返回：
    # "The model could not generate the image based on the prompt provided.
    #  You will not be charged for this request. Try rephrasing the prompt."
    # 该类属于模型主动拒绝、且明确“不计费”，应作为不惩罚的内容违规处理。
    "AI_STUDIO_IMAGE_GENERATION_REFUSED": "图片生成失败，模型无法根据当前提示词生成图片（未产生扣费），请调整或重述提示词后重试。",
}


# AI Studio 图片生成被模型拒绝时错误文本中出现的稳定特征串（大写匹配）。
_VEO_AI_STUDIO_IMAGE_REFUSAL_MARKERS = (
    "THE MODEL COULD NOT GENERATE THE IMAGE BASED ON THE PROMPT",
    "AI STUDIO 4K IMAGE GENERATION RETURNED NO IMAGE",
    "UNABLE TO SHOW THE GENERATED IMAGE",
)


_VEO_RUNTIME_GENERATION_FAILURE_MARKERS = (
    "Generation job finished with state: FAILED",
    "PUBLIC_ERROR_HIGH_TRAFFIC",
)


def _veo_generation_failure_should_be_runtime(err: Any) -> bool:
    try:
        text = str(err or "")
    except Exception:
        text = ""
    failure_reasons = _veo_extract_failure_reasons(err)
    haystack = f"{text}\n{failure_reasons}".upper()
    return any(marker.upper() in haystack for marker in _VEO_RUNTIME_GENERATION_FAILURE_MARKERS)


def _veo_content_violation_reason(err: Any) -> Optional[str]:
    try:
        s = str(err or "").strip()
    except Exception:
        s = ""
    if not s:
        return None
    haystack = s.upper()
    for reason in _VEO_CONTENT_VIOLATION_REASON_MESSAGES:
        if reason in haystack:
            return reason
    # AI Studio 图片模型主动拒绝生成（且明确不计费）：错误文本不含上述 reason 关键字，
    # 但包含稳定的拒绝特征串，单独识别并归为不惩罚的内容违规。
    if any(marker in haystack for marker in _VEO_AI_STUDIO_IMAGE_REFUSAL_MARKERS):
        return "AI_STUDIO_IMAGE_GENERATION_REFUSED"
    return None


def _veo_extract_failure_reasons(err: Any) -> str:
    """从插件错误信息中提取 VEO 返回的 mediaStatus.failureReasons。

    browser_extension/providers/veo_provider.js 会把失败详情格式化为：
    ``failureReasons=FINISH_REASON_...``；这里同时兼容 JSON/dict 风格的
    ``failureReasons`` / ``failure_reasons`` 字段。
    """
    values: List[str] = []

    def add(raw: Any) -> None:
        if raw is None:
            return
        if isinstance(raw, (list, tuple, set)):
            for item in raw:
                add(item)
            return
        s = str(raw or "").strip()
        if not s:
            return
        if s.startswith("[") and s.endswith("]"):
            try:
                parsed = json.loads(s)
                add(parsed)
                return
            except Exception:
                s = s[1:-1].strip()
        for part in re.split(r"[,，|]+", s):
            item = part.strip().strip("\"' ")
            if item and item not in values:
                values.append(item)

    for attr in ("failureReasons", "failure_reasons"):
        try:
            add(getattr(err, attr, None))
        except Exception:
            pass

    try:
        text = str(err or "")
    except Exception:
        text = ""
    if text:
        for m in re.finditer(
            r"['\"]?(?:failureReasons|failure_reasons)['\"]?\s*[:=]\s*(\[[^\]]*\]|[^;\r\n。]+)",
            text,
            flags=re.IGNORECASE,
        ):
            add(m.group(1))

    return ",".join(values)


def _veo_content_violation_message(reason: str, err: Any) -> str:
    if reason == "PUBLIC_ERROR_UNSAFE_GENERATION":
        failure_reasons = _veo_extract_failure_reasons(err)
        if failure_reasons:
            return f"生成失败，内容包含{failure_reasons}内容，请手动再试一次。"
    return _VEO_CONTENT_VIOLATION_REASON_MESSAGES.get(
        reason,
        f"VEO内容审核未通过（{reason}）",
    )

def _veo_parse_access_expires(raw: Any) -> Optional[datetime]:
    """解析 Labs / NextAuth 返回的 expires（ISO-8601、带 Z、或 SQLite 本地时间串）。"""
    s = str(raw or "").strip()
    if not s:
        return None
    if s.endswith("Z") and len(s) > 1:
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s.replace(" ", "T", 1))
        return dt
    except ValueError:
        pass
    try:
        if len(s) >= 19:
            return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        pass
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d")
    except ValueError:
        return None


def _veo_cached_access_still_valid(
    token: Optional[str],
    expires_raw: Optional[str],
    *,
    margin_seconds: float,
) -> bool:
    """若 mapping 上已有 access_token 且 expires 未到（预留 margin），则无需再开窗拉取。"""
    at = str(token or "").strip()
    if not at:
        return False
    exp_s = str(expires_raw or "").strip()
    if not exp_s:
        # auth/session 未给 expires、或仅存 session_token 时无法判断过期点，沿用缓存避免每次开窗
        return True
    dt = _veo_parse_access_expires(exp_s)
    if dt is None:
        return False
    margin = timedelta(seconds=max(0.0, float(margin_seconds)))
    if dt.tzinfo is None:
        return datetime.now() + margin < dt
    return datetime.now(timezone.utc) + margin < dt.astimezone(timezone.utc)


def _build_debug_progress_panel_script() -> str:
    """返回调试进度面板注入脚本（单实例，重复调用只更新内容）。"""
    return r"""
(payload) => {
  try {
    const PANEL_ID = "__veo_debug_progress_panel__";
    const STYLE_ID = "__veo_debug_progress_panel_style__";
    const safe = (v) => (v === null || v === undefined) ? "" : String(v);
    const data = {
      title: safe(payload && payload.title),
      updatedAt: safe(payload && payload.updatedAt),
      entries: Array.isArray(payload && payload.entries) ? payload.entries.map((x) => ({
        idx: safe(x && x.idx),
        ts: safe(x && x.ts),
        level: safe(x && x.level),
        text: safe(x && x.text),
      })) : [],
    };

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
#${PANEL_ID}{
position:fixed;top:16px;right:16px;z-index:2147483647;width:420px;
background:rgba(15,23,42,.95);color:#e5e7eb;border:1px solid rgba(148,163,184,.35);
border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:12px;font-family:Arial,sans-serif;
}
#${PANEL_ID}.min{width:220px}
#${PANEL_ID} .hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(148,163,184,.25)}
#${PANEL_ID} .ttl{font-weight:700;color:#f8fafc}
#${PANEL_ID} .btn{background:#334155;color:#f8fafc;border:0;border-radius:8px;padding:4px 8px;cursor:pointer}
#${PANEL_ID} .bd{padding:10px 12px;max-height:55vh;overflow:auto}
#${PANEL_ID} .it{padding:7px 8px;margin-bottom:6px;border-radius:8px;background:rgba(30,41,59,.75)}
#${PANEL_ID} .it.ok{border-left:3px solid #22c55e}
#${PANEL_ID} .it.warn{border-left:3px solid #f59e0b}
#${PANEL_ID} .it.err{border-left:3px solid #ef4444}
#${PANEL_ID} .meta{font-size:11px;color:#94a3b8;margin-bottom:3px}
#${PANEL_ID} .txt{white-space:pre-wrap;word-break:break-word;line-height:1.4}
#${PANEL_ID} .fts{padding:8px 12px;border-top:1px solid rgba(148,163,184,.2);color:#94a3b8}
      `.trim();
      document.documentElement.appendChild(style);
    }

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.innerHTML = `
        <div class="hdr">
          <span class="ttl"></span>
          <button class="btn tg" type="button">收起</button>
        </div>
        <div class="bd"></div>
        <div class="fts"></div>
      `;
      document.documentElement.appendChild(panel);
    }

    const ttl = panel.querySelector(".ttl");
    const bd = panel.querySelector(".bd");
    const fts = panel.querySelector(".fts");
    const tg = panel.querySelector(".tg");
    if (!ttl || !bd || !fts || !tg) return;

    ttl.textContent = data.title || "VEO 调试进度";
    bd.innerHTML = "";
    for (const e of data.entries) {
      const item = document.createElement("div");
      const lv = (e.level || "info").toLowerCase();
      let cls = "it";
      if (lv === "ok" || lv === "success") cls += " ok";
      else if (lv === "warn" || lv === "warning") cls += " warn";
      else if (lv === "err" || lv === "error" || lv === "fail") cls += " err";
      item.className = cls;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `#${safe(e.idx)}  ${safe(e.ts)}  [${lv || "info"}]`;

      const txt = document.createElement("div");
      txt.className = "txt";
      txt.textContent = safe(e.text);

      item.appendChild(meta);
      item.appendChild(txt);
      bd.appendChild(item);
    }

    fts.textContent = data.updatedAt ? `更新时间: ${data.updatedAt}` : "";
    try {
      bd.scrollTop = bd.scrollHeight;
    } catch (_e1) {}

    tg.onclick = () => {
      const min = panel.classList.toggle("min");
      bd.style.display = min ? "none" : "block";
      fts.style.display = min ? "none" : "block";
      tg.textContent = min ? "展开" : "收起";
    };
  } catch (_e) {
    // 忽略注入失败，避免影响主流程。
  }
}
"""


# ---------------------------------------------------------------------------
# VEO Session：按 window 维度缓存
# ---------------------------------------------------------------------------
_VEO_SESSIONS: Dict[str, "VeoSession"] = {}


def _veo_key(vendor: str, base_url: str, space_id: str, window_key: str) -> str:
    return "|".join([
        "veo",
        str(vendor or "").strip().lower(),
        str(base_url or "").strip().rstrip("/").lower(),
        str(space_id or "").strip(),
        str(window_key or "").strip(),
    ])


def _drop_veo_session(cache_key: str) -> None:
    k = (cache_key or "").strip()
    if not k:
        return
    _VEO_SESSIONS.pop(k, None)


class VeoSession:
    """按 window 维度缓存的 VEO 会话。

    复用同一个指纹浏览器窗口与 Playwright CDP 连接。
    """

    def __init__(self, cache_key: str, pw_ctx: PlaywrightBrowserContext) -> None:
        self.cache_key = cache_key
        self.pw_ctx = pw_ctx

        self.last_used_at: float = time.time()
        self.create_lock = asyncio.Lock()
        self._bring_drafts_lock = asyncio.Lock()

        self.idle_close_task: Optional[asyncio.Task] = None
        self.idle_close_disabled: bool = False

        self.monitor_log_path: Optional[str] = None
        self.idle_close_seconds: float = 30.0

        self.browser_open_args: list[str] = []
        self.browser_force_open: bool = False
        self.browser_headless: bool = False
        self.browser_pure_mode: bool = True

        self.debug_panel_seq: int = 0
        self.debug_panel_entries: list[Dict[str, str]] = []

        self.veo_short_access_token: Optional[str] = None
        self.veo_short_access_expires: Optional[str] = None
        self.veo_short_session_token: Optional[str] = None
        self.veo_short_email: Optional[str] = None
        self.veo_short_token_lock = asyncio.Lock()

    @property
    def _log_file(self) -> Path:
        if self.monitor_log_path:
            return Path(self.monitor_log_path)
        return MONITOR_LOG_FILE

    async def ensure_open(
        self,
        *,
        args: Optional[list[str]] = None,
        force_open: bool = False,
        headless: bool = False,
        acquire_bring_lock: bool = False,
        pure_mode: Optional[bool] = None,
    ) -> None:
        """确保指纹浏览器窗口已打开、CDP 已连接。"""
        self.last_used_at = time.time()
        pm = self.browser_pure_mode if pure_mode is None else bool(pure_mode)
        # 串行化窗口 open/close：避免并发 ensure_open 与 Cloudflare 自愈重启产生竞态。
        async def _inner() -> None:
            await self.pw_ctx.ensure_open(
                args=args, force_open=force_open, headless=headless, require_page=False, pure_mode=pm
            )
        if acquire_bring_lock:
            async with self._bring_drafts_lock:
                await _inner()
        else:
            await _inner()

    async def disconnect_playwright_under_bring_lock(self) -> None:
        """先占 _bring_drafts_lock，再占 pw_ctx.driver_lock，再断开 CDP（与 bring 及仅持 driver_lock 的页面逻辑互斥）。"""
        async with self._bring_drafts_lock:
            async with self.pw_ctx.driver_lock:
                await self.pw_ctx.disconnect_playwright_only()

    async def navigate_to(self, url: str, *, timeout_ms: int = 60_000) -> None:
        """导航到指定 URL。"""
        if self.pw_ctx.page is None:
            raise RuntimeError("page 未初始化，请先调用 ensure_open")
        try:
            await self.pw_ctx.page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        except Exception as e:
            raise NonPenalizedTaskError(f"打开 VEO 页面失败：{e}", status_code=400) from e

    async def page_fetch(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        json_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """在浏览器页面上下文中发起 fetch 请求（走指纹浏览器网络栈）。"""
        if self.pw_ctx.page is None:
            raise RuntimeError("page 未初始化，请先调用 ensure_open")
        return await page_fetch_json(
            self.pw_ctx.page,
            url=url,
            method=method,
            headers=headers or {"Accept": "application/json", "Content-Type": "application/json"},
            json_data=json_data,
            log_file=self._log_file,
        )

    # ------------------------------------------------------------------
    # 调试面板
    # ------------------------------------------------------------------
    async def _push_debug_progress(self, page: Any, text: str, *, level: str = "info") -> None:
        """向页面插件弹窗写入调试步骤；同一页面始终复用单个面板。"""
        return;
        if page is None:
            return
        try:
            msg = str(text or "").strip()
        except Exception:
            msg = ""
        if not msg:
            return
        self.debug_panel_seq += 1
        now_str = time.strftime("%H:%M:%S")
        self.debug_panel_entries.append(
            {
                "idx": str(self.debug_panel_seq),
                "ts": now_str,
                "level": str(level or "info"),
                "text": msg,
            }
        )
        if len(self.debug_panel_entries) > 80:
            self.debug_panel_entries = self.debug_panel_entries[-80:]
        payload = {
            "title": "VEO 调试进度",
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "entries": list(self.debug_panel_entries),
        }
        script = _build_debug_progress_panel_script()
        try:
            await page.evaluate(script, payload)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Cloudflare 检测 & 自愈
    # ------------------------------------------------------------------
    async def _is_cloudflare_page(self, page, *, deep: bool = False) -> bool:
        """判断当前页面是否为 Cloudflare 拦截/挑战页。"""
        if page is None:
            return False
        try:
            u = str(getattr(page, "url", "") or "").strip()
        except Exception:
            u = ""
        ul = u.lower()
        if "/cdn-cgi/" in ul:
            return True
        try:
            title = await page.title()
        except Exception:
            title = ""
        tl = (title or "").strip().lower()
        if "just a moment" in tl or "attention required" in tl:
            return True
        if not deep:
            return False
        try:
            html = await page.content()
        except Exception:
            html = ""
        hl = (html or "").lower()
        if "cloudflare" in hl and ("just a moment" in hl or "/cdn-cgi/" in hl or "cf-ray" in hl):
            return True
        if ("turnstile" in hl or "cf-challenge" in hl) and ("/cdn-cgi/" in hl or "cloudflare" in hl):
            return True
        return False

    async def raise_if_cloudflare_page_nonpenalized(
        self,
        page,
        *,
        stage: str,
        target_url: str,
        window_pool_google_relogin_db: Optional[Database] = None,
        window_pool_google_relogin_window_pk: Optional[int] = None,
        window_pool_google_relogin_timeout_ms: Optional[int] = None,
    ) -> None:
        """与 Sora `_raise_if_cloudflare_page_nonpenalized` 同类：bring 目标页 + 等待/重启，仍判定 CF 则抛 NonPenalizedTaskError（用于窗口池巡检）。

        window_pool_google_*：窗口池巡检时若检测到 Google 登录/选账号页，先按窗口凭据自动登录再 bring。
        """
        async with self._bring_drafts_lock:
            await self.ensure_open(args=self.browser_open_args, force_open=self.browser_force_open, headless=self.browser_headless, acquire_bring_lock=False)
            if (
                window_pool_google_relogin_db is not None
                and window_pool_google_relogin_window_pk is not None
                and int(window_pool_google_relogin_window_pk) > 0
            ):
                try:
                    to_ms = int(window_pool_google_relogin_timeout_ms or 120_000)
                except Exception:
                    to_ms = 120_000
                to_ms = max(45_000, min(to_ms, 240_000))
                await self._perform_google_relogin_if_stuck_on_accounts(
                    db=window_pool_google_relogin_db,
                    window_pk=int(window_pool_google_relogin_window_pk),
                    timeout_ms=to_ms,
                )
            await self._bring_target_page_to_front(
                refresh_target=False, drafts_url=target_url, acquire_bring_lock=False
            )
            try:
                th = (urlparse(target_url).netloc or "").strip().lower()
            except Exception:
                th = ""
            cur = self.pw_ctx.page
            for _ in range(2):
                if cur is None:
                    return
                if not await self._is_cloudflare_page(cur, deep=False):
                    return
                await self._bring_target_page_to_front(
                    refresh_target=False, drafts_url=target_url, acquire_bring_lock=False
                )
                cur = self.pw_ctx.page
                if cur is None:
                    return
            if await self._is_cloudflare_page(cur, deep=False):
                raise NonPenalizedTaskError(
                    f"当前页面为 Cloudflare 验证/拦截页，无法继续：{stage}",
                    status_code=503,
                )

    async def _try_click_cloudflare_checkbox(self, page) -> bool:
        """尝试点击 Cloudflare Turnstile challenge 的 checkbox。

        策略：
        1. frame.locator()：CDP 原生可穿透 shadow-root，尝试直接点击
        2. 坐标法：frame_element().bounding_box() 拿到 iframe 屏幕位置，
           模拟拟人化鼠标移动后 mouse.click() 点击 checkbox 坐标
        """
        log_file = (
            Path(self.monitor_log_path)
            if self.monitor_log_path
            else (MONITOR_LOG_FILE)
        )

        def _log(msg: str) -> None:
            try:
                append_log(log_file, f"[cf_checkbox] {msg}")
            except Exception:
                pass

        try:
            cf_frame = None
            try:
                for i, f in enumerate(page.frames):
                    fu = str(getattr(f, "url", "") or "")
                    if "challenges.cloudflare.com" in fu or "/cdn-cgi/" in fu:
                        cf_frame = f
                        _log(f"找到 cf_frame: frame[{i}]")
                        break
            except Exception as e:
                _log(f"遍历 page.frames 异常: {e}")

            if cf_frame is None:
                await self._push_debug_progress(page, "未发现 Cloudflare checkbox iframe", level="warn")
                return False

            # 策略1：frame.locator()（CDP 可穿 closed shadow-root）
            try:
                loc = cf_frame.locator("input[type='checkbox']")
                cnt = await loc.count()
                _log(f"策略1 locator count={cnt}")
                if cnt > 0:
                    await self._push_debug_progress(page, "发现了 checkbox（locator）", level="info")
                    await loc.first.click(force=True, timeout=1500)
                    _log("策略1 locator click 成功")
                    await self._push_debug_progress(page, "点击 checkbox 成功（locator）", level="ok")
                    return True
            except Exception as e:
                _log(f"策略1 locator 失败: {e}")
                await self._push_debug_progress(page, f"点击 checkbox 失败（locator）：{_short_err_msg(e)}", level="warn")

            # 策略2：坐标法 + 拟人化鼠标移动
            try:
                iframe_handle = await cf_frame.frame_element()
                box = await iframe_handle.bounding_box()
                if not (box and box.get("width", 0) > 0 and box.get("height", 0) > 0):
                    _log(f"策略2 bounding_box 无效: {box}")
                    return False

                target_x = box["x"] + 26.0
                target_y = box["y"] + box["height"] / 2.0
                _log(f"策略2 目标坐标: ({target_x:.1f}, {target_y:.1f})")
                await self._push_debug_progress(page, "发现了 checkbox（坐标法）", level="info")

                start_x = target_x + random.uniform(-80, 120)
                start_y = target_y + random.uniform(-50, 50)
                await page.mouse.move(start_x, start_y)
                await asyncio.sleep(random.uniform(0.08, 0.20))
                await page.mouse.move(target_x, target_y, steps=random.randint(6, 12))
                await asyncio.sleep(random.uniform(0.04, 0.12))
                await page.mouse.click(target_x, target_y)
                _log("策略2 坐标点击完成")
                await self._push_debug_progress(page, "点击 checkbox 成功（坐标法）", level="ok")
                return True
            except Exception as e:
                _log(f"策略2 坐标法异常: {e}")
                await self._push_debug_progress(page, f"点击 checkbox 失败（坐标法）：{_short_err_msg(e)}", level="warn")

        except Exception as e:
            _log(f"顶层异常: {e}")

        _log("所有策略均未成功点击 checkbox")
        await self._push_debug_progress(page, "checkbox 点击失败：所有策略已尝试", level="error")
        return False

    async def _wait_cloudflare_auto_pass(
        self,
        page,
        *,
        max_wait_seconds: float = 10.0,
        max_success_clicks: int = 2,
    ) -> bool:
        """等待 Cloudflare 可能自动放行，同时尝试点击 Turnstile checkbox。

        返回：
        - True: 超时后仍像 Cloudflare（可考虑重启）
        - False: 已不再像 Cloudflare（无需重启）
        """
        try:
            deadline = time.time() + max(0.0, float(max_wait_seconds))
        except Exception:
            deadline = time.time() + 10.0
        await asyncio.sleep(5.0)
        try:
            max_click_success = max(0, int(max_success_clicks))
        except Exception:
            max_click_success = 2
        poll_after_click = 6.0
        poll_idle = 1.0
        await self._push_debug_progress(page, "检测到 Cloudflare，开始等待自动放行并尝试点击 checkbox", level="warn")
        reported_click_fail = False
        consecutive_not_cf = 0
        clicked_success_count = 0
        while time.time() < deadline:
            try:
                is_closed = bool(getattr(page, "is_closed", lambda: False)())
            except Exception:
                is_closed = False
            if is_closed:
                return True

            try:
                still_cf = await self._is_cloudflare_page(page, deep=True)
            except Exception:
                still_cf = True
            if not still_cf:
                consecutive_not_cf += 1
                if consecutive_not_cf >= 2:
                    await self._push_debug_progress(page, "Cloudflare 已放行", level="ok")
                    return False
                await self._push_debug_progress(page, "Cloudflare 疑似已放行，进行二次确认", level="info")
                remain = deadline - time.time()
                if remain <= 0:
                    break
                try:
                    await asyncio.sleep(min(poll_idle, max(0.1, remain)))
                except Exception:
                    break
                continue
            consecutive_not_cf = 0

            clicked = False
            try:
                clicked = await self._try_click_cloudflare_checkbox(page)
            except Exception:
                pass
            if clicked:
                clicked_success_count += 1
                await self._push_debug_progress(
                    page,
                    f"checkbox 已点击（第 {clicked_success_count} 次），等待 Cloudflare 验证结果",
                    level="info",
                )
                if max_click_success > 0 and clicked_success_count >= max_click_success:
                    await self._push_debug_progress(
                        page,
                        f"checkbox 成功点击已达上限（{max_click_success} 次），提前结束等待",
                        level="warn",
                    )
                    try:
                        await asyncio.sleep(1.0)
                    except Exception:
                        pass
                    try:
                        still_cf_after_limit = await self._is_cloudflare_page(page, deep=True)
                    except Exception:
                        still_cf_after_limit = True
                    if not still_cf_after_limit:
                        await self._push_debug_progress(page, "Cloudflare 已放行", level="ok")
                        return False
                    return True
            elif not reported_click_fail:
                await self._push_debug_progress(page, "尚未成功点击 checkbox，继续重试", level="warn")
                reported_click_fail = True

            remain = deadline - time.time()
            if remain <= 0:
                break
            sleep_sec = poll_after_click if clicked else poll_idle
            try:
                await asyncio.sleep(min(sleep_sec, max(0.1, remain)))
            except Exception:
                break
        return True

    async def _restart_window_and_restore_single_drafts(self, *, drafts_url: str, target_host: str) -> Any:
        """关闭并重开指纹浏览器窗口（仅打开窗口，不连接 CDP/不查找页面）。"""
        log_file = (
            Path(self.monitor_log_path)
            if self.monitor_log_path
            else (MONITOR_LOG_FILE)
        )
        try:
            append_log(log_file, "[veo][drafts] detected cloudflare interstitial, restarting fp window once")
        except Exception:
            pass

        try:
            await self.pw_ctx.close()
        except Exception:
            pass
        try:
            await asyncio.sleep(0.5)
        except Exception:
            pass

        try:
            append_log(log_file, "[veo][drafts] reopen window only: skip cdp connect/page probing")
        except Exception:
            pass

        async with acquire_browser_open_slot(self.pw_ctx.base_url):
            try:
                rsp = await self.pw_ctx.fp_client.browser_open(
                    vendor=self.pw_ctx.vendor,
                    base_url=self.pw_ctx.base_url,
                    access_key=self.pw_ctx.access_key,
                    space_id=self.pw_ctx.space_id,
                    window_key=self.pw_ctx.window_key,
                    args=self.browser_open_args,
                    force_open=self.browser_force_open,
                    headless=self.browser_headless,
                    pure_mode=self.browser_pure_mode,
                )
                try:
                    code = int((rsp or {}).get("code", -1))
                except Exception:
                    code = -1
                try:
                    append_log(log_file, f"[veo][drafts] browser_open result code={code}")
                except Exception:
                    pass
            except Exception as e:
                try:
                    append_log(log_file, f"[veo][drafts] browser_open failed: {e}")
                except Exception:
                    pass

            try:
                self.pw_ctx.browser = None
                self.pw_ctx.context = None
                self.pw_ctx.page = None
                self.pw_ctx.cdp_endpoint = None
            except Exception:
                pass

            try:
                await asyncio.sleep(20.0)
            except Exception:
                pass

        try:
            await self.pw_ctx.ensure_open(
                args=self.browser_open_args,
                force_open=False,
                headless=self.browser_headless,
                require_page=False,
                pure_mode=self.browser_pure_mode,
            )
        except Exception as e:
            try:
                append_log(log_file, f"[veo][drafts] CDP reconnect after restart failed: {e}")
            except Exception:
                pass
        return None

    # ------------------------------------------------------------------
    # Login 按钮检测 & 点击
    # ------------------------------------------------------------------
    async def _maybe_click_login_button_if_prompted(self, page) -> tuple:
        has_login_button = False
        """尝试点击页面上的 Log in 按钮/链接（不依赖固定提示文案）。"""
        if page is None:
            return False, has_login_button

        try:
            await page.wait_for_load_state("domcontentloaded", timeout=4000)
        except Exception:
            pass

        scopes: list[Any] = [page]
        try:
            for fr in list(getattr(page, "frames", []) or []):
                if fr is not page and fr not in scopes:
                    scopes.append(fr)
        except Exception:
            pass

        login_name_re = re.compile(r"log\s*in", re.IGNORECASE)

        try:
            for sc in scopes:
                try:
                    if hasattr(sc, "get_by_role"):
                        btn_cnt = await sc.get_by_role("button", name=login_name_re).count()
                        link_cnt = await sc.get_by_role("link", name=login_name_re).count()
                        if (btn_cnt + link_cnt) > 0:
                            has_login_button = True
                            break
                    loc_probe = sc.locator('button, a, [role="button"], [role="link"]').filter(has_text=login_name_re)
                    if (await loc_probe.count()) > 0:
                        has_login_button = True
                        break
                except Exception:
                    continue
        except Exception:
            has_login_button = False

        if not has_login_button:
            await self._push_debug_progress(page, "未发现 Log in 按钮/链接", level="info")
            return False, has_login_button
        await self._push_debug_progress(page, "发现 Log in 按钮/链接，准备点击", level="info")

        for sc in scopes:
            try:
                scope_name = "page" if sc is page else "frame"
                if hasattr(sc, "get_by_role"):
                    try:
                        btn = sc.get_by_role("button", name=login_name_re)
                        await btn.first.click(timeout=3000)
                        await self._push_debug_progress(page, f"点击 Log in 成功（button/{scope_name}）", level="ok")
                        return True, has_login_button
                    except Exception as e:
                        await self._push_debug_progress(page, f"点击 Log in 失败（button/{scope_name}）：{_short_err_msg(e)}", level="warn")
                    try:
                        link = sc.get_by_role("link", name=login_name_re)
                        await link.first.click(timeout=3000)
                        await self._push_debug_progress(page, f"点击 Log in 成功（link/{scope_name}）", level="ok")
                        return True, has_login_button
                    except Exception as e:
                        await self._push_debug_progress(page, f"点击 Log in 失败（link/{scope_name}）：{_short_err_msg(e)}", level="warn")

                try:
                    loc2 = sc.locator('button, a, [role="button"], [role="link"]').filter(has_text=login_name_re)
                    await loc2.first.click(timeout=3000)
                    await self._push_debug_progress(page, f"点击 Log in 成功（text fallback/{scope_name}）", level="ok")
                    return True, has_login_button
                except Exception as e:
                    await self._push_debug_progress(page, f"点击 Log in 失败（text fallback/{scope_name}）：{_short_err_msg(e)}", level="warn")
            except Exception:
                continue

        await self._push_debug_progress(page, "点击 Log in 失败（全部策略）", level="error")
        return False, has_login_button

    async def _maybe_click_get_started_button_if_prompted(self, page) -> tuple:
        has_get_started = False
        """尝试点击页面上的 Get started 按钮/链接。"""
        if page is None:
            return False, has_get_started

        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass

        try:
            await page.wait_for_load_state("domcontentloaded", timeout=4000)
        except Exception:
            pass

        scopes: list[Any] = [page]
        try:
            for fr in list(getattr(page, "frames", []) or []):
                if fr is not page and fr not in scopes:
                    scopes.append(fr)
        except Exception:
            pass

        button_patterns = [
            ("Get started", re.compile(r"get\s*started", re.IGNORECASE)),
            ("使ってみる", re.compile(r"使ってみる")),
        ]

        matched_label: str = ""
        matched_re: Any = None

        try:
            for sc in scopes:
                try:
                    for label, pat in button_patterns:
                        if hasattr(sc, "get_by_role"):
                            btn_cnt = await sc.get_by_role("button", name=pat).count()
                            link_cnt = await sc.get_by_role("link", name=pat).count()
                            if (btn_cnt + link_cnt) > 0:
                                has_get_started = True
                                matched_label, matched_re = label, pat
                                break
                        loc_probe = sc.locator('button, a, [role="button"], [role="link"]').filter(has_text=pat)
                        if (await loc_probe.count()) > 0:
                            has_get_started = True
                            matched_label, matched_re = label, pat
                            break
                    if has_get_started:
                        break
                except Exception:
                    continue
        except Exception:
            has_get_started = False

        if not has_get_started:
            await self._push_debug_progress(page, "未发现 Get started / 使ってみる 按钮/链接", level="info")
            return False, has_get_started
        await self._push_debug_progress(page, f"发现 {matched_label} 按钮/链接，准备点击", level="info")

        for sc in scopes:
            try:
                scope_name = "page" if sc is page else "frame"
                if hasattr(sc, "get_by_role"):
                    try:
                        btn = sc.get_by_role("button", name=matched_re)
                        await btn.first.click(timeout=3000)
                        await self._push_debug_progress(page, f"点击 {matched_label} 成功（button/{scope_name}）", level="ok")
                        return True, has_get_started
                    except Exception as e:
                        await self._push_debug_progress(page, f"点击 {matched_label} 失败（button/{scope_name}）：{_short_err_msg(e)}", level="warn")
                    try:
                        link = sc.get_by_role("link", name=matched_re)
                        await link.first.click(timeout=3000)
                        await self._push_debug_progress(page, f"点击 {matched_label} 成功（link/{scope_name}）", level="ok")
                        return True, has_get_started
                    except Exception as e:
                        await self._push_debug_progress(page, f"点击 {matched_label} 失败（link/{scope_name}）：{_short_err_msg(e)}", level="warn")

                try:
                    loc2 = sc.locator('button, a, [role="button"], [role="link"]').filter(has_text=matched_re)
                    await loc2.first.click(timeout=3000)
                    await self._push_debug_progress(page, f"点击 {matched_label} 成功（text fallback/{scope_name}）", level="ok")
                    return True, has_get_started
                except Exception as e:
                    await self._push_debug_progress(page, f"点击 {matched_label} 失败（text fallback/{scope_name}）：{_short_err_msg(e)}", level="warn")
            except Exception:
                continue

        await self._push_debug_progress(page, f"点击 {matched_label} 失败（全部策略）", level="error")
        return False, has_get_started

    async def _click_google_gmail_account_row(self, p: Any) -> None:
        """Google「Choose an account」页：真实可点击区域多为外层 [role=link]，邮箱在 div[data-email]（见 Google 新版 DOM）。"""
        gmail_re = re.compile(r"@gmail\.com", re.I)
        timeout_ms = 15_000

        async def _try_click(locator: Any, *, force: bool = False) -> bool:
            try:
                n = await locator.count()
            except Exception:
                n = 0
            if n <= 0:
                return False
            el = locator.first
            try:
                await el.scroll_into_view_if_needed(timeout=timeout_ms)
            except Exception:
                pass
            try:
                await el.click(timeout=timeout_ms, force=force)
                return True
            except Exception:
                return False

        # 1) 账号行容器（DevTools：li > div[role=link][jsname=W3oRb] 包裹整行）
        if await _try_click(p.locator('[role="link"]:has(div[data-email*="@gmail.com"])')):
            return
        if await _try_click(p.locator('li:has(div[data-email*="@gmail.com"]) [role="link"]')):
            return
        # 2) jsname=bQiQze 的邮箱格（与 data-email 同节点，部分环境需 force）
        if await _try_click(p.locator('div[jsname="bQiQze"][data-email*="@gmail.com"]'), force=True):
            return
        if await _try_click(p.locator('div[data-email*="@gmail.com"]'), force=True):
            return
        # 3) 旧版 / 纯文案
        if await _try_click(p.locator("div").filter(has_text=gmail_re), force=True):
            return
        if await _try_click(p.locator("[role='listitem']").filter(has_text=gmail_re)):
            return
        # 5) DOM 原生 click（部分覆盖层会挡住 Playwright 合成点击）
        for sel in (
            '[role="link"]:has(div[data-email*="@gmail.com"])',
            'div[data-email*="@gmail.com"]',
        ):
            loc = p.locator(sel)
            try:
                if await loc.count() <= 0:
                    continue
                el = loc.first
                try:
                    await el.scroll_into_view_if_needed(timeout=timeout_ms)
                except Exception:
                    pass
                await el.evaluate("node => (node instanceof HTMLElement && node.click())")
                return
            except Exception:
                continue
        raise RuntimeError("未找到可点击的 @gmail.com 账号行")

    async def _maybe_click_google_account_picker_if_present(self, open_pages: list[tuple[Any, Any, str]]) -> bool:
        """若某标签页为 Google 账号选择（标题或 URL），置前并点击 @gmail.com 账号行。"""
        for _c, p, _u in open_pages:
            try:
                if bool(getattr(p, "is_closed", lambda: False)()):
                    continue
            except Exception:
                continue
            try:
                title = (await p.title() or "").strip().lower()
            except Exception:
                title = ""
            u_low = (_u or "").strip().lower()
            looks_google_account_ui = (
                "sign in - google accounts" in title
                or "choose an account" in title
                or (
                    "accounts.google.com" in u_low
                    and any(x in u_low for x in ("signin", "oauth", "selectaccount", "identifier"))
                )
            )
            if not looks_google_account_ui:
                continue
            try:
                await p.bring_to_front()
            except Exception:
                pass
            try:
                await self._click_google_gmail_account_row(p)
                await self._push_debug_progress(p, "Google 账号选择页：已点击 @gmail.com 账号行", level="ok")
                try:
                    await asyncio.sleep(1.5)
                except Exception:
                    pass
                return True
            except Exception as e:
                await self._push_debug_progress(
                    p, f"Google 账号选择页：点击 @gmail.com 失败：{_short_err_msg(e)}", level="warn"
                )
                return False
        return False

    async def _try_google_accounts_login_autofill(
        self,
        open_pages: list[tuple[Any, Any, str]],
        *,
        db: Database,
        window_pk: int,
        timeout_ms: int = 90_000,
    ) -> None:
        """在 accounts.google.com 标签页上按窗口凭据自动填密码/邮箱/TOTP（EFA 可选）。"""
        from .sora_plus_register_executor import (
            google_accounts_autofill_login_steps,
            resolve_window_platform_login_creds_optional_efa,
        )

        def _pg_closed(pg: Any) -> bool:
            try:
                return bool(getattr(pg, "is_closed", lambda: False)())
            except Exception:
                return True

        acc_page: Any = None
        for _c, p, u in open_pages:
            if _pg_closed(p):
                continue
            if "accounts.google.com" in (u or "").lower():
                acc_page = p
                break
        if acc_page is None:
            return

        try:
            creds = await resolve_window_platform_login_creds_optional_efa(db, window_pk=int(window_pk))
        except Exception as e:
            await self._push_debug_progress(
                acc_page, f"Google 自动登录：读取窗口凭据失败：{_short_err_msg(e)}", level="warn"
            )
            return

        try:
            await acc_page.bring_to_front()
        except Exception:
            pass

        async def _pcb(_n: int, data: Dict[str, Any]) -> None:
            msg = str((data or {}).get("msg") or "").strip()
            if msg:
                await self._push_debug_progress(acc_page, f"Google 自动登录：{msg}", level="info")

        await google_accounts_autofill_login_steps(
            acc_page,
            platform_username=str(creds.get("platform_username") or ""),
            platform_password=str(creds.get("platform_password") or ""),
            platform_efa=creds.get("platform_efa"),
            timeout_ms=int(timeout_ms),
            progress_cb=_pcb,
        )

    @staticmethod
    def _veo_is_page_closed(p: Any) -> bool:
        try:
            return bool(getattr(p, "is_closed", lambda: False)())
        except Exception:
            return True

    @staticmethod
    def _google_url_indicates_relogin_required(u: str) -> bool:
        ul = (u or "").strip().lower()
        if "accounts.google.com" not in ul:
            return False
        return any(
            x in ul
            for x in (
                "/signin",
                "/oauth",
                "selectaccount",
                "servicelogin",
                "/identifier",
                "challenge",
                "speedbump",
                "/v3/signin",
            )
        )

    async def _veo_snapshot_contexts_pages(self) -> tuple[list[Any], list[tuple[Any, Any, str]]]:
        """返回 (contexts, open_pages[(ctx,page,url)])。"""
        ctx0 = getattr(self.pw_ctx, "context", None)
        br0 = getattr(self.pw_ctx, "browser", None)
        try:
            ctxs0 = list(getattr(br0, "contexts", []) or [])
        except Exception:
            ctxs0 = []
        if ctx0 is not None and ctx0 not in ctxs0:
            ctxs0.insert(0, ctx0)
        open_pages0: list[tuple[Any, Any, str]] = []
        for c0 in (ctxs0 or []):
            try:
                pages0 = list(getattr(c0, "pages", []) or [])
            except Exception:
                pages0 = []
            for p0 in pages0:
                if self._veo_is_page_closed(p0):
                    continue
                try:
                    u0 = str(getattr(p0, "url", "") or "").strip()
                except Exception:
                    u0 = ""
                open_pages0.append((c0, p0, u0))
        return ctxs0, open_pages0

    async def _veo_detect_google_login_and_gmail_visible(self) -> tuple[bool, bool]:
        """检测当前是否处于 Google 登录/选账号相关页，以及可见文本中是否出现 @gmail.com。

        用于管理台「开号」合并按钮：有 @gmail.com（账号列表）时走连接置前+点选；否则走完整开号登录。
        """
        _, open_pages = await self._veo_snapshot_contexts_pages()
        if not open_pages:
            return False, False

        is_google = False
        chunks: list[str] = []
        for _c, p, u in open_pages:
            if self._veo_is_page_closed(p):
                continue
            ul = str(u or "").strip().lower()
            url_hit = self._google_url_indicates_relogin_required(ul) or ("google.com" in ul) 
            title_hit = False
            try:
                t = (await p.title() or "").strip().lower()
                title_hit = "sign in - google accounts" in t or "choose an account" in t
            except Exception:
                pass
            if not url_hit and not title_hit:
                continue
            is_google = True
            try:
                chunks.append(str(await p.inner_text(timeout=5000) or ""))
            except Exception:
                chunks.append("")

        if not is_google:
            return False, False

        blob = "\n".join(chunks).lower()
        has_gmail = "@gmail.com" in blob
        return True, has_gmail

    async def _perform_google_relogin_if_stuck_on_accounts(
        self,
        *,
        db: Database,
        window_pk: int,
        timeout_ms: int,
    ) -> None:
        """调用方须已持有 ``_bring_drafts_lock``：检测 Google 登录/选账号页并自动登录。"""
        _, open_pages = await self._veo_snapshot_contexts_pages()
        if not open_pages:
            return
        need = False
        for _c, p, u in open_pages:
            if self._google_url_indicates_relogin_required(str(u)):
                need = True
                break
        if not need:
            for _c, p, _u in open_pages:
                try:
                    if self._veo_is_page_closed(p):
                        continue
                    t = (await p.title() or "").strip().lower()
                    if "sign in - google accounts" in t or "choose an account" in t:
                        need = True
                        break
                except Exception:
                    continue
        if not need:
            return
        if await self._maybe_click_google_account_picker_if_present(open_pages):
            _, open_pages = await self._veo_snapshot_contexts_pages()
        await self._try_google_accounts_login_autofill(
            open_pages,
            db=db,
            window_pk=int(window_pk),
            timeout_ms=int(timeout_ms),
        )

    async def _nonpenalized_raise_if_google_account_logged_out(self, drafts_page: Any) -> None:
        """未走管理台「连接置前」自动登录时，若仍停留在 Google 登录相关页则视为被登出。"""
        _, open_pages = await self._veo_snapshot_contexts_pages()
        for _ctx, p, u in open_pages:
            ul = str(u or "").strip().lower()
            if self._google_url_indicates_relogin_required(ul):
                raise NonPenalizedTaskError("账号被登出", status_code=401)
            if not self._veo_is_page_closed(p):
                try:
                    t = (await p.title() or "").strip().lower()
                    if "sign in - google accounts" in t or "choose an account" in t:
                        raise NonPenalizedTaskError("账号被登出", status_code=401)
                except NonPenalizedTaskError:
                    raise
                except Exception:
                    pass
        if drafts_page is None or self._veo_is_page_closed(drafts_page):
            return
        try:
            du = str(getattr(drafts_page, "url", "") or "").strip().lower()
            if self._google_url_indicates_relogin_required(du):
                raise NonPenalizedTaskError("账号被登出", status_code=401)
            t = (await drafts_page.title() or "").strip().lower()
            if "sign in - google accounts" in t or "choose an account" in t:
                raise NonPenalizedTaskError("账号被登出", status_code=401)
        except NonPenalizedTaskError:
            raise
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 核心：将目标页面置前（完整照搬 sora 的 _bring_sora_drafts_to_front）
    # ------------------------------------------------------------------
    async def _bring_target_page_to_front(
        self,
        refresh_target=True,
        *,
        drafts_url: str,
        acquire_bring_lock: bool = True,
        google_login_db: Optional[Database] = None,
        google_login_window_pk: Optional[int] = None,
        google_login_timeout_ms: Optional[int] = None,
    ) -> None:
        """将目标页面置前，并尽量确保整个指纹浏览器实例只保留一个目标页面。

        需求背景：指纹浏览器可能开了多个标签页/窗口；即使 ensure_open 选中了可用 page，也不一定是目标页面。
        这里确保 drafts_url 在每次 ensure_open 后都会被 bring_to_front，
        且会关闭同一个指纹浏览器（同一 CDP 连接）内除 drafts_url 外的其它页面（包括其它站点、about:blank、新窗口、重复 drafts 等），
        尽量只保留一个目标页面以节省内存。

        acquire_bring_lock：为 False 时表示调用方已持有 ``_bring_drafts_lock``（避免与外层 ``async with`` 死锁）。

        google_login_db / google_login_window_pk：仅管理台「连接置前」接口传入；若同时有值，会在合并/关闭标签前执行选 @gmail.com 账号 + 自动填密码/邮箱/TOTP。

        未传入时：若 bring 结束后仍停留在 Google 登录/选账号页，抛出 ``NonPenalizedTaskError("账号被登出")``。
        """
        try:
            target_host = urlparse(drafts_url).netloc.strip().lower()
        except Exception:
            target_host = ""

        gl_db = google_login_db
        gl_wpk = google_login_window_pk
        try:
            gl_to = int(google_login_timeout_ms) if google_login_timeout_ms is not None else 90_000
        except Exception:
            gl_to = 90_000

        async def _inner() -> None:
            def _is_page_closed(p: Any) -> bool:
                try:
                    return bool(getattr(p, "is_closed", lambda: False)())
                except Exception:
                    return False

            def _safe_page_url(p: Any) -> str:
                try:
                    return str(getattr(p, "url", "") or "").strip()
                except Exception:
                    return ""

            def _safe_page_host(u: str) -> str:
                try:
                    return (urlparse(u).netloc or "").strip().lower()
                except Exception:
                    return ""

            async def _keep_only_one_drafts_page(keep_page: Any) -> Any:
                """关闭其它所有页面/多余 contexts，仅保留 keep_page。返回 keep_page。"""
                ctxs1, open_pages1 = await self._veo_snapshot_contexts_pages()
                keep_ctx = None
                for c1, p1, _u1 in open_pages1:
                    if p1 is keep_page:
                        keep_ctx = c1
                        break
                if keep_ctx is None:
                    try:
                        maybe_ctx = getattr(keep_page, "context", None)
                        keep_ctx = maybe_ctx() if callable(maybe_ctx) else maybe_ctx
                    except Exception:
                        keep_ctx = None

                for _c1, p1, _u1 in open_pages1:
                    if p1 is keep_page:
                        continue
                    try:
                        await p1.close()
                    except Exception:
                        pass

                if keep_ctx is not None:
                    for c1 in ctxs1:
                        if c1 is keep_ctx:
                            continue
                        try:
                            await c1.close()
                        except Exception:
                            pass

                try:
                    if keep_ctx is not None:
                        self.pw_ctx.context = keep_ctx
                except Exception:
                    pass
                return keep_page

            ctxs, open_pages = await self._veo_snapshot_contexts_pages()
            if not ctxs:
                return

            if gl_db is not None and gl_wpk is not None:
                if await self._maybe_click_google_account_picker_if_present(open_pages):
                    ctxs, open_pages = await self._veo_snapshot_contexts_pages()
                    if not ctxs:
                        return
                try:
                    await self._try_google_accounts_login_autofill(
                        open_pages,
                        db=gl_db,
                        window_pk=int(gl_wpk),
                        timeout_ms=gl_to,
                    )
                except Exception as e:
                    hint = open_pages[0][1] if open_pages else None
                    if hint is not None:
                        await self._push_debug_progress(
                            hint, f"Google 自动登录异常：{_short_err_msg(e)}", level="warn"
                        )
                ctxs, open_pages = await self._veo_snapshot_contexts_pages()
                if not ctxs:
                    return

            drafts_page = None
            cur_page = getattr(self.pw_ctx, "page", None)
            if cur_page is not None and not _is_page_closed(cur_page):
                cur_u0 = _safe_page_url(cur_page)
                if cur_u0.startswith(drafts_url):
                    drafts_page = cur_page

            if drafts_page is None:
                for _c, p, u in open_pages:
                    if u.startswith(drafts_url):
                        drafts_page = p
                        break

            if drafts_page is None:
                ctx_pref = getattr(self.pw_ctx, "context", None) or (ctxs[0] if ctxs else None)
                if ctx_pref is None:
                    return
                try:
                    drafts_page = await ctx_pref.new_page()
                except Exception:
                    return
                try:
                    await drafts_page.goto(drafts_url, wait_until="domcontentloaded")
                except Exception:
                    pass

            await self._push_debug_progress(drafts_page, "已选定目标页面，准备清理其它页面", level="info")

            drafts_page = await _keep_only_one_drafts_page(drafts_page)

            try:
                self.pw_ctx.page = drafts_page
            except Exception:
                pass
            try:
                await drafts_page.bring_to_front()
            except Exception:
                pass
            try:
                cur_u = str(getattr(drafts_page, "url", "") or "").strip()
            except Exception:
                cur_u = ""

            if refresh_target:
                try:
                    await drafts_page.reload(wait_until="domcontentloaded", timeout=30_000)
                    await self._push_debug_progress(drafts_page, "目标页面刷新完成", level="ok")
                except Exception:
                    await self._push_debug_progress(drafts_page, "目标页面刷新失败（将继续流程）", level="warn")
                    pass

                try:
                    await drafts_page.evaluate("() => { try { window.focus(); } catch(e) {} }")
                except Exception:
                    pass

                await asyncio.sleep(5.0)

            try:
                await drafts_page.mouse.click(5, 400)
                await asyncio.sleep(0.3)
            except Exception:
                pass

            # 若出现未登录提示，尽量先触发登录
            try:
                try:
                    page_html = await drafts_page.content()
                    if "Something went wrong. Please try again in a few minutes." in (page_html or ""):
                        await self._push_debug_progress(
                            drafts_page,
                            "检测到 Something went wrong 提示，先刷新目标页面",
                            level="warn",
                        )
                        try:
                            await drafts_page.goto(drafts_url, wait_until="domcontentloaded")
                        except Exception:
                            pass
                        try:
                            await asyncio.sleep(2.0)
                        except Exception:
                            pass
                except Exception:
                    pass

                clicked, has_get_started = await self._maybe_click_get_started_button_if_prompted(drafts_page)
                if clicked:
                    try:
                        await asyncio.sleep(3.0)
                    except Exception:
                        pass

                    try:
                        await drafts_page.goto(drafts_url, wait_until="domcontentloaded")
                    except Exception:
                        pass

                if not clicked and has_get_started:
                    await self._push_debug_progress(drafts_page, "重新再试一次点击 Get started", level="ok")
                    try:
                        await drafts_page.goto(drafts_url, wait_until="domcontentloaded")
                    except Exception:
                        pass

                    clicked, has_get_started = await self._maybe_click_get_started_button_if_prompted(drafts_page)
                    if clicked:
                        await self._push_debug_progress(drafts_page, "重新再试一次点击 Get started 成功", level="ok")
                    else:
                        await self._push_debug_progress(drafts_page, "重新再试一次点击 Get started 失败", level="error")
            except Exception:
                pass

            # Cloudflare interstitial 自愈
            try:
                maybe_cf = await self._is_cloudflare_page(drafts_page, deep=False)
                if maybe_cf:
                    try:
                        await drafts_page.goto(drafts_url, wait_until="domcontentloaded")
                    except Exception:
                        pass
                    await asyncio.sleep(3.0)

                    await self._push_debug_progress(drafts_page, "页面疑似 Cloudflare，进入自愈流程", level="warn")
                    still_cf_after_wait = await self._wait_cloudflare_auto_pass(
                        drafts_page,
                        max_wait_seconds=45.0,
                        max_success_clicks=3,
                    )
                    if still_cf_after_wait and await self._is_cloudflare_page(drafts_page, deep=True):
                        await self._push_debug_progress(drafts_page, "Cloudflare 持续存在，准备重启窗口", level="warn")
                        await self._restart_window_and_restore_single_drafts(
                            drafts_url=drafts_url, target_host=target_host
                        )
                        try:
                            ctx_new = getattr(self.pw_ctx, "context", None)
                            br_new = getattr(self.pw_ctx, "browser", None)
                            ctxs_new: list[Any] = []
                            try:
                                ctxs_new = list(getattr(br_new, "contexts", []) or [])
                            except Exception:
                                pass
                            if ctx_new is not None and ctx_new not in ctxs_new:
                                ctxs_new.insert(0, ctx_new)

                            all_pages_new: list[tuple[Any, str]] = []
                            for c_n in ctxs_new:
                                try:
                                    ps = list(getattr(c_n, "pages", []) or [])
                                except Exception:
                                    ps = []
                                for p_n in ps:
                                    try:
                                        closed = bool(getattr(p_n, "is_closed", lambda: False)())
                                    except Exception:
                                        closed = False
                                    if closed:
                                        continue
                                    try:
                                        u_n = str(getattr(p_n, "url", "") or "").strip()
                                    except Exception:
                                        u_n = ""
                                    all_pages_new.append((p_n, u_n))

                            target_page_new: Any = None
                            for p_n, u_n in all_pages_new:
                                if u_n.startswith(drafts_url):
                                    target_page_new = p_n
                                    break
                            if target_page_new is None:
                                for p_n, u_n in all_pages_new:
                                    try:
                                        h_n = (urlparse(u_n).netloc or "").strip().lower()
                                    except Exception:
                                        h_n = ""
                                    if h_n == target_host:
                                        target_page_new = p_n
                                        break

                            if target_page_new is not None:
                                for p_n, _u_n in all_pages_new:
                                    if p_n is target_page_new:
                                        continue
                                    try:
                                        await p_n.close()
                                    except Exception:
                                        pass
                                try:
                                    self.pw_ctx.page = target_page_new
                                    drafts_page = target_page_new
                                except Exception:
                                    pass
                                try:
                                    await target_page_new.bring_to_front()
                                except Exception:
                                    pass
                                await self._push_debug_progress(
                                    drafts_page, "重启后已恢复目标页面并置前", level="ok"
                                )
                        except Exception:
                            pass
            except Exception:
                pass

            if gl_db is None or gl_wpk is None:
                await self._nonpenalized_raise_if_google_account_logged_out(drafts_page)

        if acquire_bring_lock:
            async with self._bring_drafts_lock:
                await _inner()
        else:
            await _inner()

    # ------------------------------------------------------------------
    # idle close / close_and_drop
    # ------------------------------------------------------------------
    def _cancel_idle_close(self) -> None:
        t = self.idle_close_task
        self.idle_close_task = None
        if t and not t.done():
            try:
                cur = asyncio.current_task()
            except Exception:
                cur = None
            if cur is not None and t is cur:
                return
            t.cancel()

    def _schedule_idle_close(self) -> None:
        if bool(self.idle_close_disabled):
            self._cancel_idle_close()
            return
        self._cancel_idle_close()

        async def _job():
            try:
                secs = max(0.0, float(self.idle_close_seconds))
                if secs <= 0:
                    return
                await asyncio.sleep(secs)
                if bool(self.idle_close_disabled):
                    return
                if self.create_lock.locked():
                    return
                await self.close_and_drop()
            except asyncio.CancelledError:
                return
            except Exception:
                return

        self.idle_close_task = asyncio.create_task(_job())

    async def close_and_drop(self) -> None:
        await self.close()
        _drop_veo_session(self.cache_key)

    async def close(self) -> None:
        self._cancel_idle_close()
        await self.pw_ctx.close_and_drop()


def get_or_create_veo_session(
    *,
    vendor: str,
    base_url: str,
    access_key: Optional[str],
    space_id: str,
    window_key: str,
) -> VeoSession:
    """获取/创建 VEO 会话（按 window 维度缓存，避免重复开浏览器）。"""
    k = _veo_key(vendor, base_url, space_id, window_key)
    sess = _VEO_SESSIONS.get(k)
    if sess is None:
        pw_ctx = get_or_create_playwright_ctx(
            vendor=vendor,
            base_url=base_url,
            access_key=access_key,
            space_id=space_id,
            window_key=window_key,
        )
        sess = VeoSession(cache_key=k, pw_ctx=pw_ctx)
        _VEO_SESSIONS[k] = sess
    else:
        sess.pw_ctx.access_key = access_key
    return sess


VEO_FLOW_OPEN_ACCOUNT_DEFAULT_URL = "https://labs.google/fx/ja/tools/flow"


async def veo_flow_open_account(
    progress_cb: ProgressCB,
    *,
    db: Database,
    window_pk: int,
    browser_vendor: str,
    browser_base_url: str,
    browser_access_key: Optional[str],
    space_id: str,
    window_key: str,
    timeout_seconds: float,
    flow_url: Optional[str] = None,
    headless: bool = False,
    pure_mode: bool = True,
) -> Dict[str, Any]:
    """按窗口凭据完成 Google 登录，打开 Google Flow，再断开本地 CDP（保留指纹浏览器窗口）。"""
    from .sora_plus_register_executor import (
        _do_login_flow,
        _is_already_logged_in,
        _pick_platform_domain_page,
        _resolve_window_platform_credentials,
    )

    creds = await _resolve_window_platform_credentials(db, window_pk=int(window_pk))
    platform_url = str(creds["platform_url"] or "").strip()
    platform_username = str(creds["platform_username"] or "").strip()
    platform_password = str(creds["platform_password"] or "").strip()
    platform_efa = str(creds["platform_efa"] or "").strip()

    target_flow = str(flow_url or "").strip() or VEO_FLOW_OPEN_ACCOUNT_DEFAULT_URL
    timeout_ms = int(max(10_000, min(float(timeout_seconds) * 1000, 120_000)))

    await progress_cb(1, {"stage": "resolve_credentials", "window_pk": int(window_pk)})

    sess = get_or_create_veo_session(
        vendor=browser_vendor,
        base_url=browser_base_url,
        access_key=browser_access_key,
        space_id=space_id,
        window_key=window_key,
    )
    sess.browser_headless = headless
    sess.browser_pure_mode = pure_mode
    sess.idle_close_disabled = True
    try:
        sess._cancel_idle_close()
    except Exception:
        pass

    await sess.ensure_open(args=[], force_open=False, headless=headless)

    ctx = sess.pw_ctx
    async with ctx.driver_lock:
        if ctx.context is None:
            raise RuntimeError("浏览器上下文不可用：context is None")
        page = await _pick_platform_domain_page(ctx.context, platform_url=platform_url)
        ctx.page = page

        await page.goto(platform_url, wait_until="domcontentloaded", timeout=timeout_ms)
        await progress_cb(10, {"stage": "page_loaded", "url": platform_url})

        current_url = str(page.url or "").strip()
        if _is_already_logged_in(current_url):
            await progress_cb(55, {"stage": "already_logged_in", "current_url": current_url})
        else:
            await progress_cb(12, {"stage": "need_login", "current_url": current_url})
            await _do_login_flow(
                page,
                platform_username=platform_username,
                platform_password=platform_password,
                platform_efa=platform_efa,
                timeout_ms=timeout_ms,
                progress_cb=progress_cb,
            )
        print(f"target_flow: {target_flow}")
        await page.goto(target_flow, wait_until="domcontentloaded", timeout=timeout_ms)
        await progress_cb(90, {"stage": "flow_opened", "url": target_flow})

    try:
        br = getattr(ctx, "browser", None)
        pw = getattr(ctx, "playwright", None)
        try:
            ctx.browser = None
            ctx.context = None
            ctx.page = None
            ctx.cdp_endpoint = None
        except Exception:
            pass
        try:
            if br is not None:
                await br.close()
        except Exception:
            pass
        try:
            if pw is not None:
                await pw.stop()
        except Exception:
            pass
        try:
            ctx.playwright = None
        except Exception:
            pass
        await progress_cb(99, {"stage": "cdp_disconnected"})
    except Exception:
        pass

    return {
        "ok": True,
        "stage": "flow_ready",
        "platform_url": platform_url,
        "platform_username": platform_username,
        "flow_url": target_flow,
        "message": "已登录 Google 并打开 Flow，已断开 CDP",
    }


async def veo_admin_unified_open_or_connect(
    progress_cb: ProgressCB,
    *,
    db: Database,
    window_pk: int,
    browser_vendor: str,
    browser_base_url: str,
    browser_access_key: Optional[str],
    space_id: str,
    window_key: str,
    timeout_seconds: float,
    headless: bool,
    default_target_url: str,
    google_login_timeout_ms: int,
    pure_mode: bool = True,
) -> Dict[str, Any]:
    """??? VEO ??/??????????????? Google ??/??/EFA ?????

    ?????????? CDP ?? Playwright ??/? Google ???????????
    launcher ?? WS ???????????? storage????????????????
    """
    from .sora_plus_register_executor import resolve_window_platform_login_creds_optional_efa

    try:
        gl_ms = int(google_login_timeout_ms)
    except Exception:
        gl_ms = 120_000
    gl_ms = max(45_000, min(gl_ms, 240_000))

    creds = await resolve_window_platform_login_creds_optional_efa(db, window_pk=int(window_pk))
    google_account = str(creds.get("platform_username") or "").strip()
    google_password = str(creds.get("platform_password") or "")
    google_efa = str(creds.get("platform_efa") or "").strip()
    if not google_account or not google_password:
        raise NonPenalizedTaskError("??????? Google ???????????????", status_code=400)

    target_url = str(default_target_url or "").strip() or "https://labs.google/fx"
    sess = get_or_create_veo_session(
        vendor=browser_vendor,
        base_url=browser_base_url,
        access_key=browser_access_key,
        space_id=space_id,
        window_key=window_key,
    )
    sess.browser_headless = headless
    sess.browser_pure_mode = pure_mode
    sess.idle_close_disabled = True
    try:
        sess._cancel_idle_close()
    except Exception:
        pass

    await progress_cb(3, {"stage": "extension_connect", "target_url": target_url})
    client = await ensure_extension_connected_via_window(
        sess=sess,
        target_url="https://accounts.google.com/",
        space_id=space_id,
        window_key=window_key,
        wait_seconds=10.0,
        log_file=getattr(sess, "_log_file", None),
        force_open=getattr(sess, "browser_force_open", None),
        headless=headless,
        pure_mode=pure_mode,
        auto_triger_connection=True,
        google_account=google_account,
        google_password=google_password,
        google_efa=google_efa,
    )
    if client is None:
        raise NonPenalizedTaskError(f"?????????space_id={space_id!r} window_key={window_key!r}", status_code=503)

    await progress_cb(8, {"stage": "google_auto_login_dispatch", "account": google_account})
    result = await submit_extension_task(
        space_id=space_id,
        window_key=window_key,
        provider="veo",
        payload={
            "action": "google_auto_login",
            "workflow_kind": "google_auto_login",
            "target_url": target_url,
            "google_account": google_account,
            "google_password": google_password,
            "google_efa": google_efa,
        },
        progress_cb=progress_cb,
        timeout_seconds=max(float(timeout_seconds or 0), float(gl_ms) / 1000.0),
    )
    return {
        "ok": True,
        "branch": "extension_google_auto_login",
        "target_url": target_url,
        "message": "????? Google ?????????????? VEO/Flow ???",
        "result": result,
    }


# ---------------------------------------------------------------------------
# Google Labs / Flow：余额与档位（与 flow2api flow_client.get_credits 对齐）
# ---------------------------------------------------------------------------
VEO_GOOG_API_KEY = "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"
FLOW_LABS_CREDITS_URL = f"https://aisandbox-pa.googleapis.com/v1/credits?key={VEO_GOOG_API_KEY}"
# 刷新 VEO 额度时：新开标签页读取「Next update: Apr 22」或「Next update: Tomorrow」作为额度重置日
VEO_ONE_GOOGLE_AI_ACTIVITY_URL = "https://one.google.com/ai/activity?g1_landing_page=0"

FLOW_VIDEO_SUBMIT_T2V_URL = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText"
FLOW_FLOW_UPLOAD_IMAGE_URL = "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage"
FLOW_VIDEO_SUBMIT_I2V_START_IMAGE_URL = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage"
FLOW_VIDEO_SUBMIT_I2V_START_END_URL = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage"
FLOW_VIDEO_SUBMIT_R2V_URL = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages"
FLOW_VIDEO_POLL_URL = "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus"
FLOW_FLOW_UPSAMPLE_IMAGE_URL = "https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage"
FLOW_FLOW_WORKFLOWS_BASE_URL = "https://aisandbox-pa.googleapis.com/v1/flowWorkflows"
# Flow / Labs 当前常用 enterprise site key；动态解析失败时兜底（与 flow2api 一致）
VEO_RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV"

# 与 flow2api generation_handler gemini-3.1-flash-image-*（NARWHAL）一致
IMAGE_ASPECT_RATIO_LANDSCAPE = "IMAGE_ASPECT_RATIO_LANDSCAPE"
IMAGE_ASPECT_RATIO_PORTRAIT = "IMAGE_ASPECT_RATIO_PORTRAIT"
IMAGE_ASPECT_RATIO_SQUARE = "IMAGE_ASPECT_RATIO_SQUARE"
IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE = "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE"
IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR = "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR"
VEO_IMAGE_MODEL_NARWHAL = "NARWHAL"
# 与 flow2api generation_handler gemini-3.0-pro-image-*（GEM_PIX_2）一致
VEO_IMAGE_MODEL_GEM_PIX_2 = "GEM_PIX_2"
VEO_IMAGE_GENERATION_MAX_REFERENCE_IMAGES = 10
VEO_IMAGE_REFERENCE_MAX_PIXELS_4K = 3840 * 2160
UPSAMPLE_IMAGE_RESOLUTION_2K = "UPSAMPLE_IMAGE_RESOLUTION_2K"
UPSAMPLE_IMAGE_RESOLUTION_4K = "UPSAMPLE_IMAGE_RESOLUTION_4K"

PAYGATE_TIER_NOT_PAID = "PAYGATE_TIER_NOT_PAID"
PAYGATE_TIER_ONE = "PAYGATE_TIER_ONE"
PAYGATE_TIER_TWO = "PAYGATE_TIER_TWO"

def _veo_extract_project_id_from_url(url: str) -> Optional[str]:
    if not url:
        return None
    m = re.search(r"/tools/flow/project/([a-zA-Z0-9_-]+)", url)
    return m.group(1) if m else None

def _veo_project_page_url(*, project_id: str, hint_url: str) -> str:
    """构建 Flow 项目页 URL（保留 hint 中的语言前缀，如 /fx/zh/tools/flow/...）。"""
    pid = (project_id or "").strip()
    if not pid:
        return (hint_url or "").strip() or "https://labs.google/fx"
    hint = (hint_url or "").strip() or "https://labs.google/fx"
    try:
        p = urlparse(hint)
        origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else "https://labs.google"
    except Exception:
        origin = "https://labs.google"
    m = re.search(r"/fx/([a-z]{2})/tools/flow", hint, re.I)
    if m:
        return f"{origin}/fx/{m.group(1)}/tools/flow/project/{pid}"
    return f"{origin}/fx/tools/flow/project/{pid}"


def _veo_db_bool(value: Any, *, default: bool = False) -> bool:
    """解析 sqlite/mysql-ish boolean，避免字符串 "0" 被 bool("0") 误判为 True。"""
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


@dataclass
class _VeoKeepaliveWindow:
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


class VeoAccessKeepaliveRefresher:
    """VEO 窗口池 access_expires 保活与到期后 token 刷新调度器。

    策略：
    - 周期扫描只负责发现需要预约的窗口；
    - 创建“到期前 margin 文生图保活”任务时，同时创建“过期后 10 秒刷新 token”任务；
    - 因此 token 刷新不会依赖下一次 `_window_pool_reconcile_interval` 扫描，即使 DB 将
      reconcile 周期设置为 3600 秒，也不会出现 token 过期很久才刷新。
    """

    def __init__(
        self,
        *,
        db: Database,
        stop_event: asyncio.Event,
        signal_window_pool_replenish: Optional[Callable[[], None]] = None,
        keepalive_margin_seconds: float = 150.0,
        keepalive_timeout: float = 300.0,
        max_concurrency: int = 20,
    ) -> None:
        self.db = db
        self.stop_event = stop_event
        self.signal_window_pool_replenish = signal_window_pool_replenish
        self.keepalive_margin_seconds = float(keepalive_margin_seconds or 300.0)
        self.keepalive_timeout = float(keepalive_timeout or 300.0)
        self.max_concurrency = max(1, int(max_concurrency or 1))

        self.task: Optional[asyncio.Task] = None
        self.wake = asyncio.Event()
        self._semaphore = asyncio.Semaphore(self.max_concurrency)
        self._workers: set[asyncio.Task] = set()
        # (mapping_id, job_kind, expires_s)：同一个 mapping 可以同时有 keepalive + token_refresh。
        self._inflight_jobs: set[tuple[int, str, str]] = set()
        # mapping_id -> (sora_access_expires, attempted_at). 同一个 expires 只预约一次保活/刷新组合。
        self._attempted: dict[int, tuple[str, float]] = {}
        self._balance_refresh_cursor = 0
        self._next_balance_refresh_at = 0.0

    def start(self) -> None:
        """启动 VEO 保活调度器（幂等）。"""
        if self.task is not None and not self.task.done():
            try:
                self.wake_up()
            except Exception:
                pass
            return
        try:
            self.wake_up()  # 启动后立即扫描一次。
        except Exception:
            pass
        self.task = asyncio.create_task(self._loop(), name="veo_access_keepalive_refresher")

    def wake_up(self) -> None:
        """唤醒调度循环尽快重新扫描新 token/expires。"""
        try:
            self.wake.set()
        except Exception:
            pass

    async def stop(self) -> None:
        """停止调度器并取消已经预约但尚未执行的 VEO 保活/刷新任务。"""
        t = self.task
        self.task = None
        try:
            self.wake.set()
        except Exception:
            pass
        if t is not None and not t.done():
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        workers = list(self._workers)
        self._workers.clear()
        for wt in workers:
            if wt is not None and not wt.done():
                wt.cancel()
        if workers:
            try:
                await asyncio.gather(*workers, return_exceptions=True)
            except Exception:
                pass
        self._inflight_jobs.clear()
        self._attempted.clear()

    def _seconds_until_expiry(self, expires_raw: Any) -> Optional[float]:
        dt = _veo_parse_access_expires(expires_raw)
        if dt is None:
            return None
        if dt.tzinfo is None:
            return (dt - datetime.now()).total_seconds()
        return (dt.astimezone(timezone.utc) - datetime.now(timezone.utc)).total_seconds()

    def _row_to_picked(self, row: Dict[str, Any]) -> _VeoKeepaliveWindow:
        return _VeoKeepaliveWindow(
            mapping_id=int(row.get("mapping_id") or row.get("id")),
            window_pk=int(row.get("window_pk") or 0),
            window_key=str(row.get("window_key") or ""),
            task_code=str(row.get("task_code") or ""),
            task_concurrency=int(row.get("task_concurrency") or 1),
            threshold=int(row.get("continuous_error_threshold") or 3),
            close_window_threshold=int(row.get("continuous_error_close_window_threshold") or 3),
            timeout_seconds=int(row.get("timeout_seconds") or 1800),
            create_task_handler=str(row.get("create_task_handler") or ""),
            browser_vendor=str(row.get("browser_vendor") or "generic"),
            browser_base_url=str(row.get("browser_base_url") or ""),
            browser_access_key=row.get("browser_access_key"),
            space_id=str(row.get("space_id") or ""),
            sora_access_token=(str(row.get("sora_access_token") or "").strip() or None),
            sora_access_expires=(str(row.get("sora_access_expires") or "").strip() or None),
            default_target_url=(str(row.get("default_target_url") or "").strip() or None),
            window_ip=(str(row.get("window_ip") or "").strip() or None),
            headless=_veo_db_bool(row.get("headless"), default=False),
            pure_mode=_veo_db_bool(row.get("pure_mode"), default=True),
            error_retry_count=int(row.get("error_retry_count") or 0),
            project_id=(str(row.get("current_project_id") or "").strip() or None),
        )

    async def _try_reserve_mapping(self, mapping_id: int) -> bool:
        """为自动保活/刷新短暂预占 mapping，避免与普通任务同时使用同一窗口。"""
        mid = int(mapping_id)
        if mid <= 0:
            return False
        async with self.db._write_conn() as db:  # type: ignore[attr-defined]
            cur = await db.execute(
                """
                UPDATE task_type_windows
                SET inflight_slots = COALESCE(inflight_slots, 0) + 1,
                    error_cooldown_until = datetime('now','localtime', '+60 seconds'),
                    updated_at = datetime('now','localtime')
                WHERE id = ?
                  AND deleted = 0
                  AND enabled = 1
                  AND COALESCE(inflight_slots, 0) = 0
                """,
                (mid,),
            )
            await db.commit()
            return int(cur.rowcount or 0) > 0

    def _schedule_worker(self, row: Dict[str, Any], *, delay_seconds: float, job_kind: str) -> bool:
        try:
            mapping_id = int(row.get("mapping_id") or row.get("id") or 0)
        except Exception:
            mapping_id = 0
        if mapping_id <= 0:
            return False
        expires_s = str(row.get("sora_access_expires") or "").strip()
        if not expires_s:
            return False
        kind = str(job_kind or "").strip() or "keepalive"
        key = (mapping_id, kind, expires_s)
        if key in self._inflight_jobs:
            return False

        delay = max(0.0, float(delay_seconds or 0.0))
        coro = self._refresh_expired_access_token_after_delay(row, delay)
        name = f"veo_access_token_refresh_{mapping_id}"

        self._inflight_jobs.add(key)
        worker = asyncio.create_task(coro, name=name)
        self._workers.add(worker)

        def _done(t: asyncio.Task, job_key: tuple[int, str, str] = key) -> None:
            self._workers.discard(t)
            self._inflight_jobs.discard(job_key)
            try:
                exc = t.exception()
            except asyncio.CancelledError:
                return
            except Exception:
                return
            if exc is not None:
                logger.warning(
                    "veo access keepalive worker mapping=%s kind=%s err=%s",
                    job_key[0],
                    job_key[1],
                    exc,
                )

        worker.add_done_callback(_done)
        return True

    def _schedule_keepalive_with_token_refresh(
        self,
        row: Dict[str, Any],
        *,
        token_refresh_delay_seconds: float,
    ) -> tuple[bool, bool, bool]:
        try:
            mapping_id = int(row.get("mapping_id") or row.get("id") or 0)
        except Exception:
            mapping_id = 0
        if mapping_id <= 0:
            return False
        expires_s = str(row.get("sora_access_expires") or "").strip()
        if not expires_s:
            return False
        prev = self._attempted.get(mapping_id)
        if prev and prev[0] == expires_s:
            return False
        logger.info(
            "_schedule_keepalive_with_token_refresh scheduled: mapping_id=%d delay=%.1fs",
            mapping_id,
            token_refresh_delay_seconds,
        )
        # 同一个 expires 同时预约：1) 到期前 margin 文生图保活；2) 到期后 10s 刷新 token。
        self._attempted[mapping_id] = (expires_s, time.monotonic())

        token_ok = self._schedule_worker(
            row,
            delay_seconds=token_refresh_delay_seconds,
            job_kind="token_refresh",
        )

        double_token_ok = self._schedule_worker(
            row,
            delay_seconds=token_refresh_delay_seconds+60.0,
            job_kind="double_token_refresh",
        )

        if not token_ok:
            self._attempted.pop(mapping_id, None)
        return token_ok

    async def _sleep_or_stopped(self, delay_seconds: float) -> bool:
        delay = max(0.0, float(delay_seconds or 0.0))
        if delay <= 0:
            return self.stop_event.is_set()
        try:
            await asyncio.wait_for(self.stop_event.wait(), timeout=delay)
            return True
        except asyncio.TimeoutError:
            return self.stop_event.is_set()

    async def _refresh_expired_access_token_after_delay(
        self, row: Dict[str, Any], delay_seconds: float
    ) -> None:
        if await self._sleep_or_stopped(delay_seconds):
            return
        try:
            mapping_id = int(row.get("mapping_id") or row.get("id") or 0)
        except Exception:
            mapping_id = 0
        if mapping_id <= 0:
            return
        original_expires = str(row.get("sora_access_expires") or "").strip()
        try:
            ctx = await self.db.get_task_type_window_context(mapping_id)
        except Exception:
            ctx = None
        if not ctx:
            return
        current_expires = str(ctx.get("sora_access_expires") or "").strip()
        if current_expires != original_expires:
            logger.debug("veo expired token refresh skipped: mapping=%s expires changed", mapping_id)
            return
        await self._refresh_expired_access_token_one(row)

    async def _refresh_expired_access_token_one(self, row: Dict[str, Any]) -> None:
        async with self._semaphore:
            if self.stop_event.is_set():
                return
            picked = self._row_to_picked(row)
            if picked.create_task_handler != "veo_workflow":
                return
            if not picked.window_key or not picked.browser_base_url:
                return
            reserved = await self._try_reserve_mapping(picked.mapping_id)
            if not reserved:
                expires_s = str(row.get("sora_access_expires") or "").strip()
                prev = self._attempted.get(picked.mapping_id)
                if prev and prev[0] == expires_s:
                    self._attempted.pop(picked.mapping_id, None)
                logger.debug("veo expired token refresh skipped: mapping=%s already busy", picked.mapping_id)
                return
            try:
                project_id = str(picked.project_id or "").strip()
                project_page = _veo_project_page_url(
                    project_id=project_id,
                    hint_url=picked.default_target_url or "https://labs.google/fx",
                )
                sess = get_or_create_veo_session(
                    vendor=picked.browser_vendor,
                    base_url=picked.browser_base_url,
                    access_key=picked.browser_access_key,
                    space_id=picked.space_id,
                    window_key=picked.window_key,
                )
                sess.browser_headless = picked.headless
                sess.browser_pure_mode = picked.pure_mode
                sess.idle_close_disabled = True
                sess._cancel_idle_close()
                logger.info(
                    "veo expired token refresh start: mapping=%s expires=%s",
                    picked.mapping_id,
                    picked.sora_access_expires,
                )
                token_info = await veo_fetch_access_tokens_via_extension(
                    sess=sess,
                    target_url=project_page,
                    space_id=picked.space_id,
                    window_key=picked.window_key,
                    connect_wait_seconds=8.0,
                    token_timeout_seconds=min(45.0, max(10.0, self.keepalive_timeout)),
                    log_file=sess._log_file,
                    auto_triger_connection=True,
                    force_fetch=True,
                )
                access_token = str(
                    (token_info or {}).get("session_token")
                    or (token_info or {}).get("access_token")
                    or (token_info or {}).get("short_access_token")
                    or ""
                ).strip()
                expires = str(
                    (token_info or {}).get("expires")
                    or (token_info or {}).get("short_expires")
                    or ""
                ).strip() or None
                if not access_token:
                    raise RuntimeError("VEO extension did not return access/session token")
                await self.db.update_task_type_window(
                    mapping_id=picked.mapping_id,
                    sora_access_token=access_token,
                    sora_access_expires=expires,
                )
                logger.info(
                    "veo expired token refresh done: mapping=%s new_expires=%s",
                    picked.mapping_id,
                    expires,
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("veo expired token refresh failed: mapping=%s err=%s", picked.mapping_id, e)
            finally:
                try:
                    await self.db.release_mapping_slot(picked.mapping_id)
                except Exception:
                    pass

    async def _refresh_balance_one(self, row: Dict[str, Any]) -> bool:
        async with self._semaphore:
            if self.stop_event.is_set():
                return False
            picked = self._row_to_picked(row)
            if picked.create_task_handler != "veo_workflow":
                return False
            if not picked.window_key or not picked.browser_base_url:
                return False
            reserved = await self._try_reserve_mapping(picked.mapping_id)
            if not reserved:
                logger.debug("veo balance refresh skipped: mapping=%s already busy", picked.mapping_id)
                return False
            try:
                project_id = str(picked.project_id or "").strip()
                picked.default_target_url = _veo_project_page_url(
                    project_id=project_id,
                    hint_url=picked.default_target_url or "https://labs.google/fx",
                )
                logger.info(
                    "veo balance refresh start: mapping=%s target=%s",
                    picked.mapping_id,
                    picked.default_target_url,
                )
                info = await refresh_veo_balance_via_extension(
                    db=self.db,
                    picked=picked,
                    refresh_timeout_seconds=max(10.0, min(60.0, float(self.keepalive_timeout or 60.0))),
                    signal_window_pool_replenish=self.signal_window_pool_replenish,
                    auto_triger_connection=True,
                    force_refresh_token=False,
                )
                logger.info(
                    "veo balance refresh done: mapping=%s credits=%s",
                    picked.mapping_id,
                    (info or {}).get("credits") if info else None,
                )
                return bool(info)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("veo balance refresh failed: mapping=%s err=%s", picked.mapping_id, e)
                return False
            finally:
                try:
                    await self.db.release_mapping_slot(picked.mapping_id)
                except Exception:
                    pass

    async def _refresh_balances_round_robin(self, rows: List[Dict[str, Any]]) -> None:
        if not rows:
            self._balance_refresh_cursor = 0
            return
        rows = list(rows)
        start = self._balance_refresh_cursor % len(rows)
        ordered = rows[start:] + rows[:start]
        ok = 0
        skipped_or_failed = 0
        logger.info("veo balance refresh round start: windows=%d start=%d", len(ordered), start)
        for row in ordered:
            if self.stop_event.is_set():
                return
            try:
                if await self._refresh_balance_one(row):
                    ok += 1
                else:
                    skipped_or_failed += 1
            except asyncio.CancelledError:
                raise
            except Exception as e:
                skipped_or_failed += 1
                logger.warning("veo balance refresh mapping=%s err=%s", row.get("mapping_id") or row.get("id"), e)
            finally:
                self._balance_refresh_cursor += 1
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=random.uniform(0.1, 0.5))
                return
            except asyncio.TimeoutError:
                pass
        logger.info("veo balance refresh round done: ok=%d skipped_or_failed=%d", ok, skipped_or_failed)

    async def _loop(self) -> None:
        """VEO 窗口池：按扫描周期预约到期前保活，并同步预约过期后 token 刷新。"""
        while not self.stop_event.is_set():
            try:
                # 先清除旧唤醒信号再扫描；如果扫描过程中有新 token 写入并 wake_up，
                # 事件会保留到下面 wait 处，避免被扫描结束时误清掉。
                self.wake.clear()
                try:
                    r_sec, _ = await self.db.get_window_pool_maintainer_intervals_seconds(
                        create_task_handler="veo_workflow"
                    )
                    scan_interval = max(10.0, float(r_sec or 600.0))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    scan_interval = 600.0
                margin = max(1.0, float(self.keepalive_margin_seconds or 300.0))
                schedule_horizon = scan_interval + margin

                rows = await self.db._veo_keepalive_list_candidates()
                scheduled_token_refresh = 0
                now_mono = time.monotonic()
                # 简单清理，避免长期运行时 attempted 字典无限增长。
                if len(self._attempted) > 10000:
                    stale_before = now_mono - 2 * 86400.0
                    self._attempted = {
                        mid: item
                        for mid, item in self._attempted.items()
                        if float(item[1]) >= stale_before
                    }
                for row in rows:
                    try:
                        mapping_id = int(row.get("mapping_id") or row.get("id") or 0)
                    except Exception:
                        mapping_id = 0
                    if mapping_id <= 0:
                        continue
                    expires_s = str(row.get("sora_access_expires") or "").strip()
                    if not expires_s:
                        continue
                    seconds_left = self._seconds_until_expiry(expires_s)
                    if seconds_left is None:
                        continue
                    if seconds_left <= 0:
                        continue
                    if seconds_left <= schedule_horizon:
                        # 保活任务的理论执行点：expires - margin。
                        # token 刷新任务：理论保活点 + margin + 30s，等价于 expires + 30s。
                        # 如果进程启动/扫描时已经进入 margin，保活会立即跑，但刷新仍对齐 expires+50s，
                        # 避免被错误推迟到 now+margin+30s。
                        intended_keepalive_delay = seconds_left - margin
                        token_refresh_delay = max(0.0, intended_keepalive_delay + margin + 30.0)
                        token_ok = self._schedule_keepalive_with_token_refresh(
                            row,
                            token_refresh_delay_seconds=token_refresh_delay,
                        )
                        if token_ok:
                            scheduled_token_refresh += 1

                now_mono = time.monotonic()
                if now_mono >= self._next_balance_refresh_at:
                    self._next_balance_refresh_at = now_mono + scan_interval * 6
                    balance_rows = await self.db._veo_balance_refresh_list_candidates()
                    await self._refresh_balances_round_robin(balance_rows)

                if scheduled_token_refresh :
                    logger.info(
                        "veo access keepalive scheduled: token_refresh=%d scan_interval=%.1fs horizon=%.1fs",
                        scheduled_token_refresh,
                        scan_interval,
                        schedule_horizon,
                    )
                try:
                    await asyncio.wait_for(self.wake.wait(), timeout=scan_interval)
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.exception("veo access keepalive loop: %s", e)
                try:
                    await asyncio.wait_for(self.stop_event.wait(), timeout=30.0)
                    return
                except asyncio.TimeoutError:
                    pass



def _veo_payload_looks_like_i2v(payload: Dict[str, Any]) -> bool:
    """仅用于图生视频判定。"""
    vt = str(payload.get("video_type") or payload.get("veo_video_type") or "").strip().lower()
    if vt in ("i2v", "image_to_video", "img2vid", "img2video"):
        return True
    if str(payload.get("first_image_url") or payload.get("firstImageUrl") or "").strip():
        return True
    if str(payload.get("image_url") or payload.get("imageUrl") or "").strip():
        return True
    imgs = payload.get("images")
    if isinstance(imgs, list) and len(imgs) > 0:
        return True
    last_u = str(payload.get("last_image_url") or payload.get("lastImageUrl") or "").strip()
    if last_u:
        return True
    return False


def _veo_payload_has_image_generation_references(payload: Dict[str, Any]) -> bool:
    """仅用于图生图判定：`images` 为多参考图输入，单图字段仅在未传 `images` 时兼容。"""
    payload = payload or {}
    imgs = payload.get("images")
    if isinstance(imgs, list) and len(imgs) > 0:
        return True
    if str(payload.get("first_image_url") or payload.get("firstImageUrl") or "").strip():
        return True
    if str(payload.get("image_url") or payload.get("imageUrl") or "").strip():
        return True
    return False


def _veo_pick_orientation_from_ratio(ratio: Optional[str]) -> Optional[str]:
    """与 `sora_task_executor._pick_orientation_from_ratio` 一致：16:9→landscape，9:16→portrait。"""
    if not ratio:
        return None
    s = str(ratio).strip().lower().replace("：", ":")
    if "16:9" in s:
        return "landscape"
    if "9:16" in s:
        return "portrait"
    return None


def _veo_parse_pixel_pair_from_payload(payload: Dict[str, Any]) -> Optional[tuple[int, int]]:
    """从 payload 的宽高字段解析像素尺寸（宽×高）。"""
    pairs = (
        ("width", "height"),
        ("video_width", "video_height"),
        ("w", "h"),
    )
    for wk, hk in pairs:
        try:
            if payload.get(wk) is None or payload.get(hk) is None:
                continue
            w = int(float(payload.get(wk)))
            h = int(float(payload.get(hk)))
            if w > 0 and h > 0:
                return w, h
        except Exception:
            continue
    return None


def _veo_orientation_from_pixel_dimensions(w: int, h: int) -> Optional[str]:
    if w > h:
        return "landscape"
    if h > w:
        return "portrait"
    return None


def _veo_try_parse_wh_in_ratio_string(ratio: str) -> Optional[tuple[int, int]]:
    """比例串中的 `1920x1080` / `1080*1920` / `1080×1920` → (宽, 高)。"""
    s = str(ratio or "").strip()
    if not s:
        return None
    m = re.search(r"(\d+)\s*[xX*×]\s*(\d+)", s)
    if not m:
        return None
    try:
        a = int(m.group(1))
        b = int(m.group(2))
        if a > 0 and b > 0:
            return a, b
    except Exception:
        pass
    return None


def _veo_resolve_orientation_str(payload: Dict[str, Any]) -> Optional[str]:
    """横竖屏语义 `portrait` / `landscape`，与 Sora 一致优先「比例/宽高」，再 `orientation` / 显式 API 字段。

    顺序：
    1. `width`×`height`（及 video_width / w、h 等）
    2. `size_ratio` / `aspect_ratio` / `ratio` / `尺寸` 中的 `WxH` 子串
    3. 同上字段中的 `16:9` / `9:16`（与 Sora `_pick_orientation_from_ratio` 一致）
    4. `orientation`
    5. `video_aspect_ratio` / `aspectRatio` / `veo_aspect_ratio`（含横竖、PORTRAIT/LANDSCAPE）
    """
    payload = payload or {}

    wh = _veo_parse_pixel_pair_from_payload(payload)
    if wh:
        o = _veo_orientation_from_pixel_dimensions(wh[0], wh[1])
        if o:
            return o

    ratio = str(
        payload.get("size_ratio") or payload.get("aspect_ratio") or payload.get("ratio") or payload.get("尺寸") or ""
    ).strip() or None
    if ratio:
        wh2 = _veo_try_parse_wh_in_ratio_string(ratio)
        if wh2:
            o2 = _veo_orientation_from_pixel_dimensions(wh2[0], wh2[1])
            if o2:
                return o2
        lo = _veo_pick_orientation_from_ratio(ratio)
        if lo:
            return lo

    ori = str(payload.get("orientation") or "").strip().lower()
    if ori in ("portrait", "landscape"):
        return ori

    raw_ar = str(
        payload.get("video_aspect_ratio") or payload.get("aspectRatio") or payload.get("veo_aspect_ratio") or ""
    ).strip()
    if raw_ar:
        u = raw_ar.upper()
        if "PORTRAIT" in u or "竖" in raw_ar:
            return "portrait"
        if "LANDSCAPE" in u or "横" in raw_ar:
            return "landscape"

    return None


VIDEO_ASPECT_RATIO_LANDSCAPE = "VIDEO_ASPECT_RATIO_LANDSCAPE"
VIDEO_ASPECT_RATIO_PORTRAIT = "VIDEO_ASPECT_RATIO_PORTRAIT"

# 与 flow2api generation_handler MODEL_CONFIG 中 veo_3_1_i2v_s_fast_*_fl 对齐
VEO_I2V_MODEL_LANDSCAPE_FL = "veo_3_1_i2v_s_fast_fl"
VEO_I2V_MODEL_PORTRAIT_FL = "veo_3_1_i2v_s_fast_portrait_fl"
# 与 flow2api generation_handler 中 veo_3_1_r2v_fast / veo_3_1_r2v_fast_portrait（Ingredients 多图）对齐
VEO_R2V_MODEL_LANDSCAPE = "veo_3_1_r2v_fast_landscape"
VEO_R2V_MODEL_PORTRAIT = "veo_3_1_r2v_fast_portrait"
VEO_T2V_MODEL_FAST_PORTRAIT = "veo_3_1_t2v_fast_portrait"
VEO_T2V_MODEL_FAST = "veo_3_1_t2v_fast"
VEO_EXTENSION_ULTRA_BALANCE_THRESHOLD = 2000
VEO_EXTENSION_ULTRA_MODEL_KEYS = {
    VEO_I2V_MODEL_LANDSCAPE_FL,
    VEO_I2V_MODEL_PORTRAIT_FL,
    VEO_R2V_MODEL_LANDSCAPE,
    VEO_R2V_MODEL_PORTRAIT,
    VEO_T2V_MODEL_FAST_PORTRAIT,
    VEO_T2V_MODEL_FAST,
}


def _veo_resolve_i2v_aspect_ratio(payload: Dict[str, Any]) -> str:
    """I2V 的 aisandbox aspectRatio：与 T2V 相同规则，默认横屏。"""
    o = _veo_resolve_orientation_str(payload)
    if o == "portrait":
        return VIDEO_ASPECT_RATIO_PORTRAIT
    if o == "landscape":
        return VIDEO_ASPECT_RATIO_LANDSCAPE
    return VIDEO_ASPECT_RATIO_LANDSCAPE


def _veo_extract_url_from_image_item(item: Any) -> Optional[str]:
    if isinstance(item, str):
        u = item.strip()
        return u or None
    if isinstance(item, dict):
        for k in ("url", "image_url", "imageUrl", "src", "first_image_url", "firstImageUrl"):
            v = str(item.get(k) or "").strip()
            if v:
                return v
    return None


def _veo_collect_ingredients_image_urls(payload: Dict[str, Any]) -> List[str]:
    """Ingredients（R2V）参考图 URL：来自 `Ingredients_images`（或 `ingredients_images`），与 flow2api r2v 一致最多 3 张。"""
    payload = payload or {}
    raw = payload.get("Ingredients_images")
    if raw is None:
        raw = payload.get("ingredients_images")
    if not isinstance(raw, list):
        return []
    if len(raw) > 8:
        raise NonPenalizedTaskError("Ingredients 模式最多支持 8 张参考图", status_code=400, content_violation=True)
    out: List[str] = []
    for it in raw:
        u = _veo_extract_url_from_image_item(it)
        if not u:
            raise NonPenalizedTaskError("Ingredients_images 中存在无法解析的图片地址", status_code=400, content_violation=True)
        out.append(u)
    return out

def _veo_collect_ingredients_video_urls(payload: Dict[str, Any]) -> List[str]:
    """Ingredients/R2V 视频参考 URL，最多 1 个。

    业务入口只允许从 payload.video_url 读取参考视频；不要从其它
    ingredients/reference 字段兼容解析，避免误把结果视频地址等字段当成参考视频。
    """
    payload = payload or {}
    if "video_url" not in payload or payload.get("video_url") is None:
        return []
    video_url = str(payload.get("video_url") or "").strip()
    if not video_url:
        return []
    parsed = urlparse(video_url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        raise NonPenalizedTaskError(
            "payload.video_url 仅支持以 http:// 或 https:// 开头的视频地址",
            status_code=400,
            content_violation=True,
        )
    return [video_url]


def _veo_resolve_r2v_model(payload: Dict[str, Any]) -> tuple[str, str]:
    """R2V videoModelKey + aspectRatio，与 generation_handler 中 veo_3_1_r2v_fast* 一致。"""
    o = _veo_resolve_orientation_str(payload)
    if o is None:
        raw = (
            str(
                payload.get("model")
                or payload.get("veo_model")
                or payload.get("video_model")
                or payload.get("videoModelKey")
                or ""
            )
            .strip()
            .lower()
        )
        if "r2v_fast_portrait" in raw or raw == "veo_3_1_r2v_fast_portrait":
            o = "portrait"
        elif "r2v" in raw and "portrait" in raw:
            o = "portrait"

    if o == "portrait":
        return VEO_R2V_MODEL_PORTRAIT, VIDEO_ASPECT_RATIO_PORTRAIT
    return VEO_R2V_MODEL_LANDSCAPE, VIDEO_ASPECT_RATIO_LANDSCAPE


def _veo_collect_i2v_image_urls(payload: Dict[str, Any]) -> List[str]:
    """解析 1～2 张图 URL：优先 `images` 数组（顺序=首帧、尾帧），否则 first_image_url / image_url + last/end。"""
    payload = payload or {}
    imgs = payload.get("images")
    if isinstance(imgs, list) and len(imgs) > 0:
        if len(imgs) > 2:
            raise NonPenalizedTaskError("图生视频最多支持 2 张图片（首帧与尾帧）", status_code=400, content_violation=True)
        out: List[str] = []
        for it in imgs:
            u = _veo_extract_url_from_image_item(it)
            if not u:
                raise NonPenalizedTaskError("images 数组中存在无法解析的图片地址", status_code=400, content_violation=True)
            out.append(u)
        return out

    first = str(payload.get("first_image_url") or payload.get("firstImageUrl") or "").strip()
    if not first:
        first = str(payload.get("image_url") or payload.get("imageUrl") or "").strip()
    last = str(
        payload.get("last_image_url")
        or payload.get("lastImageUrl")
        or payload.get("end_image_url")
        or payload.get("endImageUrl")
        or ""
    ).strip()
    if last and not first:
        raise NonPenalizedTaskError(
            "图生视频不能只提供尾图：请提供首图 first_image_url（或 images[0]），"
            "顺序为 [首帧, 尾帧]",
            status_code=400,
        )
    urls: List[str] = []
    if first:
        urls.append(first)
    if last:
        urls.append(last)
    return urls


def _veo_collect_image_generation_reference_urls(payload: Dict[str, Any]) -> List[str]:
    """解析图片生成参考图 URL：优先 `images` 数组，兼容单图字段 `first_image_url` / `image_url`。"""
    payload = payload or {}
    imgs = payload.get("images")
    if isinstance(imgs, list) and len(imgs) > 0:
        if len(imgs) > VEO_IMAGE_GENERATION_MAX_REFERENCE_IMAGES:
            raise NonPenalizedTaskError(
                f"多图生图最多支持 {VEO_IMAGE_GENERATION_MAX_REFERENCE_IMAGES} 张参考图",
                status_code=400,
            )
        out: List[str] = []
        for it in imgs:
            u = _veo_extract_url_from_image_item(it)
            if not u:
                raise NonPenalizedTaskError("images 数组中存在无法解析的图片地址", status_code=400)
            out.append(u)
        return out

    first = str(payload.get("first_image_url") or payload.get("firstImageUrl") or "").strip()
    if not first:
        first = str(payload.get("image_url") or payload.get("imageUrl") or "").strip()
    if first:
        return [first]
    return []

def _veo_resolve_t2v_model(payload: Dict[str, Any]) -> tuple[str, str]:
    """返回 (videoModelKey, aspectRatio)。横竖屏与 Sora 一致：优先宽高/比例字段，再 model 显式指定。

    与 `sora_gen_video` 对齐的输入：`size_ratio` / `aspect_ratio` / `ratio` / `尺寸`、`width`×`height`、
    比例串内 `WxH`、`16:9`/`9:16`、`orientation`；另支持 `video_aspect_ratio` 等 API 字段。
    若以上均未判定，则回退解析 `model` / `videoModelKey` 是否含 `t2v_fast_portrait`。
    默认横屏 VEO_T2V_MODEL_FAST。
    """
    o = _veo_resolve_orientation_str(payload)
    if o is None:
        raw = (
            str(
                payload.get("model")
                or payload.get("veo_model")
                or payload.get("video_model")
                or payload.get("videoModelKey")
                or ""
            )
            .strip()
            .lower()
        )
        if "t2v_fast_portrait" in raw or raw == VEO_T2V_MODEL_FAST_PORTRAIT:
            o = "portrait"

    if o == "portrait":
        return VEO_T2V_MODEL_FAST_PORTRAIT, VIDEO_ASPECT_RATIO_PORTRAIT
    return VEO_T2V_MODEL_FAST, VIDEO_ASPECT_RATIO_LANDSCAPE


def _veo_payload_video_model_override(payload: Dict[str, Any]) -> Optional[str]:
    raw = (payload or {}).get("video_model")
    if raw is None:
        return None
    model = str(raw).strip()
    return model or None

def _veo_payload_video_model_is_omni(payload: Dict[str, Any]) -> bool:
    raw = (payload or {}).get("video_model")
    if raw is None:
        return False
    model = str(raw).strip()
    if model == _VEO_OMNI_T2V_MODEL or model == "veo-omni-flash":
        return True;
    return False

def _veo_payload_video_model_uses_r2v_for_i2v_refs(payload: Dict[str, Any]) -> bool:
    payload = payload or {}
    candidates = (
        payload.get("video_model"),
        payload.get("extension_model_key"),
        payload.get("model"),
        payload.get("veo_model"),
        payload.get("videoModelKey"),
    )
    for raw in candidates:
        model = str(raw or "").strip().lower()
        if model in {_VEO_OMNI_T2V_MODEL, _VEO_OMNI_VEDIT_MODEL}:
            return True
    return False

def _veo_payload_image_model_4k(payload: Dict[str, Any]) -> bool:
    resolution = (payload or {}).get("resolution")
    n_frames = (payload or {}).get("n_frames")
    if resolution is None:
        return False
    if n_frames is None:
        return False
    try:
        iv = int(float(n_frames))
    except Exception:
        iv = 0
    return str(resolution).strip().lower() == "4k" and iv == 1


def _veo_resolve_extension_video_model_and_aspect(
    payload: Dict[str, Any],
    *,
    want_ingredients: bool = False,
    want_i2v: bool = False,
    window_balance: Optional[int] = None,
) -> tuple[str, str]:
    payload = payload or {}
    if want_ingredients:
        model_key, video_aspect = _veo_resolve_r2v_model(payload)
    elif want_i2v:
        video_aspect = _veo_resolve_i2v_aspect_ratio(payload)
        model_key = (
            VEO_I2V_MODEL_PORTRAIT_FL
            if video_aspect == VIDEO_ASPECT_RATIO_PORTRAIT
            else VEO_I2V_MODEL_LANDSCAPE_FL
        )
    else:
        model_key, video_aspect = _veo_resolve_t2v_model(payload)

    override_model = _veo_payload_video_model_override(payload)
    if override_model:
        if override_model == _VEO_OMNI_T2V_MODEL:
            override_model = _VEO_OMNI_T2V_MODEL
        elif override_model == "veo-omni-flash":
            override_model = _VEO_OMNI_T2V_MODEL
        else:
            override_model = model_key;
        model_key = override_model

    try:
        balance_i = int(window_balance) if window_balance is not None else int(payload.get("remaining_quota"))
    except Exception:
        balance_i = 0
    if balance_i > VEO_EXTENSION_ULTRA_BALANCE_THRESHOLD and model_key in VEO_EXTENSION_ULTRA_MODEL_KEYS:
        model_key = f"{model_key}_ultra"
    return model_key, video_aspect

def veo_format_paygate_tier_label(tier: Optional[str]) -> str:
    """将 userPaygateTier 转为可读套餐名（与 flow2api manage.html formatAccountType 一致）。"""
    t = str(tier or "").strip()
    if not t or t in ("0", "PAYGATE_TIER_NOT_PAID"):
        # free账号
        return "0" 
    if t in ("1", "PAYGATE_TIER_ONE"):
        # pro账号
        return "1"
    if t in ("2", "PAYGATE_TIER_TWO"):
        # ultra账号
        return "2"
    return "-1" #其它类型


def _veo_normalize_credits_payload(data: Any) -> Dict[str, Any]:
    """解析 aisandbox /v1/credits 的 JSON（与 flow2api get_credits 字段一致）。"""
    if not isinstance(data, dict):
        raise RuntimeError("credits 返回格式异常")
    try:
        credits_i = int(data.get("credits") if data.get("credits") is not None else 0)
    except Exception:
        credits_i = 0
    tier_raw = data.get("userPaygateTier") or data.get("user_paygate_tier")
    tier_s = str(tier_raw).strip() if tier_raw is not None else None
    if tier_s == "":
        tier_s = None
    return {"credits": credits_i, "user_paygate_tier": tier_s, "raw": data}

def _veo_local_next_1505_datetime() -> datetime:
    """本地「下一次 01:05」：当前时刻若已过当天 01:05 则为明天 01:05，否则为今天 01:05。"""
    now = datetime.now()
    today_0305 = now.replace(hour=3, minute=5, second=0, microsecond=0)
    if now > today_0305:
        nd = now.date() + timedelta(days=1)
        return datetime(nd.year, nd.month, nd.day, 3, 5, 0)
    return today_0305


def _veo_local_next_0305_cooldown_str() -> str:
    """VEO 余额接口不返回到期时间时，按本地北京时间下一次 01:05:00 作为 cooldown_until。"""
    return _veo_local_next_1505_datetime().strftime("%Y-%m-%d %H:%M:%S")


def _veo_local_next_paid_or_free_cooldown_str(user_paygate_tier: Optional[str]) -> str:
    """余额接口不返回到期时间时：普通账号用下一次 03:05，付费会员用 7 天后的同一时间。"""
    tier = str(user_paygate_tier or "").strip()
    dt = _veo_local_next_1505_datetime()
    if tier and tier != PAYGATE_TIER_NOT_PAID:
        dt = dt + timedelta(days=7)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _veo_parse_proxy_url(proxy_url: str) -> Dict[str, str]:
    raw = str(proxy_url or "").strip()
    if not raw:
        return {}
    u = urlparse(raw if "://" in raw else f"http://{raw}")
    return {
        "scheme": (u.scheme or "http").lower(),
        "host": str(u.hostname or "").strip(),
        "port": str(u.port or (443 if (u.scheme or "").lower() == "https" else 80)),
        "username": unquote(u.username or ""),
        "password": unquote(u.password or ""),
    }


def _veo_chain_http_to_socks5h_get(
    *,
    system_proxy: str,
    window_proxy: str,
    url: str,
    headers: Dict[str, str],
    timeout: float = 45.0,
) -> tuple[int, str]:
    """本机 -> system_proxy(http/https CONNECT) -> window_proxy(socks5h) -> HTTPS GET。"""
    sp = _veo_parse_proxy_url(system_proxy)
    wp = _veo_parse_proxy_url(window_proxy)
    target = urlparse(url)
    if sp.get("scheme") not in ("http", "https"):
        raise RuntimeError("两层代理暂仅支持第一层 system_proxy 为 http/https")
    if wp.get("scheme") not in ("socks5", "socks5h", "socks"):
        raise RuntimeError("两层代理暂仅支持第二层 window_proxy 为 socks5/socks5h")
    if (target.scheme or "").lower() != "https":
        raise RuntimeError("VEO credits 两层代理仅支持 https 目标")
    if not sp.get("host") or not wp.get("host") or not target.hostname:
        raise RuntimeError("代理或目标 URL 缺少 host")

    def _read_until(sock: socket.socket, marker: bytes, limit: int = 65536) -> bytes:
        buf = b""
        while marker not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            if len(buf) > limit:
                raise RuntimeError("读取代理响应超限")
        return buf

    def _recvn(sock: socket.socket, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise RuntimeError("连接提前关闭")
            buf += chunk
        return buf

    with socket.create_connection((sp["host"], int(sp["port"])), timeout=timeout) as raw_sock:
        raw_sock.settimeout(timeout)
        sock: socket.socket = raw_sock
        if sp.get("scheme") == "https":
            sock = ssl.create_default_context().wrap_socket(raw_sock, server_hostname=sp["host"])
            sock.settimeout(timeout)
        connect_lines = [f"CONNECT {wp['host']}:{wp['port']} HTTP/1.1", f"Host: {wp['host']}:{wp['port']}"]
        if sp.get("username") or sp.get("password"):
            auth = base64.b64encode(f"{sp.get('username','')}:{sp.get('password','')}".encode()).decode()
            connect_lines.append(f"Proxy-Authorization: Basic {auth}")
        sock.sendall(("\r\n".join(connect_lines) + "\r\n\r\n").encode("ascii"))
        status_line = _read_until(sock, b"\r\n\r\n").split(b"\r\n", 1)[0].decode("iso-8859-1", "ignore")
        if " 200 " not in f" {status_line} ":
            raise RuntimeError(f"system_proxy CONNECT window_proxy 失败：{status_line}")

        sock.sendall(b"\x05\x02\x00\x02" if (wp.get("username") or wp.get("password")) else b"\x05\x01\x00")
        ver_method = _recvn(sock, 2)
        if ver_method[0] != 5 or ver_method[1] == 0xFF:
            raise RuntimeError("window_proxy SOCKS5 握手失败")
        if ver_method[1] == 2:
            user_b = wp.get("username", "").encode("utf-8")
            pwd_b = wp.get("password", "").encode("utf-8")
            sock.sendall(b"\x01" + bytes([len(user_b)]) + user_b + bytes([len(pwd_b)]) + pwd_b)
            if _recvn(sock, 2) != b"\x01\x00":
                raise RuntimeError("window_proxy SOCKS5 认证失败")
        elif ver_method[1] != 0:
            raise RuntimeError(f"window_proxy SOCKS5 不支持的认证方式：{ver_method[1]}")

        host_b = target.hostname.encode("idna")
        sock.sendall(b"\x05\x01\x00\x03" + bytes([len(host_b)]) + host_b + int(target.port or 443).to_bytes(2, "big"))
        rep = _recvn(sock, 4)
        if rep[0] != 5 or rep[1] != 0:
            raise RuntimeError(f"window_proxy SOCKS5 CONNECT 目标失败，rep={rep[1] if len(rep) > 1 else '?'}")
        if rep[3] == 1:
            _recvn(sock, 4)
        elif rep[3] == 3:
            _recvn(sock, _recvn(sock, 1)[0])
        elif rep[3] == 4:
            _recvn(sock, 16)
        _recvn(sock, 2)

        tls_sock = ssl.create_default_context().wrap_socket(sock, server_hostname=target.hostname)
        tls_sock.settimeout(timeout)
        path = (target.path or "/") + (f"?{target.query}" if target.query else "")
        req_headers = dict(headers or {})
        req_headers["Host"] = target.netloc
        req_headers["Connection"] = "close"
        req = f"GET {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in req_headers.items()) + "\r\n"
        tls_sock.sendall(req.encode("utf-8"))
        raw = b""
        while True:
            chunk = tls_sock.recv(65536)
            if not chunk:
                break
            raw += chunk
        head, _, resp_body = raw.partition(b"\r\n\r\n")
        head_text = head.decode("iso-8859-1", "ignore")
        try:
            status = int(head_text.split("\r\n", 1)[0].split()[1])
        except Exception:
            status = 0
        header_map: Dict[str, str] = {}
        for line in head_text.split("\r\n")[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                header_map[k.strip().lower()] = v.strip().lower()
        if header_map.get("transfer-encoding") == "chunked":
            out = b""
            rest = resp_body
            while True:
                line, _, rest = rest.partition(b"\r\n")
                size = int(line.split(b";", 1)[0], 16)
                if size <= 0:
                    break
                out += rest[:size]
                rest = rest[size + 2 :]
            resp_body = out
        enc = header_map.get("content-encoding", "")
        if "gzip" in enc:
            resp_body = gzip.decompress(resp_body)
        return status, resp_body.decode("utf-8", "replace")

async def veo_fetch_credits_by_proxy(
    *,
    sess: Optional["VeoSession"] = None,
    target_url: str,
    access_token: str,
    db: Any = None,
    picked: Any = None,
    log_file: Optional[Path] = None,
) -> Dict[str, Any]:
    """本地经两层代理 GET aisandbox /v1/credits，不再打开指纹浏览器窗口。"""
    tok = str(access_token or "").strip()
    if not tok:
        raise RuntimeError("缺少 access_token（请先获取并保存 access_token）")

    log_file = log_file or (Path(sess.monitor_log_path) if sess is not None and getattr(sess, "monitor_log_path", None) else MONITOR_LOG_FILE)

    async def _resolve_system_proxy() -> str:
        if db is None:
            return ""
        try:
            syscfg = await db.get_system_config()
            if bool(getattr(syscfg, "proxy_enabled", False)):
                return str(getattr(syscfg, "proxy_url", "") or "").strip()
        except Exception:
            return ""
        return ""

    async def _resolve_window_proxy() -> str:
        if db is None or picked is None:
            return ""
        window_pk = int(getattr(picked, "window_pk", 0) or 0)
        if window_pk <= 0:
            return ""
        try:
            async with db._read_conn() as conn:  # type: ignore[attr-defined]
                conn.row_factory = __import__("aiosqlite").Row
                cur = await conn.execute(
                    """
                    SELECT p.protocol, p.host, p.port, p.proxy_username, p.proxy_password
                    FROM windows w
                    JOIN proxies p ON p.deleted = 0 AND (
                         (COALESCE(w.proxy_id, 0) > 0 AND p.proxy_id = w.proxy_id)
                      OR (COALESCE(w.proxy_id, 0) = 0 AND TRIM(COALESCE(w.proxy_addr, '')) <> '' AND (
                           TRIM(COALESCE(p.last_ip, '')) = TRIM(w.proxy_addr)
                        OR TRIM(COALESCE(p.host, '')) = TRIM(w.proxy_addr)
                        OR TRIM(COALESCE(p.host, '') || ':' || COALESCE(p.port, '')) = TRIM(w.proxy_addr)
                      ))
                    )
                    WHERE w.id = ? AND w.deleted = 0
                    LIMIT 1
                    """,
                    (window_pk,),
                )
                row = await cur.fetchone()
            if not row:
                return ""
            proto = str(row["protocol"] or "socks5").strip().lower()
            if proto in ("socks", "socks5") or proto not in ("socks5h", "http", "https"):
                proto = "socks5h"
            host = str(row["host"] or "").strip()
            port = str(row["port"] or "").strip()
            if not host or not port:
                return ""
            user = quote(str(row["proxy_username"] or "").strip(), safe="")
            pwd = quote(str(row["proxy_password"] or "").strip(), safe="")
            auth = f"{user}:{pwd}@" if user or pwd else ""
            return f"{proto}://{auth}{host}:{port}"
        except Exception as e:
            append_log(log_file, f"[veo] resolve window proxy failed: {safe_trim(str(e), 200)}")
            return ""

    system_proxy = await _resolve_system_proxy()
    window_proxy = await _resolve_window_proxy()
    proxy_url = window_proxy or system_proxy or None
    headers = {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Authorization": f"Bearer {tok}",
        "Origin": "https://labs.google",
        "Referer": "https://labs.google/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "x-goog-api-key": VEO_GOOG_API_KEY,
        "x-client-data": "COPjygE=",
    }
    append_log(log_file, f"[veo] local credits proxy_system={'yes' if system_proxy else 'no'} proxy_window={'yes' if window_proxy else 'no'}")
    if system_proxy and window_proxy and _veo_parse_proxy_url(window_proxy).get("scheme") in ("socks", "socks5", "socks5h"):
        status, body_text = await asyncio.to_thread(
            _veo_chain_http_to_socks5h_get,
            system_proxy=system_proxy,
            window_proxy=window_proxy,
            url=FLOW_LABS_CREDITS_URL,
            headers=headers,
            timeout=45.0,
        )
        obj = json.loads(body_text) if body_text.strip() else {}
    else:
        client_kwargs: Dict[str, Any] = {"timeout": httpx.Timeout(45.0), "trust_env": True}
        if proxy_url:
            client_kwargs["proxy"] = proxy_url
        try:
            client = httpx.AsyncClient(**client_kwargs)
        except ImportError as e:
            if proxy_url and str(proxy_url).lower().startswith(("socks5://", "socks5h://", "socks4://")):
                raise RuntimeError("当前环境缺少 SOCKS 支持，请安装依赖：pip install 'httpx[socks]' socksio") from e
            raise
        async with client:
            try:
                resp = await client.get(FLOW_LABS_CREDITS_URL, headers=headers)
            except ImportError as e:
                if proxy_url and str(proxy_url).lower().startswith(("socks5://", "socks5h://", "socks4://")):
                    raise RuntimeError("当前环境缺少 SOCKS 支持，请安装依赖：pip install 'httpx[socks]' socksio") from e
                raise
            status, body_text = resp.status_code, resp.text
            obj = resp.json() if resp.text.strip() else {}
    if int(status or 0) >= 400:
        raise RuntimeError(f"查询 credits 失败：HTTP {status} {safe_trim(body_text, 400)}")
    out = _veo_normalize_credits_payload(obj)
    out["cooldown_until"] = _veo_local_next_0305_cooldown_str()
    return out


# ---------------------------------------------------------------------------
# 获取 token：长 token（浏览器 Cookie ST）与短 token（auth/session AT）
# ---------------------------------------------------------------------------
def _veo_extension_labs_url(target_url: str) -> str:
    """插件 content-script 只注入 labs.google；触发 WS 时统一落到 labs.google。"""
    raw = (target_url or "").strip() or "https://labs.google/fx"
    try:
        p = urlparse(raw)
        host = (p.netloc or "").lower()
        if p.scheme in ("http", "https") and (host == "labs.google" or host.endswith(".labs.google")):
            return raw
    except Exception:
        pass
    return "https://labs.google/fx"


VEO_FLOW_PAGE_URL_PREFIX = "https://labs.google/fx/tools/flow"


def _veo_input_token_params_result(
    *,
    access_token: Optional[str],
    access_expires: Optional[str],
    session_token: Optional[str],
    short_access_token: Optional[str],
    short_expires: Optional[str],
    target_url: str,
    current_url: str,
) -> Dict[str, Any]:
    session_tok = str(session_token or access_token or "").strip()
    short_tok = str(short_access_token or access_token or session_tok or "").strip()
    exp = str(access_expires or "").strip() or None
    short_exp = str(short_expires or exp or "").strip() or None
    return {
        "type": "veo_access_tokens",
        "source": "input_params",
        "access_token": session_tok or short_tok,
        "session_token": session_tok or short_tok,
        "expires": exp,
        "short_access_token": short_tok,
        "short_expires": short_exp,
        "target_url": target_url,
        "current_url": current_url,
        "required_url_prefix": VEO_FLOW_PAGE_URL_PREFIX,
        "token_fetch_skipped": True,
        "skip_reason": "current_page_not_flow",
    }


def _veo_extension_ids_from_session(
    sess: "VeoSession",
    *,
    space_id: Optional[str] = None,
    window_key: Optional[str] = None,
) -> tuple[str, str]:
    sid = str(space_id or getattr(getattr(sess, "pw_ctx", None), "space_id", "") or "").strip()
    wkey = str(window_key or getattr(getattr(sess, "pw_ctx", None), "window_key", "") or "").strip()
    if not sid or not wkey:
        raise RuntimeError("缺少插件连接标识：space_id/window_key")
    return sid, wkey

def is_accounts_google(url):
    parsed = urlparse(url)
    return parsed.netloc == "accounts.google.com"

def is_google_flow(url):
    parsed = urlparse(url)
    return parsed.netloc == "labs.google"

async def veo_fetch_access_tokens_via_extension(
    *,
    sess: "VeoSession",
    target_url: str,
    space_id: Optional[str] = None,
    window_key: Optional[str] = None,
    connect_wait_seconds: float = 8.0,
    token_timeout_seconds: float = 45.0,
    log_file: Optional[Path] = None,
    auto_triger_connection: Optional[bool] = True,
    access_token: Optional[str] = None,
    access_expires: Optional[str] = None,
    session_token: Optional[str] = None,
    short_access_token: Optional[str] = None,
    short_expires: Optional[str] = None,
    google_account: Optional[str] = None,
    google_password: Optional[str] = None,
    google_efa: Optional[str] = None,
    force_fetch: Optional[bool] = False,
) -> Dict[str, Any]:
    """通过浏览器插件读取 VEO long session-token 与 short access_token。"""
    sid, wkey = _veo_extension_ids_from_session(sess, space_id=space_id, window_key=window_key)
    log_file = log_file or (Path(sess.monitor_log_path) if getattr(sess, "monitor_log_path", None) else MONITOR_LOG_FILE)
    client = await ensure_extension_connected_via_window(
        sess=sess,
        target_url=target_url,
        space_id=sid,
        window_key=wkey,
        wait_seconds=connect_wait_seconds,
        log_file=log_file,
        auto_triger_connection = auto_triger_connection,
        google_account=google_account,
        google_password=google_password,
        google_efa=google_efa,
    )
    if client is None:
        raise NonPenalizedTaskError(
            f"浏览器插件未连接：space_id={sid!r} window_key={wkey!r}",
            status_code=503,
        )

    labs_target = _veo_extension_labs_url(target_url)
    try:
        page_info = await submit_extension_task(
            space_id=sid,
            window_key=wkey,
            provider="veo",
            payload={
                "action": "get_current_page",
                "workflow_kind": "get_current_page",
            },
            progress_cb=_noop_progress_cb,
            timeout_seconds=max(3.0, min(10.0, float(connect_wait_seconds or 8.0))),
        )
        current_url = str((page_info or {}).get("url") or "").strip()
        if not force_fetch and not is_google_flow(current_url):
            append_log(
                log_file,
                "[veo][token] current page is not flow page, skip extension token fetch "
                f"current_url={safe_trim(current_url, 300)!r} required_prefix={VEO_FLOW_PAGE_URL_PREFIX!r}",
            )
            return _veo_input_token_params_result(
                access_token="",
                access_expires="1999-00-20T07:00:00.000Z",
                session_token="",
                short_access_token="",
                short_expires="1999-00-20T07:00:00.000Z",
                target_url=target_url,
                current_url=current_url,
            )
    except Exception as e:
        append_log(log_file, f"[veo][token] check current page via extension failed, continue token fetch: {e}")

    info = await submit_extension_task(
        space_id=sid,
        window_key=wkey,
        provider="veo",
        payload={
            "action": "fetch_tokens",
            "workflow_kind": "fetch_tokens",
            "target_url": labs_target,
            "project_page": labs_target,
        },
        progress_cb=_noop_progress_cb,
        timeout_seconds=max(5.0, float(token_timeout_seconds or 45.0)),
    )
    if not isinstance(info, dict):
        raise RuntimeError(f"插件返回 token 格式异常：{info!r}")
    session_token = str(info.get("session_token") or info.get("access_token") or "").strip()
    short_at = str(info.get("short_access_token") or "").strip()
    if not session_token:
        raise NonPenalizedTaskError("插件未返回 VEO long session_token", status_code=401)
    if not short_at:
        raise NonPenalizedTaskError("插件未返回 VEO short access_token", status_code=401)

    try:
        sess.veo_short_access_token = short_at
        sess.veo_short_access_expires = str(info.get("short_expires") or "").strip() or None
        sess.veo_short_session_token = session_token
        sess.veo_short_email = str(info.get("email") or "").strip() or None
    except Exception:
        pass
    out = dict(info)
    out["access_token"] = session_token
    out["session_token"] = session_token
    out["short_access_token"] = short_at
    append_log(
        log_file,
        f"[veo][token] extension returned long_len={len(session_token)} short_len={len(short_at)}",
    )
    return out


async def force_fetch_access_token_in_window(
    *,
    sess: "VeoSession",
    target_url: str,
    google_account: Optional[str] = None,
    google_password: Optional[str] = None,
    google_efa: Optional[str] = None,
) -> Dict[str, Any]:
    """通过浏览器插件读取长效 Cookie token；必要时先用带 fpb_* URL 触发 WS。"""
    sess._cancel_idle_close()
    info = await veo_fetch_access_tokens_via_extension(
        sess=sess,
        target_url=target_url,
        connect_wait_seconds=8.0,
        token_timeout_seconds=45.0,
        log_file=Path(sess.monitor_log_path) if sess.monitor_log_path else MONITOR_LOG_FILE,
        google_account=google_account,
        google_password=google_password,
        google_efa=google_efa,
        force_fetch=True,
    )
    return {
        "access_token": str((info or {}).get("short_access_token") or (info or {}).get("access_token") or "").strip() or None,
        "session_token": str((info or {}).get("short_access_token") or (info or {}).get("access_token") or "").strip() or None,
        "expires": str((info or {}).get("short_expires") or "").strip() or None,
        "email": str((info or {}).get("email") or "").strip() or None,
        "short_access_token": str((info or {}).get("short_access_token") or "").strip() or None,
        "short_expires": str((info or {}).get("short_expires") or "").strip() or None,
        "source": str((info or {}).get("source") or "extension").strip() or "extension",
    }


async def _veo_resolve_system_proxy(db: Any) -> str:
    if db is None:
        return ""
    try:
        syscfg = await db.get_system_config()
        if bool(getattr(syscfg, "proxy_enabled", False)):
            return str(getattr(syscfg, "proxy_url", "") or "").strip()
    except Exception:
        return ""
    return ""


async def _veo_resolve_window_proxy(db: Any, picked: Any, log_file: Path) -> str:
    if db is None or picked is None:
        return ""
    window_pk = int(getattr(picked, "window_pk", 0) or 0)
    if window_pk <= 0:
        return ""
    try:
        async with db._read_conn() as conn:  # type: ignore[attr-defined]
            conn.row_factory = __import__("aiosqlite").Row
            cur = await conn.execute(
                """
                SELECT p.protocol, p.host, p.port, p.proxy_username, p.proxy_password
                FROM windows w
                JOIN proxies p ON p.deleted = 0 AND (
                     (COALESCE(w.proxy_id, 0) > 0 AND p.proxy_id = w.proxy_id)
                  OR (COALESCE(w.proxy_id, 0) = 0 AND TRIM(COALESCE(w.proxy_addr, '')) <> '' AND (
                       TRIM(COALESCE(p.last_ip, '')) = TRIM(w.proxy_addr)
                    OR TRIM(COALESCE(p.host, '')) = TRIM(w.proxy_addr)
                    OR TRIM(COALESCE(p.host, '') || ':' || COALESCE(p.port, '')) = TRIM(w.proxy_addr)
                  ))
                )
                WHERE w.id = ? AND w.deleted = 0
                LIMIT 1
                """,
                (window_pk,),
            )
            row = await cur.fetchone()
        if not row:
            return ""
        proto = str(row["protocol"] or "socks5").strip().lower()
        if proto in ("socks", "socks5") or proto not in ("socks5h", "http", "https"):
            proto = "socks5h"
        host = str(row["host"] or "").strip()
        port = str(row["port"] or "").strip()
        if not host or not port:
            return ""
        user = quote(str(row["proxy_username"] or "").strip(), safe="")
        pwd = quote(str(row["proxy_password"] or "").strip(), safe="")
        auth = f"{user}:{pwd}@" if user or pwd else ""
        return f"{proto}://{auth}{host}:{port}"
    except Exception as e:
        append_log(log_file, f"[veo] resolve window proxy failed: {safe_trim(str(e), 200)}")
        return ""
    
async def fetch_short_access_token_by_proxy(
    *,
    session_token: str,
    target_url: str = "https://labs.google/fx",
    db: Any = None,
    picked: Any = None,
    log_file: Optional[Path] = None,
) -> Dict[str, Any]:
    """通过两层代理 GET https://labs.google/fx/api/auth/session，用长效 session-token 换短效 access_token。"""
    st = str(session_token or "").strip()
    if not st:
        raise RuntimeError("缺少 __Secure-next-auth.session-token")
    log_file = log_file or MONITOR_LOG_FILE
    auth_session_url = "https://labs.google/fx/api/auth/session"
    referer = (target_url or "https://labs.google/fx").strip() or "https://labs.google/fx"
    headers = {
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        "Cookie": f"__Secure-next-auth.session-token={st}",
        "Referer": referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    }
    system_proxy = await _veo_resolve_system_proxy(db)
    window_proxy = await _veo_resolve_window_proxy(db, picked, log_file)
    proxy_url = window_proxy or system_proxy or None
    append_log(log_file, f"[veo][token] auth/session by proxy proxy_system={'yes' if system_proxy else 'no'} proxy_window={'yes' if window_proxy else 'no'}")
    if system_proxy and window_proxy and _veo_parse_proxy_url(window_proxy).get("scheme") in ("socks", "socks5", "socks5h"):
        status, body_text = await asyncio.to_thread(
            _veo_chain_http_to_socks5h_get,
            system_proxy=system_proxy,
            window_proxy=window_proxy,
            url=auth_session_url,
            headers=headers,
            timeout=45.0,
        )
        data = json.loads(body_text) if body_text.strip() else {}
    else:
        client_kwargs: Dict[str, Any] = {"timeout": httpx.Timeout(45.0), "trust_env": True}
        if proxy_url:
            client_kwargs["proxy"] = proxy_url
        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.get(auth_session_url, headers=headers)
            status, body_text = resp.status_code, resp.text
            data = resp.json() if resp.text.strip() else {}
    if int(status or 0) >= 400:
        raise RuntimeError(f"auth/session 失败：HTTP {status} {safe_trim(body_text, 400)}")
    if not isinstance(data, dict):
        raise RuntimeError("auth/session 返回格式异常")
    access_token = str(data.get("access_token") or data.get("accessToken") or "").strip()
    if not access_token:
        raise RuntimeError(f"auth/session 未返回 access_token：{safe_trim(str(data), 400)}")
    user = data.get("user") if isinstance(data.get("user"), dict) else {}
    return {
        "access_token": access_token,
        "expires": str(data.get("expires") or "").strip() or None,
        "email": str((user or {}).get("email") or "").strip() or None,
        "session_token": st,
    }


def _veo_trpc_create_project_url(target_url: str) -> str:
    raw = (target_url or "").strip() or "https://labs.google/fx"
    try:
        p = urlparse(raw)
        if p.scheme and p.netloc:
            return f"{p.scheme}://{p.netloc}/fx/api/trpc/project.createProject"
    except Exception:
        pass
    return "https://labs.google/fx/api/trpc/project.createProject"


def _veo_trpc_delete_project_url(target_url: str) -> str:
    # 删除项目按 Flow Web 当前接口固定走 labs.google。
    return "https://labs.google/fx/api/trpc/project.deleteProject"


def _parse_trpc_create_project_response(obj: Any) -> Optional[str]:
    if obj is None:
        return None
    cur: Any = obj
    if isinstance(cur, list) and cur:
        cur = cur[0]
    if not isinstance(cur, dict):
        return None

    def _dig(d: Any, *keys: str) -> Any:
        x = d
        for k in keys:
            if not isinstance(x, dict):
                return None
            x = x.get(k)
        return x

    r = _dig(cur, "result", "data", "json", "result")
    if isinstance(r, dict):
        pid = r.get("projectId") or r.get("project_id")
        if pid:
            s = str(pid).strip()
            return s or None

    j = _dig(cur, "result", "data", "json")
    if isinstance(j, dict):
        pid2 = j.get("projectId") or j.get("project_id")
        if pid2:
            s2 = str(pid2).strip()
            return s2 or None

    pid3 = cur.get("projectId") or cur.get("project_id")
    if pid3:
        s3 = str(pid3).strip()
        return s3 or None
    return None


async def veo_create_flow_project_in_window(
    *,
    sess: "VeoSession",
    target_url: str,
    title: str,
    tool_name: str = "PINHOLE",
) -> str:
    """通过浏览器插件在指纹窗口内调用 Flow `project.createProject`。"""
    title = str(title or "").strip()
    if not title:
        raise RuntimeError("项目标题不能为空")
    tn = str(tool_name or "PINHOLE").strip() or "PINHOLE"
    sess._cancel_idle_close()
    sid, wkey = _veo_extension_ids_from_session(sess)
    log_file = Path(sess.monitor_log_path) if sess.monitor_log_path else MONITOR_LOG_FILE
    client = await ensure_extension_connected_via_window(
        sess=sess,
        target_url=target_url,
        space_id=sid,
        window_key=wkey,
        wait_seconds=8.0,
        log_file=log_file,
        auto_triger_connection=True,
    )
    if client is None:
        raise NonPenalizedTaskError(
            f"浏览器插件未连接：space_id={sid!r} window_key={wkey!r}",
            status_code=503,
        )
    info = await submit_extension_task(
        space_id=sid,
        window_key=wkey,
        provider="veo",
        payload={
            "action": "create_flow_project",
            "workflow_kind": "create_flow_project",
            "target_url": _veo_extension_labs_url(target_url),
            "project_page": _veo_extension_labs_url(target_url),
            "title": title,
            "tool_name": tn,
        },
        progress_cb=_noop_progress_cb,
        timeout_seconds=60.0,
    )
    if not isinstance(info, dict):
        raise RuntimeError(f"插件返回 createProject 格式异常：{info!r}")
    pid = str(info.get("project_id") or info.get("projectId") or "").strip()
    if not pid:
        pid = _parse_trpc_create_project_response(info.get("response"))
    if not pid:
        raise RuntimeError(f"createProject 响应无效：{safe_trim(str(info), 500)}")
    append_log(log_file, f"[veo][project] created via extension title={title!r} project_id={pid}")
    return pid


async def veo_delete_flow_project_in_window(
    *,
    sess: "VeoSession",
    target_url: str,
    project_id: str,
) -> Dict[str, Any]:
    """通过浏览器插件在指纹窗口内调用 Flow `project.deleteProject`。"""
    pid = str(project_id or "").strip()
    if not pid:
        raise RuntimeError("project_id 不能为空")
    sess._cancel_idle_close()
    sid, wkey = _veo_extension_ids_from_session(sess)
    log_file = Path(sess.monitor_log_path) if sess.monitor_log_path else MONITOR_LOG_FILE
    client = await ensure_extension_connected_via_window(
        sess=sess,
        target_url=target_url,
        space_id=sid,
        window_key=wkey,
        wait_seconds=8.0,
        log_file=log_file,
        auto_triger_connection=True,
    )
    if client is None:
        raise NonPenalizedTaskError(
            f"浏览器插件未连接：space_id={sid!r} window_key={wkey!r}",
            status_code=503,
        )
    info = await submit_extension_task(
        space_id=sid,
        window_key=wkey,
        provider="veo",
        payload={
            "action": "delete_flow_project",
            "workflow_kind": "delete_flow_project",
            "target_url": _veo_extension_labs_url(target_url),
            "project_page": _veo_extension_labs_url(target_url),
            "project_id": pid,
        },
        progress_cb=_noop_progress_cb,
        timeout_seconds=60.0,
    )
    if not isinstance(info, dict):
        raise RuntimeError(f"插件返回 deleteProject 格式异常：{info!r}")
    if info.get("success") is False:
        raise RuntimeError(f"deleteProject 失败：{safe_trim(str(info), 500)}")
    append_log(log_file, f"[veo][project] deleted via extension project_id={pid}")
    return {
        "success": True,
        "project_id": pid,
        "response": info.get("response"),
        "status": info.get("status"),
        "source": "extension",
    }


def _veo_resolve_n_frames(payload: Dict[str, Any]) -> int:
    """与 Sora 一致读取时长字段；显式为 1 时表示单帧 → 走文生图/图生图，其它值交给 `_pick_n_frames`（视频帧数语义）。"""
    duration_v = payload.get("n_frames") or payload.get("duration_frames") or payload.get("duration") or payload.get("时长")
    try:
        iv = int(float(duration_v))
    except Exception:
        iv = 0
    if iv == 1:
        return 1
    return iv


_VEO_KNOWN_IMAGE_ASPECT_RATIOS = frozenset(
    {
        IMAGE_ASPECT_RATIO_LANDSCAPE,
        IMAGE_ASPECT_RATIO_PORTRAIT,
        IMAGE_ASPECT_RATIO_SQUARE,
        IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE,
        IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR,
    }
)


def _veo_normalize_explicit_image_aspect_ratio(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip().upper().replace("-", "_")
    return s if s in _VEO_KNOWN_IMAGE_ASPECT_RATIOS else None


def _veo_image_aspect_from_dimensions(w: int, h: int) -> Optional[str]:
    """由像素宽高推断 Flow 图片 aspectRatio；无法归一到已知比例时按横竖给 16:9 / 9:16 类枚举。"""
    if w <= 0 or h <= 0:
        return None
    if w == h:
        return IMAGE_ASPECT_RATIO_SQUARE
    g = gcd(w, h)
    a, b = w // g, h // g
    if a > b:
        if a * 9 == b * 16:
            return IMAGE_ASPECT_RATIO_LANDSCAPE
        if a * 3 == b * 4:
            return IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE
        r = w / h
        if abs(r - 16 / 9) < 0.04:
            return IMAGE_ASPECT_RATIO_LANDSCAPE
        if abs(r - 4 / 3) < 0.04:
            return IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE
        return IMAGE_ASPECT_RATIO_LANDSCAPE
    if b > a:
        if b * 9 == a * 16:
            return IMAGE_ASPECT_RATIO_PORTRAIT
        if b * 3 == a * 4:
            return IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR
        r = h / w
        if abs(r - 16 / 9) < 0.04:
            return IMAGE_ASPECT_RATIO_PORTRAIT
        if abs(r - 4 / 3) < 0.04:
            return IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR
        return IMAGE_ASPECT_RATIO_PORTRAIT
    return IMAGE_ASPECT_RATIO_SQUARE


def _veo_pick_image_aspect_from_ratio_string(ratio: Optional[str]) -> Optional[str]:
    """从 `3:4`、`1920x1080` 等解析图片比例（不调用视频用的 `_veo_resolve_orientation_str`）。"""
    if not ratio:
        return None
    s = str(ratio).strip().lower().replace("：", ":")
    wh = _veo_try_parse_wh_in_ratio_string(s)
    if wh:
        got = _veo_image_aspect_from_dimensions(wh[0], wh[1])
        if got:
            return got
    for m in re.finditer(r"(\d+)\s*:\s*(\d+)", s):
        try:
            cw, ch = int(m.group(1)), int(m.group(2))
        except ValueError:
            continue
        got = _veo_image_aspect_from_dimensions(cw, ch)
        if got:
            return got
    return None


def _veo_resolve_image_aspect_ratio(payload: Dict[str, Any]) -> str:
    """文生图/图生图：支持 1:1、4:3、3:4、16:9、9:16（及 `IMAGE_ASPECT_RATIO_*` 显式值），默认横版 16:9 类。

    与视频的 `_veo_resolve_orientation_str` 分离：视频仅 16:9/9:16；图片多 Square / 4:3 / 3:4。
    """
    payload = payload or {}
    for key in ("image_aspect_ratio", "veo_image_aspect_ratio", "aspect_ratio"):
        got = _veo_normalize_explicit_image_aspect_ratio(payload.get(key))
        if got:
            return got

    wh = _veo_parse_pixel_pair_from_payload(payload)
    if wh:
        got = _veo_image_aspect_from_dimensions(wh[0], wh[1])
        if got:
            return got

    ratio = str(
        payload.get("size_ratio") or payload.get("aspect_ratio") or payload.get("ratio") or payload.get("尺寸") or ""
    ).strip() or None
    if ratio:
        got = _veo_pick_image_aspect_from_ratio_string(ratio)
        if got:
            return got

    ori = str(payload.get("orientation") or "").strip().lower()
    if ori == "portrait":
        return IMAGE_ASPECT_RATIO_PORTRAIT
    if ori == "landscape":
        return IMAGE_ASPECT_RATIO_LANDSCAPE

    raw_ar = str(
        payload.get("video_aspect_ratio") or payload.get("aspectRatio") or payload.get("veo_aspect_ratio") or ""
    ).strip()
    if raw_ar:
        got = _veo_pick_image_aspect_from_ratio_string(raw_ar)
        if got:
            return got
        u = raw_ar.upper()
        if "PORTRAIT" in u or "竖" in raw_ar:
            return IMAGE_ASPECT_RATIO_PORTRAIT
        if "LANDSCAPE" in u or "横" in raw_ar:
            return IMAGE_ASPECT_RATIO_LANDSCAPE

    return IMAGE_ASPECT_RATIO_LANDSCAPE


def _veo_truthy_payload_flag(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    s = str(v or "").strip().lower()
    return s in ("1", "true", "yes", "on")


def _veo_resolve_image_model_name(payload: Dict[str, Any]) -> str:
    """文生图/图生图模型：默认 NARWHAL；`use_gem_pix_2` 或显式模型名为 GEM_PIX_2 时用 GEM_PIX_2（对齐 flow2api）。"""
    for key in ("veo_image_model", "image_model_name", "imageModelName"):
        raw = payload.get(key)
        if raw is None or str(raw).strip() == "":
            continue
        s = str(raw).strip().upper().replace("-", "_")
        if s in ("GEM_PIX_2", "GEMPIX2", "GEM_PIX2"):
            return VEO_IMAGE_MODEL_GEM_PIX_2
        if s in ("NARWHAL",):
            return VEO_IMAGE_MODEL_NARWHAL
    if _veo_truthy_payload_flag(payload.get("use_gem_pix_2") or payload.get("veo_use_gem_pix_2")):
        return VEO_IMAGE_MODEL_GEM_PIX_2
    return VEO_IMAGE_MODEL_NARWHAL


def _veo_resolve_image_output_resolution(payload: Dict[str, Any]) -> tuple[str, bool, Optional[str]]:
    """返回 (展示用标签 '1K'|'2K'|'4K', 是否需要调用 flow/upsampleImage, upsample targetResolution)。默认 1K，不放大。"""
    raw = payload.get("resolution") or payload.get("image_resolution") or payload.get("veo_image_resolution")
    if raw is None or str(raw).strip() == "":
        return ("1K", False, None)
    s = str(raw).strip().lower().replace(" ", "")
    if s in ("4k", "4096", "3840", "4k_output", "uhd_4k"):
        return ("4K", True, UPSAMPLE_IMAGE_RESOLUTION_4K)
    if s in ("2k", "2048", "2k_output", "uhd_2k"):
        return ("2K", True, UPSAMPLE_IMAGE_RESOLUTION_2K)
    return ("1K", False, None)

# ---------------------------------------------------------------------------
# 入口函数
# ---------------------------------------------------------------------------
async def veo_workflow(
    payload: Dict[str, Any],
    progress_cb: ProgressCB,
    *,
    browser_vendor: str,
    browser_base_url: str,
    browser_access_key: Optional[str],
    space_id: str,
    window_key: str,
    timeout_seconds: float,
    access_token: Optional[str] = None,
    access_expires: Optional[str] = None,
    headless: bool = False,
    pure_mode: bool = True,
    db: Any = None,
    task_type_window_id: Optional[int] = None,
) -> Dict[str, Any]:
    """VEO：指纹浏览器页面内 fetch aisandbox API。

    - 视频：`n_frames`（或 duration / duration_frames / 时长）经 `_pick_n_frames` 归一后 **>1**（如 300/450）
      时走文生视频 / 图生视频 / **Ingredients（R2V）多图**：若 `Ingredients_images`（或 `ingredients_images`）
      含至少 1 张可解析地址则走 `batchAsyncGenerateVideoReferenceImages`，模型与 flow2api
      `veo_3_1_r2v_fast` / `veo_3_1_r2v_fast_portrait` 一致，最多 3 张；否则再按首尾帧图判断 I2V 或 T2V。
      轮询 `batchCheckAsyncVideoGenerationStatus`。
    - 图片：当上述字段 **显式为 1** 时走文生图 / 图生图：`flow/uploadImage`（图生图仅首张）
      + `projects/{id}/flowMedia:batchGenerateImages`；默认模型 NARWHAL，`use_gem_pix_2`（或 `image_model_name`=`GEM_PIX_2`）时用 GEM_PIX_2（与 flow2api 一致）。
      比例支持 `IMAGE_ASPECT_RATIO_*` 显式值及 1:1 / 4:3 / 3:4 / 16:9 / 9:16（或宽高像素），默认横版。
      `resolution` / `veo_image_resolution` 等为 **2k/4k** 时在生成后调用 `flow/upsampleImage`：`share_url` 为 2K/4K 的 `data:image/jpeg;base64,...`，`origin_image_url` 为 1K fife 直链；放大失败时回退为 1K 并写入 `upsample_error`。

    project_id 解析顺序：payload（veo_project_id / project_id / current_project_id）
    → veo_url 中的 /tools/flow/project/{id}
    → 若传入 db 与 task_type_window_id（task_type_windows.id），则从 veo_flow_projects 随机一条。
    """
    payload = payload or {}
    project_id_from_db = False
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise NonPenalizedTaskError("payload.prompt 不能为空", status_code=400)

    n_frames = _veo_resolve_n_frames(payload)
    image_mode = n_frames == 1

    ingredients_urls: List[str] = []
    ingredients_video_urls: List[str] = []
    want_ingredients = False
    if not image_mode:
        ingredients_urls = _veo_collect_ingredients_image_urls(payload)
        ingredients_video_urls = _veo_collect_ingredients_video_urls(payload)
        want_ingredients = len(ingredients_urls) >= 1 or len(ingredients_video_urls) >= 1
        #raise NonPenalizedTaskError("Veo3.1视频维护中，暂时下架", status_code=400,content_violation=True)

    want_i2v = False
    if not image_mode:
        want_i2v = _veo_payload_looks_like_i2v(payload)
    if want_ingredients:
        want_i2v = False

    i2v_urls: List[str] = []
    r2v_from_i2v_urls: List[str] = []
    if want_i2v:
        i2v_urls = _veo_collect_i2v_image_urls(payload)
        if len(i2v_urls) == 0:
            raise NonPenalizedTaskError(
                "图生图需要提供至少一张参考图（first_image_url / image_url / images 等）"
                if image_mode
                else "图生视频需要提供 1-2 张图片（first_image_url / image_url / images 等）",
                status_code=400,
            )
        if _veo_payload_video_model_uses_r2v_for_i2v_refs(payload):
            r2v_from_i2v_urls = list(i2v_urls)
            ingredients_urls.extend(i2v_urls)
            want_ingredients = True
            want_i2v = False
            i2v_urls = []

    labs_hint = str(payload.get("veo_url") or payload.get("target_url") or "").strip() or "https://labs.google/fx"
    project_id = str(
        payload.get("veo_project_id") or payload.get("project_id") or payload.get("current_project_id") or ""
    ).strip()
    if not project_id:
        project_id = _veo_extract_project_id_from_url(labs_hint) or ""
    if not project_id and db is not None and task_type_window_id:
        try:
            mid = int(task_type_window_id)
            if mid > 0:
                picked_pid = await db.get_random_veo_flow_project_id(mid)
                if picked_pid:
                    project_id = str(picked_pid).strip()
                    project_id_from_db = True
        except Exception:
            project_id = project_id or ""
    if not project_id:
        raise NonPenalizedTaskError(
            "缺少 Flow projectId：请在本窗口绑定的「Veo 项目」中至少添加一个项目，"
            "或在 payload 中设置 veo_project_id（或 project_id），"
            "或让 veo_url 包含 /tools/flow/project/{id}",
            status_code=400,
        )

    monitor_log_path = str(payload.get("monitor_log_path") or "").strip() or None
    idle_close_seconds = float(payload.get("ctx_idle_close_seconds") or 30.0)
    max_wait_seconds = float(payload.get("veo_pending_max_wait_seconds") or max(60.0, min(float(timeout_seconds), 1800.0)))
    poll_interval_seconds = float(payload.get("veo_pending_poll_interval_seconds") or 5.0)

    sess = get_or_create_veo_session(
        vendor=browser_vendor,
        base_url=browser_base_url,
        access_key=browser_access_key,
        space_id=space_id,
        window_key=window_key,
    )
    sess.browser_headless = headless
    sess.browser_pure_mode = pure_mode
    sess.monitor_log_path = monitor_log_path
    sess.idle_close_seconds = idle_close_seconds

    log_file = sess._log_file
    project_page = _veo_project_page_url(project_id=project_id, hint_url=labs_hint)
    bring_prefix = project_page
    print(f"bring_prefix: {bring_prefix}")
    if project_id_from_db and task_type_window_id:
        append_log(
            log_file,
            f"[veo] project_id from DB random pick mapping_id={int(task_type_window_id)} -> {project_id!r}",
        )
    _mode = (
        "IMAGE"
        if image_mode
        else ("INGREDIENTS_R2V" if want_ingredients else ("I2V" if want_i2v else "T2V"))
    )
    append_log(
        log_file,
        f"[veo] workflow {_mode} n_frames={n_frames} start project_id={project_id!r} "
        f"prompt={safe_trim(prompt, 200)!r} "
        f"ingredients={len(ingredients_urls) if want_ingredients else 0} "
        f"ingredient_videos={len(ingredients_video_urls) if want_ingredients else 0} "
        f"images={len(i2v_urls) if want_i2v else 0}",
    )
    await progress_cb(
        1,
        {
            "stage": "init",
            "workflow_kind": "image" if image_mode else "video",
            "n_frames": n_frames,
            "video_mode": (
                "r2v"
                if want_ingredients
                else ("i2v" if want_i2v else "t2v")
            ),
            "prompt": safe_trim(prompt, 200),
            "project_id": project_id,
            "image_count": len(ingredients_urls) if want_ingredients else (len(i2v_urls) if want_i2v else 0),
            "video_reference_count": len(ingredients_video_urls) if want_ingredients else 0,
        },
    )

    if should_use_extension_executor(payload):
        # 插件模式下任务执行不再每次用带 fpb_* 参数的 URL 打开/导航窗口。
        # fpb_* 配置只在管理页“AccessToken / 过期 -> 更新”时写入一次，插件会持久化
        # 到 chrome.storage.local；之后只要指纹浏览器窗口启动、插件启动，就用缓存配置
        # 自动连接 WebSocket。这里保持目标页 URL 干净，避免额外 CDP/导航造成风控风险。
        annotated_project_page = project_page
        annotated_bring_prefix = project_page
        ext_at = str(access_token or "").strip() or None
        ext_session_token = str(access_token or "").strip() or None
        ext_exp = str(access_expires or "").strip() or None
        ext_tok_info: Optional[Dict[str, Any]] = None
        _ext_window_balance: Optional[int] = None
        if not image_mode and db is not None and task_type_window_id:
            try:
                mid = int(task_type_window_id)
                if mid > 0:
                    row = await db.get_task_type_window_context(mid)
                    if row:
                        try:
                            _ext_window_balance = int(row.get("remaining_quota"))
                        except Exception:
                            _ext_window_balance = None
                        t2 = str(row.get("sora_access_token") or "").strip() or None
                        e2 = str(row.get("sora_access_expires") or "").strip() or None
                        if t2:
                            ext_session_token,ext_at, ext_exp = t2, t2, e2
            except Exception as e:
                append_log(log_file, f"[veo][extension] reload access_token/balance from DB failed (use call args): {e}")
    
        try:
            client = await ensure_extension_connected_via_window(
                sess=sess,
                target_url=project_page,
                space_id=space_id,
                window_key=window_key,
                wait_seconds=10,
                log_file=log_file,
                auto_triger_connection = True,
            )
            if client is None:
                raise NonPenalizedTaskError(
                    f"浏览器插件未连接： window_key={window_key!r}",
                    status_code=503,
                )
            if not image_mode and not _veo_cached_access_still_valid(access_token, access_expires, margin_seconds=10):
                ext_tok_info = await veo_fetch_access_tokens_via_extension(
                    sess=sess,
                    target_url=project_page,
                    space_id=space_id,
                    window_key=window_key,
                    connect_wait_seconds=float(payload.get("extension_connect_wait_seconds") or 8.0),
                    token_timeout_seconds=float(payload.get("extension_token_timeout_seconds") or 45.0),
                    log_file=log_file,
                    access_token=ext_session_token,
                    access_expires=ext_exp,
                    session_token=ext_session_token,
                    short_access_token=ext_at,
                    short_expires=ext_exp,
                    force_fetch=True,
                )
                ext_session_token = str((ext_tok_info or {}).get("session_token") or (ext_tok_info or {}).get("access_token") or "").strip() or None
                ext_exp = str((ext_tok_info or {}).get("expires") or "").strip() or None
                ext_at = str((ext_tok_info or {}).get("short_access_token") or "").strip() or ext_at
                if not _veo_cached_access_still_valid(ext_at, ext_exp, margin_seconds=10):
                    # Video generation is now executed by the Flow browser
                    # console scripts and does not require the legacy short
                    # access token. Do not automatically disable the task
                    # window when that legacy token is absent/expired; doing
                    # so incorrectly turns off every VEO mapping after a
                    # successful or failed generation. Explicit callers may
                    # opt back into the old behavior for diagnostics.
                    if bool(payload.get("disable_window_on_logout", False)) and db is not None and task_type_window_id:
                        try:
                            mid = int(task_type_window_id)
                            if mid > 0:
                                await db.update_task_type_window(mapping_id=mid, enabled=False)
                                append_log(log_file, f"[veo][extension] google account logged out; disabled task_type_window id={mid}")
                        except Exception as disable_e:
                            append_log(log_file, f"[veo][extension] disable task_type_window after logout failed: {disable_e}")
                    raise RuntimeError("google账号已登出")
        except Exception as e:
            append_log(log_file, f"[veo][extension] fetch long/short access_token via extension failed: {e}")
            if isinstance(e, NonPenalizedTaskError):
                raise
            if image_mode:
                raise
            ext_session_token = None
            ext_at = None
        if image_mode:
            _ext_image_aspect = _veo_resolve_image_aspect_ratio(payload)
            _ext_image_model = _veo_resolve_image_model_name(payload)
            _ext_resolution_label, _ext_want_upsample, _ext_upsample_target_resolution = _veo_resolve_image_output_resolution(payload)
            _ext_want_external_4k = _ext_resolution_label == "4K" and _veo_4k_use_2k_realesrgan(payload)
            if _ext_want_external_4k:
                _ext_resolution_label, _ext_want_upsample, _ext_upsample_target_resolution = ("2K", True, UPSAMPLE_IMAGE_RESOLUTION_2K)
            _ext_i2i_urls = _veo_collect_image_generation_reference_urls(payload) if _veo_payload_has_image_generation_references(payload) else []
            _ext_model_key = None
            _ext_video_aspect = None
        else:
            _ext_model_key, _ext_video_aspect = _veo_resolve_extension_video_model_and_aspect(
                payload,
                want_ingredients=want_ingredients,
                want_i2v=want_i2v,
                window_balance=_ext_window_balance,
            )
            if _ext_model_key == _VEO_OMNI_T2V_MODEL and want_ingredients:
                _ext_model_key = _VEO_OMNI_R2V_MODEL
                if ingredients_video_urls:
                    _ext_model_key = _VEO_OMNI_VEDIT_MODEL
            print(f"_ext_model_key:{_ext_model_key} _ext_video_aspect:{_ext_video_aspect}");
            _ext_image_aspect = None
            _ext_image_model = None
            _ext_resolution_label, _ext_want_upsample, _ext_upsample_target_resolution = ("1K", False, None)
            _ext_want_external_4k = False
            _ext_i2i_urls = []
        # 保存对外返回用的原始图片 URL。后续 localize 只替换“插件上传用 URL”，
        # 不能污染 thumb_url 等需要返回给公网用户的字段。
        _original_ingredients_urls = list(ingredients_urls)
        _original_i2v_urls = list(i2v_urls)
        if r2v_from_i2v_urls:
            _original_i2v_urls = list(r2v_from_i2v_urls)
        _masked_face_reference_count = 0
        _face_mosaic_enabled = app_config.veo_face_mosaic_enabled
        # Mask every image reference before localization/upload, including image
        # generation references and video-generation first/last frames.
        async def _mask_image_refs(urls: List[str], kind: str) -> List[str]:
            nonlocal _masked_face_reference_count
            results = await _veo_mosaic_reference_media_batch(
                urls,
                payload=payload,
                progress_cb=progress_cb,
                log_file=log_file,
                kind=kind,
            )
            _masked_face_reference_count += sum(faces for _, faces in results)
            return [masked_url for masked_url, _ in results]

        if _face_mosaic_enabled and (ingredients_urls or i2v_urls):
            _ingredients_count = len(ingredients_urls)
            _masked_image_refs = await _mask_image_refs([*ingredients_urls, *i2v_urls], "image")
            ingredients_urls = _masked_image_refs[:_ingredients_count]
            i2v_urls = _masked_image_refs[_ingredients_count:]
        elif not _face_mosaic_enabled and (ingredients_urls or i2v_urls or ingredients_video_urls):
            append_log(log_file, "[veo][reference-mosaic] skipped by config")
        if _veo_extension_local_image_cache_enabled(payload):
            # 输入图不要让指纹浏览器通过海外代理直连原图；Python 服务端先直连下载并
            # 暴露为 http://<base_url>/assets/veo_image_cache/...，插件再读取这个
            # 本机白名单 URL。这里仅替换下发给插件的 URL，不改用户原始 payload。
            if ingredients_urls:
                ingredients_urls = await _veo_materialize_image_urls_for_extension(
                    ingredients_urls,
                    kind="ingredients",
                    payload=payload,
                    progress_cb=progress_cb,
                    log_file=log_file,
                )
            if i2v_urls:
                i2v_urls = await _veo_materialize_image_urls_for_extension(
                    i2v_urls,
                    kind="i2v",
                    payload=payload,
                    progress_cb=progress_cb,
                    log_file=log_file,
                )
            if _ext_i2i_urls:
                _ext_i2i_urls = await _veo_materialize_image_urls_for_extension(
                    _ext_i2i_urls,
                    kind="image_reference",
                    payload=payload,
                    progress_cb=progress_cb,
                    log_file=log_file,
                )
        if ingredients_video_urls:
            # The watermark service downloads remote HTTP(S) inputs itself. Do not
            # localize the original first, otherwise the same source is downloaded
            # once here and once again by the masking service.
            source_video_url = str(ingredients_video_urls[0] or "").strip()
            video_url_for_extension = source_video_url
            if _face_mosaic_enabled:
                video_url_for_extension, _video_faces = await _veo_mosaic_reference_media(
                    source_video_url,
                    payload=payload,
                    progress_cb=progress_cb,
                    log_file=log_file,
                    kind="video",
                )
                _masked_face_reference_count += _video_faces
            # The extension must receive a local allow-listed URL. This is the only
            # download of the masked result; the original remote input was not cached.
            ingredients_video_urls = [
                await _veo_materialize_video_for_extension(
                    video_url_for_extension,
                    kind="ingredients_video",
                    progress_cb=progress_cb,
                    log_file=log_file,
                )
            ]
        _ext_video_reference_meta: Dict[str, Any] = {}
        if ingredients_video_urls:
            _video_ref_url = str(ingredients_video_urls[0] or "").strip()
            _video_ref_path = _veo_local_asset_path_from_url(_video_ref_url)
            if _video_ref_path:
                _ext_video_reference_meta = await _veo_probe_local_video_metadata(_video_ref_path)
                if _ext_video_reference_meta:
                    _veo_assert_reference_video_duration(_ext_video_reference_meta, source=_video_ref_url)
                    try:
                        await progress_cb(
                            3,
                            {
                                "stage": "reference_video_metadata",
                                "duration_seconds": _ext_video_reference_meta.get("duration_seconds"),
                                "fps": _ext_video_reference_meta.get("fps"),
                                "frame_count": _ext_video_reference_meta.get("frame_count"),
                                "end_frame_index": _ext_video_reference_meta.get("end_frame_index"),
                            },
                        )
                    except Exception:
                        pass
                    append_log(
                        log_file,
                        "[veo][extension][video-cache] metadata "
                        f"duration={_ext_video_reference_meta.get('duration_seconds')} "
                        f"fps={_ext_video_reference_meta.get('fps')} "
                        f"frames={_ext_video_reference_meta.get('frame_count')} "
                        f"end_frame_index={_ext_video_reference_meta.get('end_frame_index')}",
                    )
        ext_payload = dict(payload)
        if not image_mode and _masked_face_reference_count > 0:
            ext_payload["prompt"] = f"{prompt}\n注意：生成视频中的人物脸部不允许有马赛克，必须还原自然人物面部。"

        if image_mode:
            if _ext_want_external_4k:
                ext_payload["resolution"] = "2k"
                ext_payload["image_resolution"] = "2k"
                ext_payload["veo_image_resolution"] = "2k"
            ext_prompt = str(ext_payload.get("prompt") or "").strip()
            image_text_locale_hint = (
                "文字要求：输出图片中所有可读文字、文案、标题、标签、包装辅助文案如果前面提示词没有特别指定，优先使用简体中文。"
                "人物要求：输出图片的人物人种如果前面提示词中没有特别指定，优先使用中国或东亚模特。"
            )
            if image_text_locale_hint not in ext_prompt:
                ext_payload["prompt"] = f"{ext_prompt}\n\n{image_text_locale_hint}"
            else:
                ext_payload["prompt"] = ext_prompt

        if _ext_video_reference_meta:
            # Python 服务端已经下载到本机缓存，顺手 ffprobe 最快且能拿到真实 fps/帧数；
            # 下发给插件，避免插件只能用 <video>.duration 后按固定 8fps 猜 endFrameIndex。
            if _ext_video_reference_meta.get("duration_seconds"):
                ext_payload.setdefault("ingredients_video_duration_seconds", _ext_video_reference_meta.get("duration_seconds"))
                ext_payload.setdefault("video_reference_duration_seconds", _ext_video_reference_meta.get("duration_seconds"))
            if _ext_video_reference_meta.get("fps"):
                ext_payload.setdefault("ingredients_video_fps", _ext_video_reference_meta.get("fps"))
                ext_payload.setdefault("video_reference_fps", _ext_video_reference_meta.get("fps"))
            if _ext_video_reference_meta.get("frame_count"):
                ext_payload.setdefault("ingredients_video_frame_count", _ext_video_reference_meta.get("frame_count"))
                ext_payload.setdefault("video_reference_frame_count", _ext_video_reference_meta.get("frame_count"))
            if _ext_video_reference_meta.get("end_frame_index") is not None:
                ext_payload.setdefault("ingredients_video_end_frame_index", _ext_video_reference_meta.get("end_frame_index"))
                ext_payload.setdefault("video_reference_end_frame_index", _ext_video_reference_meta.get("end_frame_index"))
        print(f"_ext_image_aspect:{_ext_image_aspect}");
        ext_payload.update(
            {
                "workflow_kind": "image" if image_mode else "video",
                "video_mode": (
                    "r2v"
                    if want_ingredients
                    else ("i2v" if want_i2v else "t2v")
                ),
                "project_id": project_id,
                "project_page": annotated_project_page,
                "bring_prefix": annotated_bring_prefix,
                "n_frames": n_frames,
                "image_mode": image_mode,
                "ingredients_urls": ingredients_urls,
                "ingredients_video_urls": ingredients_video_urls,
                "ingredients_video_url": ingredients_video_urls[0] if ingredients_video_urls else "",
                "i2v_urls": i2v_urls,
                "timeout_seconds": timeout_seconds,
                "max_wait_seconds": max_wait_seconds,
                "poll_interval_seconds": poll_interval_seconds,
                "access_token": ext_at,
                "access_expires": ext_exp,
                "ext_session_token": ext_session_token,
                "extension_model_key": _ext_model_key,
                "extension_video_aspect_ratio": _ext_video_aspect,
                "extension_image_aspect_ratio": _ext_image_aspect,
                "extension_image_model_name": _ext_image_model,
                "extension_image_reference_urls": _ext_i2i_urls,
                "extension_image_resolution_label": _ext_resolution_label,
                # 兼容旧插件字段名：历史上只有 2K，所以叫 want_2k；现在表示“需要图片放大”。
                "extension_image_want_2k": _ext_want_upsample,
                "extension_image_want_upsample": _ext_want_upsample,
                "extension_image_upsample_target_resolution": _ext_upsample_target_resolution,
            }
        )
        _ext_r2_upload = _veo_extension_r2_upload_config(ext_payload, resolution_label=_ext_resolution_label) if image_mode else {}
        if _ext_r2_upload:
            ext_payload["r2_upload"] = _ext_r2_upload
            ext_payload["extension_r2_upload"] = _ext_r2_upload
        append_log(log_file, f"[veo][extension] dispatch workflow {_mode} project_id={project_id!r} model={_ext_model_key!r} ratio={_ext_video_aspect!r}")
        # 如插件在 token 获取后意外断开，仍走统一的“中转页 fpb_* URL 触发 WS”接口；
        # Python 只短暂连接 CDP 打开中转页，随后立刻断开；目标页由插件延迟跳转打开。
        if await wait_extension_client(space_id, window_key, timeout_seconds=0.2) is None:
            try:
                await ensure_extension_connected_via_window(
                    sess=sess,
                    target_url=project_page,
                    space_id=space_id,
                    window_key=window_key,
                    wait_seconds=float(payload.get("extension_connect_wait_seconds") or 8.0),
                    log_file=log_file,
                )
            except Exception as e:
                append_log(log_file, f"[veo][extension] ensure websocket for extension failed: {e}")
        _ext_failure_reasons_from_progress: List[str] = []

        async def _extension_progress_cb(_progress: int, _data: Optional[Dict[str, Any]] = None) -> None:
            if isinstance(_data, dict):
                _raw_failure_reasons = _data.get("failure_reasons") or _data.get("failureReasons")
                if isinstance(_raw_failure_reasons, (list, tuple, set)):
                    for _item in _raw_failure_reasons:
                        _s = str(_item or "").strip()
                        if _s and _s not in _ext_failure_reasons_from_progress:
                            _ext_failure_reasons_from_progress.append(_s)
                elif _raw_failure_reasons:
                    _s = str(_raw_failure_reasons or "").strip()
                    if _s and _s not in _ext_failure_reasons_from_progress:
                        _ext_failure_reasons_from_progress.append(_s)
            await progress_cb(_progress, _data)

        try:
            _ext_result = await submit_extension_task(
                space_id=space_id,
                window_key=window_key,
                provider="veo",
                payload=ext_payload,
                progress_cb=_extension_progress_cb,
                timeout_seconds=max_wait_seconds + 120.0,
            )
        except Exception as e:
            if _ext_failure_reasons_from_progress and not _veo_extract_failure_reasons(e):
                try:
                    setattr(e, "failure_reasons", list(_ext_failure_reasons_from_progress))
                except Exception:
                    pass
            if _veo_generation_failure_should_be_runtime(e):
                raise RuntimeError(str(e)) from e
            _violation_reason = _veo_content_violation_reason(e)
            if _violation_reason:
                try:
                    _violation_status = int(getattr(e, "status_code", None) or 0)
                except Exception:
                    _violation_status = 0
                if _violation_status < 400 or _violation_status >= 500:
                    _violation_status = 400
                if _violation_reason == "MEDIA_GENERATION_STATUS_FAILED":
                    # 该类错误的原始信息通常包含 status/code/message/failureReasons/
                    # mediaGenerationId 等关键诊断字段，直接完整返回，便于用户调整提示词。
                    raise NonPenalizedTaskError(
                        str(e),
                        status_code=_violation_status,
                        content_violation=True,
                    )
                _violation_prefix = _veo_content_violation_message(_violation_reason, e)
                raise NonPenalizedTaskError(
                    f"{_violation_prefix}：{safe_trim(str(e), 500)}",
                    status_code=_violation_status,
                    content_violation=True,
                )
            raise
        if isinstance(_ext_result, dict) and not image_mode:
            _public_thumb = ""
            if want_i2v and _original_i2v_urls:
                _public_thumb = str(_original_i2v_urls[0] or "").strip()
            elif want_ingredients and _original_ingredients_urls:
                _public_thumb = str(_original_ingredients_urls[0] or "").strip()
            if _veo_is_base64_media_value(_public_thumb):
                _public_thumb = ""
            _existing_thumb = str(_ext_result.get("thumb_url") or "").strip()
            # 双保险：即使浏览器插件未及时重载，仍在 Python 返回前把本地缓存地址
            # 还原为用户传入的公网原图，避免把 192.168.x.x 暴露给外部调用方。
            if _existing_thumb and _veo_is_base64_media_value(_existing_thumb):
                _ext_result = dict(_ext_result)
                _ext_result["thumb_url"] = ""
                _existing_thumb = ""
            if _public_thumb and (
                not _existing_thumb
                or _veo_is_local_asset_url(_existing_thumb)
            ):
                _ext_result = dict(_ext_result)
                _ext_result["thumb_url"] = _public_thumb
        if isinstance(_ext_result, dict) and image_mode and _ext_want_external_4k:
            _ext_result = await _veo_external_upscale_2k_to_4k(
                _ext_result,
                progress_cb=progress_cb,
                log_file=log_file,
            )
        if isinstance(_ext_result, dict) and not image_mode:
            """
            _ext_result = await _veo_remove_result_video_watermark(
                _ext_result,
                payload=payload,
                project_id=project_id,
                model_key=_ext_model_key or "",
                progress_cb=progress_cb,
                log_file=log_file,
            )
            """
        _ext_result = _veo_rewrite_flow_content_urls(_ext_result)
        return _ext_result, project_page

    raise NonPenalizedTaskError(
        "VEO only supports extension/plugin mode: enable extension_executor or set payload.executor to extension/plugin",
        status_code=400,
    )
