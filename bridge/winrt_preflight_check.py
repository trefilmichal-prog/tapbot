#!/usr/bin/env python3
"""Preflight checks for Windows notification daemon WINRT dependencies."""

from __future__ import annotations

import importlib
import sys


def main() -> int:
    missing: list[str] = []

    try:
        from winrt.windows.foundation import TypedEventHandler  # noqa: F401
    except Exception as error:
        missing.append(
            f"Missing symbol winrt.windows.foundation.TypedEventHandler: {error}"
        )

    try:
        from winrt.windows.ui.notifications.management import (  # noqa: F401
            UserNotificationListener,
        )
    except Exception as error:
        missing.append(
            "Missing symbol "
            "winrt.windows.ui.notifications.management.UserNotificationListener: "
            f"{error}"
        )

    enum_candidates = (
        "UserNotificationKinds",
        "UserNotificationKind",
        "NotificationKinds",
        "notification_kinds.UserNotificationKinds",
        "notification_kinds.UserNotificationKind",
        "models.UserNotificationKinds",
        "models.UserNotificationKind",
    )
    toast_candidates = ("TOAST", "Toast")

    module_name = "winrt.windows.ui.notifications.management"
    try:
        management_module = importlib.import_module(module_name)
    except Exception as error:
        missing.append(f"Missing module {module_name}: {error}")
        management_module = None

    enum_type = None
    enum_source = None
    if management_module is not None:
        for candidate_path in enum_candidates:
            current = management_module
            try:
                for attribute in candidate_path.split("."):
                    current = getattr(current, attribute)
                enum_type = current
                enum_source = candidate_path
                break
            except AttributeError:
                continue

        if enum_type is None:
            missing.append(
                "Missing notification kind enum type in "
                f"{module_name}; tried: {', '.join(enum_candidates)}"
            )
        else:
            if not any(hasattr(enum_type, candidate) for candidate in toast_candidates):
                missing.append(
                    "Missing toast enum symbol on "
                    f"{module_name}.{enum_source}; "
                    f"tried: {', '.join(toast_candidates)}"
                )

    if missing:
        print("[ERROR] WINRT daemon preflight failed.")
        for issue in missing:
            print(f"[ERROR] {issue}")
        return 1

    print(
        "[INFO] WINRT daemon preflight OK: TypedEventHandler, "
        "UserNotificationListener and toast enum symbol are available."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
