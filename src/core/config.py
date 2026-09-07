"""Configuration management for FPBrowser2API.

设计目标（参考 flow2api）：
- 基础值从 `config/setting.toml` 读取
- 关键值允许在运行时由数据库覆盖（管理后台修改后重启仍生效）
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from .paths import CONFIG_DIR


def _load_toml(path: Path) -> Dict[str, Any]:
    try:
        import tomllib  # py>=3.11
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception:
        import tomli  # type: ignore
        with path.open("rb") as f:
            return tomli.load(f)


class Config:
    def __init__(self) -> None:
        self._config = self._load_config()

        # DB 覆盖项（None 表示仍使用文件配置）
        self._admin_username: Optional[str] = None
        self._admin_password: Optional[str] = None
        self._api_key: Optional[str] = None
        self._proxy_enabled: Optional[bool] = None
        self._proxy_url: Optional[str] = None
        self._debug_enabled: Optional[bool] = None
        self._log_to_file: Optional[bool] = None
        self._stop_accepting_tasks: Optional[bool] = None
        self._skip_video_watermark_remove: Optional[bool] = None

    def _load_config(self) -> Dict[str, Any]:
        config_path = CONFIG_DIR / "setting.toml"
        if not config_path.exists():
            example_path = CONFIG_DIR / "setting_example.toml"
            raise FileNotFoundError(f"缺少配置文件：{config_path}（可参考 {example_path}）")
        return _load_toml(config_path)

    def reload_config(self) -> None:
        self._config = self._load_config()

    def get_raw_config(self) -> Dict[str, Any]:
        return self._config

    # -------- server --------
    @property
    def server_host(self) -> str:
        return str(self._config.get("server", {}).get("host", "0.0.0.0"))

    @property
    def server_port(self) -> int:
        return int(self._config.get("server", {}).get("port", 8000))

    # -------- global/security --------
    @property
    def admin_username(self) -> str:
        if self._admin_username is not None:
            return self._admin_username
        return str(self._config.get("global", {}).get("admin_username", "admin"))

    def set_admin_username_from_db(self, username: str) -> None:
        self._admin_username = username

    @property
    def admin_password(self) -> str:
        if self._admin_password is not None:
            return self._admin_password
        return str(self._config.get("global", {}).get("admin_password", "admin"))

    def set_admin_password_from_db(self, password: str) -> None:
        self._admin_password = password

    @property
    def api_key(self) -> str:
        if self._api_key is not None:
            return self._api_key
        return str(self._config.get("global", {}).get("api_key", "fpb123456"))

    @api_key.setter
    def api_key(self, value: str) -> None:
        self._api_key = value
        self._config.setdefault("global", {})["api_key"] = value

    # -------- system --------
    @property
    def proxy_enabled(self) -> bool:
        if self._proxy_enabled is not None:
            return bool(self._proxy_enabled)
        return bool(self._config.get("system", {}).get("proxy_enabled", False))

    def set_proxy_enabled_from_db(self, enabled: bool) -> None:
        self._proxy_enabled = bool(enabled)

    @property
    def proxy_url(self) -> str:
        if self._proxy_url is not None:
            return str(self._proxy_url or "")
        return str(self._config.get("system", {}).get("proxy_url", "") or "")

    def set_proxy_url_from_db(self, url: Optional[str]) -> None:
        self._proxy_url = (url or "").strip()

    @property
    def debug_enabled(self) -> bool:
        if self._debug_enabled is not None:
            return bool(self._debug_enabled)
        return bool(self._config.get("system", {}).get("debug_enabled", False))

    def set_debug_enabled(self, enabled: bool) -> None:
        self._debug_enabled = bool(enabled)
        self._config.setdefault("system", {})["debug_enabled"] = bool(enabled)

    @property
    def log_to_file(self) -> bool:
        if self._log_to_file is not None:
            return bool(self._log_to_file)
        return bool(self._config.get("system", {}).get("log_to_file", False))

    def set_log_to_file_from_db(self, enabled: bool) -> None:
        self._log_to_file = bool(enabled)

    @property
    def stop_accepting_tasks(self) -> bool:
        if self._stop_accepting_tasks is not None:
            return bool(self._stop_accepting_tasks)
        return bool(self._config.get("system", {}).get("stop_accepting_tasks", False))

    def set_stop_accepting_tasks_from_db(self, enabled: bool) -> None:
        self._stop_accepting_tasks = bool(enabled)
        self._config.setdefault("system", {})["stop_accepting_tasks"] = bool(enabled)

    @property
    def skip_video_watermark_remove(self) -> bool:
        if self._skip_video_watermark_remove is not None:
            return bool(self._skip_video_watermark_remove)
        return bool(self._config.get("system", {}).get("skip_video_watermark_remove", False))

    def set_skip_video_watermark_remove_from_db(self, enabled: bool) -> None:
        self._skip_video_watermark_remove = bool(enabled)
        self._config.setdefault("system", {})["skip_video_watermark_remove"] = bool(enabled)

    # -------- video postprocess (去水印 / 1080p 超分) --------
    def _video_postprocess(self) -> Dict[str, Any]:
        section = self._config.get("video_postprocess", {})
        return section if isinstance(section, dict) else {}

    @property
    def veo_face_mosaic_enabled(self) -> bool:
        """Whether VEO reference images/videos should have faces mosaiced."""
        import os

        raw = os.getenv("FPB_VEO_FACE_MOSAIC", "")
        if raw.strip():
            return raw.strip().lower() in {"1", "true", "yes", "on"}
        return bool(self._video_postprocess().get("face_mosaic", True))

    @property
    def video_remove_watermark_enabled(self) -> bool:
        """是否启用生成后去水印（默认关闭，需自行部署 onnx_watermark_service）。"""
        import os
        raw = os.getenv("FPB_VIDEO_REMOVE_WATERMARK", "")
        if raw.strip():
            return raw.strip().lower() in {"1", "true", "yes", "on"}
        return bool(self._video_postprocess().get("remove_watermark", False))

    @property
    def video_upscale_1080p_enabled(self) -> bool:
        """是否启用 *-1080p 模型的超分（默认关闭）。"""
        import os
        raw = os.getenv("FPB_VIDEO_UPSCALE_1080P", "")
        if raw.strip():
            return raw.strip().lower() in {"1", "true", "yes", "on"}
        return bool(self._video_postprocess().get("upscale_1080p", False))

    @property
    def video_postprocess_service_base_url(self) -> str:
        """去水印/超分外部服务根地址；留空视为未部署。"""
        import os
        raw = os.getenv("FPB_VIDEO_POSTPROCESS_SERVICE_BASE_URL", "")
        if raw.strip():
            return raw.strip().rstrip("/")
        return str(self._video_postprocess().get("service_base_url", "") or "").strip().rstrip("/")

    @property
    def video_postprocess_service_base_urls(self) -> List[str]:
        """Return shared postprocess endpoints in failover order."""
        import os

        raw_env = os.getenv("FPB_VIDEO_POSTPROCESS_SERVICE_BASE_URLS", "").strip()
        configured: Any = (
            raw_env.split(",")
            if raw_env
            else self._video_postprocess().get("service_base_urls", [])
        )
        if isinstance(configured, str):
            configured = [configured]
        if not isinstance(configured, list):
            configured = []

        urls: List[str] = []
        for value in [*configured, self.video_postprocess_service_base_url]:
            url = str(value or "").strip().rstrip("/")
            if url and url not in urls:
                urls.append(url)
        return urls

    @property
    def video_upscale_service_base_urls(self) -> List[str]:
        """Return upscale endpoints, allowing an optional upscale-only override."""
        import os

        raw_env = os.getenv("FPB_VIDEO_UPSCALE_SERVICE_BASE_URLS", "").strip()
        configured: Any = (
            raw_env.split(",")
            if raw_env
            else self._video_postprocess().get("upscale_service_base_urls", [])
        )
        if isinstance(configured, str):
            configured = [configured]
        if not isinstance(configured, list) or not configured:
            return self.video_postprocess_service_base_urls

        urls: List[str] = []
        for value in configured:
            url = str(value or "").strip().rstrip("/")
            if url and url not in urls:
                urls.append(url)
        return urls

    @property
    def video_upscale_timeout_seconds(self) -> float:
        try:
            value = float(self._video_postprocess().get("upscale_timeout_seconds", 1500.0))
        except (TypeError, ValueError):
            value = 1500.0
        return max(30.0, value)

    @property
    def video_upscale_retry_interval_seconds(self) -> float:
        try:
            value = float(self._video_postprocess().get("upscale_retry_interval_seconds", 20.0))
        except (TypeError, ValueError):
            value = 20.0
        return max(0.0, value)

    # -------- browser extension executor --------
    @property
    def extension_executor_enabled(self) -> bool:
        import os
        raw = os.getenv("FPB_EXTENSION_EXECUTOR_ENABLED", "")
        if raw.strip():
            return raw.strip().lower() in {"1", "true", "yes", "on"}
        return bool(self._config.get("extension_executor", {}).get("enabled", False))

    @property
    def extension_bridge_token(self) -> str:
        import os
        raw = os.getenv("FPB_EXTENSION_BRIDGE_TOKEN", "")
        if raw.strip():
            return raw.strip()
        return str(self._config.get("extension_executor", {}).get("bridge_token", "") or "")

    @property
    def extension_bridge_url(self) -> str:
        """浏览器插件连接 Python 后端的 WebSocket 地址。

        指纹浏览器和 Python 不在同一台机器时，应在 config/setting.toml 中配置成
        ws://<Python后端局域网IP>:<端口>/api/extension/ws
        环境变量 FPB_EXTENSION_BRIDGE_URL 仍保留为最高优先级覆盖。
        """
        import os
        raw = os.getenv("FPB_EXTENSION_BRIDGE_URL", "")
        if raw.strip():
            return raw.strip()
        base_url = str(self._config.get("extension_executor", {}).get("base_url", "") or "").strip();
        bridge_url = f"ws://{base_url}/api/extension/ws"
        return bridge_url

    @property
    def extension_launcher_url(self) -> str:
        """浏览器插件配置中转页地址。

        ``trigger_veo_extension_ws_connection_via_window`` 会先打开此地址，并在
        URL hash 中附加 fpb_* 与 redirect_url，由插件读取配置、连接 WebSocket，
        再跳转到 redirect_url。建议配置为你自己控制的局域网页面，例如：
        http://192.168.1.9:8000/
        """
        import os
        raw = os.getenv("FPB_EXTENSION_LAUNCHER_URL", "")
        if raw.strip():
            return raw.strip()
        base_url = str(self._config.get("extension_executor", {}).get("base_url", "") or "").strip();
        launcher_url = f"http://{base_url}/"
        return launcher_url

    @property
    def extension_task_timeout_seconds(self) -> float:
        import os
        raw = os.getenv("FPB_EXTENSION_TASK_TIMEOUT_SECONDS", "")
        if raw.strip():
            try:
                return max(1.0, float(raw))
            except ValueError:
                pass
        return max(1.0, float(self._config.get("extension_executor", {}).get("task_timeout_seconds", 1800.0)))



config = Config()

