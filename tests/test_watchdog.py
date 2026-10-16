import importlib.util
import pathlib
import unittest
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
    def test_healthy_supervisor(self):
        self.assertEqual(m.decide({"safe":True,"running":0,"queued":2,"supervisor_alive":True},10),"supervisor_alive")
if __name__ == "__main__":
    unittest.main()
