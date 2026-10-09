import tempfile
import unittest
from pathlib import Path

import app


class ScheduleStorageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.original_path = app.DB_PATH
        app.DB_PATH = Path(self.tmp.name) / "schedule.db"
        app.init_db()

    def tearDown(self):
        app.DB_PATH = self.original_path
        self.tmp.cleanup()

    def test_revision_prevents_silent_overwrite(self):
        revision, state = app.get_state()
        self.assertEqual(revision, 0)
        state["logs"]["2026-10-05|monday"] = {"status": "done", "hours": 1.5}
        self.assertEqual(app.update_state(0, state), 1)
        self.assertIsNone(app.update_state(0, {**state, "logs": {}}))
        self.assertEqual(len(app.get_state()[1]["logs"]), 1)

    def test_rejects_invalid_data(self):
        revision, state = app.get_state()
        state["logs"]["bad"] = {"status": "unknown"}
        with self.assertRaises(ValueError):
            app.update_state(revision, state)
        self.assertEqual(app.get_state()[0], revision)


if __name__ == "__main__":
    unittest.main()
