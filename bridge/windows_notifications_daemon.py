#!/usr/bin/env python3
"""Long-running Windows toast notification daemon with TCP JSON IPC."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import importlib
import json
import logging
import signal
import threading
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional, Set


LOGGER = logging.getLogger("windows_notifications_daemon")


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
        self._notification_kind_toast = None
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

        if hasattr(UserNotificationListener, "get_current"):
            try:
                listener = UserNotificationListener.get_current()
                if listener is not None:
                    LOGGER.info(
                        "Resolved UserNotificationListener via get_current()."
                    )
                    return listener
            except Exception as error:
                attempts.append(f"get_current() failed: {error}")
        else:
            attempts.append("get_current() missing")

        if hasattr(UserNotificationListener, "current"):
            try:
                listener = UserNotificationListener.current
                if callable(listener):
                    listener = listener()
                if listener is not None:
                    LOGGER.info(
                        "Resolved UserNotificationListener via current accessor."
                    )
                    return listener
            except Exception as error:
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
        self._last_error = (
            "Unable to resolve UserNotificationListener. "
            "The installed WINRT binding appears incompatible "
            "(missing get_current/current/constructor APIs). "
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
            "notification_kinds.UserNotificationKinds",
            "notification_kinds.UserNotificationKind",
            "models.UserNotificationKinds",
            "models.UserNotificationKind",
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
                LOGGER.info(
                    "Resolved notification kinds enum via %s.%s",
                    module_name,
                    candidate_path,
                )
                return current_value, attempted_symbols
            except AttributeError:
                continue
            except Exception as error:
                attempted_symbols.append(
                    f"{candidate_path} raised {error.__class__.__name__}: {error}"
                )

        return None, attempted_symbols

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
                self._available = False
                self._last_error = (
                    "Unable to resolve WINRT notification kind enum type. "
                    "Tried symbols in winrt.windows.ui.notifications.management: "
                    f"{', '.join(attempted_symbols)}"
                )
                LOGGER.error(self._last_error)
                return

            self._notification_kind_toast = self._resolve_toast_notification_kind(
                notification_kinds_enum
            )
            if self._notification_kind_toast is None:
                self._available = False
                self._last_error = (
                    "Unable to resolve WINRT toast notification kind enum value. "
                    f"Enum type: {notification_kinds_enum}."
                )
                return

            access = await listener.request_access_async()
            status_name = getattr(access, "name", str(access))
            if status_name != "ALLOWED":
                self._available = True
                self._access_denied = True
                self._last_error = f"Notification access status is {status_name}."
                LOGGER.warning(self._last_error)
                return

            self._listener = listener
            self._available = True

            handler = TypedEventHandler[object, object](self._on_notification_changed)
            self._listener.add_notification_changed(handler)
            await self.refresh_snapshot()
            LOGGER.info("Notification collector ready.")
        except Exception as error:  # pragma: no cover - winrt runtime behavior
            self._available = False
            self._last_error = str(error)
            LOGGER.exception("Failed to initialize notification collector")

    def _resolve_toast_notification_kind(self, notification_kinds_enum):
        """Resolve enum member name differences across WINRT binding variants."""
        candidate_names = ("TOAST", "Toast")
        for member_name in candidate_names:
            try:
                kind = getattr(notification_kinds_enum, member_name)
                LOGGER.info(
                    "Resolved notification kind enum member for toast notifications via %s.",
                    member_name,
                )
                return kind
            except AttributeError:
                continue

        LOGGER.error(
            "Failed to resolve toast notification enum member on %s. "
            "Tried members: %s",
            notification_kinds_enum,
            ", ".join(candidate_names),
        )
        return None

    async def refresh_snapshot(self) -> None:
        if not self._listener:
            return
        if self._notification_kind_toast is None:
            LOGGER.error(
                "Cannot refresh notifications because toast notification kind enum is unresolved."
            )
            return
        try:
            raw_notifications = await self._listener.get_notifications_async(
                self._notification_kind_toast
            )
            mapped = [self._map_notification(item) for item in raw_notifications]
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
            title = None
            body = None

            for binding in bindings:
                texts = binding.get_text_elements()
                for index, text_item in enumerate(texts):
                    content = (text_item.text or "").strip()
                    if not content:
                        continue
                    if title is None:
                        title = content
                        continue
                    if body is None and index >= 1:
                        body = content
                        break
                if title and body:
                    break

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

    await bridge.run()
    return 0


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
