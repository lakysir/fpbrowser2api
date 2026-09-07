"""Database storage layer (SQLite + aiosqlite).

参考 flow2api 的策略：
- init_db(): 建表（CREATE TABLE IF NOT EXISTS）
- check_and_migrate_db(): 启动时检查缺失表/缺失列并补齐（ALTER TABLE ADD COLUMN）
- 配置行/管理员账号：首次启动从 setting.toml 初始化，后续仅补缺不覆盖
"""

from __future__ import annotations

import asyncio
import aiosqlite
import json
import re
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from .auth import AuthManager
from .models import (
    AdminUser,
    AutoRefreshErrorLog,
    BrowserSpace,
    CardKey,
    FingerprintBrowser,
    PaypalAccount,
    PlatformAccount,
    Project,
    ProxyInfo,
    SystemConfig,
    Task,
    TaskType,
    TaskTypePublic,
    TaskTypeWindow,
    WindowInfo,
)
from .paths import DATA_DIR


class Database:
    _BUSY_TIMEOUT_MS = 8000
    _PAYPAL_ACCOUNT_FIELDS: tuple[str, ...] = (
        "label",
        "paypal_email",
        "paypal_password",
        "account_status",
        "card_number",
        "card_expiry_raw",
        "card_expiry_year",
        "card_expiry_month",
        "card_cvv",
        "phone",
        "sms_api_url",
        "first_name",
        "last_name",
        "full_name",
        "address_line1",
        "address_line2",
        "city",
        "state",
        "postal_code",
        "country",
        "raw_line",
        "notes",
    )

    def __init__(self, db_path: Optional[str] = None) -> None:
        if db_path is None:
            data_dir = DATA_DIR
            data_dir.mkdir(parents=True, exist_ok=True)
            db_path = str(data_dir / "fpbrowser.db")
        self.db_path = db_path
        self._write_lock: asyncio.Lock | None = None

    def _get_write_lock(self) -> asyncio.Lock:
        if self._write_lock is None:
            self._write_lock = asyncio.Lock()
        return self._write_lock

    @asynccontextmanager
    async def _write_conn(self) -> AsyncIterator[aiosqlite.Connection]:
        """Acquire the write lock and yield a connection with WAL + busy_timeout."""
        async with self._get_write_lock():
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
                yield db

    @asynccontextmanager
    async def _read_conn(self) -> AsyncIterator[aiosqlite.Connection]:
        """Yield a connection with busy_timeout (no write lock)."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
            yield db

    def db_exists(self) -> bool:
        return Path(self.db_path).exists()

    @staticmethod
    def _is_db_locked_error(exc: Exception) -> bool:
        msg = str(exc or "").lower()
        return isinstance(exc, sqlite3.OperationalError) and ("database is locked" in msg)

    async def _table_exists(self, db: aiosqlite.Connection, table_name: str) -> bool:
        cur = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,),
        )
        row = await cur.fetchone()
        return row is not None

    async def _column_exists(self, db: aiosqlite.Connection, table_name: str, column_name: str) -> bool:
        try:
            cur = await db.execute(f"PRAGMA table_info({table_name})")
            cols = await cur.fetchall()
            return any(c[1] == column_name for c in cols)
        except Exception:
            return False

    async def init_db(self) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("PRAGMA journal_mode=WAL")
            await db.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
            await db.execute("PRAGMA foreign_keys=ON")

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS admin_users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    is_admin BOOLEAN DEFAULT 0,
                    can_switch_proxy BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS user_page_permissions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    page_key TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    UNIQUE (user_id, page_key),
                    FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
                )
                """
            )
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS user_project_permissions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    project_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    UNIQUE (user_id, project_id),
                    FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
                )
                """
            )
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS user_task_type_permissions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    task_type_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    UNIQUE (user_id, task_type_id),
                    FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS system_config (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    proxy_enabled BOOLEAN DEFAULT 0,
                    proxy_url TEXT,
                    api_key TEXT NOT NULL,
                    debug_enabled BOOLEAN DEFAULT 0,
                    log_to_file BOOLEAN DEFAULT 0,
                    stop_accepting_tasks BOOLEAN DEFAULT 0,
                    skip_video_watermark_remove BOOLEAN DEFAULT 0,
                    public_create_task_max_inflight INTEGER DEFAULT 180,
                    server_count INTEGER DEFAULT 1,
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_agent_config (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    api_key TEXT,
                    default_model TEXT DEFAULT 'gpt-5.5',
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    deleted BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS browsers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    lan_addr TEXT NOT NULL,
                    vendor TEXT DEFAULT 'generic',
                    access_key TEXT,
                    browser_pool_limit INTEGER DEFAULT 0,
                    deleted BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (project_id) REFERENCES projects(id)
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS spaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    browser_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    space_id TEXT NOT NULL,
                    project_ids TEXT,
                    deleted BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    UNIQUE (browser_id, space_id),
                    FOREIGN KEY (browser_id) REFERENCES browsers(id)
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS windows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    space_pk INTEGER NOT NULL,
                    window_key TEXT NOT NULL,
                    window_sort_num INTEGER,
                    window_name TEXT NOT NULL,
                    window_remark TEXT,
                    platform_account TEXT,
                    platform_url TEXT,
                    platform_account_id INTEGER,
                    proxy_id INTEGER,
                    proxy_addr TEXT,
                    proxy_country TEXT,
                    proxy_expire_at TEXT,
                    enabled BOOLEAN DEFAULT 1,
                    window_status INTEGER DEFAULT 0,
                    deleted BOOLEAN DEFAULT 0,
                    raw_json TEXT,
                    synced_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    UNIQUE (space_pk, window_key),
                    FOREIGN KEY (space_pk) REFERENCES spaces(id)
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS proxies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    space_pk INTEGER NOT NULL,
                    proxy_id INTEGER NOT NULL,
                    purchase_type TEXT,
                    expire_at TEXT,
                    ip_type TEXT,
                    risk_level TEXT,
                    asn_type TEXT,
                    protocol TEXT,
                    host TEXT,
                    port TEXT,
                    proxy_username TEXT,
                    proxy_password TEXT,
                    refresh_url TEXT,
                    remark TEXT,
                    check_status INTEGER,
                    check_channel TEXT,
                    check_channel_value TEXT,
                    last_ip TEXT,
                    last_country TEXT,
                    last_state TEXT,
                    last_city TEXT,
                    check_time TEXT,
                    create_time TEXT,
                    update_time TEXT,
                    deleted BOOLEAN DEFAULT 0,
                    raw_json TEXT,
                    synced_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    UNIQUE (space_pk, proxy_id),
                    FOREIGN KEY (space_pk) REFERENCES spaces(id)
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    space_pk INTEGER NOT NULL,
                    account_id INTEGER NOT NULL,
                    platform_url TEXT,
                    platform_username TEXT,
                    platform_password TEXT,
                    platform_efa TEXT,
                    platform_remarks TEXT,
                    deleted BOOLEAN DEFAULT 0,
                    raw_json TEXT,
                    synced_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    UNIQUE (space_pk, account_id),
                    FOREIGN KEY (space_pk) REFERENCES spaces(id)
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS task_types (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    code TEXT UNIQUE NOT NULL,
                    project_id INTEGER,
                    concurrency INTEGER DEFAULT 1,
                    total_concurrency INTEGER DEFAULT 100,
                    continuous_error_threshold INTEGER DEFAULT 3,
                    continuous_error_close_window_threshold INTEGER DEFAULT 3,
                    timeout_seconds INTEGER DEFAULT 1800,
                    window_call_cooldown_seconds INTEGER DEFAULT 30,
                    create_task_handler TEXT,
                    refresh_quota_handler TEXT,
                    default_target_url TEXT,
                    enabled BOOLEAN DEFAULT 1,
                    deleted BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS task_type_windows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_type_id INTEGER NOT NULL,
                    window_pk INTEGER NOT NULL,
                    inflight_slots INTEGER DEFAULT 0,
                    total_errors INTEGER DEFAULT 0,
                    consecutive_errors INTEGER DEFAULT 0,
                    daily_quota INTEGER DEFAULT 0,
                    remaining_quota INTEGER DEFAULT 0,
                    sora_remaining_count INTEGER DEFAULT 0,
                    sora_purchased_remaining_count INTEGER DEFAULT 0,
                    sora_rate_limit_reached BOOLEAN DEFAULT 0,
                    sora_access_resets_in_seconds INTEGER DEFAULT 0,
                    sora_invite_code TEXT,
                    sora_access_token TEXT,
                    sora_access_expires TEXT,
                    sora_plan_title TEXT,
                    sora_subscription_end TEXT,
                    sora_drafts_count INTEGER DEFAULT 0,
                    -- 额度重置时间点（来自 nf/check：now + access_resets_in_seconds）
                    cooldown_until TIMESTAMP,
                    -- 连续错误熔断冷却时间（与 cooldown_until 区分）
                    error_cooldown_until TIMESTAMP,
                    enabled BOOLEAN DEFAULT 1,
                    headless BOOLEAN DEFAULT 0,
                    pure_mode BOOLEAN DEFAULT 0,
                    deleted BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    UNIQUE (task_type_id, window_pk),
                    FOREIGN KEY (task_type_id) REFERENCES task_types(id),
                    FOREIGN KEY (window_pk) REFERENCES windows(id)
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS veo_flow_projects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_type_window_id INTEGER NOT NULL,
                    project_id TEXT NOT NULL,
                    project_name TEXT NOT NULL,
                    tool_name TEXT NOT NULL DEFAULT 'PINHOLE',
                    is_active BOOLEAN DEFAULT 1,
                    deleted BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    FOREIGN KEY (task_type_window_id) REFERENCES task_type_windows(id)
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS dreamina_subject_images (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    uid TEXT,
                    subject_id TEXT,
                    data_id TEXT,
                    name TEXT NOT NULL,
                    image_uri TEXT NOT NULL,
                    width INTEGER DEFAULT 0,
                    height INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT UNIQUE NOT NULL,
                    task_type_code TEXT NOT NULL,
                    generation_id TEXT,
                    status TEXT NOT NULL DEFAULT 'queued',
                    progress INTEGER DEFAULT 0,
                    prompt TEXT NOT NULL,
                    image_path TEXT,
                    window_pk INTEGER,
                    window_ip TEXT,
                    result_json TEXT,
                    error_message TEXT,
                    content_violation INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP,
                    started_at TIMESTAMP,
                    completed_at TIMESTAMP
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    actor TEXT,
                    method TEXT NOT NULL,
                    path TEXT NOT NULL,
                    request_body TEXT,
                    response_body TEXT,
                    status_code INTEGER NOT NULL,
                    duration FLOAT NOT NULL,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS auto_refresh_error_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mapping_id INTEGER NOT NULL,
                    task_type_id INTEGER,
                    task_code TEXT,
                    window_pk INTEGER,
                    window_name TEXT,
                    platform_account TEXT,
                    error_message TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS card_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    card_key TEXT NOT NULL UNIQUE,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS paypal_accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    label TEXT,
                    paypal_email TEXT,
                    paypal_password TEXT,
                    account_status TEXT DEFAULT 'new',
                    card_number TEXT,
                    card_expiry_raw TEXT,
                    card_expiry_year INTEGER,
                    card_expiry_month INTEGER,
                    card_cvv TEXT,
                    phone TEXT,
                    sms_api_url TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    full_name TEXT,
                    address_line1 TEXT,
                    address_line2 TEXT,
                    city TEXT,
                    state TEXT,
                    postal_code TEXT,
                    country TEXT,
                    raw_line TEXT,
                    notes TEXT,
                    deleted BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                    updated_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
            )

            await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id)")
            # 兼容旧库：可能还未 ADD COLUMN generation_id，此处索引创建允许失败（迁移阶段会再补一次）
            try:
                await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_generation_id ON tasks(generation_id)")
            except Exception:
                pass
            await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_window_status_created ON tasks(window_pk, status, created_at)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status_id ON tasks(status, id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status_violation ON tasks(status, content_violation)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_type_status_id ON tasks(task_type_code, status, id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_window_ip ON tasks(window_ip)")
            # 管理后台任务列表：默认按创建时间倒序分页。
            # 没有该索引时 SQLite 会扫描旧索引后额外构建临时 B-Tree 排序，历史任务多时刷新明显变慢。
            await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_created_id_desc ON tasks(created_at DESC, id DESC)")
            # 管理后台队列条：统计违规任务。content_violation 之前没有独立索引，
            # `SUM(CASE ...) FROM tasks` 会读取整张 tasks 表（包含大 prompt/result 字段的 2GB 库尤其慢）。
            await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_content_violation ON tasks(content_violation)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_task_types_code ON task_types(code)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_browsers_project_id ON browsers(project_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_spaces_browser_id ON spaces(browser_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_windows_space_pk ON windows(space_pk)")
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_veo_flow_projects_ttw ON veo_flow_projects(task_type_window_id)"
            )
            # 调度挑选路径索引：按 task_type 过滤 + 活跃记录排序挑选
            await db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_ttw_pick_active_order
                ON task_type_windows(task_type_id, consecutive_errors, updated_at, remaining_quota DESC)
                WHERE deleted = 0 AND enabled = 1
                """
            )
            # 兼容旧库：windows 可能缺失 window_status，先补列再建索引
            if await self._table_exists(db, "windows") and not await self._column_exists(db, "windows", "window_status"):
                await db.execute("ALTER TABLE windows ADD COLUMN window_status INTEGER DEFAULT 0")
            # 调度路径会频繁按可用窗口状态过滤
            try:
                await db.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_windows_pick_status
                    ON windows(space_pk, window_status)
                    WHERE deleted = 0 AND enabled = 1
                    """
                )
            except Exception:
                # 启动阶段不因历史库索引失败中断，后续 check_and_migrate_db 会再次补齐
                pass
            await db.execute("CREATE INDEX IF NOT EXISTS idx_proxies_space_pk ON proxies(space_pk)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_accounts_space_pk ON platform_accounts(space_pk)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_req_logs_created_at ON request_logs(created_at)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_dreamina_subject_images_subject_id ON dreamina_subject_images(subject_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_auto_refresh_err_created_at ON auto_refresh_error_logs(created_at)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_auto_refresh_err_mapping_id ON auto_refresh_error_logs(mapping_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_card_keys_sort_order ON card_keys(sort_order, id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_paypal_accounts_deleted_id ON paypal_accounts(deleted, id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_paypal_accounts_email ON paypal_accounts(paypal_email)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_paypal_accounts_phone ON paypal_accounts(phone)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_user_page_permissions_user_id ON user_page_permissions(user_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_user_project_permissions_user_id ON user_project_permissions(user_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_user_task_type_permissions_user_id ON user_task_type_permissions(user_id)")

            await db.commit()

    async def _ensure_default_rows(self, db: aiosqlite.Connection, config_dict: Dict[str, Any]) -> None:
        """确保 system_config 与 admin_users 至少有一条记录（不覆盖已有）。"""
        # system_config (id=1)
        cur = await db.execute("SELECT COUNT(*) FROM system_config WHERE id = 1")
        cnt = (await cur.fetchone())[0]
        if cnt == 0:
            proxy_enabled = bool(config_dict.get("system", {}).get("proxy_enabled", False))
            proxy_url = (config_dict.get("system", {}).get("proxy_url", "") or "").strip() or None
            api_key = str(config_dict.get("global", {}).get("api_key", "fpb123456"))
            debug_enabled = bool(config_dict.get("system", {}).get("debug_enabled", False))
            log_to_file = bool(config_dict.get("system", {}).get("log_to_file", False))
            skip_video_watermark_remove = bool(config_dict.get("system", {}).get("skip_video_watermark_remove", False))
            public_create_task_max_inflight = int(
                config_dict.get("system", {}).get("public_create_task_max_inflight", 180) or 180
            )
            server_count = int(
                config_dict.get("system", {}).get("server_count", 1) or 1
            )
            await db.execute(
                """
                INSERT INTO system_config (
                    id, proxy_enabled, proxy_url, api_key, debug_enabled, log_to_file,
                    skip_video_watermark_remove, public_create_task_max_inflight, server_count
                )
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    proxy_enabled,
                    proxy_url,
                    api_key,
                    debug_enabled,
                    log_to_file,
                    skip_video_watermark_remove,
                    public_create_task_max_inflight,
                    server_count,
                ),
            )

        if await self._table_exists(db, "ai_agent_config"):
            cur = await db.execute("SELECT COUNT(*) FROM ai_agent_config WHERE id = 1")
            ai_cnt = int((await cur.fetchone())[0] or 0)
            if ai_cnt == 0:
                ai_cfg = config_dict.get("ai_agent", {}) or {}
                ai_api_key = str(ai_cfg.get("api_key") or "").strip() or None
                ai_default_model = str(ai_cfg.get("default_model") or "gpt-5.5").strip() or "gpt-5.5"
                await db.execute(
                    """
                    INSERT INTO ai_agent_config (id, api_key, default_model)
                    VALUES (1, ?, ?)
                    """,
                    (ai_api_key, ai_default_model),
                )

        # admin_users: 仅当空表时创建默认管理员
        cur = await db.execute("SELECT COUNT(*) FROM admin_users")
        cnt = (await cur.fetchone())[0]
        if cnt == 0:
            username = str(config_dict.get("global", {}).get("admin_username", "admin"))
            password = str(config_dict.get("global", {}).get("admin_password", "admin"))
            password_hash = AuthManager.hash_password(password)
            await db.execute(
                """
                INSERT INTO admin_users (username, password_hash, is_admin)
                VALUES (?, ?, 1)
                """,
                (username, password_hash),
            )
        else:
            # 兼容历史库：确保至少有 1 个管理员
            cur = await db.execute("SELECT COUNT(*) FROM admin_users WHERE is_admin = 1")
            admin_cnt = int((await cur.fetchone())[0] or 0)
            if admin_cnt <= 0:
                await db.execute("UPDATE admin_users SET is_admin = 1 WHERE id = (SELECT id FROM admin_users ORDER BY id ASC LIMIT 1)")

        # 默认任务类型（仅补缺）
        defaults: List[Tuple[str, str, int, int, int]] = [
            ("文/图生视频", "gen_video", 1, 3, 1800),
            ("文/图生图", "gen_image", 2, 3, 600),
        ]
        for name, code, conc, thr, timeout in defaults:
            cur = await db.execute("SELECT COUNT(*) FROM task_types WHERE code = ?", (code,))
            if (await cur.fetchone())[0] == 0:
                await db.execute(
                    """
                    INSERT INTO task_types (name, code, concurrency, continuous_error_threshold, timeout_seconds, enabled, deleted)
                    VALUES (?, ?, ?, ?, ?, 1, 0)
                    """,
                    (name, code, conc, thr, timeout),
                )

    async def check_and_migrate_db(self, config_dict: Dict[str, Any]) -> None:
        """升级模式：补齐缺失表/列，并确保默认行存在。"""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
            await db.execute("PRAGMA foreign_keys=ON")

            # Step 1: 缺失表（直接复用 init_db 的建表语句）
            await self.init_db()

            # Step 2: 缺失列（示例：未来扩展时在这里追加）
            if await self._table_exists(db, "ai_agent_config"):
                columns_to_add = [
                    ("api_key", "TEXT"),
                    ("default_model", "TEXT DEFAULT 'gpt-5.5'"),
                    ("updated_at", "TIMESTAMP"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "ai_agent_config", col_name):
                        await db.execute(f"ALTER TABLE ai_agent_config ADD COLUMN {col_name} {col_type}")

            if await self._table_exists(db, "system_config"):
                columns_to_add = [
                    ("log_to_file", "BOOLEAN DEFAULT 0"),
                    ("stop_accepting_tasks", "BOOLEAN DEFAULT 0"),
                    ("skip_video_watermark_remove", "BOOLEAN DEFAULT 0"),
                    ("public_create_task_max_inflight", "INTEGER DEFAULT 180"),
                    ("server_count", "INTEGER DEFAULT 1"),
                    ("browser_open_concurrency", "INTEGER DEFAULT 3"),
                    ("browser_open_queue_timeout", "REAL DEFAULT 120.0"),
                    ("task_queue_max_size", "INTEGER DEFAULT 1000"),
                    ("task_queue_timeout_seconds", "REAL DEFAULT 300.0"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "system_config", col_name):
                        await db.execute(f"ALTER TABLE system_config ADD COLUMN {col_name} {col_type}")

            if await self._table_exists(db, "admin_users"):
                if not await self._column_exists(db, "admin_users", "is_admin"):
                    await db.execute("ALTER TABLE admin_users ADD COLUMN is_admin BOOLEAN DEFAULT 0")
                if not await self._column_exists(db, "admin_users", "can_switch_proxy"):
                    await db.execute("ALTER TABLE admin_users ADD COLUMN can_switch_proxy BOOLEAN DEFAULT 0")

            # task_types: 动态 handler 字段
            if await self._table_exists(db, "task_types"):
                columns_to_add = [
                    ("create_task_handler", "TEXT"),
                    ("refresh_quota_handler", "TEXT"),
                    ("continuous_error_close_window_threshold", "INTEGER DEFAULT 3"),
                    ("project_id", "INTEGER"),
                    ("total_concurrency", "INTEGER DEFAULT 100"),
                    ("error_retry_count", "INTEGER DEFAULT 0"),
                    ("default_target_url", "TEXT"),
                    ("window_call_cooldown_seconds", "INTEGER DEFAULT 30"),
                    ("window_pool_enabled", "BOOLEAN DEFAULT 0"),
                    ("window_pool_reconcile_interval_sec", "INTEGER DEFAULT 600"),
                    ("window_pool_cloudflare_interval_sec", "INTEGER DEFAULT 1800"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "task_types", col_name):
                        await db.execute(f"ALTER TABLE task_types ADD COLUMN {col_name} {col_type}")

            # browsers: browser_pool_limit（每个浏览器独立的窗口池上限）
            if await self._table_exists(db, "browsers"):
                columns_to_add = [
                    ("browser_pool_limit", "INTEGER DEFAULT 0"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "browsers", col_name):
                        await db.execute(f"ALTER TABLE browsers ADD COLUMN {col_name} {col_type}")

            # spaces: project_ids（用于 RoxyBrowser list_v3 的 projectIds 过滤）
            if await self._table_exists(db, "spaces"):
                columns_to_add = [
                    ("project_ids", "TEXT"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "spaces", col_name):
                        await db.execute(f"ALTER TABLE spaces ADD COLUMN {col_name} {col_type}")

            # tasks: generation_id（用于按 generation_id 反查历史任务窗口）；window_ip（窗口绑定 IP）；updated_at；content_violation
            if await self._table_exists(db, "tasks"):
                columns_to_add = [
                    ("generation_id", "TEXT"),
                    ("window_ip", "TEXT"),
                    ("updated_at", "TIMESTAMP"),
                    ("content_violation", "INTEGER DEFAULT 0"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "tasks", col_name):
                        await db.execute(f"ALTER TABLE tasks ADD COLUMN {col_name} {col_type}")
                # 索引：便于按 generation_id 快速定位任务
                try:
                    await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_generation_id ON tasks(generation_id)")
                except Exception:
                    pass

            # windows: window_sort_num（RoxyBrowser: windowSortNum，用于 UI 展示）
            if await self._table_exists(db, "windows"):
                columns_to_add = [
                    ("window_sort_num", "INTEGER"),
                    ("window_remark", "TEXT"),
                    ("platform_account_id", "INTEGER"),
                    ("proxy_id", "INTEGER"),
                    ("window_status", "INTEGER DEFAULT 0"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "windows", col_name):
                        await db.execute(f"ALTER TABLE windows ADD COLUMN {col_name} {col_type}")

                # 仅当新增了 proxy_id 列（或历史数据未回填）时，尝试从 raw_json 回填
                # raw_json 结构：{"raw": {"proxyModuleId": <int>}, ...}
                if await self._column_exists(db, "windows", "proxy_id"):
                    try:
                        await db.execute(
                            """
                            UPDATE windows
                            SET proxy_id = CAST(json_extract(raw_json, '$.raw.proxyModuleId') AS INTEGER)
                            WHERE proxy_id IS NULL
                              AND raw_json IS NOT NULL
                              AND json_extract(raw_json, '$.raw.proxyModuleId') IS NOT NULL
                            """
                        )
                    except Exception:
                        # json_extract 依赖 SQLite JSON1；若不可用则用 Python 手工回填
                        try:
                            cur = await db.execute(
                                "SELECT id, raw_json FROM windows WHERE proxy_id IS NULL AND raw_json IS NOT NULL"
                            )
                            rows = await cur.fetchall()
                            for rid, raw_json in rows:
                                try:
                                    obj = json.loads(raw_json or "{}")
                                except Exception:
                                    continue
                                raw_obj = obj.get("raw")
                                if not isinstance(raw_obj, dict):
                                    continue
                                pid_raw = raw_obj.get("proxyModuleId")
                                if pid_raw in (None, "", "-"):
                                    continue
                                try:
                                    pid = int(pid_raw)
                                except Exception:
                                    continue
                                await db.execute("UPDATE windows SET proxy_id = ? WHERE id = ?", (pid, int(rid)))
                        except Exception:
                            pass

                if await self._column_exists(db, "windows", "platform_account_id"):
                    try:
                        await db.execute(
                            """
                            UPDATE windows
                            SET platform_account_id = CAST(json_extract(raw_json, '$.raw.platformAccountId') AS INTEGER)
                            WHERE platform_account_id IS NULL
                              AND raw_json IS NOT NULL
                              AND json_extract(raw_json, '$.raw.platformAccountId') IS NOT NULL
                            """
                        )
                    except Exception:
                        pass

            # proxies: expire_at（代理过期时间，用于 UI 过滤/展示）
            if await self._table_exists(db, "proxies"):
                columns_to_add = [
                    ("purchase_type", "TEXT"),
                    ("expire_at", "TEXT"),
                    ("risk_level", "TEXT"),
                    ("asn_type", "TEXT"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "proxies", col_name):
                        await db.execute(f"ALTER TABLE proxies ADD COLUMN {col_name} {col_type}")

            # task_type_windows: 移除 max_concurrency（窗口层并发不再配置）
            if await self._table_exists(db, "task_type_windows"):
                # 是否需要做一次性迁移：旧版 cooldown_until 曾用于“错误冷却”
                need_cooldown_migration = False
                if await self._column_exists(db, "task_type_windows", "max_concurrency"):
                    # SQLite 不支持 DROP COLUMN：采用“建新表 -> 拷贝 -> 替换”的方式迁移
                    await db.execute("PRAGMA foreign_keys=OFF")
                    await db.execute("BEGIN")
                    await db.execute(
                        """
                        CREATE TABLE IF NOT EXISTS task_type_windows_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            task_type_id INTEGER NOT NULL,
                            window_pk INTEGER NOT NULL,
                            inflight_slots INTEGER DEFAULT 0,
                            total_errors INTEGER DEFAULT 0,
                            consecutive_errors INTEGER DEFAULT 0,
                            daily_quota INTEGER DEFAULT 0,
                            remaining_quota INTEGER DEFAULT 0,
                            cooldown_until TIMESTAMP,
                            error_cooldown_until TIMESTAMP,
                            enabled BOOLEAN DEFAULT 1,
                            deleted BOOLEAN DEFAULT 0,
                            created_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                            updated_at TIMESTAMP DEFAULT (datetime('now','localtime')),
                            UNIQUE (task_type_id, window_pk),
                            FOREIGN KEY (task_type_id) REFERENCES task_types(id),
                            FOREIGN KEY (window_pk) REFERENCES windows(id)
                        )
                        """
                    )
                    await db.execute(
                        """
                        INSERT INTO task_type_windows_new (
                            id, task_type_id, window_pk,
                            inflight_slots,
                            total_errors, consecutive_errors,
                            daily_quota, remaining_quota,
                            cooldown_until, error_cooldown_until, enabled, deleted,
                            created_at, updated_at
                        )
                        SELECT
                            id, task_type_id, window_pk,
                            0 AS inflight_slots,
                            total_errors, consecutive_errors,
                            daily_quota, remaining_quota,
                            cooldown_until, NULL AS error_cooldown_until, enabled, deleted,
                            created_at, updated_at
                        FROM task_type_windows
                        """
                    )
                    await db.execute("DROP TABLE task_type_windows")
                    await db.execute("ALTER TABLE task_type_windows_new RENAME TO task_type_windows")
                    await db.execute("COMMIT")
                    await db.execute("PRAGMA foreign_keys=ON")
                    # 发生过旧表重建：需要进行一次性 cooldown 字段迁移
                    need_cooldown_migration = True

                # Sora 扩展字段（余额/邀请码）
                columns_to_add = [
                    ("inflight_slots", "INTEGER DEFAULT 0"),
                    ("sora_remaining_count", "INTEGER DEFAULT 0"),
                    ("sora_purchased_remaining_count", "INTEGER DEFAULT 0"),
                    ("sora_rate_limit_reached", "BOOLEAN DEFAULT 0"),
                    ("sora_access_resets_in_seconds", "INTEGER DEFAULT 0"),
                    ("sora_invite_code", "TEXT"),
                    ("sora_access_token", "TEXT"),
                    ("sora_access_expires", "TEXT"),
                    ("sora_plan_title", "TEXT"),
                    ("sora_subscription_end", "TEXT"),
                    ("error_cooldown_until", "TIMESTAMP"),
                    ("headless", "BOOLEAN DEFAULT 0"),
                    ("pure_mode", "BOOLEAN DEFAULT 0"),
                    ("sora_drafts_count", "INTEGER DEFAULT 1"),
                ]
                for col_name, col_type in columns_to_add:
                    if not await self._column_exists(db, "task_type_windows", col_name):
                        await db.execute(f"ALTER TABLE task_type_windows ADD COLUMN {col_name} {col_type}")
                        if col_name == "error_cooldown_until":
                            # 新增 error_cooldown_until 列：需要进行一次性 cooldown 字段迁移
                            need_cooldown_migration = True

                # 迁移：旧版 cooldown_until 曾用于“错误冷却”，为避免与“额度重置时间点”混用，
                # 将其复制到 error_cooldown_until，并清空 cooldown_until。
                #
                # 注意：该迁移必须是“一次性的”。新版中 cooldown_until 用于表示“额度重置时间点”
                # （来自 nf/check 的 now + access_resets_in_seconds），不能在每次 ensure_schema 时反复清空。
                if need_cooldown_migration and await self._column_exists(db, "task_type_windows", "error_cooldown_until"):
                    try:
                        await db.execute(
                            """
                            UPDATE task_type_windows
                            SET error_cooldown_until = cooldown_until
                            WHERE error_cooldown_until IS NULL AND cooldown_until IS NOT NULL
                            """
                        )
                        await db.execute("UPDATE task_type_windows SET cooldown_until = NULL WHERE cooldown_until IS NOT NULL")
                    except Exception:
                        pass

                # 查询优化索引：支持调度挑选高频路径（兼容已有库）
                await db.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_ttw_pick_active_order
                    ON task_type_windows(task_type_id, consecutive_errors, updated_at, remaining_quota DESC)
                    WHERE deleted = 0 AND enabled = 1
                    """
                )

            if await self._table_exists(db, "windows"):
                await db.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_windows_pick_status
                    ON windows(space_pk, window_status)
                    WHERE deleted = 0 AND enabled = 1
                    """
                )

            if await self._table_exists(db, "tasks"):
                await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_window_status_created ON tasks(window_pk, status, created_at)")
                await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status_id ON tasks(status, id)")
                await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status_violation ON tasks(status, content_violation)")
                await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_type_status_id ON tasks(task_type_code, status, id)")
                await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_window_ip ON tasks(window_ip)")
                await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_created_id_desc ON tasks(created_at DESC, id DESC)")
                await db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_content_violation ON tasks(content_violation)")

            if await self._table_exists(db, "browsers"):
                await db.execute("CREATE INDEX IF NOT EXISTS idx_browsers_project_id ON browsers(project_id)")
            if await self._table_exists(db, "spaces"):
                await db.execute("CREATE INDEX IF NOT EXISTS idx_spaces_browser_id ON spaces(browser_id)")

            # Step 3: 默认行（不覆盖已有）
            await self._ensure_default_rows(db, config_dict=config_dict)
            await db.commit()

    # ---------- AI agent config ----------
    async def get_ai_agent_config(self) -> Dict[str, Any]:
        for i in range(4):
            try:
                async with self._read_conn() as db:
                    db.row_factory = aiosqlite.Row
                    cur = await db.execute("SELECT * FROM ai_agent_config WHERE id = 1")
                    row = await cur.fetchone()
                    if row:
                        return dict(row)
                    return {"id": 1, "api_key": "", "default_model": "gpt-5.5", "updated_at": None}
            except Exception as e:
                if self._is_db_locked_error(e) and i < 3:
                    await asyncio.sleep(0.05 * (i + 1))
                    continue
                raise

    async def update_ai_agent_config(
        self,
        *,
        api_key: Optional[str] = None,
        default_model: Optional[str] = None,
    ) -> None:
        async with self._write_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM ai_agent_config WHERE id = 1")
            row = await cur.fetchone()
            current = dict(row) if row else {}
            new_api_key = api_key if api_key is not None else str(current.get("api_key") or "")
            new_default_model = default_model if default_model is not None else str(current.get("default_model") or "gpt-5.5")
            await db.execute(
                """
                INSERT INTO ai_agent_config (id, api_key, default_model, updated_at)
                VALUES (1, ?, ?, datetime('now','localtime'))
                ON CONFLICT(id) DO UPDATE SET
                  api_key=excluded.api_key,
                  default_model=excluded.default_model,
                  updated_at=datetime('now','localtime')
                """,
                (new_api_key, new_default_model),
            )
            await db.commit()

    # ---------- system config ----------
    async def get_system_config(self) -> SystemConfig:
        for i in range(4):
            try:
                async with self._read_conn() as db:
                    db.row_factory = aiosqlite.Row
                    cur = await db.execute("SELECT * FROM system_config WHERE id = 1")
                    row = await cur.fetchone()
                    if row:
                        return SystemConfig(**dict(row))
                    # 理论上不会走到这里（启动会 ensure 默认行）
                    return SystemConfig()
            except Exception as e:
                if self._is_db_locked_error(e) and i < 3:
                    await asyncio.sleep(0.05 * (i + 1))
                    continue
                raise

    async def update_system_config(
        self,
        proxy_enabled: Optional[bool] = None,
        proxy_url: Optional[str] = None,
        api_key: Optional[str] = None,
        debug_enabled: Optional[bool] = None,
        log_to_file: Optional[bool] = None,
        stop_accepting_tasks: Optional[bool] = None,
        skip_video_watermark_remove: Optional[bool] = None,
        public_create_task_max_inflight: Optional[int] = None,
        server_count: Optional[int] = None,
        browser_open_concurrency: Optional[int] = None,
        browser_open_queue_timeout: Optional[float] = None,
        task_queue_max_size: Optional[int] = None,
        task_queue_timeout_seconds: Optional[float] = None,
    ) -> None:
        async with self._write_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM system_config WHERE id = 1")
            row = await cur.fetchone()
            current = dict(row) if row else {}

            new_proxy_enabled = proxy_enabled if proxy_enabled is not None else bool(current.get("proxy_enabled", False))
            new_proxy_url = proxy_url if proxy_url is not None else current.get("proxy_url")
            new_api_key = api_key if api_key is not None else str(current.get("api_key", "fpb123456"))
            new_debug_enabled = debug_enabled if debug_enabled is not None else bool(current.get("debug_enabled", False))
            new_log_to_file = log_to_file if log_to_file is not None else bool(current.get("log_to_file", False))
            new_stop_accepting = (
                stop_accepting_tasks if stop_accepting_tasks is not None else bool(current.get("stop_accepting_tasks", False))
            )
            new_skip_video_watermark_remove = (
                skip_video_watermark_remove
                if skip_video_watermark_remove is not None
                else bool(current.get("skip_video_watermark_remove", False))
            )
            current_inflight = int(current.get("public_create_task_max_inflight", 180) or 180)
            new_public_create_task_max_inflight = (
                int(public_create_task_max_inflight)
                if public_create_task_max_inflight is not None
                else current_inflight
            )
            current_server_count = int(current.get("server_count", 1) or 1)
            new_server_count = (
                max(1, int(server_count))
                if server_count is not None
                else current_server_count
            )
            current_concurrency = int(current.get("browser_open_concurrency", 3) or 3)
            new_browser_open_concurrency = (
                max(1, min(50, int(browser_open_concurrency)))
                if browser_open_concurrency is not None
                else current_concurrency
            )
            current_queue_timeout = float(current.get("browser_open_queue_timeout", 120.0) or 120.0)
            new_browser_open_queue_timeout = (
                max(10.0, min(600.0, float(browser_open_queue_timeout)))
                if browser_open_queue_timeout is not None
                else current_queue_timeout
            )
            current_task_queue_max_size = int(current.get("task_queue_max_size", 1000) or 1000)
            new_task_queue_max_size = (
                max(1, min(100000, int(task_queue_max_size)))
                if task_queue_max_size is not None
                else current_task_queue_max_size
            )
            current_task_queue_timeout = float(current.get("task_queue_timeout_seconds", 300.0) or 300.0)
            new_task_queue_timeout_seconds = (
                max(10.0, min(3600.0, float(task_queue_timeout_seconds)))
                if task_queue_timeout_seconds is not None
                else current_task_queue_timeout
            )

            await db.execute(
                """
                INSERT INTO system_config (
                  id, proxy_enabled, proxy_url, api_key, debug_enabled, log_to_file,
                  stop_accepting_tasks, skip_video_watermark_remove, public_create_task_max_inflight, server_count,
                  browser_open_concurrency, browser_open_queue_timeout,
                  task_queue_max_size, task_queue_timeout_seconds, updated_at
                )
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
                ON CONFLICT(id) DO UPDATE SET
                  proxy_enabled=excluded.proxy_enabled,
                  proxy_url=excluded.proxy_url,
                  api_key=excluded.api_key,
                  debug_enabled=excluded.debug_enabled,
                  log_to_file=excluded.log_to_file,
                  stop_accepting_tasks=excluded.stop_accepting_tasks,
                  skip_video_watermark_remove=excluded.skip_video_watermark_remove,
                  public_create_task_max_inflight=excluded.public_create_task_max_inflight,
                  server_count=excluded.server_count,
                  browser_open_concurrency=excluded.browser_open_concurrency,
                  browser_open_queue_timeout=excluded.browser_open_queue_timeout,
                  task_queue_max_size=excluded.task_queue_max_size,
                  task_queue_timeout_seconds=excluded.task_queue_timeout_seconds,
                  updated_at=datetime('now','localtime')
                """,
                (
                    new_proxy_enabled,
                    new_proxy_url,
                    new_api_key,
                    new_debug_enabled,
                    new_log_to_file,
                    new_stop_accepting,
                    new_skip_video_watermark_remove,
                    new_public_create_task_max_inflight,
                    new_server_count,
                    new_browser_open_concurrency,
                    new_browser_open_queue_timeout,
                    new_task_queue_max_size,
                    new_task_queue_timeout_seconds,
                ),
            )
            await db.commit()

    async def reload_config_to_memory(self) -> SystemConfig:
        """从 DB 读取 system_config，回写到内存 config（用于热更新）。"""
        from .config import config as mem

        syscfg = await self.get_system_config()
        mem.api_key = syscfg.api_key
        mem.set_proxy_enabled_from_db(syscfg.proxy_enabled)
        mem.set_proxy_url_from_db(syscfg.proxy_url)
        mem.set_debug_enabled(syscfg.debug_enabled)
        mem.set_log_to_file_from_db(syscfg.log_to_file)
        try:
            mem.set_stop_accepting_tasks_from_db(syscfg.stop_accepting_tasks)
        except Exception:
            pass
        try:
            mem.set_skip_video_watermark_remove_from_db(syscfg.skip_video_watermark_remove)
        except Exception:
            pass

        from ..services.playwright_broswer_context import (
            set_browser_open_concurrency,
            set_browser_open_queue_timeout,
        )
        set_browser_open_concurrency(syscfg.browser_open_concurrency)
        set_browser_open_queue_timeout(syscfg.browser_open_queue_timeout)

        return syscfg

    # ---------- admin user ----------
    async def get_admin_user(self, username: str) -> Optional[AdminUser]:
        for i in range(4):
            try:
                async with self._read_conn() as db:
                    db.row_factory = aiosqlite.Row
                    cur = await db.execute("SELECT * FROM admin_users WHERE username = ?", (username,))
                    row = await cur.fetchone()
                    if row:
                        return AdminUser(**dict(row))
                    return None
            except Exception as e:
                if self._is_db_locked_error(e) and i < 3:
                    await asyncio.sleep(0.05 * (i + 1))
                    continue
                raise

    async def get_first_admin_user(self) -> Optional[AdminUser]:
        for i in range(4):
            try:
                async with self._read_conn() as db:
                    db.row_factory = aiosqlite.Row
                    cur = await db.execute("SELECT * FROM admin_users ORDER BY id ASC LIMIT 1")
                    row = await cur.fetchone()
                    if row:
                        return AdminUser(**dict(row))
                    return None
            except Exception as e:
                if self._is_db_locked_error(e) and i < 3:
                    await asyncio.sleep(0.05 * (i + 1))
                    continue
                raise

    async def get_admin_user_by_id(self, user_id: int) -> Optional[AdminUser]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM admin_users WHERE id = ?", (int(user_id),))
            row = await cur.fetchone()
            if row:
                return AdminUser(**dict(row))
            return None

    async def list_admin_users(self) -> List[AdminUser]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM admin_users ORDER BY id ASC")
            rows = await cur.fetchall()
            return [AdminUser(**dict(r)) for r in rows]

    async def create_admin_user(
        self,
        username: str,
        password_hash: str,
        is_admin: bool = False,
        can_switch_proxy: bool = False,
    ) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                INSERT INTO admin_users (username, password_hash, is_admin, can_switch_proxy)
                VALUES (?, ?, ?, ?)
                """,
                (username.strip(), password_hash, 1 if is_admin else 0, 1 if can_switch_proxy else 0),
            )
            await db.commit()
            return int(cur.lastrowid)

    async def update_admin_user_role(self, user_id: int, is_admin: bool) -> None:
        async with self._write_conn() as db:
            await db.execute(
                """
                UPDATE admin_users
                SET is_admin = ?, updated_at = datetime('now','localtime')
                WHERE id = ?
                """,
                (1 if is_admin else 0, int(user_id)),
            )
            await db.commit()

    async def update_admin_user_proxy_switch(self, user_id: int, can_switch_proxy: bool) -> None:
        async with self._write_conn() as db:
            await db.execute(
                """
                UPDATE admin_users
                SET can_switch_proxy = ?, updated_at = datetime('now','localtime')
                WHERE id = ?
                """,
                (1 if can_switch_proxy else 0, int(user_id)),
            )
            await db.commit()

    async def update_admin_password(self, username: str, new_password_hash: str) -> None:
        async with self._write_conn() as db:
            await db.execute(
                """
                UPDATE admin_users
                SET password_hash = ?, updated_at = datetime('now','localtime')
                WHERE username = ?
                """,
                (new_password_hash, username),
            )
            await db.commit()

    async def update_admin_username(self, old_username: str, new_username: str) -> None:
        async with self._write_conn() as db:
            await db.execute(
                """
                UPDATE admin_users
                SET username = ?, updated_at = datetime('now','localtime')
                WHERE username = ?
                """,
                (new_username, old_username),
            )
            await db.commit()

    async def update_admin_password_by_id(self, user_id: int, new_password_hash: str) -> None:
        async with self._write_conn() as db:
            await db.execute(
                """
                UPDATE admin_users
                SET password_hash = ?, updated_at = datetime('now','localtime')
                WHERE id = ?
                """,
                (new_password_hash, int(user_id)),
            )
            await db.commit()

    async def get_user_page_permissions(self, user_id: int) -> List[str]:
        async with self._read_conn() as db:
            cur = await db.execute(
                "SELECT page_key FROM user_page_permissions WHERE user_id = ? ORDER BY page_key ASC",
                (int(user_id),),
            )
            rows = await cur.fetchall()
            return [str(x[0]) for x in rows if x and x[0]]

    async def get_user_project_permissions(self, user_id: int) -> List[int]:
        async with self._read_conn() as db:
            cur = await db.execute(
                "SELECT project_id FROM user_project_permissions WHERE user_id = ? ORDER BY project_id ASC",
                (int(user_id),),
            )
            rows = await cur.fetchall()
            out: List[int] = []
            for x in rows:
                try:
                    out.append(int(x[0]))
                except Exception:
                    continue
            return out

    async def get_user_task_type_permissions(self, user_id: int) -> List[int]:
        async with self._read_conn() as db:
            cur = await db.execute(
                "SELECT task_type_id FROM user_task_type_permissions WHERE user_id = ? ORDER BY task_type_id ASC",
                (int(user_id),),
            )
            rows = await cur.fetchall()
            out: List[int] = []
            for x in rows:
                try:
                    out.append(int(x[0]))
                except Exception:
                    continue
            return out

    async def set_user_page_permissions(self, user_id: int, page_keys: List[str]) -> None:
        clean = sorted({str(x or "").strip() for x in (page_keys or []) if str(x or "").strip()})
        async with self._write_conn() as db:
            await db.execute("DELETE FROM user_page_permissions WHERE user_id = ?", (int(user_id),))
            for k in clean:
                await db.execute(
                    "INSERT INTO user_page_permissions (user_id, page_key) VALUES (?, ?)",
                    (int(user_id), k),
                )
            await db.commit()

    async def set_user_project_permissions(self, user_id: int, project_ids: List[int]) -> None:
        clean_set: set[int] = set()
        for x in (project_ids or []):
            try:
                v = int(x)
            except Exception:
                continue
            if v > 0:
                clean_set.add(v)
        clean = sorted(clean_set)
        async with self._write_conn() as db:
            await db.execute("DELETE FROM user_project_permissions WHERE user_id = ?", (int(user_id),))
            for pid in clean:
                await db.execute(
                    "INSERT INTO user_project_permissions (user_id, project_id) VALUES (?, ?)",
                    (int(user_id), int(pid)),
                )
            await db.commit()

    async def set_user_task_type_permissions(self, user_id: int, task_type_ids: List[int]) -> None:
        clean_set: set[int] = set()
        for x in (task_type_ids or []):
            try:
                v = int(x)
            except Exception:
                continue
            if v > 0:
                clean_set.add(v)
        clean = sorted(clean_set)
        async with self._write_conn() as db:
            await db.execute("DELETE FROM user_task_type_permissions WHERE user_id = ?", (int(user_id),))
            for tid in clean:
                await db.execute(
                    "INSERT INTO user_task_type_permissions (user_id, task_type_id) VALUES (?, ?)",
                    (int(user_id), int(tid)),
                )
            await db.commit()

    # ---------- request logs（仅查询/清理；已不再写入，避免表无限膨胀）----------
    async def get_request_logs(self, limit: int = 200) -> List[Dict[str, Any]]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT * FROM request_logs ORDER BY created_at DESC LIMIT ?",
                (limit,),
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def list_dreamina_subject_images_by_ids(self, ids: List[int]) -> List[Dict[str, Any]]:
        """按 dreamina_subject_images.id 批量读取图片资源，保持传入 id 顺序；不存在的 id 忽略。"""
        safe_ids: List[int] = []
        seen: set[int] = set()
        for x in ids or []:
            try:
                n = int(x)
            except Exception:
                continue
            if n > 0 and n not in seen:
                safe_ids.append(n)
                seen.add(n)
        if not safe_ids:
            return []
        placeholders = ",".join("?" for _ in safe_ids)
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                f"""
                SELECT id, uid, subject_id, data_id, name, image_uri, width, height, created_at, updated_at
                FROM dreamina_subject_images
                WHERE id IN ({placeholders})
                """,
                tuple(safe_ids),
            )
            rows = await cur.fetchall()
            by_id = {int(r["id"]): dict(r) for r in rows}
            return [by_id[x] for x in safe_ids if x in by_id]

    async def clear_request_logs(self) -> bool:
        """清空 request_logs。若表数据页损坏（malformed 等），则 DROP 后按 init_db 同结构重建空表。

        Returns:
            True 表示因损坏走了 DROP 重建；False 表示普通 DELETE 清空成功。
        """
        # 与 init_db 中 request_logs 定义保持一致
        ddl = """
                CREATE TABLE request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    actor TEXT,
                    method TEXT NOT NULL,
                    path TEXT NOT NULL,
                    request_body TEXT,
                    response_body TEXT,
                    status_code INTEGER NOT NULL,
                    duration FLOAT NOT NULL,
                    created_at TIMESTAMP DEFAULT (datetime('now','localtime'))
                )
                """
        async with self._write_conn() as db:
            try:
                await db.execute("DELETE FROM request_logs")
                await db.commit()
                return False
            except Exception as e:
                msg = str(e).lower()
                if (
                    "malformed" not in msg
                    and "database disk image" not in msg
                    and "corrupt" not in msg
                ):
                    raise
                try:
                    await db.rollback()
                except Exception:
                    pass
                await db.execute("DROP TABLE IF EXISTS request_logs")
                await db.execute(ddl.strip())
                await db.execute(
                    "CREATE INDEX IF NOT EXISTS idx_req_logs_created_at ON request_logs(created_at)"
                )
                await db.commit()
                return True

    # ---------- project tree (single-query optimization) ----------
    async def get_project_tree(
        self,
        project_id: Optional[int] = None,
        allowed_project_ids: Optional[List[int]] = None,
    ) -> List[Dict[str, Any]]:
        """用单条 JOIN 查询构建完整项目树，避免 N+1 嵌套查询。"""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row

            where_parts = ["p.deleted = 0"]
            params: List[Any] = []

            if project_id is not None:
                where_parts.append("p.id = ?")
                params.append(int(project_id))
            if allowed_project_ids is not None:
                safe_ids = [int(x) for x in allowed_project_ids if int(x) > 0]
                if not safe_ids:
                    return []
                placeholders = ",".join("?" for _ in safe_ids)
                where_parts.append(f"p.id IN ({placeholders})")
                params.extend(safe_ids)

            cur = await db.execute(
                f"""
                SELECT
                  p.id AS p_id, p.name AS p_name, p.deleted AS p_deleted,
                  p.created_at AS p_created_at, p.updated_at AS p_updated_at,
                  b.id AS b_id, b.project_id AS b_project_id, b.name AS b_name,
                  b.lan_addr AS b_lan_addr, b.vendor AS b_vendor, b.access_key AS b_access_key,
                  b.browser_pool_limit AS b_browser_pool_limit,
                  b.deleted AS b_deleted, b.created_at AS b_created_at, b.updated_at AS b_updated_at,
                  s.id AS s_id, s.browser_id AS s_browser_id, s.name AS s_name,
                  s.space_id AS s_space_id, s.project_ids AS s_project_ids,
                  s.deleted AS s_deleted, s.created_at AS s_created_at, s.updated_at AS s_updated_at,
                  w.id AS w_id, w.space_pk AS w_space_pk, w.window_key AS w_window_key,
                  w.window_sort_num AS w_window_sort_num, w.window_name AS w_window_name,
                  w.window_remark AS w_window_remark,
                  w.platform_account AS w_platform_account, w.platform_url AS w_platform_url,
                  w.platform_account_id AS w_platform_account_id,
                  w.proxy_id AS w_proxy_id, w.proxy_addr AS w_proxy_addr,
                  w.proxy_country AS w_proxy_country, w.proxy_expire_at AS w_proxy_expire_at,
                  w.enabled AS w_enabled, w.window_status AS w_window_status,
                  w.deleted AS w_deleted, w.synced_at AS w_synced_at,
                  w.created_at AS w_created_at, w.updated_at AS w_updated_at,
                  (SELECT COUNT(*) FROM task_type_windows ttw
                   WHERE ttw.window_pk = w.id AND ttw.deleted = 0) AS w_bound_task_type_count,
                  (SELECT GROUP_CONCAT(ttw.id, ',') FROM task_type_windows ttw
                   WHERE ttw.window_pk = w.id AND ttw.deleted = 0) AS w_bound_task_type_mapping_ids
                FROM projects p
                LEFT JOIN browsers b ON b.project_id = p.id AND b.deleted = 0
                LEFT JOIN spaces s ON s.browser_id = b.id AND s.deleted = 0
                LEFT JOIN windows w ON w.space_pk = s.id AND w.deleted = 0
                WHERE {' AND '.join(where_parts)}
                ORDER BY
                  p.updated_at DESC, p.id DESC,
                  b.updated_at DESC, b.id DESC,
                  s.updated_at DESC, s.id DESC,
                  (w.window_sort_num IS NULL) ASC, w.window_sort_num ASC, w.window_name ASC, w.id ASC
                """,
                params,
            )
            rows = await cur.fetchall()

            from collections import OrderedDict
            projects_map: OrderedDict[int, Dict[str, Any]] = OrderedDict()
            browsers_map: OrderedDict[int, Dict[str, Any]] = OrderedDict()
            spaces_map: OrderedDict[int, Dict[str, Any]] = OrderedDict()

            for r in rows:
                pid = r["p_id"]
                if pid not in projects_map:
                    projects_map[pid] = {
                        "id": pid, "name": r["p_name"], "deleted": bool(r["p_deleted"]),
                        "created_at": r["p_created_at"], "updated_at": r["p_updated_at"],
                        "browsers": [],
                    }

                bid = r["b_id"]
                if bid is None:
                    continue
                if bid not in browsers_map:
                    b_dict = {
                        "id": bid, "project_id": r["b_project_id"], "name": r["b_name"],
                        "lan_addr": r["b_lan_addr"], "vendor": r["b_vendor"],
                        "access_key": r["b_access_key"],
                        "browser_pool_limit": r["b_browser_pool_limit"] or 0,
                        "deleted": bool(r["b_deleted"]),
                        "created_at": r["b_created_at"], "updated_at": r["b_updated_at"],
                        "spaces": [],
                    }
                    browsers_map[bid] = b_dict
                    projects_map[pid]["browsers"].append(b_dict)

                sid = r["s_id"]
                if sid is None:
                    continue
                if sid not in spaces_map:
                    s_dict = {
                        "id": sid, "browser_id": r["s_browser_id"], "name": r["s_name"],
                        "space_id": r["s_space_id"], "project_ids": r["s_project_ids"],
                        "deleted": bool(r["s_deleted"]),
                        "created_at": r["s_created_at"], "updated_at": r["s_updated_at"],
                        "windows": [],
                    }
                    spaces_map[sid] = s_dict
                    browsers_map[bid]["spaces"].append(s_dict)

                wid = r["w_id"]
                if wid is None:
                    continue
                spaces_map[sid]["windows"].append({
                    "id": wid, "space_pk": r["w_space_pk"],
                    "window_key": r["w_window_key"],
                    "window_sort_num": r["w_window_sort_num"],
                    "window_name": r["w_window_name"],
                    "window_remark": r["w_window_remark"],
                    "platform_account": r["w_platform_account"],
                    "platform_url": r["w_platform_url"],
                    "platform_account_id": r["w_platform_account_id"],
                    "proxy_id": r["w_proxy_id"], "proxy_addr": r["w_proxy_addr"],
                    "proxy_country": r["w_proxy_country"],
                    "proxy_expire_at": r["w_proxy_expire_at"],
                    "enabled": bool(r["w_enabled"]) if r["w_enabled"] is not None else True,
                    "window_status": r["w_window_status"] or 0,
                    "bound_task_type_count": r["w_bound_task_type_count"] or 0,
                    "bound_task_type_mapping_ids": r["w_bound_task_type_mapping_ids"] or "",
                    "deleted": bool(r["w_deleted"]) if r["w_deleted"] is not None else False,
                    "synced_at": r["w_synced_at"],
                    "created_at": r["w_created_at"], "updated_at": r["w_updated_at"],
                })

            return list(projects_map.values())

    # ---------- projects ----------
    async def list_projects(self, allowed_project_ids: Optional[List[int]] = None) -> List[Project]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            if allowed_project_ids is None:
                cur = await db.execute("SELECT * FROM projects WHERE deleted = 0 ORDER BY updated_at DESC, id DESC")
            else:
                safe_ids = [int(x) for x in allowed_project_ids if int(x) > 0]
                if not safe_ids:
                    return []
                placeholders = ",".join("?" for _ in safe_ids)
                cur = await db.execute(
                    f"SELECT * FROM projects WHERE deleted = 0 AND id IN ({placeholders}) ORDER BY updated_at DESC, id DESC",
                    safe_ids,
                )
            rows = await cur.fetchall()
            return [Project(**dict(r)) for r in rows]

    async def create_project(self, name: str) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                "INSERT INTO projects (name, deleted) VALUES (?, 0)",
                (name.strip(),),
            )
            await db.commit()
            return int(cur.lastrowid)

    async def update_project(self, project_id: int, name: str) -> None:
        async with self._write_conn() as db:
            await db.execute(
                "UPDATE projects SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?",
                (name.strip(), project_id),
            )
            await db.commit()

    async def delete_project(self, project_id: int) -> None:
        async with self._write_conn() as db:
            await db.execute("UPDATE projects SET deleted = 1, updated_at = datetime('now','localtime') WHERE id = ?", (project_id,))
            await db.commit()

    # ---------- browsers ----------
    async def list_browsers(self, project_id: int) -> List[FingerprintBrowser]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT * FROM browsers WHERE deleted = 0 AND project_id = ? ORDER BY updated_at DESC, id DESC",
                (project_id,),
            )
            rows = await cur.fetchall()
            return [FingerprintBrowser(**dict(r)) for r in rows]

    async def create_browser(
        self,
        project_id: int,
        name: str,
        lan_addr: str,
        vendor: str = "generic",
        access_key: Optional[str] = None,
        browser_pool_limit: int = 0,
    ) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                INSERT INTO browsers (project_id, name, lan_addr, vendor, access_key, browser_pool_limit, deleted)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                """,
                (project_id, name.strip(), lan_addr.strip(), vendor.strip() or "generic", access_key, max(0, int(browser_pool_limit or 0))),
            )
            await db.commit()
            return int(cur.lastrowid)

    async def update_browser(self, browser_id: int, name: str, lan_addr: str, vendor: str, access_key: Optional[str], browser_pool_limit: int = 0) -> None:
        async with self._write_conn() as db:
            await db.execute(
                """
                UPDATE browsers
                SET name=?, lan_addr=?, vendor=?, access_key=?, browser_pool_limit=?, updated_at=datetime('now','localtime')
                WHERE id=?
                """,
                (name.strip(), lan_addr.strip(), vendor.strip() or "generic", access_key, max(0, int(browser_pool_limit or 0)), browser_id),
            )
            await db.commit()

    async def delete_browser(self, browser_id: int) -> None:
        async with self._write_conn() as db:
            await db.execute("UPDATE browsers SET deleted = 1, updated_at=datetime('now','localtime') WHERE id = ?", (browser_id,))
            await db.commit()

    async def get_browser(self, browser_id: int) -> Optional[FingerprintBrowser]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM browsers WHERE id = ?", (browser_id,))
            row = await cur.fetchone()
            return FingerprintBrowser(**dict(row)) if row else None

    # ---------- spaces ----------
    async def list_spaces(self, browser_id: int) -> List[BrowserSpace]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT * FROM spaces WHERE deleted = 0 AND browser_id = ? ORDER BY updated_at DESC, id DESC",
                (browser_id,),
            )
            rows = await cur.fetchall()
            return [BrowserSpace(**dict(r)) for r in rows]

    async def create_space(self, browser_id: int, name: str, space_id: str, project_ids: Optional[str] = None) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                INSERT INTO spaces (browser_id, name, space_id, project_ids, deleted)
                VALUES (?, ?, ?, ?, 0)
                """,
                (browser_id, name.strip(), space_id.strip(), (project_ids or "").strip() or None),
            )
            await db.commit()
            return int(cur.lastrowid)

    async def update_space(self, space_pk: int, name: str, space_id: str, project_ids: Optional[str] = None) -> None:
        async with self._write_conn() as db:
            await db.execute(
                "UPDATE spaces SET name=?, space_id=?, project_ids=?, updated_at=datetime('now','localtime') WHERE id=?",
                (name.strip(), space_id.strip(), (project_ids or "").strip() or None, space_pk),
            )
            await db.commit()

    async def delete_space(self, space_pk: int) -> None:
        async with self._write_conn() as db:
            await db.execute("UPDATE spaces SET deleted = 1, updated_at=datetime('now','localtime') WHERE id = ?", (space_pk,))
            await db.commit()

    async def get_space(self, space_pk: int) -> Optional[BrowserSpace]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM spaces WHERE id = ?", (space_pk,))
            row = await cur.fetchone()
            return BrowserSpace(**dict(row)) if row else None

    # ---------- windows ----------
    async def list_windows(self, space_pk: int) -> List[WindowInfo]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT w.*,
                       (SELECT COUNT(*) FROM task_type_windows t
                        WHERE t.window_pk = w.id AND t.deleted = 0) AS bound_task_type_count,
                       (SELECT GROUP_CONCAT(t.id, ',') FROM task_type_windows t
                        WHERE t.window_pk = w.id AND t.deleted = 0) AS bound_task_type_mapping_ids
                FROM windows w
                WHERE w.deleted = 0 AND w.space_pk = ?
                ORDER BY (w.window_sort_num IS NULL) ASC, w.window_sort_num ASC, w.window_name ASC, w.id ASC
                """,
                (space_pk,),
            )
            rows = await cur.fetchall()
            result: List[WindowInfo] = []
            for r in rows:
                d = dict(r)
                if d.get("raw_json"):
                    try:
                        d["raw"] = json.loads(d["raw_json"])
                    except Exception:
                        d["raw"] = None
                d.pop("raw_json", None)
                result.append(WindowInfo(**d))
            return result

    async def list_window_project_pairs(self, window_pks: List[int]) -> Dict[int, int]:
        ids: List[int] = []
        for x in (window_pks or []):
            try:
                v = int(x)
            except Exception:
                continue
            if v > 0:
                ids.append(v)
        ids = sorted(set(ids))
        if not ids:
            return {}
        placeholders = ",".join("?" for _ in ids)
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                f"""
                SELECT
                  w.id AS window_pk,
                  p.id AS project_id
                FROM windows w
                JOIN spaces s ON s.id = w.space_pk
                JOIN browsers b ON b.id = s.browser_id
                JOIN projects p ON p.id = b.project_id
                WHERE w.deleted = 0
                  AND s.deleted = 0
                  AND b.deleted = 0
                  AND p.deleted = 0
                  AND w.id IN ({placeholders})
                """,
                ids,
            )
            rows = await cur.fetchall()
            out: Dict[int, int] = {}
            for r in rows:
                try:
                    out[int(r["window_pk"])] = int(r["project_id"])
                except Exception:
                    continue
            return out

    async def get_window_bound_ip_last_country(self, *, space_id: str = "", window_key: str = "", window_pk: int = 0) -> str:
        """读取窗口绑定代理 IP 的 last_country。

        优先按 windows.proxy_id 关联 proxies.last_country；读取不到时降级使用
        windows.proxy_country / windows.raw_json 中同步到的 lastCountry。调用方可传
        window_pk，或传 space_id + window_key。
        """
        sid = str(space_id or "").strip()
        wk = str(window_key or "").strip()
        try:
            wpk = int(window_pk or 0)
        except Exception:
            wpk = 0
        if wpk <= 0 and (not sid or not wk):
            return ""

        where_sql = "w.id = ?" if wpk > 0 else "s.space_id = ? AND w.window_key = ?"
        params: tuple[Any, ...] = (wpk,) if wpk > 0 else (sid, wk)
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                f"""
                SELECT
                  w.proxy_country AS window_proxy_country,
                  w.raw_json AS window_raw_json,
                  p.last_country AS proxy_last_country
                FROM windows w
                JOIN spaces s ON s.id = w.space_pk AND s.deleted = 0
                LEFT JOIN proxies p
                  ON p.space_pk = w.space_pk
                 AND p.deleted = 0
                 AND p.proxy_id = w.proxy_id
                WHERE w.deleted = 0
                  AND {where_sql}
                LIMIT 1
                """,
                params,
            )
            row = await cur.fetchone()
        if not row:
            return ""
        d = dict(row)
        for key in ("proxy_last_country", "window_proxy_country"):
            code = str(d.get(key) or "").strip().lower()
            if code:
                return code
        raw = d.get("window_raw_json")
        if raw:
            try:
                raw_obj = json.loads(raw) if isinstance(raw, str) else raw
                if isinstance(raw_obj, dict):
                    inner = raw_obj.get("raw") if isinstance(raw_obj.get("raw"), dict) else raw_obj
                    code = str(
                        inner.get("lastCountry")
                        or inner.get("last_country")
                        or inner.get("proxyCountry")
                        or inner.get("proxy_country")
                        or ""
                    ).strip().lower()
                    if code:
                        return code
            except Exception:
                return ""
        return ""

    async def upsert_windows(self, space_pk: int, windows: List[Dict[str, Any]]) -> Dict[str, Any]:
        """把同步到的窗口信息保存到 DB（按 space_pk+window_key 唯一 upsert）。

        返回：dict，包含 affected（写入/更新行数）、skipped（跳过数）、skipped_keys（跳过的 window_key 列表）。
        使用 _write_conn 避免与任务创建/进度查询等并发写导致死锁。

        注意：若某个 window_key 已存在于其他 space_pk 下（窗口已被转移到别的空间），
        则跳过该窗口，不在当前空间下新增或更新。
        """
        async with self._write_conn() as db:
            await db.execute("PRAGMA foreign_keys=ON")
            affected = 0
            skipped = 0
            skipped_keys: List[str] = []
            for w in windows:
                raw_obj = w.get("raw")
                if not isinstance(raw_obj, dict):
                    raw_obj = {}
                window_key = str(w.get("window_key") or w.get("id") or w.get("dirId") or w.get("name") or "").strip()
                if not window_key:
                    continue
                # 若该 window_key 已存在于其他 space_pk 下，跳过（窗口可能已被转移到别的项目空间）
                cur_chk = await db.execute(
                    "SELECT 1 FROM windows WHERE window_key = ? AND deleted = 0 LIMIT 1",
                    (window_key,),
                )
                if await cur_chk.fetchone():
                    skipped += 1
                    skipped_keys.append(window_key)
                    continue
                # window_sort_num: 优先取标准 snake_case，其次取 Roxy 的 camelCase，最后从 raw 里兜底
                window_sort_num_raw = (
                    w.get("window_sort_num")
                    if w.get("window_sort_num") is not None
                    else (w.get("windowSortNum") if w.get("windowSortNum") is not None else None)
                )
                if window_sort_num_raw is None:
                    window_sort_num_raw = raw_obj.get("windowSortNum")
                try:
                    window_sort_num = int(window_sort_num_raw) if window_sort_num_raw not in (None, "", "-") else None
                except Exception:
                    window_sort_num = None

                window_name = str(w.get("window_name") or w.get("name") or window_key).strip()
                window_remark = (w.get("window_remark") if w.get("window_remark") is not None else w.get("remark"))
                window_remark = (str(window_remark).strip() if window_remark is not None else None)
                platform_account = (w.get("platform_account") or w.get("account") or w.get("username"))
                platform_url = (w.get("platform_url") or w.get("url"))
                platform_account_id_raw = (
                    w.get("platform_account_id")
                    if w.get("platform_account_id") is not None
                    else w.get("platformAccountId")
                )
                if platform_account_id_raw is None:
                    platform_account_id_raw = raw_obj.get("platformAccountId")
                try:
                    platform_account_id = int(platform_account_id_raw) if platform_account_id_raw not in (None, "", "-") else None
                except Exception:
                    platform_account_id = None
                # proxy_id: 优先从 raw 中提取（Roxy: proxyInfo.moduleId -> minimal_raw.proxyModuleId）
                proxy_id_raw = None
                proxy_id_raw = (
                    raw_obj.get("proxyModuleId")
                    if raw_obj.get("proxyModuleId") is not None
                    else (raw_obj.get("proxy_module_id") if raw_obj.get("proxy_module_id") is not None else raw_obj.get("moduleId"))
                )
                if proxy_id_raw is None:
                    proxy_info = raw_obj.get("proxyInfo")
                    if isinstance(proxy_info, dict):
                        proxy_id_raw = proxy_info.get("moduleId")
                if proxy_id_raw is None:
                    proxy_id_raw = w.get("proxy_id") if w.get("proxy_id") is not None else w.get("proxyModuleId")
                try:
                    proxy_id = int(proxy_id_raw) if proxy_id_raw not in (None, "", "-") else None
                except Exception:
                    proxy_id = None
                proxy_addr = (w.get("proxy_addr") or w.get("proxy") or w.get("proxy_url"))
                proxy_country = (w.get("proxy_country") or w.get("country"))
                proxy_expire_at = (w.get("proxy_expire_at") or w.get("expire_at") or w.get("proxy_expire"))
                enabled = 1 if bool(w.get("enabled", True)) else 0
                window_status_raw = w.get("window_status")
                if window_status_raw is None:
                    window_status_raw = w.get("windowStatus")
                try:
                    window_status = 1 if int(window_status_raw or 0) == 1 else 0
                except Exception:
                    window_status = 0
                deleted = 1 if bool(w.get("deleted", False)) else 0
                raw_json = json.dumps(w, ensure_ascii=False)

                await db.execute(
                    """
                    INSERT INTO windows (
                        space_pk, window_key, window_sort_num, window_name, window_remark,
                        platform_account, platform_url, platform_account_id,
                        proxy_id,
                        proxy_addr, proxy_country, proxy_expire_at,
                        enabled, window_status, deleted, raw_json, synced_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
                    ON CONFLICT(space_pk, window_key) DO UPDATE SET
                        window_sort_num=excluded.window_sort_num,
                        window_name=excluded.window_name,
                        window_remark=CASE
                            WHEN excluded.window_remark IS NULL OR TRIM(COALESCE(excluded.window_remark, '')) = '' THEN windows.window_remark
                            ELSE excluded.window_remark
                        END,
                        platform_account=excluded.platform_account,
                        platform_url=excluded.platform_url,
                        platform_account_id=CASE
                            -- 远端明确返回 account_id：直接采用
                            WHEN excluded.platform_account_id IS NOT NULL THEN excluded.platform_account_id
                            -- 远端未返回任何账号信息：保留本地 id，避免短暂空数据把绑定抹掉
                            WHEN TRIM(COALESCE(excluded.platform_account, '')) = ''
                                 AND TRIM(COALESCE(excluded.platform_url, '')) = '' THEN windows.platform_account_id
                            -- 远端账号名/网址与本地一致：沿用本地 id
                            WHEN TRIM(COALESCE(excluded.platform_account, '')) = TRIM(COALESCE(windows.platform_account, ''))
                                 AND (
                                      TRIM(COALESCE(excluded.platform_url, '')) = ''
                                   OR TRIM(COALESCE(windows.platform_url, '')) = ''
                                   OR TRIM(COALESCE(excluded.platform_url, '')) = TRIM(COALESCE(windows.platform_url, ''))
                                 ) THEN windows.platform_account_id
                            -- 账号已变化但没有 id：清空旧 id，避免“当前账号”和“绑定账号”不一致
                            ELSE NULL
                        END,
                        -- 约定：同步窗口时，若新数据未解析到 proxy_id，则保留已有 proxy_id
                        proxy_id=COALESCE(excluded.proxy_id, windows.proxy_id),
                        proxy_addr=excluded.proxy_addr,
                        proxy_country=excluded.proxy_country,
                        proxy_expire_at=excluded.proxy_expire_at,
                        enabled=excluded.enabled,
                        window_status=COALESCE(excluded.window_status, windows.window_status),
                        -- 约定：同步窗口时，以指纹浏览器返回的删除状态为准；
                        -- 若本地曾标记删除但远端仍返回该窗口，则恢复为未删除并展示
                        deleted=excluded.deleted,
                        raw_json=excluded.raw_json,
                        synced_at=datetime('now','localtime'),
                        updated_at=datetime('now','localtime')
                    """,
                    (
                        space_pk,
                        window_key,
                        window_sort_num,
                        window_name,
                        window_remark,
                        platform_account,
                        platform_url,
                        platform_account_id,
                        proxy_id,
                        proxy_addr,
                        proxy_country,
                        proxy_expire_at,
                        enabled,
                        window_status,
                        deleted,
                        raw_json,
                    ),
                )
                affected += 1
            await db.commit()
            return {"affected": affected, "skipped": skipped, "skipped_keys": skipped_keys}

    async def update_window_remark(self, *, space_pk: int, window_key: str, remark: str) -> int:
        wk = str(window_key or "").strip()
        if not wk:
            return 0
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE windows
                SET window_remark = ?, updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND window_key = ? AND deleted = 0
                """,
                (
                    (str(remark or "").strip() or None),
                    int(space_pk),
                    wk,
                ),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    async def update_window_raw_core_version(self, *, space_pk: int, window_key: str, core_version: str) -> int:
        """在 windows.raw_json 的 raw 子对象中写入 coreVersion（供列表展示；与 Roxy /browser/mdf 一致）。"""
        wk = str(window_key or "").strip()
        cv = str(core_version or "").strip()
        if not wk or not cv:
            return 0
        async with self._write_conn() as db:
            cur = await db.execute(
                "SELECT raw_json FROM windows WHERE space_pk = ? AND window_key = ? AND deleted = 0 LIMIT 1",
                (int(space_pk), wk),
            )
            row = await cur.fetchone()
            if not row:
                return 0
            raw_s = row[0]
            try:
                obj = json.loads(raw_s) if raw_s else {}
            except Exception:
                obj = {}
            if not isinstance(obj, dict):
                obj = {}
            raw_inner = obj.get("raw")
            if not isinstance(raw_inner, dict):
                raw_inner = {}
            raw_inner["coreVersion"] = cv
            obj["raw"] = raw_inner
            new_json = json.dumps(obj, ensure_ascii=False)
            cur2 = await db.execute(
                """
                UPDATE windows
                SET raw_json = ?, updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND window_key = ? AND deleted = 0
                """,
                (new_json, int(space_pk), wk),
            )
            await db.commit()
            return int(cur2.rowcount or 0)

    async def count_proxy_bindings(self, space_pk: int = 0) -> Dict[int, int]:
        """统计全局：每个 proxy_id 被多少个“本地未删除窗口”绑定（跨所有空间，代理是全局共用的）。

        说明：
        - 优先使用 windows.proxy_id 统计（选择代理 moduleId 的场景）。
        - 若 windows.proxy_id 为空/0（常见于“自定义代理”），则尝试用 windows.proxy_addr 匹配本地 proxies：
          - proxies.last_ip == windows.proxy_addr
          - 或 proxies.host:port == windows.proxy_addr
          - 或 proxies.host == windows.proxy_addr
        - 只要能匹配到 1 个本地 proxy_id，就按该 proxy_id 计数；否则归到 0（不计入任何代理）。
        """
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                WITH win AS (
                  SELECT
                    id,
                    COALESCE(proxy_id, 0) AS pid,
                    TRIM(COALESCE(proxy_addr, '')) AS proxy_addr
                  FROM windows
                  WHERE deleted = 0
                ),
                matched AS (
                  SELECT
                    w.id AS window_id,
                    MIN(p.proxy_id) AS matched_proxy_id
                  FROM win w
                  JOIN proxies p
                    ON p.deleted = 0
                   AND w.pid = 0
                   AND w.proxy_addr <> ''
                   AND (
                     (p.last_ip IS NOT NULL AND TRIM(p.last_ip) <> '' AND TRIM(p.last_ip) = w.proxy_addr)
                     OR ((p.host || ':' || p.port) IS NOT NULL AND TRIM(p.host || ':' || p.port) = w.proxy_addr)
                     OR (p.host IS NOT NULL AND TRIM(p.host) <> '' AND TRIM(p.host) = w.proxy_addr)
                   )
                  GROUP BY w.id
                )
                SELECT
                  COALESCE(NULLIF(win.pid, 0), matched.matched_proxy_id, 0) AS proxy_id,
                  COUNT(*) AS cnt
                FROM win
                LEFT JOIN matched ON matched.window_id = win.id
                GROUP BY COALESCE(NULLIF(win.pid, 0), matched.matched_proxy_id, 0)
                """,
            )
            rows = await cur.fetchall()
            out: Dict[int, int] = {}
            for r in rows:
                try:
                    pid = int(r["proxy_id"] or 0)
                except Exception:
                    pid = 0
                try:
                    out[pid] = int(r["cnt"] or 0)
                except Exception:
                    out[pid] = 0
            return out

    async def count_proxy_success_tasks(self, space_pk: int = 0) -> Dict[int, int]:
        """统计全局：每个 proxy_id 对应的成功任务数（基于 tasks.window_ip，跨所有空间）。"""
        stats = await self.count_proxy_task_stats(space_pk)
        out: Dict[int, int] = {}
        for pid, row in stats.items():
            try:
                out[int(pid)] = int((row or {}).get("completed", 0) or 0)
            except Exception:
                out[int(pid)] = 0
        return out

    async def list_proxy_bound_windows(self, proxy_id: int) -> List[Dict[str, Any]]:
        """返回某个代理当前绑定的窗口详情（跨所有空间）。"""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                WITH target_proxy AS (
                  SELECT
                    proxy_id,
                    TRIM(COALESCE(last_ip, '')) AS key_last_ip,
                    TRIM(COALESCE(host, '')) AS key_host,
                    CASE
                      WHEN TRIM(COALESCE(host, '')) <> '' AND TRIM(COALESCE(port, '')) <> ''
                      THEN TRIM(COALESCE(host, '')) || ':' || TRIM(COALESCE(port, ''))
                      ELSE ''
                    END AS key_host_port
                  FROM proxies
                  WHERE proxy_id = ? AND deleted = 0
                  ORDER BY updated_at DESC, id DESC
                  LIMIT 1
                )
                SELECT
                  w.id AS window_pk,
                  w.window_key,
                  w.window_sort_num,
                  w.window_name,
                  w.proxy_id,
                  w.proxy_addr,
                  w.proxy_country,
                  w.window_status,
                  s.id AS space_pk,
                  s.name AS space_name,
                  s.space_id AS browser_space_id,
                  b.id AS browser_id,
                  b.name AS browser_name,
                  p.id AS project_id,
                  p.name AS project_name,
                  COUNT(DISTINCT ttw.id) AS task_type_binding_count,
                  GROUP_CONCAT(DISTINCT tt.id) AS task_type_ids,
                  GROUP_CONCAT(DISTINCT (tt.name || ' [' || tt.code || ']')) AS task_type_names
                FROM target_proxy tp
                JOIN windows w
                  ON w.deleted = 0
                 AND (
                      COALESCE(w.proxy_id, 0) = tp.proxy_id
                      OR (
                        COALESCE(w.proxy_id, 0) = 0
                        AND TRIM(COALESCE(w.proxy_addr, '')) <> ''
                        AND (
                             (tp.key_last_ip <> '' AND TRIM(COALESCE(w.proxy_addr, '')) = tp.key_last_ip)
                          OR (tp.key_host <> '' AND TRIM(COALESCE(w.proxy_addr, '')) = tp.key_host)
                          OR (tp.key_host_port <> '' AND TRIM(COALESCE(w.proxy_addr, '')) = tp.key_host_port)
                        )
                      )
                 )
                JOIN spaces s ON s.id = w.space_pk
                JOIN browsers b ON b.id = s.browser_id
                JOIN projects p ON p.id = b.project_id
                LEFT JOIN task_type_windows ttw ON ttw.window_pk = w.id AND ttw.deleted = 0
                LEFT JOIN task_types tt ON tt.id = ttw.task_type_id AND tt.deleted = 0
                GROUP BY
                  w.id, w.window_key, w.window_sort_num, w.window_name, w.proxy_id, w.proxy_addr, w.proxy_country, w.window_status,
                  s.id, s.name, s.space_id, b.id, b.name, p.id, p.name
                ORDER BY (w.window_sort_num IS NULL) ASC, w.window_sort_num ASC, w.window_name ASC, w.id ASC
                """,
                (int(proxy_id),),
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def count_proxy_task_stats(self, space_pk: int = 0) -> Dict[int, Dict[str, int]]:
        """统计全局：每个 proxy_id 的成功/失败任务数（按 tasks.window_ip 精确匹配，跨所有空间）。"""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                WITH px AS (
                  SELECT
                    proxy_id,
                    TRIM(COALESCE(last_ip, '')) AS key_last_ip,
                    TRIM(COALESCE(host, '')) AS key_host,
                    CASE
                      WHEN TRIM(COALESCE(host, '')) <> '' AND TRIM(COALESCE(port, '')) <> ''
                      THEN TRIM(COALESCE(host, '')) || ':' || TRIM(COALESCE(port, ''))
                      ELSE ''
                    END AS key_host_port
                  FROM proxies
                  WHERE deleted = 0
                )
                SELECT
                  px.proxy_id AS proxy_id,
                  SUM(
                    CASE
                      WHEN t.status = 'completed' THEN 1
                      ELSE 0
                    END
                  ) AS completed_count,
                  SUM(
                    CASE
                      WHEN t.status = 'failed' THEN 1
                      ELSE 0
                    END
                  ) AS failed_count
                FROM px
                LEFT JOIN tasks t
                  ON TRIM(COALESCE(t.window_ip, '')) <> ''
                 AND (
                      (px.key_last_ip <> '' AND TRIM(COALESCE(t.window_ip, '')) = px.key_last_ip)
                   OR (px.key_host <> '' AND TRIM(COALESCE(t.window_ip, '')) = px.key_host)
                   OR (px.key_host_port <> '' AND TRIM(COALESCE(t.window_ip, '')) = px.key_host_port)
                 )
                GROUP BY px.proxy_id
                """,
            )
            rows = await cur.fetchall()
            out: Dict[int, Dict[str, int]] = {}
            for r in rows:
                try:
                    pid = int(r["proxy_id"] or 0)
                except Exception:
                    pid = 0
                try:
                    out[pid] = {
                        "completed": int(r["completed_count"] or 0),
                        "failed": int(r["failed_count"] or 0),
                    }
                except Exception:
                    out[pid] = {"completed": 0, "failed": 0}
            return out

    async def get_window(self, window_pk: int) -> Optional[WindowInfo]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM windows WHERE id = ?", (window_pk,))
            row = await cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("raw_json"):
                try:
                    d["raw"] = json.loads(d["raw_json"])
                except Exception:
                    d["raw"] = None
            d.pop("raw_json", None)
            return WindowInfo(**d)

    async def get_window_by_key(self, *, space_pk: int, window_key: str) -> Optional[WindowInfo]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT * FROM windows WHERE space_pk = ? AND window_key = ? AND deleted = 0 LIMIT 1",
                (space_pk, window_key),
            )
            row = await cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("raw_json"):
                try:
                    d["raw"] = json.loads(d["raw_json"])
                except Exception:
                    d["raw"] = None
            d.pop("raw_json", None)
            return WindowInfo(**d)

    async def delete_window_by_key(self, *, space_pk: int, window_key: str) -> Dict[str, int]:
        """本地标记删除窗口（不物理删除）。

        同时级联逻辑删除 task_type_windows 关联记录（deleted=1）。

        返回：
        - window_affected: windows 表影响行数（0 表示未找到该窗口或已被删除）
        - task_type_window_affected: task_type_windows 表影响行数

        使用 _write_conn 避免与同步窗口等并发写导致死锁。
        """
        async with self._write_conn() as db:
            db.row_factory = aiosqlite.Row
            cur_win = await db.execute(
                "SELECT id FROM windows WHERE space_pk = ? AND window_key = ? AND deleted = 0 LIMIT 1",
                (int(space_pk), str(window_key).strip()),
            )
            row = await cur_win.fetchone()
            if not row:
                return {"window_affected": 0, "task_type_window_affected": 0}

            window_pk = int(row["id"])
            cur = await db.execute(
                "UPDATE windows SET deleted = 1, updated_at=datetime('now','localtime') WHERE id = ? AND deleted = 0",
                (window_pk,),
            )
            cur_m = await db.execute(
                """
                UPDATE task_type_windows
                SET deleted = 1, updated_at = datetime('now','localtime')
                WHERE window_pk = ? AND deleted = 0
                """,
                (window_pk,),
            )
            await db.commit()
            try:
                return {
                    "window_affected": int(cur.rowcount or 0),
                    "task_type_window_affected": int(cur_m.rowcount or 0),
                }
            except Exception:
                return {"window_affected": 0, "task_type_window_affected": 0}

    async def move_window_to_space(self, *, source_space_pk: int, target_space_pk: int, window_key: str) -> int:
        """把窗口从 source_space_pk 转移到 target_space_pk（仅本地 DB）。

        说明：
        - 仅迁移本地窗口记录，不调用指纹浏览器接口。
        - 迁移后保留账号绑定信息，避免 UI 中“当前账号”被意外清空。
        - 迁移后清空代理绑定，避免跨空间引用无效代理数据。
        - 若目标空间已存在同 window_key 的有效窗口，抛出 ValueError。

        使用 _write_conn 避免与同步窗口、删除窗口等并发写导致死锁。
        """
        src = int(source_space_pk)
        dst = int(target_space_pk)
        wk = str(window_key or "").strip()
        if src <= 0 or dst <= 0 or not wk:
            return 0
        if src == dst:
            raise ValueError("目标空间不能与源空间相同")

        async with self._write_conn() as db:
            db.row_factory = aiosqlite.Row

            cur_space = await db.execute("SELECT id FROM spaces WHERE id = ? AND deleted = 0", (dst,))
            dst_row = await cur_space.fetchone()
            if not dst_row:
                raise ValueError("目标空间不存在或已删除")

            cur_src = await db.execute(
                "SELECT id FROM windows WHERE space_pk = ? AND window_key = ? AND deleted = 0 LIMIT 1",
                (src, wk),
            )
            src_row = await cur_src.fetchone()
            if not src_row:
                return 0

            cur_conflict = await db.execute(
                "SELECT id, deleted FROM windows WHERE space_pk = ? AND window_key = ? LIMIT 1",
                (dst, wk),
            )
            conflict = await cur_conflict.fetchone()
            if conflict and int(conflict["deleted"] or 0) == 0:
                raise ValueError("目标空间已存在相同窗口ID")
            if conflict and int(conflict["deleted"] or 0) == 1:
                # 唯一键是 (space_pk, window_key)，删除已逻辑删除的旧记录后再迁移。
                await db.execute("DELETE FROM windows WHERE id = ?", (int(conflict["id"]),))

            cur = await db.execute(
                """
                UPDATE windows
                SET space_pk = ?,
                    window_status = 0,
                    updated_at = datetime('now','localtime')
                WHERE id = ?
                """,
                (dst, int(src_row["id"])),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def update_window_proxy_id(self, *, space_pk: int, window_key: str, proxy_id: Optional[int]) -> int:
        """更新本地窗口代理字段（proxy_id + proxy_addr/proxy_country）。

        说明：
        - proxy_id <= 0：视为不使用代理，清空 proxy_addr/proxy_country。
        - proxy_id > 0：从同空间 proxies 表回填 proxy_addr/proxy_country，避免 tasks.window_ip 为空或陈旧。

        返回：影响行数（0 表示未找到或已删除）。
        """
        spk = int(space_pk)
        wk = str(window_key).strip()
        pid = int(proxy_id or 0)
        async with self._write_conn() as db:
            if pid <= 0:
                cur = await db.execute(
                    """
                    UPDATE windows
                    SET proxy_id = 0,
                        proxy_addr = NULL,
                        proxy_country = NULL,
                        updated_at=datetime('now','localtime')
                    WHERE space_pk = ? AND window_key = ? AND deleted = 0
                    """,
                    (spk, wk),
                )
            else:
                cur = await db.execute(
                    """
                    UPDATE windows
                    SET proxy_id = ?,
                        proxy_addr = (
                            SELECT
                              CASE
                                WHEN TRIM(COALESCE(p.last_ip, '')) <> '' THEN TRIM(p.last_ip)
                                WHEN TRIM(COALESCE(p.host, '')) <> '' AND TRIM(COALESCE(p.port, '')) <> ''
                                  THEN TRIM(p.host) || ':' || TRIM(p.port)
                                WHEN TRIM(COALESCE(p.host, '')) <> '' THEN TRIM(p.host)
                                ELSE NULL
                              END
                            FROM proxies p
                            WHERE p.proxy_id = ? AND p.deleted = 0
                            LIMIT 1
                        ),
                        proxy_country = (
                            SELECT NULLIF(TRIM(COALESCE(p.last_country, '')), '')
                            FROM proxies p
                            WHERE p.proxy_id = ? AND p.deleted = 0
                            LIMIT 1
                        ),
                        updated_at=datetime('now','localtime')
                    WHERE space_pk = ? AND window_key = ? AND deleted = 0
                    """,
                    (pid, pid, pid, spk, wk),
                )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def update_window_platform_binding(
        self,
        *,
        space_pk: int,
        window_key: str,
        platform_account_id: Optional[int],
        platform_account: Optional[str],
        platform_url: Optional[str],
    ) -> int:
        """更新窗口绑定的平台账号信息（本地立即生效）。"""
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE windows
                SET platform_account_id = ?,
                    platform_account = ?,
                    platform_url = ?,
                    updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND window_key = ? AND deleted = 0
                """,
                (
                    platform_account_id,
                    str(platform_account).strip() if platform_account is not None else None,
                    str(platform_url).strip() if platform_url is not None else None,
                    int(space_pk),
                    str(window_key).strip(),
                ),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def sync_window_statuses(self, *, space_pk: int, open_window_keys: List[str]) -> int:
        """按窗口 key 批量同步窗口状态（1=打开，0=未打开）。使用 _write_conn 避免死锁。"""
        keys = [str(x or "").strip() for x in (open_window_keys or []) if str(x or "").strip()]
        async with self._write_conn() as db:
            if keys:
                placeholders = ",".join(["?"] * len(keys))
                sql = f"""
                    UPDATE windows
                    SET window_status = CASE WHEN window_key IN ({placeholders}) THEN 1 ELSE 0 END,
                        updated_at = datetime('now','localtime')
                    WHERE space_pk = ? AND deleted = 0
                """
                params: List[Any] = [*keys, int(space_pk)]
                cur = await db.execute(sql, params)
            else:
                cur = await db.execute(
                    """
                    UPDATE windows
                    SET window_status = 0,
                        updated_at = datetime('now','localtime')
                    WHERE space_pk = ? AND deleted = 0
                    """,
                    (int(space_pk),),
                )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def update_window_status_by_space_and_key(self, *, space_id: str, window_key: str, window_status: int) -> int:
        """按 (space_id, window_key) 更新单个窗口状态（1=打开，0=未打开）。"""
        sid = str(space_id or "").strip()
        wk = str(window_key or "").strip()
        if not sid or not wk:
            return 0
        st = 1 if int(window_status or 0) == 1 else 0
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE windows
                SET window_status = ?,
                    updated_at = datetime('now','localtime')
                WHERE id = (
                    SELECT w.id
                    FROM windows w
                    JOIN spaces s ON s.id = w.space_pk
                    WHERE s.deleted = 0
                      AND w.deleted = 0
                      AND s.space_id = ?
                      AND w.window_key = ?
                    ORDER BY w.id DESC
                    LIMIT 1
                )
                """,
                (st, sid, wk),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def clear_window_platform_binding_by_account(self, *, space_pk: int, account_id: int) -> int:
        """当账号被删除时，清空引用该账号的窗口绑定。"""
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE windows
                SET platform_account_id = NULL,
                    platform_account = NULL,
                    platform_url = NULL,
                    updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND platform_account_id = ? AND deleted = 0
                """,
                (int(space_pk), int(account_id)),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def clear_window_platform_binding_by_account_global(self, *, account_id: int) -> int:
        """按 account_id 清空所有空间窗口的本地账号绑定。"""
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE windows
                SET platform_account_id = NULL,
                    platform_account = NULL,
                    platform_url = NULL,
                    updated_at = datetime('now','localtime')
                WHERE platform_account_id = ? AND deleted = 0
                """,
                (int(account_id),),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def resolve_space_pk_for_window(self, *, space_id: str, window_key: str) -> Optional[int]:
        """根据 (workspaceId=space_id, window_key) 解析本地 space_pk。

        说明：
        - tasks 执行器侧通常只有 space_id(window workspaceId) + window_key(dirId)，没有本地 spaces.id。
        - 本方法优先通过 windows+spaces join 精确定位；兜底仅按 space_id 找最近的 space_pk。
        """
        sid = str(space_id or "").strip()
        wk = str(window_key or "").strip()
        if not sid:
            return None
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            if wk:
                cur = await db.execute(
                    """
                    SELECT w.space_pk AS space_pk
                    FROM windows w
                    JOIN spaces s ON s.id = w.space_pk
                    WHERE s.deleted = 0
                      AND w.deleted = 0
                      AND s.space_id = ?
                      AND w.window_key = ?
                    ORDER BY w.id DESC
                    LIMIT 1
                    """,
                    (sid, wk),
                )
                row = await cur.fetchone()
                # aiosqlite.Row（sqlite3.Row）不是 dict，没有 .get()
                if row and dict(row).get("space_pk") is not None:
                    try:
                        return int(row["space_pk"])
                    except Exception:
                        pass

            cur2 = await db.execute(
                "SELECT id FROM spaces WHERE deleted = 0 AND space_id = ? ORDER BY id DESC LIMIT 1",
                (sid,),
            )
            row2 = await cur2.fetchone()
            if row2 and dict(row2).get("id") is not None:
                try:
                    return int(row2["id"])
                except Exception:
                    return None
            return None

    # ---------- platform accounts ----------
    async def list_platform_accounts(self, space_pk: int, *, include_deleted: bool = False) -> List[PlatformAccount]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            if include_deleted:
                cur = await db.execute(
                    """
                    SELECT * FROM platform_accounts
                    WHERE space_pk = ?
                    ORDER BY updated_at DESC, id DESC
                    """,
                    (int(space_pk),),
                )
            else:
                cur = await db.execute(
                    """
                    SELECT * FROM platform_accounts
                    WHERE deleted = 0 AND space_pk = ?
                    ORDER BY updated_at DESC, id DESC
                    """,
                    (int(space_pk),),
                )
            rows = await cur.fetchall()
            result: List[PlatformAccount] = []
            for r in rows:
                d = dict(r)
                if d.get("raw_json"):
                    try:
                        raw_obj = json.loads(d["raw_json"])
                        d["raw"] = raw_obj if isinstance(raw_obj, dict) else None
                    except Exception:
                        d["raw"] = None
                d.pop("raw_json", None)
                result.append(PlatformAccount(**d))
            return result

    async def list_all_platform_accounts(self, *, include_deleted: bool = False) -> List[PlatformAccount]:
        """返回所有空间的平台账号（按 account_id 去重，保留最近更新的记录）。"""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            where = "" if include_deleted else "WHERE deleted = 0"
            cur = await db.execute(
                f"SELECT * FROM platform_accounts {where} ORDER BY updated_at DESC, id DESC"
            )
            rows = await cur.fetchall()
            seen_account_ids: set = set()
            result: List[PlatformAccount] = []
            for r in rows:
                d = dict(r)
                aid = d.get("account_id", 0)
                if aid in seen_account_ids:
                    continue
                seen_account_ids.add(aid)
                if d.get("raw_json"):
                    try:
                        raw_obj = json.loads(d["raw_json"])
                        d["raw"] = raw_obj if isinstance(raw_obj, dict) else None
                    except Exception:
                        d["raw"] = None
                d.pop("raw_json", None)
                result.append(PlatformAccount(**d))
            return result

    async def upsert_platform_accounts(
        self,
        space_pk: int,
        accounts: List[Dict[str, Any]],
        *,
        full_replace: bool = True,
        restore_deleted: bool = True,
    ) -> int:
        """保存平台账号列表（按 space_pk+account_id upsert）。

        参数：
        - full_replace=True：以输入结果为准，未出现账号会标记 deleted=1（全量同步）
        - full_replace=False：仅增量写入，不删除其他本地账号（适合导入后回填）
        - restore_deleted=False：若本地账号已被手动删除（deleted=1），同步时保持删除状态

        使用 _write_conn 避免批量导入时与同步窗口等并发写导致死锁。
        """
        async with self._write_conn() as db:
            await db.execute("PRAGMA foreign_keys=ON")
            affected = 0
            incoming_ids: List[int] = []
            for a in (accounts or []):
                if not isinstance(a, dict):
                    continue
                account_id_raw = a.get("id") if a.get("id") is not None else a.get("account_id")
                try:
                    account_id = int(account_id_raw)
                except Exception:
                    continue
                incoming_ids.append(account_id)

                platform_url = a.get("platformUrl") if a.get("platformUrl") is not None else a.get("platform_url")
                platform_username = a.get("platformUserName") if a.get("platformUserName") is not None else a.get("platform_username")
                platform_password = a.get("platformPassword") if a.get("platformPassword") is not None else a.get("platform_password")
                platform_efa = a.get("platformEfa") if a.get("platformEfa") is not None else a.get("platform_efa")
                platform_remarks = a.get("platformRemarks") if a.get("platformRemarks") is not None else a.get("platform_remarks")

                raw_json = json.dumps(a, ensure_ascii=False)

                # 跨空间查重：如果该 account_id 已存在于其他空间，复用其 space_pk 避免重复
                _cur_existing = await db.execute(
                    "SELECT space_pk FROM platform_accounts WHERE account_id = ? LIMIT 1",
                    (int(account_id),),
                )
                _existing_row = await _cur_existing.fetchone()
                effective_space_pk = int(_existing_row[0]) if _existing_row else int(space_pk)

                await db.execute(
                    """
                    INSERT INTO platform_accounts (
                        space_pk, account_id,
                        platform_url, platform_username, platform_password, platform_efa, platform_remarks,
                        deleted, raw_json, synced_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now','localtime'), datetime('now','localtime'))
                    ON CONFLICT(space_pk, account_id) DO UPDATE SET
                        platform_url=excluded.platform_url,
                        platform_username=excluded.platform_username,
                        platform_password=excluded.platform_password,
                        platform_efa=excluded.platform_efa,
                        platform_remarks=platform_accounts.platform_remarks,
                        deleted=CASE
                          WHEN ? = 1 THEN excluded.deleted
                          WHEN platform_accounts.deleted = 1 THEN 1
                          ELSE excluded.deleted
                        END,
                        raw_json=excluded.raw_json,
                        synced_at=datetime('now','localtime'),
                        updated_at=datetime('now','localtime')
                    """,
                    (
                        effective_space_pk,
                        int(account_id),
                        str(platform_url).strip() if platform_url is not None else None,
                        str(platform_username).strip() if platform_username is not None else None,
                        str(platform_password).strip() if platform_password is not None else None,
                        str(platform_efa).strip() if platform_efa is not None else None,
                        str(platform_remarks).strip() if platform_remarks is not None else None,
                        int(1 if restore_deleted else 0),
                        raw_json,
                    ),
                )
                affected += 1

            if full_replace:
                try:
                    uniq = sorted(set(int(x) for x in incoming_ids if isinstance(x, int)))
                    if uniq:
                        placeholders = ",".join(["?"] * len(uniq))
                        await db.execute(
                            f"""
                            UPDATE platform_accounts
                            SET deleted = 1, updated_at = datetime('now','localtime')
                            WHERE space_pk = ?
                              AND deleted = 0
                              AND account_id NOT IN ({placeholders})
                            """,
                            (int(space_pk), *uniq),
                        )
                    else:
                        await db.execute(
                            """
                            UPDATE platform_accounts
                            SET deleted = 1, updated_at = datetime('now','localtime')
                            WHERE space_pk = ? AND deleted = 0
                            """,
                            (int(space_pk),),
                        )
                except Exception:
                    pass
            await db.commit()
            return affected

    async def get_platform_account(self, *, space_pk: int, account_id: int) -> Optional[PlatformAccount]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT * FROM platform_accounts
                WHERE deleted = 0 AND account_id = ?
                LIMIT 1
                """,
                (int(account_id),),
            )
            row = await cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("raw_json"):
                try:
                    raw_obj = json.loads(d["raw_json"])
                    d["raw"] = raw_obj if isinstance(raw_obj, dict) else None
                except Exception:
                    d["raw"] = None
            d.pop("raw_json", None)
            return PlatformAccount(**d)

    async def get_platform_account_by_username(self, *, space_pk: int, username: str) -> Optional[PlatformAccount]:
        username = str(username or "").strip()
        if not username:
            return None
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT * FROM platform_accounts
                WHERE deleted = 0 AND space_pk = ? AND TRIM(LOWER(platform_username)) = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (int(space_pk), username.lower()),
            )
            row = await cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("raw_json"):
                try:
                    raw_obj = json.loads(d["raw_json"])
                    d["raw"] = raw_obj if isinstance(raw_obj, dict) else None
                except Exception:
                    d["raw"] = None
            d.pop("raw_json", None)
            return PlatformAccount(**d)

    async def delete_platform_account(self, *, space_pk: int, account_id: int) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE platform_accounts
                SET deleted = 1, updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND account_id = ?
                """,
                (int(space_pk), int(account_id)),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def delete_platform_account_by_account_id(self, *, account_id: int) -> int:
        """按 Roxy account_id 删除所有本地副本。

        当前账号库在 UI 和同步逻辑中按 account_id 作为全局账号去重；账号可能最初落在
        某一个 space_pk 下，但被其他空间窗口引用。因此远端账号删除成功/已不存在后，
        本地也应按 account_id 清理，避免全局账号面板残留脏数据。
        """
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE platform_accounts
                SET deleted = 1, updated_at = datetime('now','localtime')
                WHERE account_id = ?
                """,
                (int(account_id),),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def hard_delete_platform_account_by_account_id(self, *, account_id: int) -> int:
        """按 Roxy account_id 物理删除所有本地账号记录。"""
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                DELETE FROM platform_accounts
                WHERE account_id = ?
                """,
                (int(account_id),),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def update_platform_account_remark(self, *, space_pk: int, account_id: int, remark: str) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE platform_accounts
                SET platform_remarks = ?, updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND account_id = ? AND deleted = 0
                """,
                (str(remark or "").strip(), int(space_pk), int(account_id)),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def update_platform_account_password(self, *, space_pk: int, account_id: int, password: str) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE platform_accounts
                SET platform_password = ?, updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND account_id = ? AND deleted = 0
                """,
                (str(password or "").strip(), int(space_pk), int(account_id)),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def update_platform_account_efa(self, *, space_pk: int, account_id: int, efa: str) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE platform_accounts
                SET platform_efa = ?, updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND account_id = ? AND deleted = 0
                """,
                (str(efa or "").strip(), int(space_pk), int(account_id)),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def list_account_bindings(self, space_pk: int = 0) -> Dict[int, Dict[str, Any]]:
        """返回全局账号绑定信息：account_id -> {count, windows}（跨所有空间）。"""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT
                  a.account_id AS account_id,
                  COUNT(w.id) AS cnt,
                  GROUP_CONCAT(
                    CASE
                      WHEN w.window_sort_num IS NOT NULL THEN ('#' || w.window_sort_num)
                      ELSE ('#' || w.id)
                    END,
                    ', '
                  ) AS windows
                FROM platform_accounts a
                LEFT JOIN windows w
                  ON w.deleted = 0
                 AND (
                      (w.platform_account_id IS NOT NULL AND w.platform_account_id = a.account_id)
                   OR (
                        (w.platform_account_id IS NULL OR w.platform_account_id = 0)
                    AND TRIM(COALESCE(w.platform_account, '')) = TRIM(COALESCE(a.platform_username, ''))
                    AND (
                         TRIM(COALESCE(w.platform_url, '')) = ''
                      OR TRIM(COALESCE(a.platform_url, '')) = ''
                      OR TRIM(COALESCE(w.platform_url, '')) = TRIM(COALESCE(a.platform_url, ''))
                    )
                   )
                 )
                WHERE a.deleted = 0
                GROUP BY a.account_id
                """,
            )
            rows = await cur.fetchall()
            out: Dict[int, Dict[str, Any]] = {}
            for r in rows:
                try:
                    aid = int(r["account_id"] or 0)
                except Exception:
                    continue
                out[aid] = {
                    "count": int(r["cnt"] or 0),
                    "windows": str(r["windows"] or "").strip(),
                }
            return out

    # ---------- proxies ----------
    async def list_proxies(self, space_pk: int, *, include_deleted: bool = False) -> List[ProxyInfo]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            if include_deleted:
                cur = await db.execute(
                    """
                    SELECT * FROM proxies
                    WHERE space_pk = ?
                    ORDER BY updated_at DESC, id DESC
                    """,
                    (int(space_pk),),
                )
            else:
                cur = await db.execute(
                    """
                    SELECT * FROM proxies
                    WHERE deleted = 0 AND space_pk = ?
                    ORDER BY updated_at DESC, id DESC
                    """,
                    (int(space_pk),),
                )
            rows = await cur.fetchall()
            result: List[ProxyInfo] = []
            for r in rows:
                d = dict(r)
                if d.get("raw_json"):
                    try:
                        d["raw"] = json.loads(d["raw_json"])
                    except Exception:
                        d["raw"] = None
                d.pop("raw_json", None)
                result.append(ProxyInfo(**d))
            return result

    async def list_all_proxies(self, *, include_deleted: bool = False) -> List[ProxyInfo]:
        """返回所有空间的代理列表（按 proxy_id 去重）。

        全局代理面板会传 include_deleted=1 用于展示“已删除”记录；同一个 proxy_id
        存在多条历史记录时，必须优先保留未删除记录，否则前端拿到已删除那条再点击
        “检测”会被后端的 deleted=0 条件误判为 proxy not found。
        """
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            where = "" if include_deleted else "WHERE deleted = 0"
            cur = await db.execute(
                f"""
                SELECT * FROM proxies {where}
                ORDER BY
                  CASE WHEN deleted = 0 THEN 0 ELSE 1 END ASC,
                  updated_at DESC,
                  id DESC
                """
            )
            rows = await cur.fetchall()
            seen_proxy_ids: set = set()
            result: List[ProxyInfo] = []
            for r in rows:
                d = dict(r)
                pid = d.get("proxy_id", 0)
                if pid in seen_proxy_ids:
                    continue
                seen_proxy_ids.add(pid)
                if d.get("raw_json"):
                    try:
                        d["raw"] = json.loads(d["raw_json"])
                    except Exception:
                        d["raw"] = None
                d.pop("raw_json", None)
                result.append(ProxyInfo(**d))
            return result

    async def upsert_proxies(
        self,
        space_pk: int,
        proxies: List[Dict[str, Any]],
        *,
        restore_deleted: bool = False,
        overwrite_remark: bool = False,
        mark_missing_deleted: bool = True,
    ) -> int:
        """把同步到的代理列表保存到 DB（按 space_pk+proxy_id 唯一 upsert）。

        使用 _write_conn 避免与同步窗口等并发写导致死锁。
        """
        async with self._write_conn() as db:
            await db.execute("PRAGMA foreign_keys=ON")
            affected = 0
            incoming_ids: List[int] = []
            for p in (proxies or []):
                if not isinstance(p, dict):
                    continue
                proxy_id_raw = p.get("id") if p.get("id") is not None else p.get("proxy_id")
                try:
                    proxy_id = int(proxy_id_raw)
                except Exception:
                    continue
                incoming_ids.append(int(proxy_id))

                # 过期时间字段：不同版本/不同代理源字段名可能不同，尽量兼容
                expire_at = (
                    p.get("expireAt")
                    or p.get("expire_at")
                    or p.get("expireTime")
                    or p.get("expire_time")
                    or p.get("expirationTime")
                    or p.get("expiration_time")
                    or p.get("endTime")
                    or p.get("end_time")
                    or p.get("dueTime")
                    or p.get("expireDate")
                )

                ip_type = (p.get("ipType") or p.get("ip_type"))
                purchase_type = p.get("purchase_type") or p.get("purchaseType")
                # 这两个字段由“IP检测接口”写入；同步指纹浏览器代理时默认不覆盖已有值
                risk_level = p.get("riskLevel") or p.get("risk_level")
                asn_type = p.get("asnType") or p.get("asn_type")
                protocol = (p.get("protocol") or p.get("proxyCategory") or p.get("proxy_category"))
                host = p.get("host")
                port = p.get("port")
                proxy_username = p.get("proxyUserName") or p.get("proxy_username")
                proxy_password = p.get("proxyPassword") or p.get("proxy_password")
                refresh_url = p.get("refreshUrl") or p.get("refresh_url")
                remark = p.get("remark") or p.get("remarks") or p.get("proxyRemarks")

                check_status = p.get("checkStatus")
                check_channel = p.get("checkChannel")
                check_channel_value = p.get("checkChannelValue")
                last_ip = p.get("lastIp")
                last_country = p.get("lastCountry")
                last_state = p.get("lastState")
                last_city = p.get("lastCity")
                check_time = p.get("checkTime")
                create_time = p.get("createTime")
                update_time = p.get("updateTime")

                raw_json = json.dumps(p, ensure_ascii=False)

                # 跨空间查重：如果该 proxy_id 已存在于其他空间，复用其 space_pk 避免重复
                _cur_existing = await db.execute(
                    "SELECT space_pk FROM proxies WHERE proxy_id = ? LIMIT 1",
                    (int(proxy_id),),
                )
                _existing_row = await _cur_existing.fetchone()
                effective_space_pk = int(_existing_row[0]) if _existing_row else int(space_pk)

                await db.execute(
                    """
                    INSERT INTO proxies (
                        space_pk, proxy_id,
                        purchase_type,
                        expire_at,
                        ip_type, risk_level, asn_type, protocol, host, port,
                        proxy_username, proxy_password, refresh_url, remark,
                        check_status, check_channel, check_channel_value,
                        last_ip, last_country, last_state, last_city,
                        check_time, create_time, update_time,
                        deleted, raw_json, synced_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now','localtime'), datetime('now','localtime'))
                    ON CONFLICT(space_pk, proxy_id) DO UPDATE SET
                        purchase_type=excluded.purchase_type,
                        expire_at=excluded.expire_at,
                        ip_type=excluded.ip_type,
                        protocol=excluded.protocol,
                        host=excluded.host,
                        port=excluded.port,
                        proxy_username=excluded.proxy_username,
                        proxy_password=excluded.proxy_password,
                        refresh_url=excluded.refresh_url,
                        remark=CASE
                          WHEN ? = 1 THEN excluded.remark
                          ELSE proxies.remark
                        END,
                        check_status=excluded.check_status,
                        check_channel=excluded.check_channel,
                        check_channel_value=excluded.check_channel_value,
                        last_ip=excluded.last_ip,
                        last_country=excluded.last_country,
                        last_state=excluded.last_state,
                        last_city=excluded.last_city,
                        check_time=excluded.check_time,
                        create_time=excluded.create_time,
                        update_time=excluded.update_time,
                        deleted=CASE
                          WHEN ? = 1 THEN excluded.deleted
                          WHEN proxies.deleted = 1 THEN 1
                          ELSE excluded.deleted
                        END,
                        raw_json=excluded.raw_json,
                        synced_at=datetime('now','localtime'),
                        updated_at=datetime('now','localtime')
                    """,
                    (
                        effective_space_pk,
                        int(proxy_id),
                        str(purchase_type).strip() if purchase_type is not None else None,
                        str(expire_at).strip() if expire_at is not None else None,
                        str(ip_type).strip() if ip_type is not None else None,
                        str(risk_level).strip() if risk_level is not None else None,
                        str(asn_type).strip() if asn_type is not None else None,
                        str(protocol).strip() if protocol is not None else None,
                        str(host).strip() if host is not None else None,
                        str(port).strip() if port is not None else None,
                        str(proxy_username).strip() if proxy_username is not None else None,
                        str(proxy_password).strip() if proxy_password is not None else None,
                        str(refresh_url).strip() if refresh_url is not None else None,
                        str(remark).strip() if remark is not None else None,
                        int(check_status) if str(check_status or "").strip().isdigit() else None,
                        str(check_channel).strip() if check_channel is not None else None,
                        str(check_channel_value).strip() if check_channel_value is not None else None,
                        str(last_ip).strip() if last_ip is not None else None,
                        str(last_country).strip() if last_country is not None else None,
                        str(last_state).strip() if last_state is not None else None,
                        str(last_city).strip() if last_city is not None else None,
                        str(check_time).strip() if check_time is not None else None,
                        str(create_time).strip() if create_time is not None else None,
                        str(update_time).strip() if update_time is not None else None,
                        raw_json,
                        int(1 if overwrite_remark else 0),
                        int(1 if restore_deleted else 0),
                    ),
                )
                affected += 1

            # 同步策略（默认“保留本地删除”）：
            # - 同步返回存在的代理：
            #   - restore_deleted=True：按同步结果恢复为 deleted=0
            #   - restore_deleted=False：本地已删除的仍保持 deleted=1
            # - 同步未返回的代理：本地标记 deleted=1（让 UI 不再展示）
            #
            # 注意：如果同步结果为空列表，也认为该空间当前无代理，清空本地展示。
            if mark_missing_deleted:
                try:
                    uniq = sorted(set(int(x) for x in (incoming_ids or []) if isinstance(x, int)))
                    if uniq:
                        placeholders = ",".join(["?"] * len(uniq))
                        await db.execute(
                            f"""
                            UPDATE proxies
                            SET deleted = 1, updated_at = datetime('now','localtime')
                            WHERE space_pk = ?
                              AND deleted = 0
                              AND proxy_id NOT IN ({placeholders})
                            """,
                            (int(space_pk), *uniq),
                        )
                    else:
                        await db.execute(
                            """
                            UPDATE proxies
                            SET deleted = 1, updated_at = datetime('now','localtime')
                            WHERE space_pk = ? AND deleted = 0
                            """,
                            (int(space_pk),),
                        )
                except Exception:
                    pass
            await db.commit()
            return affected

    async def find_proxy_by_ip_global(self, ip: str) -> Optional[ProxyInfo]:
        """按 IP 在本地代理库中全局查找代理（匹配 host 或 last_ip，包含已删除记录）。"""
        key = str(ip or "").strip()
        if not key:
            return None
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT * FROM proxies
                WHERE TRIM(COALESCE(host, '')) = ?
                   OR TRIM(COALESCE(last_ip, '')) = ?
                ORDER BY deleted ASC, updated_at DESC, id DESC
                LIMIT 1
                """,
                (key, key),
            )
            row = await cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("raw_json"):
                try:
                    d["raw"] = json.loads(d["raw_json"])
                except Exception:
                    d["raw"] = None
            d.pop("raw_json", None)
            return ProxyInfo(**d)

    async def update_imported_proxy_local(
        self,
        *,
        space_pk: int,
        proxy_id: int,
        host: str,
        port: str,
        proxy_username: str,
        proxy_password: str,
        protocol: Optional[str] = None,
        ip_type: Optional[str] = None,
        check_channel: Optional[str] = None,
        refresh_url: Optional[str] = None,
        remark: Optional[str] = None,
        raw: Optional[Dict[str, Any]] = None,
        overwrite_remark: bool = False,
    ) -> int:
        """导入代理时更新本地 DB。

        与普通同步不同：这里按需求把本地 created_at/create_time 刷新为当前时间，
        并恢复 deleted=0；不影响其他代理记录。
        """
        raw_json = json.dumps(raw, ensure_ascii=False) if isinstance(raw, dict) else None
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE proxies
                SET ip_type = COALESCE(?, ip_type),
                    protocol = COALESCE(?, protocol),
                    host = ?,
                    port = ?,
                    proxy_username = ?,
                    proxy_password = ?,
                    refresh_url = COALESCE(?, refresh_url),
                    remark = CASE
                      WHEN ? = 1 THEN COALESCE(?, '')
                      ELSE remark
                    END,
                    check_channel = COALESCE(?, check_channel),
                    last_ip = ?,
                    create_time = datetime('now','localtime'),
                    update_time = datetime('now','localtime'),
                    raw_json = COALESCE(?, raw_json),
                    deleted = 0,
                    synced_at = datetime('now','localtime'),
                    created_at = datetime('now','localtime'),
                    updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND proxy_id = ?
                """,
                (
                    str(ip_type).strip() if ip_type is not None else None,
                    str(protocol).strip() if protocol is not None else None,
                    str(host or "").strip(),
                    str(port or "").strip(),
                    str(proxy_username or "").strip(),
                    str(proxy_password or "").strip(),
                    str(refresh_url).strip() if refresh_url is not None else None,
                    int(1 if overwrite_remark else 0),
                    str(remark or "").strip(),
                    str(check_channel).strip() if check_channel is not None else None,
                    str(host or "").strip(),
                    raw_json,
                    int(space_pk),
                    int(proxy_id),
                ),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    async def update_proxy_remark(self, *, space_pk: int, proxy_id: int, remark: str) -> int:
        """仅更新本地代理备注。"""
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE proxies
                SET remark = ?, updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND proxy_id = ?
                """,
                (str(remark or "").strip(), int(space_pk), int(proxy_id)),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    async def delete_proxy(self, *, space_pk: int, proxy_id: int) -> int:
        """本地删除某个代理（仅标记 deleted=1，不影响指纹浏览器侧）。"""
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE proxies
                SET deleted = 1, updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND proxy_id = ?
                """,
                (int(space_pk), int(proxy_id)),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    async def delete_proxy_by_proxy_id(self, *, proxy_id: int) -> int:
        """按指纹浏览器代理 ID 全局本地删除代理。

        代理在 UI 中按 proxy_id 全局去重展示；某些历史/跨空间数据的 space_pk
        可能与当前操作入口不一致。删除时如果按 space_pk+proxy_id 未命中，
        使用本方法兜底，避免误报 proxy not found。
        """
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE proxies
                SET deleted = 1, updated_at = datetime('now','localtime')
                WHERE proxy_id = ?
                """,
                (int(proxy_id),),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    async def hard_delete_proxy_by_proxy_id(self, *, proxy_id: int) -> int:
        """按 proxy_id 从本地 DB 物理删除代理记录（跨空间兜底）。"""
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                DELETE FROM proxies
                WHERE proxy_id = ?
                """,
                (int(proxy_id),),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    async def get_proxy(self, *, space_pk: int, proxy_id: int) -> Optional[ProxyInfo]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT * FROM proxies
                WHERE deleted = 0 AND space_pk = ? AND proxy_id = ?
                LIMIT 1
                """,
                (int(space_pk), int(proxy_id)),
            )
            row = await cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("raw_json"):
                try:
                    d["raw"] = json.loads(d["raw_json"])
                except Exception:
                    d["raw"] = None
            d.pop("raw_json", None)
            return ProxyInfo(**d)

    async def get_proxy_by_proxy_id(self, *, proxy_id: int, include_deleted: bool = False) -> Optional[ProxyInfo]:
        """按 proxy_id 全局查找代理。

        代理列表在 UI 中是“全局”去重展示，但一些旧接口路径仍带 space_pk。
        因此在 space_pk+proxy_id 未命中时，用本方法兜底，避免全局面板误报
        proxy not found。include_deleted=True 时仍优先返回未删除记录。
        """
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            deleted_sql = "" if include_deleted else "AND deleted = 0"
            cur = await db.execute(
                f"""
                SELECT * FROM proxies
                WHERE proxy_id = ?
                  {deleted_sql}
                ORDER BY
                  CASE WHEN deleted = 0 THEN 0 ELSE 1 END ASC,
                  updated_at DESC,
                  id DESC
                LIMIT 1
                """,
                (int(proxy_id),),
            )
            row = await cur.fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("raw_json"):
                try:
                    d["raw"] = json.loads(d["raw_json"])
                except Exception:
                    d["raw"] = None
            d.pop("raw_json", None)
            return ProxyInfo(**d)

    async def update_proxy_ip_profile(
        self,
        *,
        space_pk: int,
        proxy_id: int,
        risk_level: Optional[str],
        asn_type: Optional[str],
    ) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE proxies
                SET risk_level = ?,
                    asn_type = ?,
                    updated_at = datetime('now','localtime')
                WHERE space_pk = ? AND proxy_id = ? AND deleted = 0
                """,
                (
                    str(risk_level).strip() if risk_level is not None else None,
                    str(asn_type).strip() if asn_type is not None else None,
                    int(space_pk),
                    int(proxy_id),
                ),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    async def update_proxy_ip_profile_by_proxy_id(
        self,
        *,
        proxy_id: int,
        risk_level: Optional[str],
        asn_type: Optional[str],
        include_deleted: bool = True,
    ) -> int:
        """按 proxy_id 全局回写 IP 画像结果。

        同一 proxy_id 可能因为历史同步残留在多个 space_pk 下；IP 风险结果与空间无关，
        全局更新可以保证“代理列表（全局）”和各处下拉缓存保持一致。
        """
        async with self._write_conn() as db:
            deleted_sql = "" if include_deleted else "AND deleted = 0"
            cur = await db.execute(
                f"""
                UPDATE proxies
                SET risk_level = ?,
                    asn_type = ?,
                    updated_at = datetime('now','localtime')
                WHERE proxy_id = ?
                  {deleted_sql}
                """,
                (
                    str(risk_level).strip() if risk_level is not None else None,
                    str(asn_type).strip() if asn_type is not None else None,
                    int(proxy_id),
                ),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    # ---------- card keys ----------
    async def list_card_keys(self) -> List[CardKey]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM card_keys ORDER BY sort_order ASC, id ASC")
            rows = await cur.fetchall()
            return [CardKey(**dict(r)) for r in rows]

    async def batch_import_card_keys(self, content: str) -> Dict[str, int]:
        tokens = str(content or "").split()
        keys = [x for x in tokens if x]
        if not keys:
            return {"inserted": 0, "skipped": 0}

        inserted = 0
        skipped = 0
        async with self._write_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT COALESCE(MAX(sort_order), 0) AS mx FROM card_keys")
            row = await cur.fetchone()
            next_order = int((row["mx"] if row else 0) or 0) + 1
            for key in keys:
                try:
                    await db.execute(
                        """
                        INSERT INTO card_keys (card_key, sort_order, updated_at)
                        VALUES (?, ?, datetime('now','localtime'))
                        """,
                        (key, int(next_order)),
                    )
                    inserted += 1
                    next_order += 1
                except Exception:
                    skipped += 1
            await db.commit()
        return {"inserted": inserted, "skipped": skipped}

    async def update_card_key(self, card_key_id: int, card_key: str) -> int:
        new_val = str(card_key or "").strip()
        if not new_val:
            raise ValueError("卡密不能为空")
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE card_keys
                SET card_key = ?, updated_at = datetime('now','localtime')
                WHERE id = ?
                """,
                (new_val, int(card_key_id)),
            )
            await db.commit()
            return int(cur.rowcount or 0)

    async def delete_card_key(self, card_key_id: int) -> int:
        async with self._write_conn() as db:
            cur = await db.execute("DELETE FROM card_keys WHERE id = ?", (int(card_key_id),))
            await db.commit()
            return int(cur.rowcount or 0)

    async def batch_delete_card_keys(self, ids: List[int]) -> int:
        if not ids:
            return 0
        safe_ids = [int(x) for x in ids if int(x) > 0]
        if not safe_ids:
            return 0
        placeholders = ",".join("?" for _ in safe_ids)
        async with self._write_conn() as db:
            cur = await db.execute(f"DELETE FROM card_keys WHERE id IN ({placeholders})", safe_ids)
            await db.commit()
            return int(cur.rowcount or 0)

    # ---------- PayPal account/materials ----------
    @staticmethod
    def _none_if_empty(value: Any) -> Optional[str]:
        s = str(value or "").strip()
        return s if s else None

    @staticmethod
    def _parse_card_expiry(raw: Any) -> tuple[Optional[int], Optional[int]]:
        text = str(raw or "").strip()
        if not text:
            return None, None
        m = re.search(r"(\d{1,4})\D+(\d{1,2})", text)
        if not m:
            return None, None
        a = int(m.group(1))
        b = int(m.group(2))
        # 支持 YYYY/M、YY/M、M/YYYY、M/YY。若第一个数大于 12，优先识别为年份。
        if a > 12:
            year, month = a, b
        else:
            month, year = a, b
        if year < 100:
            year += 2000
        if not (1 <= month <= 12):
            return year, None
        return year, month

    @staticmethod
    def _split_full_name(full_name: Any) -> tuple[Optional[str], Optional[str]]:
        text = str(full_name or "").strip()
        if not text:
            return None, None
        parts = [x for x in re.split(r"\s+", text) if x]
        if len(parts) == 1:
            return parts[0], None
        return parts[0], " ".join(parts[1:])

    @staticmethod
    def _parse_paypal_address(raw_address: Any) -> Dict[str, Optional[str]]:
        raw = str(raw_address or "").strip()
        if not raw:
            return {
                "address_line1": None,
                "address_line2": None,
                "city": None,
                "state": None,
                "postal_code": None,
                "country": None,
            }

        chunks = [x.strip() for x in raw.split(",") if x.strip()]
        address_line1 = chunks[0] if chunks else raw
        country = chunks[-1] if len(chunks) >= 2 else None
        middle = " ".join(chunks[1:-1]).strip() if len(chunks) >= 3 else (chunks[1].strip() if len(chunks) == 2 else "")

        city = middle or None
        state = None
        postal_code = None
        if middle:
            tokens = [x.strip() for x in re.split(r"\s+", middle) if x.strip()]
            if tokens:
                last = tokens[-1]
                if re.search(r"\d", last) and 3 <= len(last) <= 12:
                    postal_code = last
                    tokens = tokens[:-1]
            if tokens and re.fullmatch(r"[A-Za-z]{2}", tokens[-1] or ""):
                state = tokens[-1].upper()
                tokens = tokens[:-1]
            city = " ".join(tokens).strip() or city

        return {
            "address_line1": address_line1 or None,
            "address_line2": None,
            "city": city or None,
            "state": state,
            "postal_code": postal_code,
            "country": (country.upper() if country else None),
        }

    @classmethod
    def parse_paypal_import_line(cls, line: str) -> Dict[str, Any]:
        """解析用户粘贴的一行 PayPal 开户资料。

        格式：
        card----expiry----cvv----phone----sms_api_url----FULL NAME----ADDRESS,CITY ZIP,COUNTRY
        """
        raw_line = str(line or "").strip()
        if not raw_line:
            raise ValueError("空行")
        parts = [x.strip() for x in re.split(r"\s*----\s*", raw_line)]
        if len(parts) < 7:
            raise ValueError("字段不足，应为：卡号----到期----CVV----手机号----接码地址----姓名----地址")

        full_name = parts[5]
        first_name, last_name = cls._split_full_name(full_name)
        address = cls._parse_paypal_address("----".join(parts[6:]).strip())
        year, month = cls._parse_card_expiry(parts[1])

        data: Dict[str, Any] = {
            "label": full_name or None,
            "account_status": "new",
            "card_number": re.sub(r"\D+", "", parts[0] or ""),
            "card_expiry_raw": parts[1] or None,
            "card_expiry_year": year,
            "card_expiry_month": month,
            "card_cvv": re.sub(r"\D+", "", parts[2] or ""),
            "phone": parts[3] or None,
            "sms_api_url": parts[4] or None,
            "first_name": first_name,
            "last_name": last_name,
            "full_name": full_name or None,
            "raw_line": raw_line,
            **address,
        }
        return cls._normalize_paypal_account_payload(data)

    @classmethod
    def _normalize_paypal_account_payload(cls, payload: Dict[str, Any]) -> Dict[str, Any]:
        data: Dict[str, Any] = {}
        for key in cls._PAYPAL_ACCOUNT_FIELDS:
            if key not in payload:
                data[key] = None
                continue
            val = payload.get(key)
            if key in {"card_expiry_year", "card_expiry_month"}:
                try:
                    data[key] = int(val) if val not in (None, "") else None
                except Exception:
                    data[key] = None
                continue
            data[key] = cls._none_if_empty(val)

        if data.get("card_number"):
            data["card_number"] = re.sub(r"\D+", "", str(data["card_number"]))
        if data.get("card_cvv"):
            data["card_cvv"] = re.sub(r"\D+", "", str(data["card_cvv"]))[:4]
        if data.get("phone"):
            data["phone"] = str(data["phone"]).strip()
        if data.get("paypal_email"):
            data["paypal_email"] = str(data["paypal_email"]).strip().lower()
        if data.get("country"):
            data["country"] = str(data["country"]).strip().upper()

        # 补齐姓名拆分/合并。
        if data.get("full_name") and (not data.get("first_name") or not data.get("last_name")):
            fn, ln = cls._split_full_name(data.get("full_name"))
            data["first_name"] = data.get("first_name") or fn
            data["last_name"] = data.get("last_name") or ln
        if not data.get("full_name"):
            data["full_name"] = " ".join([x for x in [data.get("first_name"), data.get("last_name")] if x]) or None
        if not data.get("label"):
            data["label"] = data.get("paypal_email") or data.get("full_name") or data.get("phone") or data.get("card_number")

        # 补齐到期年月。
        year = data.get("card_expiry_year")
        month = data.get("card_expiry_month")
        if (not year or not month) and data.get("card_expiry_raw"):
            year, month = cls._parse_card_expiry(data.get("card_expiry_raw"))
            data["card_expiry_year"] = year
            data["card_expiry_month"] = month
        if year and month and not data.get("card_expiry_raw"):
            data["card_expiry_raw"] = f"{int(year):04d}/{int(month):02d}"

        if not data.get("account_status"):
            data["account_status"] = "new"
        return data

    async def list_paypal_accounts(
        self,
        *,
        q: str = "",
        include_deleted: bool = False,
        limit: int = 200,
        offset: int = 0,
    ) -> Dict[str, Any]:
        lim = max(1, min(1000, int(limit or 200)))
        off = max(0, int(offset or 0))
        where: List[str] = []
        params: List[Any] = []
        if not include_deleted:
            where.append("deleted = 0")
        qq = str(q or "").strip()
        if qq:
            like = f"%{qq}%"
            where.append(
                """
                (
                  COALESCE(label, '') LIKE ?
                  OR COALESCE(paypal_email, '') LIKE ?
                  OR COALESCE(phone, '') LIKE ?
                  OR COALESCE(full_name, '') LIKE ?
                  OR COALESCE(card_number, '') LIKE ?
                  OR COALESCE(address_line1, '') LIKE ?
                  OR COALESCE(city, '') LIKE ?
                  OR COALESCE(postal_code, '') LIKE ?
                )
                """
            )
            params.extend([like] * 8)
        where_clause = ("WHERE " + " AND ".join(where)) if where else ""

        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur_total = await db.execute(f"SELECT COUNT(*) AS c FROM paypal_accounts {where_clause}", params)
            row_total = await cur_total.fetchone()
            total = int((row_total["c"] if row_total else 0) or 0)
            cur = await db.execute(
                f"""
                SELECT *
                FROM paypal_accounts
                {where_clause}
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                [*params, lim, off],
            )
            rows = await cur.fetchall()
            return {
                "total": total,
                "limit": lim,
                "offset": off,
                "items": [PaypalAccount(**dict(r)).model_dump() for r in rows],
            }

    async def get_paypal_account(self, account_id: int, *, include_deleted: bool = False) -> Optional[PaypalAccount]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            if include_deleted:
                cur = await db.execute("SELECT * FROM paypal_accounts WHERE id = ?", (int(account_id),))
            else:
                cur = await db.execute("SELECT * FROM paypal_accounts WHERE id = ? AND deleted = 0", (int(account_id),))
            row = await cur.fetchone()
            return PaypalAccount(**dict(row)) if row else None

    async def upsert_paypal_account(self, payload: Dict[str, Any], *, account_id: Optional[int] = None) -> int:
        data = self._normalize_paypal_account_payload(payload or {})
        fields = list(self._PAYPAL_ACCOUNT_FIELDS)
        async with self._write_conn() as db:
            if account_id is not None and int(account_id) > 0:
                assignments = ", ".join([f"{f} = ?" for f in fields])
                params = [data.get(f) for f in fields]
                params.append(int(account_id))
                cur = await db.execute(
                    f"""
                    UPDATE paypal_accounts
                    SET {assignments},
                        updated_at = datetime('now','localtime')
                    WHERE id = ?
                    """,
                    params,
                )
                await db.commit()
                if int(cur.rowcount or 0) <= 0:
                    raise ValueError("PayPal 资料不存在")
                return int(account_id)

            placeholders = ", ".join(["?"] * len(fields))
            cur = await db.execute(
                f"""
                INSERT INTO paypal_accounts ({", ".join(fields)}, updated_at)
                VALUES ({placeholders}, datetime('now','localtime'))
                """,
                [data.get(f) for f in fields],
            )
            await db.commit()
            return int(cur.lastrowid or 0)

    async def batch_import_paypal_accounts(self, content: str) -> Dict[str, Any]:
        lines = [str(x or "").strip() for x in str(content or "").splitlines()]
        fields = list(self._PAYPAL_ACCOUNT_FIELDS)
        inserted = 0
        updated = 0
        skipped = 0
        errors: List[Dict[str, Any]] = []

        async with self._write_conn() as db:
            db.row_factory = aiosqlite.Row
            for idx, line in enumerate(lines, start=1):
                if not line:
                    continue
                try:
                    data = self.parse_paypal_import_line(line)
                except Exception as e:
                    skipped += 1
                    errors.append({"line": idx, "content": line, "reason": str(e)})
                    continue

                # 同一批/重复导入：优先按卡号+手机号匹配更新，避免同一资料重复堆积。
                existing_id: Optional[int] = None
                card = str(data.get("card_number") or "").strip()
                phone = str(data.get("phone") or "").strip()
                if card and phone:
                    cur = await db.execute(
                        """
                        SELECT id FROM paypal_accounts
                        WHERE deleted = 0 AND card_number = ? AND phone = ?
                        ORDER BY id DESC
                        LIMIT 1
                        """,
                        (card, phone),
                    )
                    row = await cur.fetchone()
                    if row:
                        existing_id = int(row["id"])

                if existing_id:
                    assignments = ", ".join([f"{f} = ?" for f in fields])
                    await db.execute(
                        f"""
                        UPDATE paypal_accounts
                        SET {assignments},
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                        """,
                        [data.get(f) for f in fields] + [existing_id],
                    )
                    updated += 1
                else:
                    placeholders = ", ".join(["?"] * len(fields))
                    await db.execute(
                        f"""
                        INSERT INTO paypal_accounts ({", ".join(fields)}, updated_at)
                        VALUES ({placeholders}, datetime('now','localtime'))
                        """,
                        [data.get(f) for f in fields],
                    )
                    inserted += 1

            await db.commit()

        return {"inserted": inserted, "updated": updated, "skipped": skipped, "errors": errors[:20]}

    async def delete_paypal_account(self, account_id: int, *, hard_delete: bool = False) -> int:
        async with self._write_conn() as db:
            if hard_delete:
                cur = await db.execute("DELETE FROM paypal_accounts WHERE id = ?", (int(account_id),))
            else:
                cur = await db.execute(
                    """
                    UPDATE paypal_accounts
                    SET deleted = 1, updated_at = datetime('now','localtime')
                    WHERE id = ? AND deleted = 0
                    """,
                    (int(account_id),),
                )
            await db.commit()
            return int(cur.rowcount or 0)

    async def batch_delete_paypal_accounts(self, ids: List[int], *, hard_delete: bool = False) -> int:
        safe_ids = [int(x) for x in (ids or []) if int(x) > 0]
        if not safe_ids:
            return 0
        placeholders = ",".join("?" for _ in safe_ids)
        async with self._write_conn() as db:
            if hard_delete:
                cur = await db.execute(f"DELETE FROM paypal_accounts WHERE id IN ({placeholders})", safe_ids)
            else:
                cur = await db.execute(
                    f"""
                    UPDATE paypal_accounts
                    SET deleted = 1, updated_at = datetime('now','localtime')
                    WHERE id IN ({placeholders}) AND deleted = 0
                    """,
                    safe_ids,
                )
            await db.commit()
            return int(cur.rowcount or 0)

    # ---------- task types ----------
    async def list_task_types(self, allowed_task_type_ids: Optional[List[int]] = None) -> List[TaskType]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            if allowed_task_type_ids is None:
                cur = await db.execute("SELECT * FROM task_types WHERE deleted = 0 ORDER BY updated_at DESC, id DESC")
            else:
                safe_ids = [int(x) for x in allowed_task_type_ids if int(x) > 0]
                if not safe_ids:
                    return []
                placeholders = ",".join("?" for _ in safe_ids)
                cur = await db.execute(
                    f"SELECT * FROM task_types WHERE deleted = 0 AND id IN ({placeholders}) ORDER BY updated_at DESC, id DESC",
                    safe_ids,
                )
            rows = await cur.fetchall()
            return [TaskType(**dict(r)) for r in rows]

    async def get_window_pool_maintainer_intervals_seconds(
        self,
        *,
        create_task_handler: Optional[str] = None,
    ) -> tuple[int, int]:
        """取「已启用且开启窗口池」任务类型上的最小 maintainer 间隔。

        Args:
            create_task_handler: 为空时保持原来的全局行为；传入例如 ``veo_workflow`` 时，
                只统计该执行器对应任务类型，避免 VEO 保活被其它任务类型的更短周期影响。
        """
        handler = str(create_task_handler or "").strip()
        where = "deleted = 0 AND enabled = 1 AND window_pool_enabled != 0"
        params: List[Any] = []
        if handler:
            where += " AND create_task_handler = ?"
            params.append(handler)
        async with self._read_conn() as db:
            cur = await db.execute(
                f"""
                SELECT
                  MIN(window_pool_reconcile_interval_sec),
                  MIN(window_pool_cloudflare_interval_sec)
                FROM task_types
                WHERE {where}
                """,
                params,
            )
            row = await cur.fetchone()
        if not row:
            return 600, 1800

        def _clamp_rec(x: Any) -> int:
            if x is None:
                return 600
            try:
                v = int(x)
            except Exception:
                return 600
            return max(10, min(7200, v))

        def _clamp_cf(x: Any) -> int:
            if x is None:
                return 1800
            try:
                v = int(x)
            except Exception:
                return 1800
            return max(30, min(86400, v))

        return _clamp_rec(row[0]), _clamp_cf(row[1])

    async def dreamina_refresh_seconds_until_next_due(
        self,
        *,
        min_remaining_quota: int,
        default_scan_interval: float = 300.0,
    ) -> float:
        """Dreamina 余额刷新：距离下一条 cooldown_until 即将到期还需等待的秒数。

        只查询 dreamina_workflow 的窗口池映射；刷新器会在 cooldown_until 前 1 分钟被唤醒。
        """
        threshold = int(min_remaining_quota)
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT CAST((julianday(MIN(m.cooldown_until)) - julianday(datetime('now','localtime', '+1 minute'))) * 86400.0 AS REAL) AS wait_seconds
                FROM task_type_windows m
                JOIN task_types t ON t.id = m.task_type_id
                JOIN windows w ON w.id = m.window_pk
                JOIN spaces s ON s.id = w.space_pk
                JOIN browsers b ON b.id = s.browser_id
                WHERE t.deleted = 0 AND t.enabled = 1
                  AND COALESCE(t.window_pool_enabled, 0) != 0
                  AND t.create_task_handler = 'dreamina_workflow'
                  AND m.deleted = 0 AND m.enabled = 1
                  AND w.deleted = 0 AND w.enabled = 1
                  AND b.deleted = 0
                  AND TRIM(COALESCE(m.sora_access_token, '')) <> ''
                  AND COALESCE(m.remaining_quota, 0) >= ?
                  AND m.cooldown_until IS NOT NULL
                  AND m.cooldown_until > datetime('now','localtime', '+1 minute')
                """,
                (threshold,),
            )
            row = await cur.fetchone()
        if not row or row["wait_seconds"] is None:
            return float(default_scan_interval)
        try:
            return max(1.0, float(row["wait_seconds"]))
        except Exception:
            return float(default_scan_interval)

    async def dreamina_refresh_list_candidates(
        self,
        *,
        due_only: bool,
        min_remaining_quota: int,
    ) -> List[Dict[str, Any]]:
        """Dreamina 余额刷新：列出需要/可被刷新器扫描的窗口池候选。

        SQL 留在 Database 内，调用方只负责业务调度与刷新动作。
        """
        threshold = int(min_remaining_quota)
        due_clause = "AND m.cooldown_until <= datetime('now','localtime', '+1 minute')" if due_only else ""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                f"""
                SELECT
                  m.id AS mapping_id,
                  m.window_pk,
                  m.remaining_quota,
                  m.sora_remaining_count,
                  m.sora_access_token,
                  m.sora_access_expires,
                  m.cooldown_until,
                  m.headless,
                  m.pure_mode,
                  t.code AS task_code,
                  t.concurrency AS task_concurrency,
                  t.continuous_error_threshold,
                  t.continuous_error_close_window_threshold,
                  t.timeout_seconds,
                  t.create_task_handler,
                  t.error_retry_count,
                  t.default_target_url,
                  w.window_key,
                  w.proxy_addr AS window_ip,
                  s.space_id,
                  b.vendor AS browser_vendor,
                  b.lan_addr AS browser_base_url,
                  b.access_key AS browser_access_key
                FROM task_type_windows m
                JOIN task_types t ON t.id = m.task_type_id
                JOIN windows w ON w.id = m.window_pk
                JOIN spaces s ON s.id = w.space_pk
                JOIN browsers b ON b.id = s.browser_id
                WHERE t.deleted = 0 AND t.enabled = 1
                  AND COALESCE(t.window_pool_enabled, 0) != 0
                  AND t.create_task_handler = 'dreamina_workflow'
                  AND m.deleted = 0 AND m.enabled = 1
                  AND w.deleted = 0 AND w.enabled = 1
                  AND b.deleted = 0
                  AND TRIM(COALESCE(m.sora_access_token, '')) <> ''
                  AND COALESCE(m.remaining_quota, 0) >= ?
                  AND m.cooldown_until IS NOT NULL
                  {due_clause}
                ORDER BY m.cooldown_until ASC, m.remaining_quota ASC, m.updated_at ASC
                """,
                (threshold,),
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def list_task_types_public(self, allowed_task_type_ids: Optional[List[int]] = None) -> List[TaskTypePublic]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            if allowed_task_type_ids is None:
                cur = await db.execute(
                    "SELECT id, name, code,timeout_seconds, created_at,enabled FROM task_types WHERE deleted = 0 ORDER BY updated_at DESC, id DESC"
                )
            else:
                safe_ids = [int(x) for x in allowed_task_type_ids if int(x) > 0]
                if not safe_ids:
                    return []
                placeholders = ",".join("?" for _ in safe_ids)
                cur = await db.execute(
                    f"SELECT id, name, code,timeout_seconds, created_at,enabled FROM task_types WHERE deleted = 0 AND id IN ({placeholders}) ORDER BY updated_at DESC, id DESC",
                    safe_ids,
                )
            rows = await cur.fetchall()
            return [TaskTypePublic(**dict(r)) for r in rows]

    async def create_task_type(
        self,
        name: str,
        code: str,
        project_id: Optional[int],
        concurrency: int,
        total_concurrency: int,
        continuous_error_threshold: int,
        continuous_error_close_window_threshold: int,
        timeout_seconds: int,
        create_task_handler: Optional[str] = None,
        refresh_quota_handler: Optional[str] = None,
        error_retry_count: int = 0,
        default_target_url: Optional[str] = None,
        window_call_cooldown_seconds: int = 30,
        window_pool_enabled: bool = False,
        window_pool_reconcile_interval_sec: int = 600,
        window_pool_cloudflare_interval_sec: int = 1800,
    ) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                INSERT INTO task_types (
                  name, code, project_id, concurrency, total_concurrency, continuous_error_threshold, continuous_error_close_window_threshold, timeout_seconds,
                  window_call_cooldown_seconds, create_task_handler, refresh_quota_handler, error_retry_count, default_target_url,
                  window_pool_enabled, window_pool_reconcile_interval_sec, window_pool_cloudflare_interval_sec,
                  enabled, deleted
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
                """,
                (
                    name.strip(),
                    code.strip(),
                    int(project_id) if project_id is not None else None,
                    int(concurrency),
                    int(total_concurrency),
                    int(continuous_error_threshold),
                    int(continuous_error_close_window_threshold),
                    int(timeout_seconds),
                    int(window_call_cooldown_seconds),
                    (create_task_handler or "").strip() or None,
                    (refresh_quota_handler or "").strip() or None,
                    int(error_retry_count),
                    (default_target_url or "").strip() or None,
                    1 if window_pool_enabled else 0,
                    int(window_pool_reconcile_interval_sec),
                    int(window_pool_cloudflare_interval_sec),
                ),
            )
            await db.commit()
            return int(cur.lastrowid)

    async def update_task_type(
        self,
        task_type_id: int,
        name: str,
        code: str,
        project_id: Optional[int],
        concurrency: int,
        total_concurrency: int,
        continuous_error_threshold: int,
        continuous_error_close_window_threshold: int,
        timeout_seconds: int,
        create_task_handler: Optional[str],
        refresh_quota_handler: Optional[str],
        enabled: bool,
        error_retry_count: int = 0,
        default_target_url: Optional[str] = None,
        window_call_cooldown_seconds: int = 30,
        window_pool_enabled: bool = False,
        window_pool_reconcile_interval_sec: int = 600,
        window_pool_cloudflare_interval_sec: int = 1800,
    ) -> None:
        async with self._write_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT code FROM task_types WHERE id=? AND deleted=0", (task_type_id,))
            row = await cur.fetchone()
            if not row:
                raise ValueError("任务类型不存在")

            old_code = str(row["code"] or "").strip()
            new_code = (code or "").strip()
            if not new_code:
                raise ValueError("code 不能为空")

            if new_code != old_code:
                cur = await db.execute(
                    "SELECT COUNT(*) AS c FROM task_types WHERE code=? AND id<>?",
                    (new_code, task_type_id),
                )
                if int((await cur.fetchone())["c"]) > 0:
                    raise ValueError("英文名称（code）已存在")

            await db.execute(
                """
                UPDATE task_types
                SET name=?, code=?, project_id=?, concurrency=?, total_concurrency=?, continuous_error_threshold=?, continuous_error_close_window_threshold=?, timeout_seconds=?,
                    window_call_cooldown_seconds=?, create_task_handler=?, refresh_quota_handler=?, error_retry_count=?, default_target_url=?,
                    window_pool_enabled=?, window_pool_reconcile_interval_sec=?, window_pool_cloudflare_interval_sec=?,
                    enabled=?, updated_at=datetime('now','localtime')
                WHERE id=?
                """,
                (
                    name.strip(),
                    new_code,
                    int(project_id) if project_id is not None else None,
                    int(concurrency),
                    int(total_concurrency),
                    int(continuous_error_threshold),
                    int(continuous_error_close_window_threshold),
                    int(timeout_seconds),
                    int(window_call_cooldown_seconds),
                    (create_task_handler or "").strip() or None,
                    (refresh_quota_handler or "").strip() or None,
                    int(error_retry_count),
                    (default_target_url or "").strip() or None,
                    1 if window_pool_enabled else 0,
                    int(window_pool_reconcile_interval_sec),
                    int(window_pool_cloudflare_interval_sec),
                    1 if enabled else 0,
                    task_type_id,
                ),
            )

            # 同步历史任务的 task_type_code，避免改 code 后历史记录“断链”
            if new_code != old_code and old_code:
                await db.execute("UPDATE tasks SET task_type_code=? WHERE task_type_code=?", (new_code, old_code))
            await db.commit()

    async def get_task_type_window_context(self, mapping_id: int) -> Optional[Dict[str, Any]]:
        """按 mapping_id 取“刷新额度/调度”所需的上下文（join 后 dict）。"""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT
                  m.*,
                  t.id AS task_type_id,
                  t.code AS task_code,
                  t.create_task_handler,
                  t.refresh_quota_handler,
                  t.default_target_url,
                  t.timeout_seconds AS task_timeout_seconds,
                  w.window_key,
                  w.window_name,
                  w.space_pk AS space_pk,
                  w.platform_account,
                  w.platform_account_id,
                  w.platform_url,
                  COALESCE(
                    (SELECT a.platform_username FROM platform_accounts a WHERE a.deleted = 0 AND w.platform_account_id IS NOT NULL AND w.platform_account_id > 0 AND a.account_id = w.platform_account_id ORDER BY a.updated_at DESC, a.id DESC LIMIT 1),
                    (SELECT a.platform_username FROM platform_accounts a WHERE a.deleted = 0 AND a.space_pk = w.space_pk AND TRIM(COALESCE(a.platform_username, '')) <> '' AND TRIM(COALESCE(a.platform_username, '')) = TRIM(COALESCE(w.platform_account, '')) ORDER BY a.updated_at DESC, a.id DESC LIMIT 1)
                  ) AS platform_username,
                  COALESCE(
                    (SELECT a.platform_password FROM platform_accounts a WHERE a.deleted = 0 AND w.platform_account_id IS NOT NULL AND w.platform_account_id > 0 AND a.account_id = w.platform_account_id ORDER BY a.updated_at DESC, a.id DESC LIMIT 1),
                    (SELECT a.platform_password FROM platform_accounts a WHERE a.deleted = 0 AND a.space_pk = w.space_pk AND TRIM(COALESCE(a.platform_username, '')) <> '' AND TRIM(COALESCE(a.platform_username, '')) = TRIM(COALESCE(w.platform_account, '')) ORDER BY a.updated_at DESC, a.id DESC LIMIT 1)
                  ) AS platform_password,
                  COALESCE(
                    (SELECT a.platform_efa FROM platform_accounts a WHERE a.deleted = 0 AND w.platform_account_id IS NOT NULL AND w.platform_account_id > 0 AND a.account_id = w.platform_account_id ORDER BY a.updated_at DESC, a.id DESC LIMIT 1),
                    (SELECT a.platform_efa FROM platform_accounts a WHERE a.deleted = 0 AND a.space_pk = w.space_pk AND TRIM(COALESCE(a.platform_username, '')) <> '' AND TRIM(COALESCE(a.platform_username, '')) = TRIM(COALESCE(w.platform_account, '')) ORDER BY a.updated_at DESC, a.id DESC LIMIT 1)
                  ) AS platform_efa,
                  s.space_id AS space_id,
                  b.vendor,
                  b.lan_addr,
                  b.access_key,
                  (
                    SELECT v.project_id FROM veo_flow_projects v
                    WHERE v.task_type_window_id = m.id AND v.deleted = 0
                    ORDER BY v.updated_at DESC, v.id DESC
                    LIMIT 1
                  ) AS current_project_id
                FROM task_type_windows m
                JOIN task_types t ON m.task_type_id = t.id
                JOIN windows w ON m.window_pk = w.id
                JOIN spaces s ON w.space_pk = s.id
                JOIN browsers b ON s.browser_id = b.id
                WHERE m.id = ? AND m.deleted = 0
                LIMIT 1
                """,
                (int(mapping_id),),
            )
            row = await cur.fetchone()
            return dict(row) if row else None

    # ---------- auto refresh error logs ----------
    async def add_auto_refresh_error_log(self, log: AutoRefreshErrorLog) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                INSERT INTO auto_refresh_error_logs (
                  mapping_id, task_type_id, task_code,
                  window_pk, window_name, platform_account,
                  error_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(log.mapping_id),
                    int(log.task_type_id) if log.task_type_id is not None else None,
                    (log.task_code or "").strip() or None,
                    int(log.window_pk) if log.window_pk is not None else None,
                    (log.window_name or "").strip() or None,
                    (log.platform_account or "").strip() or None,
                    str(log.error_message or "").strip(),
                ),
            )
            await db.commit()
            return int(cur.lastrowid or 0)

    async def list_auto_refresh_error_logs(
        self,
        limit: int = 200,
        offset: int = 0,
        task_type_id: Optional[int] = None,
        mapping_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        lim = max(1, min(500, int(limit or 200)))
        off = max(0, int(offset or 0))
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            if mapping_id is not None:
                cur = await db.execute(
                    """
                    SELECT * FROM auto_refresh_error_logs
                    WHERE mapping_id = ?
                    ORDER BY id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (int(mapping_id), lim, off),
                )
            elif task_type_id is None:
                cur = await db.execute(
                    """
                    SELECT * FROM auto_refresh_error_logs
                    ORDER BY id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (lim, off),
                )
            else:
                cur = await db.execute(
                    """
                    SELECT * FROM auto_refresh_error_logs
                    WHERE task_type_id = ?
                    ORDER BY id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (int(task_type_id), lim, off),
                )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def delete_task_type(self, task_type_id: int) -> None:
        async with self._write_conn() as db:
            await db.execute("UPDATE task_types SET deleted=1, updated_at=datetime('now','localtime') WHERE id=?", (task_type_id,))
            await db.commit()

    async def get_task_type_by_code(self, code: str) -> Optional[TaskType]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM task_types WHERE code=? AND deleted=0", (code.strip(),))
            row = await cur.fetchone()
            return TaskType(**dict(row)) if row else None

    async def get_task_type_inflight_total(self, code: str) -> int:
        async with self._read_conn() as db:
            cur = await db.execute(
                """
                SELECT COALESCE(SUM(COALESCE(m.inflight_slots, 0)), 0)
                FROM task_type_windows m
                JOIN task_types t ON t.id = m.task_type_id
                WHERE t.code = ?
                  AND t.deleted = 0
                  AND m.deleted = 0
                """,
                (code.strip(),),
            )
            row = await cur.fetchone()
        try:
            return max(0, int(row[0] if row else 0))
        except Exception:
            return 0

    async def get_task_type(self, task_type_id: int) -> Optional[TaskType]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM task_types WHERE id=? AND deleted=0", (task_type_id,))
            row = await cur.fetchone()
            return TaskType(**dict(row)) if row else None

    # ---------- task type windows mapping ----------
    async def list_task_type_windows(self, task_type_id: int) -> List[Dict[str, Any]]:
        """返回映射 + 窗口基本信息（便于 UI 展示）。"""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT
                  m.*,
                  w.window_name,
                  w.window_key,
                  w.window_sort_num,
                  w.platform_account,
                  COALESCE(
                    CASE
                      WHEN w.platform_account_id IS NOT NULL AND w.platform_account_id > 0 THEN w.platform_account_id
                      ELSE NULL
                    END,
                    (
                      SELECT a.account_id
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND a.space_pk = w.space_pk
                        AND TRIM(COALESCE(a.platform_username, '')) <> ''
                        AND TRIM(COALESCE(a.platform_username, '')) = TRIM(COALESCE(w.platform_account, ''))
                        AND (
                          TRIM(COALESCE(a.platform_url, '')) = ''
                          OR TRIM(COALESCE(w.platform_url, '')) = ''
                          OR TRIM(COALESCE(a.platform_url, '')) = TRIM(COALESCE(w.platform_url, ''))
                        )
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    )
                  ) AS platform_account_id,
                  w.platform_url,
                  COALESCE(
                    (
                      SELECT a.platform_username
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND w.platform_account_id IS NOT NULL
                        AND w.platform_account_id > 0
                        AND a.account_id = w.platform_account_id
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    ),
                    (
                      SELECT a.platform_username
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND a.space_pk = w.space_pk
                        AND TRIM(COALESCE(a.platform_username, '')) <> ''
                        AND TRIM(COALESCE(a.platform_username, '')) = TRIM(COALESCE(w.platform_account, ''))
                        AND (
                          TRIM(COALESCE(a.platform_url, '')) = ''
                          OR TRIM(COALESCE(w.platform_url, '')) = ''
                          OR TRIM(COALESCE(a.platform_url, '')) = TRIM(COALESCE(w.platform_url, ''))
                        )
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    )
                  ) AS platform_username,
                  COALESCE(
                    (
                      SELECT a.platform_password
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND w.platform_account_id IS NOT NULL
                        AND w.platform_account_id > 0
                        AND a.account_id = w.platform_account_id
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    ),
                    (
                      SELECT a.platform_password
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND a.space_pk = w.space_pk
                        AND TRIM(COALESCE(a.platform_username, '')) <> ''
                        AND TRIM(COALESCE(a.platform_username, '')) = TRIM(COALESCE(w.platform_account, ''))
                        AND (
                          TRIM(COALESCE(a.platform_url, '')) = ''
                          OR TRIM(COALESCE(w.platform_url, '')) = ''
                          OR TRIM(COALESCE(a.platform_url, '')) = TRIM(COALESCE(w.platform_url, ''))
                        )
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    )
                  ) AS platform_password,
                  COALESCE(
                    (
                      SELECT a.platform_efa
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND w.platform_account_id IS NOT NULL
                        AND w.platform_account_id > 0
                        AND a.account_id = w.platform_account_id
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    ),
                    (
                      SELECT a.platform_efa
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND a.space_pk = w.space_pk
                        AND TRIM(COALESCE(a.platform_username, '')) <> ''
                        AND TRIM(COALESCE(a.platform_username, '')) = TRIM(COALESCE(w.platform_account, ''))
                        AND (
                          TRIM(COALESCE(a.platform_url, '')) = ''
                          OR TRIM(COALESCE(w.platform_url, '')) = ''
                          OR TRIM(COALESCE(a.platform_url, '')) = TRIM(COALESCE(w.platform_url, ''))
                        )
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    )
                  ) AS platform_efa,
                  COALESCE(
                    (
                      SELECT a.platform_url
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND w.platform_account_id IS NOT NULL
                        AND w.platform_account_id > 0
                        AND a.account_id = w.platform_account_id
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    ),
                    (
                      SELECT a.platform_url
                      FROM platform_accounts a
                      WHERE a.deleted = 0
                        AND a.space_pk = w.space_pk
                        AND TRIM(COALESCE(a.platform_username, '')) <> ''
                        AND TRIM(COALESCE(a.platform_username, '')) = TRIM(COALESCE(w.platform_account, ''))
                        AND (
                          TRIM(COALESCE(a.platform_url, '')) = ''
                          OR TRIM(COALESCE(w.platform_url, '')) = ''
                          OR TRIM(COALESCE(a.platform_url, '')) = TRIM(COALESCE(w.platform_url, ''))
                        )
                      ORDER BY a.updated_at DESC, a.id DESC
                      LIMIT 1
                    )
                  ) AS platform_account_url,
                  w.space_pk,
                  w.proxy_id,
                  w.proxy_addr,
                  w.proxy_country,
                  w.proxy_expire_at,
                  w.window_status,
                  w.window_remark,
                  w.enabled AS window_enabled,
                  s.space_id AS space_id,
                  s.name AS space_name,
                  b.name AS browser_name,
                  (SELECT COUNT(*) FROM tasks WHERE window_pk = m.window_pk AND status = 'completed') AS success_count,
                  (
                    SELECT COUNT(*)
                    FROM tasks
                    WHERE window_pk = m.window_pk
                      AND status = 'completed'
                      AND created_at >= datetime('now', '-24 hours', 'localtime')
                  ) AS success_count_24h,
                  (
                    SELECT COUNT(*)
                    FROM tasks
                    WHERE window_pk = m.window_pk
                      AND status = 'failed'
                      AND created_at >= datetime('now', '-24 hours', 'localtime')
                  ) AS failed_count_24h,
                  (
                    SELECT COUNT(*)
                    FROM veo_flow_projects v
                    WHERE v.task_type_window_id = m.id AND v.deleted = 0
                  ) AS veo_flow_project_count,
                  COALESCE(
                    json_extract(w.raw_json, '$.raw.coreVersion'),
                    json_extract(w.raw_json, '$.coreVersion')
                  ) AS browser_core_version
                FROM task_type_windows m
                JOIN windows w ON m.window_pk = w.id
                JOIN spaces s ON w.space_pk = s.id
                JOIN browsers b ON s.browser_id = b.id
                WHERE m.deleted = 0 AND m.task_type_id = ?
                -- 绑定窗口排序：按 id 倒序，避免刷新额度/邀请码后因 updated_at 变化导致列表重排
                ORDER BY m.id DESC
                """,
                (task_type_id,),
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def list_veo_flow_projects(self, task_type_window_id: int) -> List[Dict[str, Any]]:
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT id, task_type_window_id, project_id, project_name, tool_name, is_active,
                       created_at, updated_at
                FROM veo_flow_projects
                WHERE task_type_window_id = ? AND deleted = 0
                ORDER BY id DESC
                """,
                (int(task_type_window_id),),
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def get_veo_flow_project(self, task_type_window_id: int, project_id: str) -> Optional[Dict[str, Any]]:
        pid = str(project_id or "").strip()
        if not pid:
            return None
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT id, task_type_window_id, project_id, project_name, tool_name, is_active,
                       created_at, updated_at
                FROM veo_flow_projects
                WHERE task_type_window_id = ? AND project_id = ? AND deleted = 0
                ORDER BY id DESC
                LIMIT 1
                """,
                (int(task_type_window_id), pid),
            )
            row = await cur.fetchone()
            return dict(row) if row else None

    async def get_random_veo_flow_project_id(self, task_type_window_id: int) -> Optional[str]:
        """从该任务窗口绑定（task_type_windows.id）的 Veo Flow 项目中随机取一个 project_id。"""
        async with self._read_conn() as db:
            cur = await db.execute(
                """
                SELECT project_id FROM veo_flow_projects
                WHERE task_type_window_id = ? AND deleted = 0 AND IFNULL(is_active, 1) = 1
                ORDER BY RANDOM()
                LIMIT 1
                """,
                (int(task_type_window_id),),
            )
            row = await cur.fetchone()
            if not row:
                return None
            s = str(row[0] or "").strip()
            return s or None

    async def count_veo_flow_projects(self, task_type_window_id: int) -> int:
        async with self._read_conn() as db:
            cur = await db.execute(
                "SELECT COUNT(*) FROM veo_flow_projects WHERE task_type_window_id = ? AND deleted = 0",
                (int(task_type_window_id),),
            )
            row = await cur.fetchone()
            try:
                return int(row[0] or 0)
            except Exception:
                return 0

    async def add_veo_flow_project(
        self,
        task_type_window_id: int,
        project_id: str,
        project_name: str,
        tool_name: str = "PINHOLE",
        is_active: bool = True,
    ) -> int:
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                INSERT INTO veo_flow_projects (
                  task_type_window_id, project_id, project_name, tool_name, is_active, deleted, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, datetime('now','localtime'))
                """,
                (
                    int(task_type_window_id),
                    str(project_id).strip(),
                    str(project_name).strip(),
                    (tool_name or "PINHOLE").strip(),
                    1 if is_active else 0,
                ),
            )
            await db.commit()
            return int(cur.lastrowid or 0)

    async def mark_veo_flow_project_deleted(self, task_type_window_id: int, project_id: str) -> int:
        pid = str(project_id or "").strip()
        if not pid:
            return 0
        async with self._write_conn() as db:
            cur = await db.execute(
                """
                UPDATE veo_flow_projects
                SET deleted = 1, is_active = 0, updated_at = datetime('now','localtime')
                WHERE task_type_window_id = ? AND project_id = ? AND deleted = 0
                """,
                (int(task_type_window_id), pid),
            )
            await db.commit()
            try:
                return int(cur.rowcount or 0)
            except Exception:
                return 0

    async def add_task_type_windows(
        self,
        task_type_id: int,
        window_pks: List[int],
        daily_quota: int,
        remaining_quota: int,
        enabled: bool = True,
    ) -> int:
        async with self._write_conn() as db:
            affected = 0
            for wid in window_pks:
                await db.execute(
                    """
                    INSERT INTO task_type_windows (
                      task_type_id, window_pk,
                      daily_quota, remaining_quota,
                      enabled, deleted, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 0, datetime('now','localtime'))
                    ON CONFLICT(task_type_id, window_pk) DO UPDATE SET
                      daily_quota=excluded.daily_quota,
                      remaining_quota=excluded.remaining_quota,
                      enabled=excluded.enabled,
                      deleted=0,
                      updated_at=datetime('now','localtime')
                    """,
                    (
                        task_type_id,
                        int(wid),
                        int(daily_quota),
                        int(remaining_quota),
                        1 if enabled else 0,
                    ),
                )
                affected += 1
            await db.commit()
            return affected

    async def update_task_type_window(
        self,
        mapping_id: int,
        enabled: Optional[bool] = None,
        deleted: Optional[bool] = None,
        task_type_id: Optional[int] = None,
        daily_quota: Optional[int] = None,
        remaining_quota: Optional[int] = None,
        sora_remaining_count: Optional[int] = None,
        sora_purchased_remaining_count: Optional[int] = None,
        sora_rate_limit_reached: Optional[bool] = None,
        sora_access_resets_in_seconds: Optional[int] = None,
        sora_invite_code: Optional[str] = None,
        sora_access_token: Optional[str] = None,
        sora_access_expires: Optional[str] = None,
        sora_plan_title: Optional[str] = None,
        sora_subscription_end: Optional[str] = None,
        sora_drafts_count: Optional[int] = None,
        cooldown_until: Optional[str] = None,  # ISO string or None
        error_cooldown_until: Optional[str] = None,  # ISO string or None
        total_errors: Optional[int] = None,
        consecutive_errors: Optional[int] = None,
        headless: Optional[bool] = None,
        pure_mode: Optional[bool] = None,
    ) -> None:
        updates: List[str] = []
        params: List[Any] = []

        def _set(col: str, val: Any) -> None:
            updates.append(f"{col}=?")
            params.append(val)

        if enabled is not None:
            _set("enabled", 1 if enabled else 0)
        if headless is not None:
            _set("headless", 1 if headless else 0)
        if pure_mode is not None:
            _set("pure_mode", 1 if pure_mode else 0)
        if deleted is not None:
            _set("deleted", 1 if deleted else 0)
        if task_type_id is not None:
            _set("task_type_id", int(task_type_id))
        if daily_quota is not None:
            _set("daily_quota", int(daily_quota))
        if remaining_quota is not None:
            _set("remaining_quota", int(remaining_quota))
        if sora_remaining_count is not None:
            _set("sora_remaining_count", int(sora_remaining_count))
        if sora_purchased_remaining_count is not None:
            _set("sora_purchased_remaining_count", int(sora_purchased_remaining_count))
        if sora_rate_limit_reached is not None:
            _set("sora_rate_limit_reached", 1 if bool(sora_rate_limit_reached) else 0)
        if sora_access_resets_in_seconds is not None:
            _set("sora_access_resets_in_seconds", int(sora_access_resets_in_seconds))
        if sora_invite_code is not None:
            _set("sora_invite_code", (sora_invite_code or "").strip() or None)
        if sora_access_token is not None:
            _set("sora_access_token", (sora_access_token or "").strip() or None)
        if sora_access_expires is not None:
            _set("sora_access_expires", (sora_access_expires or "").strip() or None)
        if sora_plan_title is not None:
            _set("sora_plan_title", (sora_plan_title or "").strip() or None)
        if sora_subscription_end is not None:
            _set("sora_subscription_end", (sora_subscription_end or "").strip() or None)
        if sora_drafts_count is not None:
            _set("sora_drafts_count", int(sora_drafts_count))
        if cooldown_until is not None:
            _set("cooldown_until", cooldown_until if cooldown_until else None)
        if error_cooldown_until is not None:
            _set("error_cooldown_until", error_cooldown_until if error_cooldown_until else None)
        if total_errors is not None:
            _set("total_errors", int(total_errors))
        if consecutive_errors is not None:
            _set("consecutive_errors", int(consecutive_errors))

        if not updates:
            return

        params.append(mapping_id)
        sql = f"UPDATE task_type_windows SET {', '.join(updates)}, updated_at=datetime('now','localtime') WHERE id=?"
        for attempt in range(5):
            try:
                async with self._write_conn() as db:
                    await db.execute(sql, params)
                    await db.commit()
                    return
            except Exception as e:
                if self._is_db_locked_error(e) and attempt < 4:
                    await asyncio.sleep(0.05 * (attempt + 1))
                    continue
                raise

    async def _tx_mark_window_status_for_mapping(self, db: Any, mapping_id: int, window_status: int) -> None:
        """在 BEGIN…COMMIT 同一事务内更新 mapping 对应 windows.window_status。

        用于挑选预占后立即标记为 1，使按 browser 的 window_status 池化上限在“打开前”即生效。
        """
        st = 1 if int(window_status or 0) == 1 else 0
        mid = int(mapping_id)
        await db.execute(
            """
            UPDATE windows
            SET window_status = ?,
                updated_at = datetime('now','localtime')
            WHERE id = (
                SELECT m.window_pk FROM task_type_windows m
                WHERE m.id = ? AND m.deleted = 0
                LIMIT 1
            )
              AND deleted = 0
            """,
            (st, mid),
        )

    async def pick_and_reserve_window_for_task(
        self,
        task_type_code: str,
        browser_pool_limit: int = 100,
        remaining_quota_exclusive_floor: int = 2,
        credit_threthold: int  = 1,
        plan_type: int = 0,
    ) -> Optional[Dict[str, Any]]:
        """挑选 1 个窗口并原子预占 1 个并发槽位（一步完成）。

        目标：
        - 避免 TaskService “先查一批候选 -> 再循环 try_reserve” 的高并发抖动
        - 把“排序挑选 + 并发预占”压缩为单次 DB 写入（单条 SQL）
        - remaining_quota 只代表额度；并发限制以 task_types.concurrency 为准
        - 预占成功同时将 windows.window_status 置 1，使单浏览器并发池按“已占位”计数

        remaining_quota_exclusive_floor:
        - 候选/预占条件之一为 remaining_quota >= floor（或与冷却窗口 OR）；由调用方按任务预扣额度传入。

        返回：
        - 成功：返回 join 后的窗口信息 dict（与 list_available_windows_for_pick 字段一致）
        - 失败：返回 None
        """
        code = (task_type_code or "").strip()
        if not code:
            return None
        pool_limit = max(1, int(browser_pool_limit or 100))
        quota_floor = max(0, int(remaining_quota_exclusive_floor))
        required_plan_type = max(0, int(plan_type or 0))

        _lock = self._get_write_lock()
        for _attempt in range(5):
            await _lock.acquire()
            try:
                async with self._read_conn() as db:
                    db.row_factory = aiosqlite.Row
                    await db.execute("PRAGMA foreign_keys=ON")
                    await db.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
                    await db.execute("BEGIN IMMEDIATE")

                    # Step 1: 按排序挑选 1 个 mapping_id，并取出本次更新需要的并发/阈值参数
                    # 负载窗口池策略：
                    # - 先按 browser_id 分组，每个浏览器使用自身的 browser_pool_limit（0 则回退全局 pool_limit）。
                    # - 再在该窗口池中按既有策略（连续错误最少 -> 最久未用 -> 余额最多）选第 1 个。
                    cur = await db.execute(
                        """
                        WITH base AS (
                          SELECT
                            m.id AS mapping_id,
                            t.concurrency AS task_concurrency,
                            t.continuous_error_threshold AS continuous_error_threshold,
                            m.consecutive_errors AS consecutive_errors,
                            m.updated_at AS mapping_updated_at,
                            m.remaining_quota AS remaining_quota,
                            m.cooldown_until AS cooldown_until,
                            m.error_cooldown_until AS error_cooldown_until,
                            COALESCE(m.inflight_slots, 0) AS inflight_slots,
                            COALESCE(w.window_status, 0) AS window_status,
                            COALESCE(CAST(TRIM(COALESCE(m.sora_plan_title, '')) AS INTEGER), 0) AS membership_plan_type,
                            b.id AS browser_pk,
                            CASE WHEN COALESCE(b.browser_pool_limit, 0) > 0 THEN b.browser_pool_limit ELSE ? END AS effective_pool_limit
                          FROM task_types t
                          JOIN task_type_windows m ON m.task_type_id = t.id
                          JOIN windows w ON m.window_pk = w.id
                          JOIN spaces s ON w.space_pk = s.id
                          JOIN browsers b ON s.browser_id = b.id
                          WHERE t.deleted = 0 AND t.enabled = 1
                            AND t.code = ?
                            AND m.deleted = 0 AND m.enabled = 1
                            AND w.deleted = 0 AND w.enabled = 1
                            AND (? <= 0 OR (TRIM(COALESCE(m.sora_plan_title, '')) GLOB '[0-9]*' AND TRIM(COALESCE(m.sora_plan_title, '')) NOT GLOB '*[^0-9]*' AND CAST(TRIM(COALESCE(m.sora_plan_title, '')) AS INTEGER) >= ?))
                        ),
                        pool_source AS (
                          SELECT
                            b.*,
                            CASE
                              WHEN (
                                ((b.remaining_quota >= ?)
                                  OR (b.remaining_quota >= ? AND b.cooldown_until IS NOT NULL AND b.cooldown_until <= datetime('now','localtime', '+5 minutes')))
                                AND (b.error_cooldown_until IS NULL OR b.error_cooldown_until <= datetime('now','localtime'))
                                AND (b.consecutive_errors < b.continuous_error_threshold)
                                AND (COALESCE(b.inflight_slots, 0) < b.task_concurrency)
                              ) THEN 1
                              ELSE 0
                            END AS is_runnable
                          FROM base b
                          WHERE b.window_status = 1
                             OR (
                                  b.window_status = 0
                                  AND (
                                    ((b.remaining_quota >= ?)
                                      OR (b.remaining_quota >= ? AND b.cooldown_until IS NOT NULL AND b.cooldown_until <= datetime('now','localtime', '+5 minutes')))
                                    AND (b.error_cooldown_until IS NULL OR b.error_cooldown_until <= datetime('now','localtime'))
                                    AND (b.consecutive_errors < b.continuous_error_threshold)
                                    AND (COALESCE(b.inflight_slots, 0) < b.task_concurrency)
                                  )
                                )
                        ),
                        ranked AS (
                          SELECT
                            p.*,
                            ROW_NUMBER() OVER (
                              PARTITION BY p.browser_pk
                              ORDER BY
                                p.window_status DESC,
                                p.consecutive_errors ASC,
                                p.mapping_updated_at ASC,
                                p.remaining_quota DESC
                            ) AS browser_pool_rank
                          FROM pool_source p
                        )
                        SELECT
                          mapping_id,
                          task_concurrency,
                          continuous_error_threshold
                        FROM ranked
                        WHERE browser_pool_rank <= effective_pool_limit
                          AND is_runnable = 1
                        ORDER BY consecutive_errors ASC, mapping_updated_at ASC,remaining_quota DESC
                        LIMIT 1
                        """,
                        (pool_limit, code, required_plan_type, required_plan_type, quota_floor, credit_threthold, quota_floor, credit_threthold),
                    )
                    #ORDER BY consecutive_errors ASC, mapping_updated_at ASC, remaining_quota DESC
                    picked = await cur.fetchone()
                    if not picked:
                        await db.execute("ROLLBACK")
                        return None

                    mapping_id = int(picked["mapping_id"])
                    task_concurrency = max(1, int(picked["task_concurrency"] or 1))
                    threshold = max(1, int(picked["continuous_error_threshold"] or 1))
                    # Step 2: 条件 UPDATE，确保并发/健康度/额度约束仍成立（在同一事务内保证原子性）
                    cur2 = await db.execute(
                        """
                        UPDATE task_type_windows
                        SET inflight_slots = COALESCE(inflight_slots, 0) + 1,
                            error_cooldown_until = datetime('now','localtime', '+60 seconds'),
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                          AND deleted = 0 AND enabled = 1
                          AND (consecutive_errors < ?)
                          AND (COALESCE(inflight_slots, 0) < ?)
                          AND (
                            (remaining_quota >= ?)
                            OR (cooldown_until IS NOT NULL AND cooldown_until <= datetime('now','localtime', '+5 minutes'))
                          )
                          AND (error_cooldown_until IS NULL OR error_cooldown_until <= datetime('now','localtime'))
                          AND (? <= 0 OR (TRIM(COALESCE(sora_plan_title, '')) GLOB '[0-9]*' AND TRIM(COALESCE(sora_plan_title, '')) NOT GLOB '*[^0-9]*' AND CAST(TRIM(COALESCE(sora_plan_title, '')) AS INTEGER) >= ?))
                        """,
                        (mapping_id, threshold, task_concurrency, quota_floor, required_plan_type, required_plan_type),
                    )
                    if int(cur2.rowcount or 0) <= 0:
                        # 理论上在 IMMEDIATE 事务内不太会发生，但为了稳健性（以及未来条件调整）保留兜底
                        await db.execute("ROLLBACK")
                        continue

                    await self._tx_mark_window_status_for_mapping(db, mapping_id, 1)

                    # Step 3: 返回 join 后的上下文字段（与旧实现一致），含窗口绑定 IP
                    cur3 = await db.execute(
                        """
                        SELECT
                          m.*,
                          t.code AS task_code,
                          t.concurrency AS task_concurrency,
                          t.continuous_error_threshold,
                          t.continuous_error_close_window_threshold,
                          t.timeout_seconds,
                          t.create_task_handler,
                          t.error_retry_count,
                          t.default_target_url,
                          w.window_key,
                          w.window_name,
                          w.platform_account,
                          w.platform_url,
                          w.proxy_addr AS window_ip,
                          s.id AS space_pk,
                          s.space_id AS space_id,
                          b.id AS browser_pk,
                          b.lan_addr,
                          b.vendor,
                          b.access_key,
                          (
                            SELECT v.project_id FROM veo_flow_projects v
                            WHERE v.task_type_window_id = m.id AND v.deleted = 0
                            ORDER BY v.updated_at DESC, v.id DESC
                            LIMIT 1
                          ) AS current_project_id
                        FROM task_type_windows m
                        JOIN task_types t ON m.task_type_id = t.id
                        JOIN windows w ON m.window_pk = w.id
                        JOIN spaces s ON w.space_pk = s.id
                        JOIN browsers b ON s.browser_id = b.id
                        WHERE m.id = ?
                        LIMIT 1
                        """,
                        (mapping_id,),
                    )
                    row = await cur3.fetchone()
                    await db.commit()
                    return dict(row) if row else None
            except Exception as e:
                if self._is_db_locked_error(e) and _attempt < 4:
                    await asyncio.sleep(0.05 * (_attempt + 1))
                    continue
                raise
            finally:
                _lock.release()
        return None

    async def pick_and_reserve_window_from_pool(
        self,
        task_type_code: str,
        pool_mapping_ids: List[int],
        remaining_quota_exclusive_floor: int = 3,
        credit_threthold: int  = 1,
        plan_type: int = 0,
    ) -> Optional[Dict[str, Any]]:
        """在窗口池 mapping 集合内原子挑选并预占 1 槽位。

        与 pick_and_reserve_window_for_task 一致：单事务内排序 LIMIT 1 + 条件 UPDATE，并设置
        error_cooldown_until = now+60s，避免高并发下多协程/多进程先读到同一候选再依次抢到同一 mapping。

        候选过滤与排序对齐 list_mapping_ids_for_pool_pick（不含全局路径的 browser 池内 ROW_NUMBER）。
        """
        code = (task_type_code or "").strip()
        ids = [int(x) for x in (pool_mapping_ids or []) if int(x) > 0]
        if not code or not ids:
            return None
        quota_floor = max(0, int(remaining_quota_exclusive_floor))
        required_plan_type = max(0, int(plan_type or 0))
        placeholders = ",".join("?" for _ in ids)

        _lock = self._get_write_lock()
        for _attempt in range(5):
            await _lock.acquire()
            try:
                async with self._read_conn() as db:
                    db.row_factory = aiosqlite.Row
                    await db.execute("PRAGMA foreign_keys=ON")
                    await db.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
                    await db.execute("BEGIN IMMEDIATE")

                    cur = await db.execute(
                        f"""
                        SELECT
                          m.id AS mapping_id,
                          t.concurrency AS task_concurrency,
                          t.continuous_error_threshold AS continuous_error_threshold,
                          COALESCE(t.window_call_cooldown_seconds, 30) AS window_call_cooldown_seconds
                        FROM task_types t
                        JOIN task_type_windows m ON m.task_type_id = t.id
                        JOIN windows w ON m.window_pk = w.id
                        WHERE t.deleted = 0 AND t.enabled = 1
                          AND t.code = ?
                          AND m.id IN ({placeholders})
                          AND m.deleted = 0 AND m.enabled = 1
                          AND w.deleted = 0 AND w.enabled = 1
                          AND w.window_status = 1
                          AND (? <= 0 OR (TRIM(COALESCE(m.sora_plan_title, '')) GLOB '[0-9]*' AND TRIM(COALESCE(m.sora_plan_title, '')) NOT GLOB '*[^0-9]*' AND CAST(TRIM(COALESCE(m.sora_plan_title, '')) AS INTEGER) >= ?))
                          AND (m.error_cooldown_until IS NULL OR m.error_cooldown_until <= datetime('now','localtime'))
                          AND (m.consecutive_errors < t.continuous_error_threshold)
                          AND (COALESCE(m.inflight_slots, 0) < t.concurrency)
                          AND (
                            (m.remaining_quota >= ?)
                            OR (m.remaining_quota >= ? AND m.cooldown_until IS NOT NULL AND m.cooldown_until <= datetime('now','localtime', '+5 minutes'))
                          )
                        ORDER BY m.consecutive_errors ASC, m.updated_at ASC, m.remaining_quota DESC
                        LIMIT 1
                        """,
                        (code, *ids, required_plan_type, required_plan_type, quota_floor,credit_threthold),
                    )
                    picked = await cur.fetchone()
                    if not picked:
                        await db.execute("ROLLBACK")
                        return None

                    mapping_id = int(picked["mapping_id"])
                    task_concurrency = max(1, int(picked["task_concurrency"] or 1))
                    threshold = max(1, int(picked["continuous_error_threshold"] or 1))
                    window_call_cooldown_seconds = max(0, int(picked["window_call_cooldown_seconds"] or 30))

                    cur2 = await db.execute(
                        """
                        UPDATE task_type_windows
                        SET inflight_slots = COALESCE(inflight_slots, 0) + 1,
                            error_cooldown_until = datetime('now','localtime', ?),
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                          AND deleted = 0 AND enabled = 1
                          AND (consecutive_errors < ?)
                          AND (COALESCE(inflight_slots, 0) < ?)
                          AND (
                            (remaining_quota >= ?)
                            OR (cooldown_until IS NOT NULL AND cooldown_until <= datetime('now','localtime', '+5 minutes'))
                          )
                          AND (error_cooldown_until IS NULL OR error_cooldown_until <= datetime('now','localtime'))
                          AND (? <= 0 OR (TRIM(COALESCE(sora_plan_title, '')) GLOB '[0-9]*' AND TRIM(COALESCE(sora_plan_title, '')) NOT GLOB '*[^0-9]*' AND CAST(TRIM(COALESCE(sora_plan_title, '')) AS INTEGER) >= ?))
                        """,
                        (f"+{window_call_cooldown_seconds} seconds", mapping_id, threshold, task_concurrency, quota_floor, required_plan_type, required_plan_type),
                    )
                    if int(cur2.rowcount or 0) <= 0:
                        await db.execute("ROLLBACK")
                        continue

                    await self._tx_mark_window_status_for_mapping(db, mapping_id, 1)

                    cur3 = await db.execute(
                        """
                        SELECT
                          m.*,
                          t.code AS task_code,
                          t.concurrency AS task_concurrency,
                          t.continuous_error_threshold,
                          t.continuous_error_close_window_threshold,
                          t.timeout_seconds,
                          t.create_task_handler,
                          t.error_retry_count,
                          t.default_target_url,
                          w.window_key,
                          w.window_name,
                          w.platform_account,
                          w.platform_url,
                          w.proxy_addr AS window_ip,
                          s.id AS space_pk,
                          s.space_id AS space_id,
                          b.id AS browser_pk,
                          b.lan_addr,
                          b.vendor,
                          b.access_key,
                          (
                            SELECT v.project_id FROM veo_flow_projects v
                            WHERE v.task_type_window_id = m.id AND v.deleted = 0
                            ORDER BY v.updated_at DESC, v.id DESC
                            LIMIT 1
                          ) AS current_project_id
                        FROM task_type_windows m
                        JOIN task_types t ON m.task_type_id = t.id
                        JOIN windows w ON m.window_pk = w.id
                        JOIN spaces s ON w.space_pk = s.id
                        JOIN browsers b ON s.browser_id = b.id
                        WHERE m.id = ?
                        LIMIT 1
                        """,
                        (mapping_id,),
                    )
                    row = await cur3.fetchone()
                    await db.commit()
                    return dict(row) if row else None
            except Exception as e:
                if self._is_db_locked_error(e) and _attempt < 4:
                    await asyncio.sleep(0.05 * (_attempt + 1))
                    continue
                raise
            finally:
                _lock.release()
        return None

    async def task_type_has_mapping_remaining_quota_above(
        self, task_type_code: str, above: int
    ) -> bool:
        """是否存在该任务类型下「可视为高于 above」的可用映射（用于 veo 窗口池分层等）。

        满足其一即算：
        - remaining_quota 严格大于 above；
        - 或库内 remaining_quota 未高于 above，但 cooldown_until 已过期（额度可能已重置而尚未刷新入库）。
        """
        code = (task_type_code or "").strip()
        if not code:
            return False
        lim = int(above)
        async with self._read_conn() as db:
            cur = await db.execute(
                """
                SELECT 1
                FROM task_types t
                JOIN task_type_windows m ON m.task_type_id = t.id AND m.deleted = 0 AND m.enabled = 1
                JOIN windows w ON m.window_pk = w.id AND w.deleted = 0 AND w.enabled = 1
                WHERE t.code = ? AND t.deleted = 0 AND t.enabled = 1 AND COALESCE(w.window_status, 1) = 0
                  AND (
                    m.remaining_quota > ?
                    OR (
                      m.remaining_quota >= 1
                      AND m.cooldown_until IS NOT NULL
                      AND m.cooldown_until <= datetime('now','localtime')
                    )
                  )
                LIMIT 1
                """,
                (code, lim),
            )
            row = await cur.fetchone()
            return row is not None

    async def _veo_keepalive_list_candidates(self) -> List[Dict[str, Any]]:
        """列出 VEO 窗口池中需要由 VEO 保活调度器判断 access_expires 的候选窗口。

        仅返回 window_pool_enabled=true、create_task_handler='veo_workflow'、
        mapping/window 已启用、窗口已打开且当前没有 inflight 的记录。
        """
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT
                  m.id AS mapping_id,
                  m.window_pk,
                  m.remaining_quota,
                  m.sora_remaining_count,
                  m.sora_access_token,
                  m.sora_access_expires,
                  m.cooldown_until,
                  m.error_cooldown_until,
                  m.inflight_slots,
                  m.headless,
                  m.pure_mode,
                  (
                    SELECT v.project_id FROM veo_flow_projects v
                    WHERE v.task_type_window_id = m.id AND v.deleted = 0
                    ORDER BY v.updated_at DESC, v.id DESC
                    LIMIT 1
                  ) AS current_project_id,
                  t.code AS task_code,
                  t.concurrency AS task_concurrency,
                  t.continuous_error_threshold,
                  t.continuous_error_close_window_threshold,
                  t.timeout_seconds,
                  t.create_task_handler,
                  t.error_retry_count,
                  t.default_target_url,
                  w.window_key,
                  w.window_status,
                  w.proxy_addr AS window_ip,
                  s.space_id,
                  b.vendor AS browser_vendor,
                  b.lan_addr AS browser_base_url,
                  b.access_key AS browser_access_key
                FROM task_type_windows m
                JOIN task_types t ON t.id = m.task_type_id
                JOIN windows w ON w.id = m.window_pk
                JOIN spaces s ON s.id = w.space_pk
                JOIN browsers b ON b.id = s.browser_id
                WHERE t.deleted = 0 AND t.enabled = 1
                  AND COALESCE(t.window_pool_enabled, 0) != 0
                  AND t.create_task_handler = 'veo_workflow'
                  AND m.deleted = 0 AND m.enabled = 1
                  AND w.deleted = 0 AND w.enabled = 1
                  AND b.deleted = 0
                  AND COALESCE(w.window_status, 0) = 1
                  AND TRIM(COALESCE(m.sora_access_token, '')) <> ''
                  AND TRIM(COALESCE(m.sora_access_expires, '')) <> ''
                  AND (m.consecutive_errors < t.continuous_error_threshold)
                ORDER BY m.sora_access_expires ASC, m.updated_at ASC
                """
            )
            #AND COALESCE(w.window_status, 0) = 1
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def _veo_balance_refresh_list_candidates(self) -> List[Dict[str, Any]]:
        """List all enabled open VEO pool windows for periodic balance refresh."""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT
                  m.id AS mapping_id,
                  m.window_pk,
                  m.remaining_quota,
                  m.sora_remaining_count,
                  m.sora_access_token,
                  m.sora_access_expires,
                  m.sora_plan_title,
                  m.cooldown_until,
                  m.error_cooldown_until,
                  m.inflight_slots,
                  m.headless,
                  m.pure_mode,
                  (
                    SELECT v.project_id FROM veo_flow_projects v
                    WHERE v.task_type_window_id = m.id AND v.deleted = 0
                    ORDER BY v.updated_at DESC, v.id DESC
                    LIMIT 1
                  ) AS current_project_id,
                  t.code AS task_code,
                  t.concurrency AS task_concurrency,
                  t.continuous_error_threshold,
                  t.continuous_error_close_window_threshold,
                  t.timeout_seconds,
                  t.create_task_handler,
                  t.error_retry_count,
                  t.default_target_url,
                  w.window_key,
                  w.window_status,
                  w.proxy_addr AS window_ip,
                  s.space_id,
                  b.vendor AS browser_vendor,
                  b.lan_addr AS browser_base_url,
                  b.access_key AS browser_access_key
                FROM task_type_windows m
                JOIN task_types t ON t.id = m.task_type_id
                JOIN windows w ON w.id = m.window_pk
                JOIN spaces s ON s.id = w.space_pk
                JOIN browsers b ON b.id = s.browser_id
                WHERE t.deleted = 0 AND t.enabled = 1
                  AND COALESCE(t.window_pool_enabled, 0) != 0
                  AND t.create_task_handler = 'veo_workflow'
                  AND m.deleted = 0 AND m.enabled = 1
                  AND w.deleted = 0 AND w.enabled = 1
                  AND b.deleted = 0
                  AND COALESCE(w.window_status, 0) = 1
                  AND COALESCE(m.inflight_slots, 0) = 0
                  AND (m.consecutive_errors < t.continuous_error_threshold)
                ORDER BY m.updated_at ASC, m.id ASC
                """
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def list_window_pool_target_mapping_ids(
        self,
        task_type_code: str,
        browser_pool_limit: int = 100,
        remaining_quota_exclusive_floor: int = 3,
        credit_threthold: int = 1,
        plan_type: int = 0,
    ) -> List[int]:
        """与 pick_and_reserve_window_for_task 相同的候选与每浏览器上限，返回应保持在池中的 mapping_id 列表（不修改 inflight）。

        额外：仍有未释放并发槽（inflight_slots > 0）的窗口一律视为应保留在池中（is_runnable 视为满足，且不受每浏览器 pool 内 ROW_NUMBER 上限挤出），避免运行中因额度已预扣低于 floor 被误判为待关闭。
        """
        code = (task_type_code or "").strip()
        if not code:
            return []
        pool_limit = max(1, int(browser_pool_limit or 100))
        quota_floor = max(0, int(remaining_quota_exclusive_floor))
        required_plan_type = max(0, int(plan_type or 0))
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                WITH base AS (
                  SELECT
                    m.id AS mapping_id,
                    t.concurrency AS task_concurrency,
                    t.continuous_error_threshold AS continuous_error_threshold,
                    m.consecutive_errors AS consecutive_errors,
                    m.updated_at AS mapping_updated_at,
                    m.remaining_quota AS remaining_quota,
                    m.cooldown_until AS cooldown_until,
                    m.error_cooldown_until AS error_cooldown_until,
                    COALESCE(m.inflight_slots, 0) AS inflight_slots,
                    COALESCE(w.window_status, 0) AS window_status,
                    b.id AS browser_pk,
                    CASE WHEN COALESCE(b.browser_pool_limit, 0) > 0 THEN b.browser_pool_limit ELSE ? END AS effective_pool_limit
                  FROM task_types t
                  JOIN task_type_windows m ON m.task_type_id = t.id
                  JOIN windows w ON m.window_pk = w.id
                  JOIN spaces s ON w.space_pk = s.id
                  JOIN browsers b ON s.browser_id = b.id
                  WHERE t.deleted = 0 AND t.enabled = 1
                    AND t.code = ?
                    AND m.deleted = 0 AND m.enabled = 1
                    AND w.deleted = 0 AND w.enabled = 1
                    AND (? <= 0 OR (TRIM(COALESCE(m.sora_plan_title, '')) GLOB '[0-9]*' AND TRIM(COALESCE(m.sora_plan_title, '')) NOT GLOB '*[^0-9]*' AND CAST(TRIM(COALESCE(m.sora_plan_title, '')) AS INTEGER) >= ?))
                ),
                pool_source AS (
                  SELECT
                    b.*,
                    CASE
                      WHEN COALESCE(b.inflight_slots, 0) > 0 THEN 1
                      WHEN (
                        ((b.remaining_quota >= ?)
                          OR (b.remaining_quota >= ? AND b.cooldown_until IS NOT NULL AND b.cooldown_until <= datetime('now','localtime', '+5 minutes')))
                        AND (b.error_cooldown_until IS NULL OR b.error_cooldown_until <= datetime('now','localtime'))
                        AND (b.consecutive_errors < b.continuous_error_threshold)
                        AND (COALESCE(b.inflight_slots, 0) < b.task_concurrency)
                      ) THEN 1
                      ELSE 0
                    END AS is_runnable
                  FROM base b
                  WHERE b.window_status = 1
                     OR COALESCE(b.inflight_slots, 0) > 0
                     OR (
                          b.window_status = 0
                          AND (
                            ((b.remaining_quota >= ?)
                              OR (b.remaining_quota >= ? AND b.cooldown_until IS NOT NULL AND b.cooldown_until <= datetime('now','localtime', '+5 minutes')))
                            AND (b.error_cooldown_until IS NULL OR b.error_cooldown_until <= datetime('now','localtime'))
                            AND (b.consecutive_errors < b.continuous_error_threshold)
                            AND (COALESCE(b.inflight_slots, 0) < b.task_concurrency)
                          )
                        )
                ),
                ranked AS (
                  SELECT
                    p.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY p.browser_pk
                      ORDER BY
                        p.window_status DESC,
                        p.consecutive_errors ASC,
                        p.mapping_updated_at ASC,
                        p.remaining_quota DESC
                    ) AS browser_pool_rank
                  FROM pool_source p
                )
                SELECT mapping_id
                FROM ranked
                WHERE browser_pool_rank <= effective_pool_limit
                  AND is_runnable = 1
                ORDER BY consecutive_errors ASC, mapping_updated_at ASC, remaining_quota DESC
                """,
                (pool_limit, code, required_plan_type, required_plan_type, quota_floor, credit_threthold, quota_floor, credit_threthold),
            )
            rows = await cur.fetchall()
            return [int(r["mapping_id"]) for r in rows]

    async def force_reserve_mapping_for_task(self, task_type_code: str, mapping_id: int) -> Optional[Dict[str, Any]]:
        """强制按指定 mapping_id 预占 1 个并发槽位，并返回窗口上下文。

        与 reserve_mapping_for_task 的差异：
        - 不再基于“额度/冷却/错误熔断/并发上限”等资源约束判断可用性
        - 仅要求：task_type 关联正确 + mapping/window 未删除且启用
        - 仍会在 task_type_windows.inflight_slots 上做 +1，保证 TaskService 的 release_mapping_slot 语义一致
        """
        code = (task_type_code or "").strip()
        mid = int(mapping_id)
        if not code or mid <= 0:
            return None

        _lock = self._get_write_lock()
        for _attempt in range(5):
            await _lock.acquire()
            try:
                async with self._read_conn() as db:
                    db.row_factory = aiosqlite.Row
                    await db.execute("PRAGMA foreign_keys=ON")
                    await db.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
                    await db.execute("BEGIN IMMEDIATE")

                    cur = await db.execute(
                        """
                        SELECT m.id AS mapping_id
                        FROM task_types t
                        JOIN task_type_windows m ON m.task_type_id = t.id
                        JOIN windows w ON m.window_pk = w.id
                        WHERE t.deleted=0 AND t.enabled=1
                          AND t.code=?
                          AND m.id=?
                          AND m.deleted=0 AND m.enabled=1
                          AND w.deleted=0 AND w.enabled=1
                        LIMIT 1
                        """,
                        (code, mid),
                    )
                    picked = await cur.fetchone()
                    if not picked:
                        await db.execute("ROLLBACK")
                        return None

                    cur2 = await db.execute(
                        """
                        UPDATE task_type_windows
                        SET inflight_slots = COALESCE(inflight_slots, 0) + 1,
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                          AND deleted = 0 AND enabled = 1
                        """,
                        (mid,),
                    )
                    if int(cur2.rowcount or 0) <= 0:
                        await db.execute("ROLLBACK")
                        continue

                    await self._tx_mark_window_status_for_mapping(db, mid, 1)

                    cur3 = await db.execute(
                        """
                        SELECT
                          m.*,
                          t.code AS task_code,
                          t.concurrency AS task_concurrency,
                          t.continuous_error_threshold,
                          t.continuous_error_close_window_threshold,
                          t.timeout_seconds,
                          t.create_task_handler,
                          t.error_retry_count,
                          t.default_target_url,
                          w.window_key,
                          w.window_name,
                          w.platform_account,
                          w.platform_url,
                          w.proxy_addr AS window_ip,
                          s.id AS space_pk,
                          s.space_id AS space_id,
                          b.id AS browser_pk,
                          b.lan_addr,
                          b.vendor,
                          b.access_key,
                          (
                            SELECT v.project_id FROM veo_flow_projects v
                            WHERE v.task_type_window_id = m.id AND v.deleted = 0
                            ORDER BY v.updated_at DESC, v.id DESC
                            LIMIT 1
                          ) AS current_project_id
                        FROM task_type_windows m
                        JOIN task_types t ON m.task_type_id = t.id
                        JOIN windows w ON m.window_pk = w.id
                        JOIN spaces s ON w.space_pk = s.id
                        JOIN browsers b ON s.browser_id = b.id
                        WHERE m.id = ?
                        LIMIT 1
                        """,
                        (mid,),
                    )
                    row = await cur3.fetchone()
                    await db.commit()
                    return dict(row) if row else None
            except Exception as e:
                if self._is_db_locked_error(e) and _attempt < 4:
                    await asyncio.sleep(0.05 * (_attempt + 1))
                    continue
                raise
            finally:
                _lock.release()
        return None

    async def force_reserve_window_for_task(self, task_type_code: str, window_pk: int) -> Optional[Dict[str, Any]]:
        """强制按指定 window_pk 预占 1 个并发槽位，并返回窗口上下文。

        与 reserve_window_for_task 的差异：
        - 不再基于“额度/冷却/错误熔断/并发上限”等资源约束判断可用性
        - 仅要求：task_type 关联正确 + mapping/window 未删除且启用
        - 仍会在 task_type_windows.inflight_slots 上做 +1，保证 TaskService 的 release_mapping_slot 语义一致
        """
        code = (task_type_code or "").strip()
        wid = int(window_pk)
        if not code or wid <= 0:
            return None

        _lock = self._get_write_lock()
        for _attempt in range(5):
            await _lock.acquire()
            try:
                async with self._read_conn() as db:
                    db.row_factory = aiosqlite.Row
                    await db.execute("PRAGMA foreign_keys=ON")
                    await db.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
                    await db.execute("BEGIN IMMEDIATE")

                    cur = await db.execute(
                        """
                        SELECT m.id AS mapping_id
                        FROM task_types t
                        JOIN task_type_windows m ON m.task_type_id = t.id
                        JOIN windows w ON m.window_pk = w.id
                        WHERE t.deleted=0 AND t.enabled=1
                          AND t.code=?
                          AND m.window_pk=?
                          AND m.deleted=0 AND m.enabled=1
                          AND w.deleted=0 AND w.enabled=1
                        LIMIT 1
                        """,
                        (code, wid),
                    )
                    picked = await cur.fetchone()
                    if not picked:
                        await db.execute("ROLLBACK")
                        return None

                    mid = int(picked["mapping_id"])

                    cur2 = await db.execute(
                        """
                        UPDATE task_type_windows
                        SET inflight_slots = COALESCE(inflight_slots, 0) + 1,
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                          AND deleted = 0 AND enabled = 1
                        """,
                        (mid,),
                    )
                    if int(cur2.rowcount or 0) <= 0:
                        await db.execute("ROLLBACK")
                        continue

                    await self._tx_mark_window_status_for_mapping(db, mid, 1)

                    cur3 = await db.execute(
                        """
                        SELECT
                          m.*,
                          t.code AS task_code,
                          t.concurrency AS task_concurrency,
                          t.continuous_error_threshold,
                          t.continuous_error_close_window_threshold,
                          t.timeout_seconds,
                          t.create_task_handler,
                          t.error_retry_count,
                          t.default_target_url,
                          w.window_key,
                          w.window_name,
                          w.platform_account,
                          w.platform_url,
                          w.proxy_addr AS window_ip,
                          s.id AS space_pk,
                          s.space_id AS space_id,
                          b.id AS browser_pk,
                          b.lan_addr,
                          b.vendor,
                          b.access_key,
                          (
                            SELECT v.project_id FROM veo_flow_projects v
                            WHERE v.task_type_window_id = m.id AND v.deleted = 0
                            ORDER BY v.updated_at DESC, v.id DESC
                            LIMIT 1
                          ) AS current_project_id
                        FROM task_type_windows m
                        JOIN task_types t ON m.task_type_id = t.id
                        JOIN windows w ON m.window_pk = w.id
                        JOIN spaces s ON w.space_pk = s.id
                        JOIN browsers b ON s.browser_id = b.id
                        WHERE m.id = ?
                        LIMIT 1
                        """,
                        (mid,),
                    )
                    row = await cur3.fetchone()
                    await db.commit()
                    return dict(row) if row else None
            except Exception as e:
                if self._is_db_locked_error(e) and _attempt < 4:
                    await asyncio.sleep(0.05 * (_attempt + 1))
                    continue
                raise
            finally:
                _lock.release()
        return None
    
    async def release_mapping_slot(self, mapping_id: int) -> None:
        """释放 1 个预占并发槽位（下限到 0，避免异常时减成负数）。"""
        mid = int(mapping_id)
        for attempt in range(5):
            try:
                async with self._write_conn() as db:
                    await db.execute("PRAGMA foreign_keys=ON")
                    await db.execute(
                        """
                        UPDATE task_type_windows
                        SET inflight_slots = CASE
                              WHEN COALESCE(inflight_slots, 0) >= 1 THEN COALESCE(inflight_slots, 0) - 1
                              ELSE 0
                            END,
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                        """,
                        (mid,),
                    )
                    await db.commit()
                    return
            except Exception as e:
                if self._is_db_locked_error(e) and attempt < 4:
                    await asyncio.sleep(0.05 * (attempt + 1))
                    continue
                raise

    # ---------- tasks ----------
    async def fail_running_and_queued_tasks_on_startup(self) -> Dict[str, int]:
        """启动时清理遗留任务状态。

        目的：
        - 进程异常退出/重启后，DB 里可能残留 status=running/queued 的任务
        - 这些任务在当前实例不可能再继续执行，需要统一置为 failed，避免 UI/调度误判

        同时：
        - 重置 `task_type_windows.inflight_slots`，避免预占并发槽位在异常退出后“泄漏”
        """
        async with self._write_conn() as db:
            tasks_failed = 0
            mapping_slots_reset = 0

            # 某些历史库可能仅局部页损坏（可启动但访问特定表时报 malformed）。
            # 启动清理不应阻断服务，因此这里对 malformed 做降级容错。
            try:
                await db.execute(
                    """
                    UPDATE tasks
                    SET status = 'failed',
                        error_message = CASE
                          WHEN error_message IS NULL OR TRIM(error_message) = '' THEN 'server restarted'
                          ELSE error_message
                        END,
                        completed_at = COALESCE(completed_at, datetime('now','localtime'))
                    WHERE status IN ('running', 'queued')
                    """
                )
                cur = await db.execute("SELECT changes()")
                tasks_failed = int(((await cur.fetchone()) or [0])[0] or 0)
            except Exception as e:
                if "database disk image is malformed" not in str(e).lower():
                    raise
                await db.rollback()

            try:
                await db.execute(
                    """
                    UPDATE task_type_windows
                    SET inflight_slots = 0,
                        updated_at = datetime('now','localtime')
                    WHERE COALESCE(inflight_slots, 0) != 0
                    """
                )
                cur = await db.execute("SELECT changes()")
                mapping_slots_reset = int(((await cur.fetchone()) or [0])[0] or 0)
            except Exception as e:
                if "database disk image is malformed" not in str(e).lower():
                    raise
                await db.rollback()

            await db.commit()
            return {"tasks_failed": tasks_failed, "mapping_slots_reset": mapping_slots_reset}

    async def create_task(self, task: Task, *, insert_created_at: Optional[str] = None) -> int:
        """insert_created_at: 显式写入 created_at（如重试归档行沿用主任务创建时间）；为空则使用当前本地时间。"""
        async with self._write_conn() as db:
            if insert_created_at and str(insert_created_at).strip():
                cur = await db.execute(
                    """
                    INSERT INTO tasks (task_id, task_type_code, generation_id, status, progress, prompt, image_path, window_pk, window_ip, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        task.task_id,
                        task.task_type_code,
                        (str(task.generation_id).strip() if task.generation_id else None),
                        task.status,
                        int(task.progress or 0),
                        task.prompt,
                        task.image_path,
                        task.window_pk,
                        (str(task.window_ip).strip() if task.window_ip else None),
                        str(insert_created_at).strip(),
                    ),
                )
            else:
                cur = await db.execute(
                    """
                    INSERT INTO tasks (task_id, task_type_code, generation_id, status, progress, prompt, image_path, window_pk, window_ip, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
                    """,
                    (
                        task.task_id,
                        task.task_type_code,
                        (str(task.generation_id).strip() if task.generation_id else None),
                        task.status,
                        int(task.progress or 0),
                        task.prompt,
                        task.image_path,
                        task.window_pk,
                        (str(task.window_ip).strip() if task.window_ip else None),
                    ),
                )
            await db.commit()
            return int(cur.lastrowid)

    async def get_task(self, task_id: str) -> Optional[Task]:
        tid = task_id.strip()
        try:
            async with self._read_conn() as db:
                db.row_factory = aiosqlite.Row
                cur = await db.execute("SELECT * FROM tasks WHERE task_id = ?", (tid,))
                row = await cur.fetchone()
                if not row:
                    return None
                d = dict(row)
                if d.get("result_json"):
                    try:
                        d["result"] = json.loads(d["result_json"])
                    except Exception:
                        d["result"] = None
                d.pop("result_json", None)
                return Task(**d)
        except RuntimeError as e:
            # 在极端线程资源不足时，aiosqlite 无法启动工作线程。
            # 这里回退到一次性同步查询，避免任务查询接口直接 500。
            if "can't start new thread" not in str(e):
                raise
            with sqlite3.connect(self.db_path) as sdb:
                sdb.row_factory = sqlite3.Row
                cur = sdb.execute("SELECT * FROM tasks WHERE task_id = ?", (tid,))
                row = cur.fetchone()
                if not row:
                    return None
                d = dict(row)
                if d.get("result_json"):
                    try:
                        d["result"] = json.loads(d["result_json"])
                    except Exception:
                        d["result"] = None
                d.pop("result_json", None)
                return Task(**d)

    async def task_status_summary(self) -> Dict[str, int]:
        """Return counts: running, completed, failed (excluding violation), violation."""
        async with self._read_conn() as db:
            # 不要用 `SUM(CASE ...) FROM tasks` 一次扫全表：
            # tasks 表里 prompt/result_json 可能很大，历史库上该 SQL 会退化为整表扫描，
            # 导致管理后台 `/api/admin/queue-info` 和任务页刷新被阻塞数秒甚至十几秒。
            # 拆成多个可走索引的 COUNT，SQLite 会使用 status/content_violation 索引。
            async def _count(sql: str, params: tuple[Any, ...] = ()) -> int:
                cur = await db.execute(sql, params)
                row = await cur.fetchone()
                try:
                    return int((row[0] if row else 0) or 0)
                except Exception:
                    return 0

            running = await _count("SELECT COUNT(*) FROM tasks WHERE status = ?", ("running",))
            completed = await _count("SELECT COUNT(*) FROM tasks WHERE status = ?", ("completed",))
            failed = await _count(
                "SELECT COUNT(*) FROM tasks WHERE status = ? AND COALESCE(content_violation, 0) = 0",
                ("failed",),
            )
            violation = await _count("SELECT COUNT(*) FROM tasks WHERE content_violation = 1")
            return {"running": running, "completed": completed, "failed": failed, "violation": violation}

    async def count_tasks(
        self,
        task_type_code: Optional[str] = None,
        status: Optional[str] = None,
        window_pk: Optional[int] = None,
        window_ip: Optional[str] = None,
        q: Optional[str] = None,
        prompt_tag: Optional[str] = None,
    ) -> int:
        where: List[str] = ["1=1"]
        params: List[Any] = []

        if task_type_code:
            where.append("task_type_code = ?")
            params.append(task_type_code.strip())
        if status:
            where.append("status = ?")
            params.append(status.strip())
        if window_pk is not None:
            where.append("window_pk = ?")
            params.append(int(window_pk))
        if window_ip:
            where.append("TRIM(COALESCE(window_ip, '')) = ?")
            params.append(window_ip.strip())
        if q:
            qq = f"%{q.strip()}%"
            where.append("(task_id LIKE ? OR generation_id LIKE ? OR prompt LIKE ? OR error_message LIKE ? OR window_ip LIKE ?)")
            params.extend([qq, qq, qq, qq, qq])
        if prompt_tag == "character_creation":
            where.append("(prompt LIKE '%video_url%' OR prompt LIKE '%generation_id%')")

        async with self._read_conn() as db:
            cur = await db.execute(f"SELECT COUNT(*) AS c FROM tasks WHERE {' AND '.join(where)}", params)
            row = await cur.fetchone()
            try:
                return int((row[0] if row else 0) or 0)
            except Exception:
                return 0

    async def list_tasks(
        self,
        limit: int = 50,
        offset: int = 0,
        task_type_code: Optional[str] = None,
        status: Optional[str] = None,
        window_pk: Optional[int] = None,
        window_ip: Optional[str] = None,
        q: Optional[str] = None,
        prompt_tag: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        lim = max(1, min(200, int(limit or 50)))
        off = max(0, int(offset or 0))

        where: List[str] = ["1=1"]
        params: List[Any] = []

        if task_type_code:
            where.append("t.task_type_code = ?")
            params.append(task_type_code.strip())
        if status:
            where.append("t.status = ?")
            params.append(status.strip())
        if window_pk is not None:
            where.append("t.window_pk = ?")
            params.append(int(window_pk))
        if window_ip:
            where.append("TRIM(COALESCE(t.window_ip, '')) = ?")
            params.append(window_ip.strip())
        if q:
            qq = f"%{q.strip()}%"
            where.append("(t.task_id LIKE ? OR t.generation_id LIKE ? OR t.prompt LIKE ? OR t.error_message LIKE ? OR t.window_ip LIKE ?)")
            params.extend([qq, qq, qq, qq, qq])
        if prompt_tag == "character_creation":
            where.append("(t.prompt LIKE '%video_url%' OR t.prompt LIKE '%generation_id%')")

        params.extend([lim, off])

        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                f"""
                SELECT
                  t.task_id,
                  t.task_type_code,
                  t.generation_id,
                  t.status,
                  t.progress,
                  t.prompt,
                  t.window_pk,
                  t.window_ip,
                  w.platform_account AS window_account,
                  w.window_sort_num AS window_sort_num,
                  s.name AS space_name,
                  t.error_message,
                  t.content_violation,
                  t.result_json,
                  t.created_at,
                  t.updated_at
                FROM tasks t
                LEFT JOIN windows w ON w.id = t.window_pk
                LEFT JOIN spaces s ON s.id = w.space_pk
                WHERE {' AND '.join(where)}
                ORDER BY t.created_at DESC, t.id DESC
                LIMIT ? OFFSET ?
                """,
                params,
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def list_task_success_fail_timeline(
        self,
        group_by: str = "account",  # account | ip
        bucket: str = "day",  # month | week | day | hour | minute
        limit: int = 100,
        offset: int = 0,
        task_type_code: Optional[str] = None,
        q: Optional[str] = None,
        start_at: Optional[str] = None,
        end_at: Optional[str] = None,
    ) -> Dict[str, Any]:
        """按账号/IP + 时间桶聚合任务成功失败数据（仅 completed/failed）。"""

        grp = str(group_by or "account").strip().lower()
        if grp not in ("account", "ip"):
            grp = "account"

        bkt = str(bucket or "day").strip().lower()
        if bkt not in ("month", "week", "day", "hour", "minute"):
            bkt = "day"

        lim = max(1, min(200, int(limit or 100)))
        off = max(0, int(offset or 0))

        if grp == "ip":
            group_expr = "TRIM(COALESCE(t.window_ip, ''))"
        else:
            group_expr = """
            CASE
              WHEN TRIM(COALESCE(CAST(w.window_sort_num AS TEXT), '')) <> ''
                THEN TRIM(COALESCE(CAST(w.window_sort_num AS TEXT), '')) ||
                     CASE
                       WHEN TRIM(COALESCE(w.platform_account, '')) <> ''
                         THEN '-' || TRIM(COALESCE(w.platform_account, ''))
                       ELSE ''
                     END
              ELSE TRIM(COALESCE(w.platform_account, ''))
            END
            """

        bucket_start_expr_map = {
            "month": "strftime('%Y-%m-01 00:00:00', t.created_at)",
            "week": "datetime(date(t.created_at, '-' || ((CAST(strftime('%w', t.created_at) AS INTEGER) + 6) % 7) || ' days') || ' 00:00:00')",
            "day": "strftime('%Y-%m-%d 00:00:00', t.created_at)",
            "hour": "strftime('%Y-%m-%d %H:00:00', t.created_at)",
            "minute": "strftime('%Y-%m-%d %H:%M:00', t.created_at)",
        }
        bucket_label_expr_map = {
            "month": "strftime('%Y-%m', t.created_at)",
            "week": "strftime('%Y-W%W', t.created_at)",
            "day": "strftime('%Y-%m-%d', t.created_at)",
            "hour": "strftime('%m-%d %H:00', t.created_at)",
            "minute": "strftime('%m-%d %H:%M', t.created_at)",
        }
        bucket_start_expr = bucket_start_expr_map[bkt]
        bucket_label_expr = bucket_label_expr_map[bkt]

        where: List[str] = ["t.status IN ('completed','failed')"]
        params: List[Any] = []

        if task_type_code:
            where.append("t.task_type_code = ?")
            params.append(str(task_type_code).strip())
        if q:
            qq = f"%{str(q).strip()}%"
            where.append(f"({group_expr} LIKE ?)")
            params.append(qq)
        if start_at:
            where.append("t.created_at >= ?")
            params.append(str(start_at).strip())
        if end_at:
            where.append("t.created_at <= ?")
            params.append(str(end_at).strip())

        where_clause = " AND ".join(where)

        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row

            cur_total = await db.execute(
                f"""
                SELECT COUNT(*) AS c
                FROM (
                  SELECT {group_expr} AS group_key
                  FROM tasks t
                  LEFT JOIN windows w ON w.id = t.window_pk
                  WHERE {where_clause}
                  GROUP BY {group_expr}
                ) g
                """,
                params,
            )
            row_total = await cur_total.fetchone()
            total_groups = int((row_total["c"] if row_total and row_total["c"] is not None else 0) or 0)

            if grp == "ip":
                # IP 模式：关联 proxies 表获取代理创建时间/ID，与 task_types.html 代理下拉列表保持一致排序
                # （按 created_at DESC, proxy_id DESC，未匹配到代理的 IP 排在最后，最终兜底按 last_created_at DESC）
                groups_sql = f"""
                SELECT g.group_key, g.total_count, g.completed_count, g.failed_count, g.last_created_at
                FROM (
                  SELECT
                    {group_expr} AS group_key,
                    COUNT(*) AS total_count,
                    SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                    SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                    MAX(t.created_at) AS last_created_at
                  FROM tasks t
                  LEFT JOIN windows w ON w.id = t.window_pk
                  WHERE {where_clause}
                  GROUP BY {group_expr}
                ) g
                LEFT JOIN (
                  SELECT
                    TRIM(COALESCE(last_ip, '')) AS last_ip,
                    MAX(created_at) AS best_created_at,
                    MAX(proxy_id) AS best_proxy_id
                  FROM proxies
                  WHERE deleted = 0 AND TRIM(COALESCE(last_ip, '')) <> ''
                  GROUP BY TRIM(COALESCE(last_ip, ''))
                ) pr ON pr.last_ip = g.group_key
                ORDER BY pr.best_created_at DESC, pr.best_proxy_id DESC, g.last_created_at DESC
                LIMIT ? OFFSET ?
                """
            else:
                # 账号模式：按窗口号（window_sort_num）倒序排列，无窗口号的排在最后
                groups_sql = f"""
                SELECT
                  {group_expr} AS group_key,
                  COUNT(*) AS total_count,
                  SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                  SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                  MAX(t.created_at) AS last_created_at
                FROM tasks t
                LEFT JOIN windows w ON w.id = t.window_pk
                WHERE {where_clause}
                GROUP BY {group_expr}
                ORDER BY CAST(MAX(w.window_sort_num) AS INTEGER) DESC, last_created_at DESC
                LIMIT ? OFFSET ?
                """
            cur_groups = await db.execute(groups_sql, [*params, lim, off])
            groups_rows = await cur_groups.fetchall()
            groups = [dict(r) for r in groups_rows]

            group_values: List[str] = [str((r.get("group_key") if isinstance(r, dict) else "") or "") for r in groups]
            events: List[Dict[str, Any]] = []
            if group_values:
                placeholders = ",".join("?" for _ in group_values)
                cur_events = await db.execute(
                    f"""
                    SELECT
                      {group_expr} AS group_key,
                      {bucket_start_expr} AS bucket_start,
                      {bucket_label_expr} AS bucket_label,
                      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                      SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                      COUNT(*) AS total_count
                    FROM tasks t
                    LEFT JOIN windows w ON w.id = t.window_pk
                    WHERE {where_clause}
                      AND {group_expr} IN ({placeholders})
                    GROUP BY {group_expr}, {bucket_start_expr}, {bucket_label_expr}
                    ORDER BY bucket_start ASC
                    """,
                    [*params, *group_values],
                )
                events_rows = await cur_events.fetchall()
                events = [dict(r) for r in events_rows]

            return {
                "group_by": grp,
                "bucket": bkt,
                "total_groups": total_groups,
                "limit": lim,
                "offset": off,
                "groups": groups,
                "events": events,
            }

    async def list_task_timeline_items(
        self,
        group_by: str = "account",  # account | ip
        bucket: str = "day",  # month | week | day | hour | minute
        group_key: str = "",
        bucket_start: str = "",
        limit: int = 200,
        offset: int = 0,
        task_type_code: Optional[str] = None,
    ) -> Dict[str, Any]:
        """查询某个分组在某个时间桶内的任务明细（completed/failed）。"""

        grp = str(group_by or "account").strip().lower()
        if grp not in ("account", "ip"):
            grp = "account"
        bkt = str(bucket or "day").strip().lower()
        if bkt not in ("month", "week", "day", "hour", "minute"):
            bkt = "day"

        lim = max(1, min(500, int(limit or 200)))
        off = max(0, int(offset or 0))

        if grp == "ip":
            group_expr = "TRIM(COALESCE(t.window_ip, ''))"
        else:
            group_expr = """
            CASE
              WHEN TRIM(COALESCE(CAST(w.window_sort_num AS TEXT), '')) <> ''
                THEN TRIM(COALESCE(CAST(w.window_sort_num AS TEXT), '')) ||
                     CASE
                       WHEN TRIM(COALESCE(w.platform_account, '')) <> ''
                         THEN '-' || TRIM(COALESCE(w.platform_account, ''))
                       ELSE ''
                     END
              ELSE TRIM(COALESCE(w.platform_account, ''))
            END
            """

        bucket_start_expr_map = {
            "month": "strftime('%Y-%m-01 00:00:00', t.created_at)",
            "week": "datetime(date(t.created_at, '-' || ((CAST(strftime('%w', t.created_at) AS INTEGER) + 6) % 7) || ' days') || ' 00:00:00')",
            "day": "strftime('%Y-%m-%d 00:00:00', t.created_at)",
            "hour": "strftime('%Y-%m-%d %H:00:00', t.created_at)",
            "minute": "strftime('%Y-%m-%d %H:%M:00', t.created_at)",
        }
        bucket_start_expr = bucket_start_expr_map[bkt]

        where: List[str] = [
            "t.status IN ('completed','failed')",
            f"{group_expr} = ?",
            f"{bucket_start_expr} = ?",
        ]
        params: List[Any] = [str(group_key or "").strip(), str(bucket_start or "").strip()]
        if task_type_code:
            where.append("t.task_type_code = ?")
            params.append(str(task_type_code).strip())
        where_clause = " AND ".join(where)

        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row

            cur_total = await db.execute(
                f"""
                SELECT COUNT(*) AS c
                FROM tasks t
                LEFT JOIN windows w ON w.id = t.window_pk
                WHERE {where_clause}
                """,
                params,
            )
            row_total = await cur_total.fetchone()
            total = int((row_total["c"] if row_total and row_total["c"] is not None else 0) or 0)

            cur_items = await db.execute(
                f"""
                SELECT
                  t.task_id,
                  t.task_type_code,
                  t.generation_id,
                  t.status,
                  t.progress,
                  t.prompt,
                  t.window_pk,
                  t.window_ip,
                  w.platform_account AS window_account,
                  w.window_sort_num AS window_sort_num,
                  s.name AS space_name,
                  t.error_message,
                  t.result_json,
                  t.created_at
                FROM tasks t
                LEFT JOIN windows w ON w.id = t.window_pk
                LEFT JOIN spaces s ON s.id = w.space_pk
                WHERE {where_clause}
                ORDER BY t.created_at DESC, t.id DESC
                LIMIT ? OFFSET ?
                """,
                [*params, lim, off],
            )
            rows = await cur_items.fetchall()
            items = [dict(r) for r in rows]

            return {
                "group_by": grp,
                "bucket": bkt,
                "group_key": str(group_key or ""),
                "bucket_start": str(bucket_start or ""),
                "total": total,
                "limit": lim,
                "offset": off,
                "items": items,
            }

    async def update_task(
        self,
        task_id: str,
        status: Optional[str] = None,
        progress: Optional[int] = None,
        window_pk: Optional[int] = None,
        window_ip: Optional[str] = None,
        generation_id: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        error_message: Optional[str] = None,
        content_violation: Optional[int] = None,
        set_started: bool = False,
        set_completed: bool = False,
        touch_created_at: bool = False,
    ) -> None:
        updates: List[str] = []
        params: List[Any] = []

        if status is not None:
            updates.append("status=?")
            params.append(status)
        if progress is not None:
            updates.append("progress=?")
            params.append(int(progress))
        if window_pk is not None:
            updates.append("window_pk=?")
            params.append(int(window_pk))
        if window_ip is not None:
            updates.append("window_ip=?")
            params.append(str(window_ip).strip() if window_ip else None)
        if generation_id is not None:
            gid = str(generation_id).strip()
            updates.append("generation_id=?")
            params.append(gid if gid else None)
        if result is not None:
            updates.append("result_json=?")
            params.append(json.dumps(result, ensure_ascii=False))
        if error_message is not None:
            updates.append("error_message=?")
            params.append(error_message)
        if content_violation is not None:
            updates.append("content_violation=?")
            params.append(int(content_violation))
        if set_started:
            updates.append("started_at=datetime('now','localtime')")
        if set_completed:
            updates.append("completed_at=datetime('now','localtime')")
        if touch_created_at:
            updates.append("created_at=datetime('now','localtime')")

        updates.append("updated_at=datetime('now','localtime')")

        if not updates:
            return

        params.append(task_id.strip())
        sql = f"UPDATE tasks SET {', '.join(updates)} WHERE task_id=?"
        for attempt in range(5):
            try:
                async with self._write_conn() as db:
                    await db.execute(sql, params)
                    await db.commit()
                    return
            except Exception as e:
                if self._is_db_locked_error(e) and attempt < 4:
                    await asyncio.sleep(0.05 * (attempt + 1))
                    continue
                raise

    async def get_task_window_pk_by_generation_id(self, generation_id: str) -> Optional[int]:
        gid = str(generation_id or "").strip()
        if not gid:
            return None
        async with self._read_conn() as db:
            cur = await db.execute(
                """
                SELECT window_pk
                FROM tasks
                WHERE generation_id = ?
                  AND window_pk IS NOT NULL
                ORDER BY id DESC
                LIMIT 1
                """,
                (gid,),
            )
            row = await cur.fetchone()
            if not row:
                return None
            try:
                return int(row[0])
            except Exception:
                return None

    # ---------- mapping runtime updates (quota/errors/cooldown) ----------
    async def consume_mapping_quota(self, mapping_id: int, amount: int = 1) -> None:
        """扣减剩余额度（最低到 0）。"""
        amt = max(1, int(amount))
        for attempt in range(5):
            try:
                async with self._write_conn() as db:
                    await db.execute(
                        """
                        UPDATE task_type_windows
                        SET remaining_quota = CASE
                              WHEN remaining_quota >= ? THEN remaining_quota - ?
                              ELSE 0
                            END,
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                        """,
                        (amt, amt, int(mapping_id)),
                    )
                    await db.commit()
                    return
            except Exception as e:
                if self._is_db_locked_error(e) and attempt < 4:
                    await asyncio.sleep(0.05 * (attempt + 1))
                    continue
                raise

    async def mark_mapping_success(self, mapping_id: int) -> None:
        """一次成功：连续错误清零。"""
        for attempt in range(5):
            try:
                async with self._write_conn() as db:
                    await db.execute(
                        """
                        UPDATE task_type_windows
                        SET consecutive_errors = 0,
                            error_cooldown_until = datetime('now','localtime'),
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                        """,
                        (int(mapping_id),),
                    )
                    await db.commit()
                    return
            except Exception as e:
                if self._is_db_locked_error(e) and attempt < 4:
                    await asyncio.sleep(0.05 * (attempt + 1))
                    continue
                raise

    async def mark_mapping_error(
        self,
        mapping_id: int,
        threshold: int,
        cooldown_seconds: int = 7200,
        cooldown_seconds_short: int = 120,
        reset_on_threshold: bool = True,
    ) -> bool:
        """一次失败：累计错误；连续错误达阈值时进入长冷却（可选清零），否则短冷却。

        Returns:
            bool: 本次失败是否触发了连续错误阈值（即进入长冷却并清零连续错误）。
        """
        thr = max(1, int(threshold))
        cd = max(10, int(cooldown_seconds))
        cd_short = max(10, int(cooldown_seconds_short))
        modifier = f"+{cd} seconds"
        modifier_short = f"+{cd_short} seconds"
        for attempt in range(5):
            try:
                async with self._write_conn() as db:
                    cur = await db.execute(
                        "SELECT consecutive_errors FROM task_type_windows WHERE id = ?",
                        (int(mapping_id),),
                    )
                    row = await cur.fetchone()
                    await cur.close()
                    if row is None:
                        return False
                    prev_ce = int((row or [0])[0] or 0)
                    reached_threshold = (prev_ce + 1) >= thr
                    await db.execute(
                        """
                        UPDATE task_type_windows
                        SET total_errors = total_errors + 1,
                            consecutive_errors = CASE
                              WHEN (consecutive_errors + 1) >= ? AND ? = 1 THEN 0
                              ELSE consecutive_errors + 1
                            END,
                            error_cooldown_until = CASE
                              WHEN (consecutive_errors + 1) >= ? THEN datetime('now','localtime', ?)
                              ELSE datetime('now','localtime', ?)
                            END,
                            updated_at = datetime('now','localtime')
                        WHERE id = ?
                        """,
                        (thr, 1 if reset_on_threshold else 0, thr, modifier, modifier_short, int(mapping_id)),
                    )
                    await db.commit()
                    return reached_threshold
            except Exception as e:
                if self._is_db_locked_error(e) and attempt < 4:
                    await asyncio.sleep(0.05 * (attempt + 1))
                    continue
                raise
        return False

    async def get_mapping_runtime_state(self, mapping_id: int) -> Dict[str, Any]:
        """读取窗口映射运行态字段（连续错误/错误冷却等）。"""
        async with self._read_conn() as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                """
                SELECT
                  id,
                  consecutive_errors,
                  error_cooldown_until,
                  enabled,
                  remaining_quota,
                  cooldown_until,
                  updated_at
                FROM task_type_windows
                WHERE id = ?
                """,
                (int(mapping_id),),
            )
            row = await cur.fetchone()
            await cur.close()
            return dict(row) if row else {}
