"""Reminder time policy.

Determines whether a morning-window reminder (00:00–06:00) should fire,
once per day, with duplicate suppression.
"""
from datetime import datetime, date, time
from typing import Optional

_reminded_date: Optional[date] = None


def should_remind(now: Optional[datetime] = None) -> bool:
    """Return True if the reminder should be shown at *now*.

    The reminder window is 00:00 <= time < 06:00. If the current date has
    already been reminded, no duplicate is emitted.

    Args:
        now: Simulated datetime. Defaults to datetime.now() when omitted.
    """
    global _reminded_date
    if now is None:
        now = datetime.now()
    # Deduplication: already reminded today
    if _reminded_date == now.date():
        return False
    # Check whether we are inside the reminder window
    if time(0, 0) <= now.time() < time(6, 0):
        _reminded_date = now.date()
        return True
    return False


def reset_state() -> None:
    """Clear the reminder date state (for testing)."""
    global _reminded_date
    _reminded_date = None
