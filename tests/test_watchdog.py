import importlib.util
import pathlib
import unittest
import tempfile
import json
import os
import uuid
from unittest.mock import MagicMock
from unittest.mock import patch
p = pathlib.Path(__file__).resolve().parents[1] / "watchdog" / "watchdog.py"
spec = importlib.util.spec_from_file_location("bridge_watchdog", p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class WatchdogTests(unittest.TestCase):
    def test_running_never_reboots(self):
        self.assertEqual(m.decide({"safe":True,"running":1,"queued":1,"supervisor_alive":False},10),"running_do_not_restart")
    def test_idle_is_safe(self):
        self.assertEqual(m.decide({"safe":True,"running":0,"queued":0,"supervisor_alive":False},10),"idle")
    def test_no_recovery_on_bad_scan(self):
        self.assertEqual(m.decide({"safe":False},10),"unknown")
    def test_consecutive_confirmations(self):
        s={"safe":True,"running":0,"queued":3,"supervisor_alive":False}
        self.assertEqual(m.decide(s,2),"suspect")
        self.assertEqual(m.decide(s,3),"recovery_candidate")
    def test_event_upload_ack_updates_cursor_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td, patch.object(m,"STATE",pathlib.Path(td)):
            event={"id":str(uuid.uuid4()),"at":"2026-10-16T00:00:00+00:00","event":"watchdog_check","verdict":"idle","safe":True}
            (m.STATE/"events.jsonl").write_text(json.dumps(event)+"\n")
            response=MagicMock()
            response.__enter__.return_value.status=201
            with patch.object(m,"config",return_value={"supabase":{"url":"https://example.supabase.co"}}),\
                 patch.dict(os.environ,{"CODEX_SUPABASE_SERVICE_ROLE_KEY":"fake-test-key"}),\
                 patch.object(m.urllib.request,"urlopen",return_value=response) as mocked:
                self.assertEqual(m.publish_events(),1)
                self.assertEqual(m.publish_events(),0)
                payload=json.loads(mocked.call_args.args[0].data)
                self.assertEqual(payload["id"],event["id"])
                self.assertEqual(payload["evidence"],{"safe":True})
                self.assertEqual(mocked.call_count,1)
    def test_failed_upload_preserves_unsent_events(self):
        with tempfile.TemporaryDirectory() as td, patch.object(m,"STATE",pathlib.Path(td)):
            (m.STATE/"events.jsonl").write_text(json.dumps({"id":str(uuid.uuid4()),"at":"2026-10-16T00:00:00+00:00","event":"observation"})+"\n")
            with patch.object(m,"config",return_value={"supabase":{"url":"https://example.supabase.co"}}),\
                 patch.dict(os.environ,{"CODEX_SUPABASE_SERVICE_ROLE_KEY":"fake-test-key"}),\
                 patch.object(m.urllib.request,"urlopen",side_effect=OSError("offline")):
                with self.assertRaises(OSError):
                    m.publish_events()
            self.assertFalse((m.STATE/"published.offset").exists())
    def test_healthy_supervisor(self):
        self.assertEqual(m.decide({"safe":True,"running":0,"queued":2,"supervisor_alive":True},10),"supervisor_alive")
if __name__ == "__main__":
    unittest.main()
