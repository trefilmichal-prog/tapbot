#!/usr/bin/env python3
"""Preflight checks for Windows notification daemon WINRT dependencies."""

from __future__ import annotations

import enum
import importlib
import sys
from typing import Any


def _resolve_notification_kinds_enum(module_name: str) -> tuple[Any | None, str | None, dict[str, Any]]:
    """Resolve notification kind enum using daemon-compatible logic and diagnostics."""
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
    toast_candidates = ("TOAST", "Toast")

    details: dict[str, Any] = {
        "module_name": module_name,
        "explicit_missing": [],
        "explicit_errors": [],
        "explicit_no_toast": [],
        "fallback_scan_attempted": False,
        "fallback_roots": [],
        "fallback_errors": [],
        "fallback_no_toast": [],
        "import_error": None,
    }

    def has_toast_member(enum_candidate: Any) -> bool:
        for member_name in toast_candidates:
            try:
                if hasattr(enum_candidate, member_name):
                    return True
            except Exception:
                continue
        return False

    def as_enum_holder(candidate: Any) -> Any | None:
        if isinstance(candidate, enum.EnumMeta):
            return candidate

        if has_toast_member(candidate):
            return candidate

        if hasattr(candidate, "__dict__"):
            for value in vars(candidate).values():
                if isinstance(value, enum.EnumMeta) and has_toast_member(value):
                    return value
        return None

    try:
        management_module = importlib.import_module(module_name)
    except Exception as error:
        details["import_error"] = f"{error.__class__.__name__}: {error}"
        return None, None, details

    for candidate_path in candidate_paths:
        current_value = management_module
        try:
            for attribute in candidate_path.split("."):
                current_value = getattr(current_value, attribute)
            resolved = as_enum_holder(current_value)
            if resolved is not None:
                if resolved is current_value:
                    return resolved, f"{module_name}.{candidate_path}", details

                for nested_name, nested_value in vars(current_value).items():
                    if nested_value is resolved:
                        return (
                            resolved,
                            f"{module_name}.{candidate_path}.{nested_name}",
                            details,
                        )
                return resolved, f"{module_name}.{candidate_path}::<nested-enum>", details

            details["explicit_no_toast"].append(
                f"{module_name}.{candidate_path} ({type(current_value).__name__})"
            )
        except AttributeError:
            details["explicit_missing"].append(f"{module_name}.{candidate_path}")
            continue
        except Exception as error:
            details["explicit_errors"].append(
                f"{module_name}.{candidate_path} -> {error.__class__.__name__}: {error}"
            )

    details["fallback_scan_attempted"] = True
    fallback_roots = [("<management module>", management_module)]
    for branch_name in ("models", "notification_kinds", "user_notification_kinds"):
        branch = getattr(management_module, branch_name, None)
        if branch is not None:
            fallback_roots.append((branch_name, branch))

    for root_name, root_value in fallback_roots:
        details["fallback_roots"].append(root_name)
        try:
            attributes = vars(root_value).items()
        except Exception as error:
            details["fallback_errors"].append(
                f"{root_name} vars() -> {error.__class__.__name__}: {error}"
            )
            continue

        for attribute_name, attribute_value in attributes:
            if attribute_name.startswith("_"):
                continue

            resolved = as_enum_holder(attribute_value)
            if resolved is None:
                if isinstance(attribute_value, enum.EnumMeta) or hasattr(
                    attribute_value, "__dict__"
                ):
                    details["fallback_no_toast"].append(
                        f"{module_name}.{root_name}.{attribute_name} ({type(attribute_value).__name__})"
                    )
                continue

            if resolved is attribute_value:
                return resolved, f"{module_name}.{root_name}.{attribute_name}", details

            for nested_name, nested_value in vars(attribute_value).items():
                if nested_value is resolved:
                    return (
                        resolved,
                        f"{module_name}.{root_name}.{attribute_name}.{nested_name}",
                        details,
                    )
            return (
                resolved,
                f"{module_name}.{root_name}.{attribute_name}::<nested-enum>",
                details,
            )

    return None, None, details


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

    module_name = "winrt.windows.ui.notifications.management"
    toast_candidates = ("TOAST", "Toast")
    enum_type, enum_source, resolution_details = _resolve_notification_kinds_enum(
        module_name
    )

    if resolution_details["import_error"] is not None:
        missing.append(
            f"Missing module {module_name}: {resolution_details['import_error']}"
        )
    elif enum_type is None:
        failed_candidates = []
        failed_candidates.extend(resolution_details["explicit_missing"])
        failed_candidates.extend(resolution_details["explicit_errors"])

        fallback_status = (
            "yes" if resolution_details["fallback_scan_attempted"] else "no"
        )
        relevant_no_toast = []
        relevant_no_toast.extend(resolution_details["explicit_no_toast"])
        relevant_no_toast.extend(resolution_details["fallback_no_toast"])

        missing.append(
            "Unable to resolve WINRT notification kind enum type. "
            f"Explicit candidates failed: {', '.join(failed_candidates) if failed_candidates else 'none'}; "
            f"fallback scan attempted: {fallback_status}; "
            "symbols found without toast member: "
            f"{', '.join(relevant_no_toast) if relevant_no_toast else 'none'}."
        )
    else:
        toast_member = next(
            (candidate for candidate in toast_candidates if hasattr(enum_type, candidate)),
            None,
        )
        if toast_member is None:
            missing.append(
                "Missing toast enum symbol on "
                f"{enum_source}; "
                f"tried: {', '.join(toast_candidates)}"
            )

    if missing:
        print("[ERROR] WINRT daemon preflight failed.")
        for issue in missing:
            print(f"[ERROR] {issue}")
        return 1

    print(
        "[INFO] WINRT daemon preflight OK: TypedEventHandler, "
        "UserNotificationListener and toast enum symbol are available. "
        f"Resolved enum path: {enum_source}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
