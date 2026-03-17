import asyncio
import json
import sys
import types
import typing
import unittest

from bridge.windows_notifications_daemon import NotificationCollector, TcpBridgeServer


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


class _FailingPushListener(_FakeListener):
    def add_notification_changed(self, handler):
        raise RuntimeError("push registration failed")


class _CollectorWithPushRegistrationFailure(NotificationCollector):
    def __init__(self, loop):
        super().__init__(loop)
        self.listener = _FailingPushListener()
        self.refresh_calls = 0

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
        self.refresh_calls += 1
        return None


class _CollectorWithActivePush(NotificationCollector):
    def __init__(self, loop):
        super().__init__(loop)
        self._push_subscription_active = True


class _FakeTextElement:
    def __init__(self, text):
        self.text = text


class _FakeBindingWithTextElements:
    def __init__(self, *texts):
        self._texts = [_FakeTextElement(value) for value in texts]

    def get_text_elements(self):
        return list(self._texts)


class _FakeVisualShapeA:
    def __init__(self, *bindings):
        self._bindings = list(bindings)

    def get_bindings(self):
        return list(self._bindings)


class _FakeBindingForShapeB:
    def __init__(self, *texts):
        self.texts = [_FakeTextElement(value) for value in texts]


class _FakeVisualShapeB:
    def __init__(self, binding):
        self.binding = binding

    def get_binding(self, _binding_key):
        return self.binding


class _FakeNotificationPayload:
    def __init__(self, visual):
        self.visual = visual


class _FakeItem:
    def __init__(self, visual):
        self.notification = _FakeNotificationPayload(visual)
        self.creation_time = None
        self.app_info = None


class _SnapshotListener:
    def __init__(self, notifications):
        self._notifications = notifications

    async def get_notifications_async(self, _kind):
        return list(self._notifications)


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

    async def test_push_registration_failed_read_still_works(self):
        collector = _CollectorWithPushRegistrationFailure(asyncio.get_running_loop())

        await collector.start()

        self.assertTrue(collector._available)
        self.assertTrue(collector._started)
        self.assertFalse(collector.is_push_subscription_active())
        self.assertEqual(collector.refresh_calls, 1)

        payload = collector.read()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["notifications"], [])

        bridge = TcpBridgeServer("127.0.0.1", 8765, collector)
        response = bridge._handle_message(
            json.dumps({"id": "1", "type": "subscribe_notifications"}).encode(
                "utf-8"
            ),
            object(),
        )
        self.assertIsNotNone(response)
        self.assertTrue(response["ok"])
        self.assertFalse(response["pushActive"])
        self.assertIn("fallback mode", response["message"])

    async def test_subscribe_notifications_reports_push_active_when_listener_is_live(self):
        collector = _CollectorWithActivePush(asyncio.get_running_loop())
        bridge = TcpBridgeServer("127.0.0.1", 8765, collector)

        response = bridge._handle_message(
            json.dumps({"id": "2", "type": "subscribe_notifications"}).encode("utf-8"),
            object(),
        )

        self.assertIsNotNone(response)
        self.assertTrue(response["ok"])
        self.assertTrue(response["pushActive"])
        self.assertIn("push events", response["message"])

    async def test_map_notification_supports_visual_shape_a(self):
        collector = NotificationCollector(asyncio.get_running_loop())
        item = _FakeItem(
            _FakeVisualShapeA(_FakeBindingWithTextElements("Title A", "Body A"))
        )

        mapped = collector._map_notification(item)

        self.assertIsNotNone(mapped)
        self.assertEqual(mapped.title, "Title A")
        self.assertEqual(mapped.body, "Body A")

    async def test_map_notification_supports_visual_shape_b(self):
        collector = NotificationCollector(asyncio.get_running_loop())
        item = _FakeItem(_FakeVisualShapeB(_FakeBindingForShapeB("Title B", "Body B")))

        mapped = collector._map_notification(item)

        self.assertIsNotNone(mapped)
        self.assertEqual(mapped.title, "Title B")
        self.assertEqual(mapped.body, "Body B")

    async def test_map_notification_without_binding_api_returns_record_without_text(self):
        collector = NotificationCollector(asyncio.get_running_loop())
        item = _FakeItem(object())

        mapped = collector._map_notification(item)

        self.assertIsNotNone(mapped)
        self.assertIsNone(mapped.title)
        self.assertIsNone(mapped.body)

    async def test_refresh_snapshot_preserves_shape_b_items_in_cache(self):
        collector = NotificationCollector(asyncio.get_running_loop())
        collector._listener = _SnapshotListener(
            [
                _FakeItem(
                    _FakeVisualShapeB(_FakeBindingForShapeB("Title B1", "Body B1"))
                ),
                _FakeItem(
                    _FakeVisualShapeB(_FakeBindingForShapeB("Title B2", "Body B2"))
                ),
            ]
        )
        collector._notification_kind_toast = 1

        await collector.refresh_snapshot()

        with collector._lock:
            cache_snapshot = list(collector._cache)

        self.assertEqual(len(cache_snapshot), 2)
        self.assertEqual(cache_snapshot[0].title, "Title B1")
        self.assertEqual(cache_snapshot[0].body, "Body B1")
        self.assertEqual(cache_snapshot[1].title, "Title B2")
        self.assertEqual(cache_snapshot[1].body, "Body B2")


if __name__ == "__main__":
    unittest.main()
