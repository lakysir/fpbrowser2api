"""Data models for FPBrowser2API (Pydantic).

说明：
- 这些模型主要用于：DB 行 <-> Python 对象、以及 API 响应结构
- 数据库存储仍以 `aiosqlite` 为主（参考 flow2api）
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, field_validator


class AdminUser(BaseModel):
    id: Optional[int] = None
    username: str
    password_hash: str
    is_admin: bool = False
    # 是否允许在任务类型绑定列表中切换窗口代理（管理员默认视为允许）
    can_switch_proxy: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class SystemConfig(BaseModel):
    id: int = 1
    proxy_enabled: bool = False
    proxy_url: Optional[str] = None
    api_key: str = "fpb123456"
    debug_enabled: bool = False
    log_to_file: bool = False
    # 开关：停止接收新任务（维护模式）
    stop_accepting_tasks: bool = False
    skip_video_watermark_remove: bool = False
    # 对外创建任务并发上限（必须为 3 的整数倍）
    public_create_task_max_inflight: int = 180
    # 服务器数量（用于计算每台服务器的并发量）
    server_count: int = 1
    # 每台服务器浏览器打开并发上限（按 browser_base_url 区分）
    browser_open_concurrency: int = 3
    # 浏览器打开排队超时（秒）
    browser_open_queue_timeout: float = 120.0
    # 任务排队队列最大长度
    task_queue_max_size: int = 1000
    # 任务排队超时（秒）
    task_queue_timeout_seconds: float = 300.0
    updated_at: Optional[datetime] = None


class Project(BaseModel):
    id: Optional[int] = None
    name: str
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class FingerprintBrowser(BaseModel):
    id: Optional[int] = None
    project_id: int
    name: str
    lan_addr: str  # 局域网地址（如 http://192.168.1.10:50000）
    vendor: str = "generic"  # roxy/gologin/adspower/...（预留扩展）
    access_key: Optional[str] = None  # 指纹浏览器侧 API Key（如需要）
    browser_pool_limit: int = 0  # 每个浏览器独立的窗口池上限，0 表示使用全局默认值
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class BrowserSpace(BaseModel):
    id: Optional[int] = None
    browser_id: int
    name: str
    space_id: str
    # 可选：RoxyBrowser /browser/list_v3 的 projectIds 过滤参数（格式 "10,11"）
    project_ids: Optional[str] = None
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class WindowInfo(BaseModel):
    """空间下窗口信息（从指纹浏览器同步而来，不允许手工编辑）。"""

    id: Optional[int] = None
    space_pk: int  # BrowserSpace.id
    window_key: str  # 指纹浏览器窗口唯一标识（若无则使用 name/url 的 hash）

    # 来自指纹浏览器侧的“窗口序号”（RoxyBrowser: windowSortNum）
    # 说明：该值更接近“用户感知的窗口ID”，前端展示优先用它。
    window_sort_num: Optional[int] = None

    window_name: str
    # 本地窗口备注（用于记录回退原因等，仅存本地 DB）
    window_remark: Optional[str] = None
    platform_account: Optional[str] = None
    platform_url: Optional[str] = None
    # 本地平台账号库的 account_id（Roxy /account/list rows.id）
    platform_account_id: Optional[int] = None

    # 指纹浏览器侧绑定的代理库 id（RoxyBrowser: proxyInfo.moduleId）
    # 说明：用于 UI 默认选中当前代理、以及统计“代理绑定数”
    proxy_id: Optional[int] = None

    proxy_addr: Optional[str] = None
    proxy_country: Optional[str] = None
    proxy_expire_at: Optional[str] = None

    enabled: bool = True
    # 窗口状态：1=已打开，0=未打开（来源：Roxy /browser/connection_info）
    window_status: int = 0
    # task_type_windows 中绑定该窗口的记录数（未删除）
    bound_task_type_count: int = 0
    # task_type_windows 映射 ID 列表（逗号分隔，用于管理页展示 mapping id）
    bound_task_type_mapping_ids: Optional[str] = None
    deleted: bool = False

    raw: Optional[Dict[str, Any]] = None  # 保存原始窗口信息 JSON（便于排查/扩展）
    synced_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ProxyInfo(BaseModel):
    """代理 IP 信息（从指纹浏览器同步而来，存本地 DB 便于 UI 选择/复用）。"""

    id: Optional[int] = None  # 本地 DB PK
    space_pk: int  # BrowserSpace.id

    proxy_id: int  # 指纹浏览器代理库 id（RoxyBrowser: /proxy/list rows.id）
    purchase_type: Optional[str] = None
    # 代理过期时间（若指纹浏览器返回；字段名不统一，这里统一落到 expire_at）
    expire_at: Optional[str] = None
    ip_type: Optional[str] = None
    # IP 画像分析结果（来源：外部 analyze-ip 接口）
    risk_level: Optional[str] = None
    asn_type: Optional[str] = None
    protocol: Optional[str] = None
    host: Optional[str] = None
    port: Optional[str] = None
    proxy_username: Optional[str] = None
    proxy_password: Optional[str] = None
    refresh_url: Optional[str] = None
    remark: Optional[str] = None

    check_status: Optional[int] = None
    check_channel: Optional[str] = None
    check_channel_value: Optional[str] = None
    last_ip: Optional[str] = None
    last_country: Optional[str] = None
    last_state: Optional[str] = None
    last_city: Optional[str] = None
    check_time: Optional[str] = None
    create_time: Optional[str] = None
    update_time: Optional[str] = None

    raw: Optional[Dict[str, Any]] = None
    synced_at: Optional[datetime] = None
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class PlatformAccount(BaseModel):
    """平台账号信息（从指纹浏览器同步而来，存本地 DB 便于绑定窗口）。"""

    id: Optional[int] = None  # 本地 DB PK
    space_pk: int  # BrowserSpace.id

    account_id: int  # 指纹浏览器平台账号 id（Roxy /account/list rows.id）
    platform_url: Optional[str] = None
    platform_username: Optional[str] = None
    platform_password: Optional[str] = None
    platform_efa: Optional[str] = None
    platform_remarks: Optional[str] = None

    raw: Optional[Dict[str, Any]] = None
    synced_at: Optional[datetime] = None
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class TaskType(BaseModel):
    id: Optional[int] = None
    name: str
    code: str  # 英文唯一
    project_id: Optional[int] = None  # 绑定项目（为空表示不限制）
    concurrency: int = 1
    total_concurrency: int = 100
    continuous_error_threshold: int = 3
    continuous_error_close_window_threshold: int = 3
    timeout_seconds: int = 1800
    # 窗口调用冷却时间（秒）：从窗口池取用窗口后，短时间内不再重复调用同一窗口
    window_call_cooldown_seconds: int = 30
    # 动态函数 key（来自 services/task_handler_registry.py）
    create_task_handler: Optional[str] = None
    refresh_quota_handler: Optional[str] = None
    error_retry_count: int = 0
    default_target_url: Optional[str] = None
    # 开启后由 TaskService 后台协程按 browser_pool_limit 预热窗口并做 Cloudflare 巡检（不占 inflight_slots）
    window_pool_enabled: bool = False
    # 窗口池与 DB 对齐周期（秒）；多任务类型同时开启池时取最小值作为全局 maintainer 周期
    window_pool_reconcile_interval_sec: int = 600
    # Cloudflare 巡检周期（秒）；多类型同时开启池时取最小值
    window_pool_cloudflare_interval_sec: int = 1800
    enabled: bool = True
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @field_validator("window_call_cooldown_seconds", mode="before")
    @classmethod
    def _coerce_window_call_cooldown(cls, v: Any) -> int:
        if v is None:
            return 30
        return int(v)

    @field_validator("window_pool_reconcile_interval_sec", mode="before")
    @classmethod
    def _coerce_reconcile_interval(cls, v: Any) -> int:
        if v is None:
            return 600
        return int(v)

    @field_validator("window_pool_cloudflare_interval_sec", mode="before")
    @classmethod
    def _coerce_cf_interval(cls, v: Any) -> int:
        if v is None:
            return 1800
        return int(v)


class TaskTypePublic(BaseModel):
    id: Optional[int] = None
    name: str
    code: str  # 英文唯一
    # 动态函数 key（来自 services/task_handler_registry.py）
    enabled: bool = True
    created_at: Optional[datetime] = None

class TaskTypeWindow(BaseModel):
    id: Optional[int] = None
    task_type_id: int
    window_pk: int  # WindowInfo.id

    # 运行中/已预占的并发槽位（用于高并发下的“窗口级”并发限制）
    # 说明：必须由 DB 原子 UPDATE 控制增减，避免多进程/多实例下超卖
    inflight_slots: int = 0

    total_errors: int = 0
    consecutive_errors: int = 0

    daily_quota: int = 0
    remaining_quota: int = 0

    cooldown_until: Optional[datetime] = None
    # 连续错误熔断冷却时间（与额度重置时间点 cooldown_until 区分）
    error_cooldown_until: Optional[datetime] = None
    enabled: bool = True
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class VeoFlowProject(BaseModel):
    """Google Labs Flow 项目（绑定到 task_type_windows.id，供 veo_workflow 使用）。"""

    id: Optional[int] = None
    task_type_window_id: int
    project_id: str
    project_name: str
    tool_name: str = "PINHOLE"
    is_active: bool = True
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class Task(BaseModel):
    id: Optional[int] = None
    task_id: str
    task_type_code: str
    # Sora：用于“基于 generation_id 创建角色”等场景的任务关联
    generation_id: Optional[str] = None

    status: str  # queued/running/completed/failed
    progress: int = 0

    prompt: str
    image_path: Optional[str] = None

    window_pk: Optional[int] = None
    window_ip: Optional[str] = None  # 窗口绑定的 IP/代理地址（来自 windows.proxy_addr）
    result: Optional[Dict[str, Any]] = None
    error_message: Optional[str] = None
    content_violation: int = 0

    created_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class RequestLog(BaseModel):
    id: Optional[int] = None
    actor: Optional[str] = None  # admin / api / username ...
    method: str
    path: str
    request_body: Optional[str] = None
    response_body: Optional[str] = None
    status_code: int
    duration: float
    created_at: Optional[datetime] = None


class AutoRefreshErrorLog(BaseModel):
    """定时刷新额度失败记录（用于风控/排查与 UI 展示）。"""

    id: Optional[int] = None
    mapping_id: int
    task_type_id: Optional[int] = None
    task_code: Optional[str] = None
    window_pk: Optional[int] = None
    window_name: Optional[str] = None
    platform_account: Optional[str] = None
    error_message: str
    created_at: Optional[datetime] = None


class CardKey(BaseModel):
    id: Optional[int] = None
    card_key: str
    sort_order: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class PaypalAccount(BaseModel):
    """PayPal 账号/开户注册资料（本地管理台使用）。"""

    id: Optional[int] = None
    label: Optional[str] = None
    paypal_email: Optional[str] = None
    paypal_password: Optional[str] = None
    account_status: str = "new"

    card_number: Optional[str] = None
    card_expiry_raw: Optional[str] = None
    card_expiry_year: Optional[int] = None
    card_expiry_month: Optional[int] = None
    card_cvv: Optional[str] = None

    phone: Optional[str] = None
    sms_api_url: Optional[str] = None

    first_name: Optional[str] = None
    last_name: Optional[str] = None
    full_name: Optional[str] = None

    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    country: Optional[str] = None

    raw_line: Optional[str] = None
    notes: Optional[str] = None
    deleted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class WindowPickerResult(BaseModel):
    window: WindowInfo
    mapping: TaskTypeWindow


class TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    progress: int
    result: Optional[Dict[str, Any]] = None
    error_message: Optional[str] = None
    content_violation: int = 0

