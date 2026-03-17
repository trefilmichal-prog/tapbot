#!/usr/bin/env python3
"""Long-running Windows toast notification daemon with TCP JSON IPC."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import enum
import inspect
import importlib
import json
import logging
import signal
import threading
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional, Set


LOGGER = logging.getLogger("windows_notifications_daemon")


def _truncate_for_log(value: Optional[str], max_length: int = 120) -> Optional[str]:
    if value is None:
        return None
    if len(value) <= max_length:
        return value
    return f"{value[: max_length - 1]}…"


@dataclass
class NotificationRecord:
    timestamp: Optional[str]
    title: Optional[str]
    body: Optional[str]
    app: Optional[str]

    def to_json(self) -> Dict[str, Optional[str]]:
        return {
            "type": "notification",
            "timestamp": self.timestamp,
            "title": self.title,
            "body": self.body,
            "app": self.app,
        }


class NotificationCollector:
    """Event-driven collector that stores latest toast snapshot."""

    def __init__(self, loop: asyncio.AbstractEventLoop, max_cache: int = 200) -> None:
        self.loop = loop
        self.max_cache = max_cache
        self._cache: List[NotificationRecord] = []
        self._lock = threading.Lock()
        self._listener = None
        self._notification_changed_handler = None
        self._notification_kind_toast = None
        self._notification_kind_source = None
        self._started = False
        self._available = False
        self._access_denied = False
        self._last_error = None
        self._snapshot_callback: Optional[
            Callable[[List[Dict[str, Optional[str]]]], Optional[Awaitable[None]]]
        ] = None

    def set_snapshot_callback(
        self,
        callback: Callable[[List[Dict[str, Optional[str]]]], Optional[Awaitable[None]]],
    ) -> None:
        self._snapshot_callback = callback

    def _resolve_listener(self, UserNotificationListener):
        """Resolve listener instance across WINRT binding API variants."""
        attempts = []
        get_current_failed = False
        current_failed = False

        def _is_incompatible_callable_shape(candidate) -> bool:
            """Guard against typing/projection artifacts masquerading as accessors."""
            candidate_name = getattr(candidate, "__name__", "") or ""
            candidate_module = getattr(candidate, "__module__", "") or ""
            candidate_type = type(candidate)
            candidate_type_name = getattr(candidate_type, "__name__", "") or ""
            candidate_type_module = getattr(candidate_type, "__module__", "") or ""
            joined = " ".join(
                part.lower()
                for part in (
                    candidate_name,
                    candidate_module,
                    candidate_type_name,
                    candidate_type_module,
                )
            )
            return "typing" in joined or "projection" in joined

        def _has_accessor_metadata(candidate) -> bool:
            doc = (getattr(candidate, "__doc__", "") or "").lower()
            # WINRT projection layers sometimes expose accessor semantics only in docs.
            return "accessor" in doc or "property" in doc or "get current" in doc

        def _can_invoke_current(candidate) -> bool:
            if _is_incompatible_callable_shape(candidate):
                attempts.append(
                    "current detected incompatible binding shape "
                    "(typing/projection callable artifact); not invoking"
                )
                return False

            if inspect.ismethod(candidate):
                return True

            if inspect.isfunction(candidate) and getattr(
                candidate, "__qualname__", ""
            ).startswith(f"{UserNotificationListener.__name__}."):
                return True

            if _has_accessor_metadata(candidate):
                attempts.append(
                    "current callable has accessor metadata; invoking as method"
                )
                return True

            attempts.append(
                "current present but callable shape is not listener-bound accessor; "
                "treating as property value"
            )
            return False

        if hasattr(UserNotificationListener, "get_current"):
            try:
                listener = UserNotificationListener.get_current()
                if listener is not None:
                    LOGGER.info(
                        "Resolved UserNotificationListener via get_current()."
                    )
                    return listener
            except Exception as error:
                get_current_failed = True
                attempts.append(f"get_current() failed: {error}")
        else:
            attempts.append("get_current() missing")

        if hasattr(UserNotificationListener, "current"):
            try:
                listener = UserNotificationListener.current
                if callable(listener) and _can_invoke_current(listener):
                    listener = listener()
                if listener is not None:
                    LOGGER.info(
                        "Resolved UserNotificationListener via current accessor."
                    )
                    return listener
                current_failed = True
                attempts.append("current returned None")
            except Exception as error:
                current_failed = True
                attempts.append(f"current failed: {error}")
        else:
            attempts.append("current missing")

        can_construct = False
        try:
            doc_text = (UserNotificationListener.__doc__ or "").lower()
            can_construct = (
                "constructor" in doc_text
                or "create an instance" in doc_text
                or "usernotificationlistener()" in doc_text
            )
        except Exception:
            can_construct = False

        if can_construct:
            try:
                listener = UserNotificationListener()
                if listener is not None:
                    LOGGER.info(
                        "Resolved UserNotificationListener via constructor()."
                    )
                    return listener
            except Exception as error:
                attempts.append(f"constructor() failed: {error}")
        else:
            attempts.append("constructor unavailable per binding docs")

        self._available = False
        if get_current_failed or current_failed:
            failure_mode = (
                "runtime access-denied/permission issue likely"
                if self._access_denied
                else "incompatible binding shape or runtime accessor failure"
            )
        else:
            failure_mode = "incompatible binding shape"
        self._last_error = (
            "Unable to resolve UserNotificationListener. "
            "The installed WINRT binding appears incompatible "
            "(missing get_current/current/constructor APIs). "
            f"Failure mode: {failure_mode}. "
            f"Details: {'; '.join(attempts)}"
        )
        LOGGER.error(self._last_error)
        return None

    def _resolve_notification_kinds_enum(self):
        """Resolve enum class used to filter toast notifications across binding variants."""
        module_name = "winrt.windows.ui.notifications.management"
        attempted_symbols: List[str] = []
        candidate_paths = (
            "UserNotificationKinds",
            "UserNotificationKind",
            "NotificationKinds",
            "NotificationKind",
            "notification_kinds",
            "notification_kinds.NotificationKinds",
            "notification_kinds.NotificationKind",
            "notification_kinds.UserNotificationKinds",
            "notification_kinds.UserNotificationKind",
            "models.notification_kinds",
            "models.NotificationKinds",
            "models.NotificationKind",
            "models.UserNotificationKinds",
            "models.UserNotificationKind",
            "user_notification_kinds",
            "user_notification_kinds.UserNotificationKinds",
            "user_notification_kinds.UserNotificationKind",
            "user_notification_kinds.NotificationKinds",
            "user_notification_kinds.NotificationKind",
            "models.user_notification_kinds",
            "models.user_notification_kinds.UserNotificationKinds",
            "models.user_notification_kinds.UserNotificationKind",
            "models.user_notification_kinds.NotificationKinds",
            "models.user_notification_kinds.NotificationKind",
        )

        def candidate_name_and_type(candidate):
            candidate_name = getattr(candidate, "__qualname__", None) or getattr(
                candidate, "__name__", None
            )
            if not candidate_name:
                candidate_name = repr(candidate)
            return candidate_name, type(candidate).__name__

        def has_toast_member(enum_candidate) -> bool:
            for member_name in ("TOAST", "Toast"):
                try:
                    if hasattr(enum_candidate, member_name):
                        return True
                except Exception:
                    continue
            return False

        def matches_notification_kind_shape(enum_candidate) -> bool:
            enum_name = (
                getattr(enum_candidate, "__qualname__", None)
                or getattr(enum_candidate, "__name__", "")
            ).lower()
            if "notification" not in enum_name or "kind" not in enum_name:
                return False

            try:
                member_names = {member.name.upper() for member in enum_candidate}
            except Exception:
                member_names = {
                    name.upper()
                    for name in dir(enum_candidate)
                    if not name.startswith("_")
                }

            expected_markers = {"TOAST", "TILE", "BADGE", "RAW"}
            return bool(member_names & expected_markers)

        def is_valid_notification_kinds_enum(enum_candidate) -> bool:
            return has_toast_member(enum_candidate) or matches_notification_kind_shape(
                enum_candidate
            )

        def as_enum_holder(candidate):
            candidate_name, candidate_type = candidate_name_and_type(candidate)

            if isinstance(candidate, enum.EnumMeta):
                if is_valid_notification_kinds_enum(candidate):
                    return candidate, None
                return (
                    None,
                    f"rejected enum {candidate_name} ({candidate_type}); missing toast-kind signal",
                )

            if hasattr(candidate, "__dict__"):
                nested_rejections = []
                for nested_name, value in vars(candidate).items():
                    if not isinstance(value, enum.EnumMeta):
                        continue
                    if is_valid_notification_kinds_enum(value):
                        return value, None
                    nested_enum_name, nested_enum_type = candidate_name_and_type(value)
                    nested_rejections.append(
                        f"nested enum {nested_enum_name} ({nested_enum_type}) missing toast-kind signal"
                    )
                if nested_rejections:
                    return (
                        None,
                        f"rejected {candidate_name} ({candidate_type}); "
                        + "; ".join(nested_rejections),
                    )

            return (
                None,
                f"rejected {candidate_name} ({candidate_type}); not an enum holder for notification kinds",
            )

        try:
            management_module = importlib.import_module(module_name)
        except Exception as error:
            attempted_symbols.append(f"{module_name} import failed: {error}")
            return None, attempted_symbols

        for candidate_path in candidate_paths:
            attempted_symbols.append(candidate_path)
            current_value = management_module
            try:
                for attribute in candidate_path.split("."):
                    current_value = getattr(current_value, attribute)
                resolved, rejection_reason = as_enum_holder(current_value)
                if resolved is None:
                    attempted_symbols.append(
                        f"{candidate_path} rejected: {rejection_reason}"
                    )
                    continue

                LOGGER.info(
                    "Resolved notification kinds enum via explicit path %s.%s",
                    module_name,
                    candidate_path,
                )
                return resolved, attempted_symbols
            except AttributeError:
                continue
            except Exception as error:
                attempted_symbols.append(
                    f"{candidate_path} raised {error.__class__.__name__}: {error}"
                )

        fallback_roots = ["<management module>"]
        fallback_candidates = [management_module]
        for branch_name in ("models", "notification_kinds", "user_notification_kinds"):
            branch = getattr(management_module, branch_name, None)
            if branch is not None:
                fallback_roots.append(branch_name)
                fallback_candidates.append(branch)

        for root_name, root_value in zip(fallback_roots, fallback_candidates):
            attempted_symbols.append(f"fallback:{root_name}")
            try:
                attributes = vars(root_value).items()
            except Exception as error:
                attempted_symbols.append(
                    f"fallback:{root_name} vars() failed: {error.__class__.__name__}: {error}"
                )
                continue

            for attribute_name, attribute_value in attributes:
                if attribute_name.startswith("_"):
                    continue

                resolved, rejection_reason = as_enum_holder(attribute_value)
                if resolved is None:
                    candidate_name, candidate_type = candidate_name_and_type(
                        attribute_value
                    )
                    attempted_symbols.append(
                        "fallback:%s.%s rejected %s (%s): %s"
                        % (
                            root_name,
                            attribute_name,
                            candidate_name,
                            candidate_type,
                            rejection_reason,
                        )
                    )
                    continue

                LOGGER.info(
                    "Resolved notification kinds enum via fallback scan %s.%s",
                    root_name,
                    attribute_name,
                )
                return resolved, attempted_symbols

        return None, attempted_symbols

    def _build_notification_changed_handler(self, TypedEventHandler):
        """Build notification change delegate across projection variants."""
        callback = self._on_notification_changed
        attempts: List[str] = []

        def _shape_info(candidate) -> str:
            candidate_module = getattr(candidate, "__module__", "") or ""
            candidate_name = (
                getattr(candidate, "__qualname__", None)
                or getattr(candidate, "__name__", None)
                or repr(candidate)
            )
            candidate_type = type(candidate)
            candidate_type_module = (
                getattr(candidate_type, "__module__", "") or ""
            )
            candidate_type_name = getattr(candidate_type, "__name__", "") or ""
            return (
                f"module={candidate_module!r}, name={candidate_name!r}, "
                f"type={candidate_type_module}.{candidate_type_name}"
            )

        def _looks_like_typing_artifact(candidate) -> bool:
            details = " ".join(
                (
                    getattr(candidate, "__module__", "") or "",
                    getattr(candidate, "__qualname__", "") or "",
                    getattr(candidate, "__name__", "") or "",
                    getattr(type(candidate), "__module__", "") or "",
                    getattr(type(candidate), "__name__", "") or "",
                    repr(candidate),
                )
            ).lower()
            return any(
                marker in details
                for marker in (
                    "typing",
                    "types.genericalias",
                    "_genericalias",
                    "types.uniontype",
                    "projection",
                )
            )

        if _looks_like_typing_artifact(TypedEventHandler):
            LOGGER.debug(
                "Skipping direct TypedEventHandler(callback) construction due to typing/proxy artifact: %s",
                _shape_info(TypedEventHandler),
            )
        elif not inspect.isclass(TypedEventHandler):
            LOGGER.debug(
                "Skipping direct TypedEventHandler(callback) construction because candidate is not a class: %s",
                _shape_info(TypedEventHandler),
            )
        else:
            try:
                handler = TypedEventHandler(callback)
                LOGGER.info(
                    "Constructed notification changed handler via TypedEventHandler(callback)."
                )
                return handler
            except Exception as error:
                attempts.append(
                    "direct constructor failed "
                    f"({error.__class__.__name__}: {error})"
                )
                LOGGER.debug(
                    "TypedEventHandler(callback) construction failed; trying generic-indexed form. %s: %s",
                    error.__class__.__name__,
                    error,
                    exc_info=True,
                )

        runtime_delegate_class = None
        generic_index_candidate = None
        try:
            generic_index_candidate = TypedEventHandler[object, object]
            LOGGER.debug(
                "Resolved generic-indexed TypedEventHandler candidate: %s",
                _shape_info(generic_index_candidate),
            )
        except Exception as error:
            attempts.append(
                "generic indexing failed "
                f"({error.__class__.__name__}: {error})"
            )
            LOGGER.debug(
                "TypedEventHandler generic indexing failed. %s: %s",
                error.__class__.__name__,
                error,
                exc_info=True,
            )

        if generic_index_candidate is not None:
            if _looks_like_typing_artifact(generic_index_candidate):
                LOGGER.debug(
                    "Skipping generic-indexed candidate due to typing/proxy artifact: %s",
                    _shape_info(generic_index_candidate),
                )
                origin = getattr(generic_index_candidate, "__origin__", None)
                if inspect.isclass(origin) and not _looks_like_typing_artifact(origin):
                    runtime_delegate_class = origin
                    LOGGER.debug(
                        "Resolved runtime delegate class from generic __origin__: %s",
                        _shape_info(runtime_delegate_class),
                    )
                else:
                    LOGGER.debug(
                        "Unable to resolve runtime delegate class from generic __origin__. origin=%s",
                        _shape_info(origin) if origin is not None else "None",
                    )
            elif inspect.isclass(generic_index_candidate):
                runtime_delegate_class = generic_index_candidate
            else:
                LOGGER.debug(
                    "Generic-indexed candidate is not a class and will be skipped: %s",
                    _shape_info(generic_index_candidate),
                )

        if runtime_delegate_class is not None:
            try:
                handler = runtime_delegate_class(callback)
                LOGGER.info(
                    "Constructed notification changed handler via resolved runtime delegate class."
                )
                return handler
            except Exception as error:
                attempts.append(
                    "runtime delegate constructor failed "
                    f"({error.__class__.__name__}: {error})"
                )
                LOGGER.debug(
                    "Resolved runtime delegate class construction failed. %s: %s",
                    error.__class__.__name__,
                    error,
                    exc_info=True,
                )

        raise RuntimeError(
            "Unable to construct notification changed handler from concrete TypedEventHandler delegate forms. "
            f"Candidate: {_shape_info(TypedEventHandler)}. Attempts: {'; '.join(attempts) or 'none'}"
        )

    async def start(self) -> None:
        if self._started:
            return

        self._started = True
        try:
            from winrt.windows.foundation import TypedEventHandler
            from winrt.windows.ui.notifications.management import UserNotificationListener
        except Exception as error:  # pragma: no cover - runtime dependency
            self._available = False
            self._last_error = f"WINRT imports failed: {error}"
            LOGGER.exception("Unable to import WINRT APIs")
            return

        try:
            listener = self._resolve_listener(UserNotificationListener)
            if listener is None:
                return

            notification_kinds_enum, attempted_symbols = (
                self._resolve_notification_kinds_enum()
            )
            if notification_kinds_enum is None:
                self._notification_kind_toast = 1
                self._notification_kind_source = "numeric-fallback"
                LOGGER.warning(
                    "Notification kind enum resolution failed; numeric fallback used for toast kind bit (1). "
                    "Tried symbols in winrt.windows.ui.notifications.management: %s",
                    ", ".join(attempted_symbols),
                )
            else:
                (
                    self._notification_kind_toast,
                    self._notification_kind_source,
                ) = self._resolve_toast_notification_kind(notification_kinds_enum)

            if self._notification_kind_source == "enum":
                LOGGER.info("Notification kind enum resolved and used for toast filtering.")
            else:
                LOGGER.info("Notification kind numeric fallback used for toast filtering.")

            access = await listener.request_access_async()
            raw_status_name = getattr(access, "name", str(access))
            normalized_status_name = str(raw_status_name).strip().upper()
            accepted_statuses = {"ALLOWED"}
            if normalized_status_name not in accepted_statuses:
                self._available = True
                self._access_denied = True
                self._last_error = (
                    "Notification access denied "
                    f"(raw status: {raw_status_name!r}, normalized status: {normalized_status_name!r})."
                )
                LOGGER.warning(self._last_error)
                return

            self._listener = listener
            self._available = True

            try:
                self._notification_changed_handler = (
                    self._build_notification_changed_handler(TypedEventHandler)
                )
            except Exception as error:
                self._last_error = f"Failed to construct notification changed delegate: {error}"
                LOGGER.exception(
                    "Notification changed delegate construction failed; listener not registered."
                )
                return

            try:
                self._listener.add_notification_changed(
                    self._notification_changed_handler
                )
            except Exception as error:
                self._last_error = (
                    f"Failed to register notification changed listener: {error}"
                )
                LOGGER.exception(
                    "Notification changed listener registration failed after delegate construction."
                )
                self._notification_changed_handler = None
                return

            LOGGER.info(
                "Notification changed handler registered and active (strong reference retained)."
            )
            await self.refresh_snapshot()
            LOGGER.info("Notification collector ready.")
        except Exception as error:  # pragma: no cover - winrt runtime behavior
            self._available = False
            self._last_error = str(error)
            LOGGER.exception("Failed to initialize notification collector")

    async def stop(self) -> None:
        if not self._started:
            return

        if self._listener and self._notification_changed_handler:
            try:
                self._listener.remove_notification_changed(
                    self._notification_changed_handler
                )
                LOGGER.info("Notification changed handler unregistered.")
            except Exception:
                LOGGER.exception("Failed to unregister notification changed handler")

        self._notification_changed_handler = None
        self._listener = None
        self._started = False

    def _resolve_toast_notification_kind(self, notification_kinds_enum):
        """Resolve enum member name differences across WINRT binding variants."""
        candidate_names = ("TOAST", "Toast")
        for member_name in candidate_names:
            try:
                kind = getattr(notification_kinds_enum, member_name)
                LOGGER.info(
                    "Resolved notification kind enum member for toast notifications via %s (enum resolved).",
                    member_name,
                )
                return kind, "enum"
            except AttributeError:
                continue

        LOGGER.error(
            "Failed to resolve toast notification enum member on %s. "
            "Tried members: %s",
            notification_kinds_enum,
            ", ".join(candidate_names),
        )
        LOGGER.warning(
            "Toast enum symbol unresolved; numeric fallback used for toast kind bit (1)."
        )
        return 1, "numeric-fallback"

    async def refresh_snapshot(self) -> None:
        if not self._listener:
            return
        if self._notification_kind_toast is None:
            LOGGER.error(
                "Cannot refresh notifications because toast notification kind enum is unresolved."
            )
            return
        try:
            try:
                raw_notifications = await self._listener.get_notifications_async(
                    self._notification_kind_toast
                )
            except (TypeError, ValueError):
                if self._notification_kind_toast == 1:
                    raise
                LOGGER.warning(
                    "get_notifications_async rejected enum toast kind; numeric fallback used for toast kind bit (1)."
                )
                self._notification_kind_toast = 1
                self._notification_kind_source = "numeric-fallback"
                raw_notifications = await self._listener.get_notifications_async(1)

            LOGGER.info(
                "Received notifications snapshot: %d items",
                len(raw_notifications),
            )
            mapped = [self._map_notification(item) for item in raw_notifications]
            LOGGER.info("Mapped notifications snapshot: %d items", len(mapped))

            if LOGGER.isEnabledFor(logging.DEBUG) and mapped:
                debug_preview = []
                for item in mapped[:3]:
                    if item is None:
                        continue
                    debug_preview.append(
                        {
                            "title": _truncate_for_log(item.title, max_length=80),
                            "body": _truncate_for_log(item.body, max_length=80),
                            "app": _truncate_for_log(item.app, max_length=60),
                            "timestamp": item.timestamp,
                        }
                    )
                    if len(debug_preview) >= 3:
                        break
                if debug_preview:
                    LOGGER.debug(
                        "Notifications preview (up to 3 items): %s", debug_preview
                    )

            cleaned = [item for item in mapped if item is not None]
            cleaned.sort(key=lambda item: item.timestamp or "", reverse=True)
            with self._lock:
                self._cache = cleaned[: self.max_cache]

            if self._snapshot_callback:
                payload = [item.to_json() for item in self._cache]
                callback_result = self._snapshot_callback(payload)
                if asyncio.iscoroutine(callback_result):
                    await callback_result
        except Exception:
            LOGGER.exception("Failed to refresh notification snapshot")

    def _on_notification_changed(self, _sender, _args) -> None:
        self.loop.call_soon_threadsafe(asyncio.create_task, self.refresh_snapshot())

    def _map_notification(self, item) -> Optional[NotificationRecord]:
        try:
            visual = item.notification.visual
            bindings = visual.get_bindings()
            collected_texts: List[str] = []

            for binding in bindings:
                texts = binding.get_text_elements()
                for text_item in texts:
                    content = (text_item.text or "").strip()
                    if not content:
                        continue
                    collected_texts.append(content)

            title = collected_texts[0] if len(collected_texts) >= 1 else None
            body = collected_texts[1] if len(collected_texts) >= 2 else None

            timestamp = None
            if item.creation_time:
                timestamp = item.creation_time.strftime("%Y-%m-%dT%H:%M:%S.%fZ")

            app = None
            try:
                app_info = item.app_info
                app = (app_info.display_info.display_name or "").strip() or None
            except Exception:
                app = None

            return NotificationRecord(timestamp=timestamp, title=title, body=body, app=app)
        except Exception:
            LOGGER.exception("Unable to map notification")
            return None

    def read(self) -> Dict[str, object]:
        if not self._available:
            return {
                "ok": False,
                "errorCode": "API_UNAVAILABLE",
                "message": self._last_error or "WINRT notification APIs are unavailable.",
                "notifications": [],
            }

        if self._access_denied:
            return {
                "ok": False,
                "errorCode": "ACCESS_DENIED",
                "message": self._last_error or "Notification access denied.",
                "notifications": [],
            }

        with self._lock:
            payload = [item.to_json() for item in self._cache]

        return {
            "ok": True,
            "errorCode": None,
            "message": None,
            "notifications": payload,
        }


class TcpBridgeServer:
    def __init__(self, host: str, port: int, collector: NotificationCollector) -> None:
        self.host = host
        self.port = port
        self.collector = collector
        self._subscribers: Set[asyncio.StreamWriter] = set()

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        LOGGER.info("Client connected: %s", peer)
        try:
            while not reader.at_eof():
                line = await reader.readline()
                if not line:
                    break

                response = self._handle_message(line, writer)
                if response is not None:
                    sent = await self._send_json(writer, response)
                    if not sent:
                        break
        except Exception:
            LOGGER.exception("Client connection failed")
        finally:
            self._subscribers.discard(writer)
            writer.close()
            await writer.wait_closed()
            LOGGER.info("Client disconnected: %s", peer)

    async def _send_json(self, writer: asyncio.StreamWriter, payload: Dict[str, object]) -> bool:
        try:
            writer.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
            await writer.drain()
            return True
        except Exception:
            self._subscribers.discard(writer)
            LOGGER.exception("Failed to write response/event to subscriber")
            return False

    def _handle_message(
        self, raw: bytes, writer: asyncio.StreamWriter
    ) -> Optional[Dict[str, object]]:
        try:
            message = json.loads(raw.decode("utf-8"))
            request_id = message.get("id")
            message_type = message.get("type")
            if message_type == "ping":
                return {"id": request_id, "ok": True, "type": "pong"}
            if message_type == "read_notifications":
                payload = self.collector.read()
                payload["id"] = request_id
                return payload
            if message_type == "subscribe_notifications":
                self._subscribers.add(writer)
                return {
                    "id": request_id,
                    "ok": True,
                    "message": "Subscribed to notifications push events.",
                }
            return {
                "id": request_id,
                "ok": False,
                "errorCode": "READ_FAILED",
                "message": f"Unknown request type: {message_type}",
                "notifications": [],
            }
        except Exception as error:
            return {
                "id": None,
                "ok": False,
                "errorCode": "READ_FAILED",
                "message": f"Invalid JSON request: {error}",
                "notifications": [],
            }

    async def broadcast_notifications(
        self, notifications: List[Dict[str, Optional[str]]]
    ) -> None:
        LOGGER.info(
            "Broadcasting notifications snapshot: %d items to %d subscribers",
            len(notifications),
            len(self._subscribers),
        )
        if not self._subscribers:
            return

        frame: Dict[str, object] = {
            "type": "notifications",
            "notifications": notifications,
        }
        dead_subscribers: List[asyncio.StreamWriter] = []
        for subscriber in self._subscribers:
            sent = await self._send_json(subscriber, frame)
            if not sent:
                dead_subscribers.append(subscriber)

        for subscriber in dead_subscribers:
            self._subscribers.discard(subscriber)

    async def run(self) -> None:
        server = await asyncio.start_server(self.handle_client, self.host, self.port)
        addresses = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
        LOGGER.info("IPC server listening on %s", addresses)
        async with server:
            await server.serve_forever()


async def async_main(host: str, port: int) -> int:
    loop = asyncio.get_running_loop()
    collector = NotificationCollector(loop=loop)
    bridge = TcpBridgeServer(host=host, port=port, collector=collector)
    collector.set_snapshot_callback(bridge.broadcast_notifications)
    await collector.start()

    try:
        await bridge.run()
        return 0
    finally:
        await collector.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Windows notifications daemon")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if hasattr(signal, "SIGINT"):
        signal.signal(signal.SIGINT, signal.SIG_DFL)

    try:
        return asyncio.run(async_main(args.host, args.port))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
