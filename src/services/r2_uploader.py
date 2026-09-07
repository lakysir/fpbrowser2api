"""Cloudflare R2 uploads using the S3-compatible AWS Signature V4 API."""

from __future__ import annotations

import hashlib
import hmac
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class R2Config:
    enabled: bool
    endpoint: str
    region: str
    bucket: str
    public_base_url: str
    access_key_id: str = ""
    access_key_secret: str = ""


def _get_access_keys(*, cfg: R2Config) -> tuple[str, str]:
    access_key_id = (cfg.access_key_id or os.environ.get("R2_ACCESS_KEY_ID") or "").strip()
    access_key_secret = (cfg.access_key_secret or os.environ.get("R2_ACCESS_KEY_SECRET") or "").strip()
    if not access_key_id or not access_key_secret:
        raise RuntimeError(
            "Missing R2 credentials: configure access_key_id/access_key_secret under "
            "[r2] in config/setting.toml or set R2_ACCESS_KEY_ID/R2_ACCESS_KEY_SECRET"
        )
    return access_key_id, access_key_secret


def r2_config_from_setting_section(section: Any) -> R2Config:
    sec: Dict[str, Any] = section if isinstance(section, dict) else {}

    def pick_str(*keys: str, default: str = "") -> str:
        for key in keys:
            value = sec.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
        return default

    return R2Config(
        enabled=bool(sec.get("enabled", False)),
        endpoint=pick_str("endpoint"),
        region=pick_str("region", default="auto"),
        bucket=pick_str("bucket"),
        public_base_url=pick_str("public_base_url"),
        access_key_id=pick_str("access_key_id"),
        access_key_secret=pick_str("access_key_secret"),
    )


def _encode_path_part(value: str) -> str:
    return quote(str(value), safe="-_.~")


def _build_object_url(cfg: R2Config, object_key: str) -> tuple[str, str, str]:
    raw_endpoint = str(cfg.endpoint or "").strip()
    if not raw_endpoint:
        raise RuntimeError("R2 endpoint is missing")
    if "://" not in raw_endpoint:
        raw_endpoint = f"https://{raw_endpoint}"
    parts = urlsplit(raw_endpoint)
    if not parts.scheme or not parts.netloc:
        raise RuntimeError(f"Invalid R2 endpoint: {cfg.endpoint!r}")

    encoded_key = "/".join(_encode_path_part(part) for part in str(object_key).lstrip("/").split("/"))
    endpoint_path = parts.path.rstrip("/")
    canonical_uri = f"{endpoint_path}/{_encode_path_part(cfg.bucket)}/{encoded_key}"
    if not canonical_uri.startswith("/"):
        canonical_uri = f"/{canonical_uri}"
    upload_url = urlunsplit((parts.scheme, parts.netloc, canonical_uri, "", ""))
    return upload_url, canonical_uri, parts.netloc


def _signing_key(secret: str, date_stamp: str, region: str) -> bytes:
    def sign(key: bytes, value: str) -> bytes:
        return hmac.new(key, value.encode("utf-8"), hashlib.sha256).digest()

    date_key = sign(f"AWS4{secret}".encode("utf-8"), date_stamp)
    region_key = sign(date_key, region)
    service_key = sign(region_key, "s3")
    return sign(service_key, "aws4_request")


def upload_bytes_to_r2(
    *,
    cfg: R2Config,
    data: bytes,
    object_key: str,
    content_type: str = "image/jpeg",
) -> str:
    if not cfg.enabled:
        raise RuntimeError("R2 is disabled")
    if not cfg.bucket:
        raise RuntimeError("R2 bucket is missing")
    access_key_id, access_key_secret = _get_access_keys(cfg=cfg)
    upload_url, canonical_uri, host = _build_object_url(cfg, object_key)

    now = time.gmtime()
    amz_date = time.strftime("%Y%m%dT%H%M%SZ", now)
    date_stamp = amz_date[:8]
    region = (cfg.region or "auto").strip() or "auto"
    payload_hash = hashlib.sha256(data).hexdigest()
    normalized_content_type = str(content_type or "application/octet-stream").strip()
    canonical_headers = (
        f"content-type:{normalized_content_type}\n"
        f"host:{host}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        ["PUT", canonical_uri, "", canonical_headers, signed_headers, payload_hash]
    )
    scope = f"{date_stamp}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        _signing_key(access_key_secret, date_stamp, region),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key_id}/{scope},"
        f"SignedHeaders={signed_headers},Signature={signature}"
    )
    headers = {
        "Content-Type": normalized_content_type,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        "Authorization": authorization,
    }
    request = Request(upload_url, data=data, headers=headers, method="PUT")
    try:
        with urlopen(request, timeout=60.0) as response:
            status = int(getattr(response, "status", 0) or response.getcode() or 0)
            if status < 200 or status >= 300:
                body = response.read(500).decode("utf-8", errors="replace")
                raise RuntimeError(f"R2 upload failed: HTTP {status}; response={body}")
    except HTTPError as exc:
        body = exc.read(500).decode("utf-8", errors="replace")
        raise RuntimeError(f"R2 upload failed: HTTP {exc.code}; response={body}") from exc

    base = str(cfg.public_base_url or "").rstrip("/")
    if not base:
        return upload_url
    public_key = "/".join(_encode_path_part(part) for part in str(object_key).lstrip("/").split("/"))
    return f"{base}/{public_key}"


def build_veo_upsample_object_key(*, project_id: str, media_name: Optional[str]) -> str:
    timestamp = time.strftime("%Y%m%d%H%M%S")
    random_id = uuid.uuid4().hex[:8]
    safe_project = "".join(
        char if (char.isalnum() or char in ("-", "_", ".")) else "_"
        for char in (project_id or "")
    ) or "proj"
    safe_media = "".join(
        char if (char.isalnum() or char in ("-", "_", ".")) else "_"
        for char in (media_name or "")
    ) or "media"
    return f"veo_workflow/image/upsample/{timestamp}_{random_id}_{safe_project}_{safe_media}.jpg"
