import sys
import types
import typing
import unittest

from bridge.windows_notifications_daemon import NotificationCollector


class _AllowedStatus:
    name = "ALLOWED"


class _FakeListener:
    def __init__(self):
        self.added_handlers = []

    async def request_access_async(self):
        return _AllowedStatus()

    def add_notification_changed(self, handler):
        self.added_handlers.append(handler)

    def remove_notification_changed(self, handler):
        pass


class _CollectorWithTypingCandidate(NotificationCollector):
    def __init__(self, loop):
        super().__init__(loop)
        self.listener = _FakeListener()

    def _resolve_typed_event_handler_class(self):
        return (
            None,
            typing.Callable,
            {
                "candidate_kind": "non-runtime",
                "candidate_source": "test.typing.Callable",
                "candidate_shape": str(typing.Callable),
            },
            ["test candidate: typing.Callable"],
        )

    def _resolve_listener(self, _):
        return self.listener

    def _resolve_notification_kinds_enum(self):
        return None, ["test enum fallback"]

    async def refresh_snapshot(self):
        return None


class NotificationCollectorFallbackTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._modules_backup = {
            name: sys.modules.get(name)
            for name in (
                "winrt",
                "winrt.windows",
                "winrt.windows.ui",
                "winrt.windows.ui.notifications",
                "winrt.windows.ui.notifications.management",
            )
        }

        winrt = types.ModuleType("winrt")
        windows = types.ModuleType("winrt.windows")
        ui = types.ModuleType("winrt.windows.ui")
        notifications = types.ModuleType("winrt.windows.ui.notifications")
        management = types.ModuleType("winrt.windows.ui.notifications.management")

        class UserNotificationListener:
            pass

        management.UserNotificationListener = UserNotificationListener

        sys.modules["winrt"] = winrt
        sys.modules["winrt.windows"] = windows
        sys.modules["winrt.windows.ui"] = ui
        sys.modules["winrt.windows.ui.notifications"] = notifications
        sys.modules["winrt.windows.ui.notifications.management"] = management

    def tearDown(self):
        for name, value in self._modules_backup.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value

    async def test_start_registers_direct_callable_when_typed_candidate_is_typing(self):
        import asyncio

        collector = _CollectorWithTypingCandidate(asyncio.get_running_loop())

        await collector.start()

        self.assertTrue(collector._started)
        self.assertIsNotNone(collector._notification_changed_handler)
        self.assertEqual(len(collector.listener.added_handlers), 1)
        self.assertIs(
            collector.listener.added_handlers[0],
            collector._notification_changed_handler,
        )
        self.assertTrue(callable(collector._notification_changed_handler))


if __name__ == "__main__":
    unittest.main()
