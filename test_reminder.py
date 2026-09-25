"""Tests for the reminder time policy using simulated time.

Each test passes an explicit datetime to should_remind(now), keeping
tests deterministic without relying on the real clock or mocking internals.
"""
import unittest
from datetime import datetime

import reminder


class TestReminderPolicy(unittest.TestCase):
    """W1-2: Failing tests — verify the time policy with simulated clock."""

    def setUp(self):
        reminder.reset_state()

    def test_23_59_no_reminder(self):
        """23:59 is outside the reminder window → no reminder."""
        self.assertFalse(
            reminder.should_remind(datetime(2025, 1, 1, 23, 59))
        )

    def test_00_00_reminder(self):
        """00:00 is the start of the window → reminder."""
        self.assertTrue(
            reminder.should_remind(datetime(2025, 1, 1, 0, 0))
        )

    def test_already_reminded_no_duplicate(self):
        """If already reminded today, do not remind again."""
        self.assertTrue(
            reminder.should_remind(datetime(2025, 1, 1, 3, 0))
        )
        self.assertFalse(
            reminder.should_remind(datetime(2025, 1, 1, 4, 0))
        )

    def test_05_59_reminder(self):
        """05:59 is still inside the window → reminder."""
        self.assertTrue(
            reminder.should_remind(datetime(2025, 1, 1, 5, 59))
        )

    def test_06_00_no_reminder(self):
        """06:00 is at the boundary (exclusive) → no reminder."""
        self.assertFalse(
            reminder.should_remind(datetime(2025, 1, 1, 6, 0))
        )

    def test_window_boundary_inclusive(self):
        """00:00 exactly is inclusive → remind."""
        self.assertTrue(reminder.should_remind(datetime(2025, 1, 1, 0, 0)))

    def test_window_boundary_exclusive(self):
        """05:59:59 is inside, 06:00:00 is outside."""
        self.assertTrue(reminder.should_remind(datetime(2025, 1, 1, 5, 59, 59)))
        self.assertFalse(reminder.should_remind(datetime(2025, 1, 1, 6, 0, 0)))

    def test_across_midnight_new_day(self):
        """After midnight, a new day resets the dedup."""
        self.assertTrue(reminder.should_remind(datetime(2025, 1, 1, 3, 0)))
        # Same day, no duplicate
        self.assertFalse(reminder.should_remind(datetime(2025, 1, 1, 4, 0)))
        # Next day, reminder fires again
        self.assertTrue(reminder.should_remind(datetime(2025, 1, 2, 1, 0)))


if __name__ == "__main__":
    unittest.main()
