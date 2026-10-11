#!/usr/bin/env python3
"""Static defense-in-depth checks for proposed, NOT deployed device migration."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SQL = (ROOT / "database/multi-device-phase2-draft.sql").read_text()


class DeviceClaimContract(unittest.TestCase):
    def test_backend_authentication_and_atomic_claim(self):
        for required in (
            "SECURITY DEFINER",
            "bridge_device_token_valid(p_device_id,p_token)",
            "sha256(convert_to(p_token,'UTF8'))",
            "FOR UPDATE SKIP LOCKED",
            "executor_device_id=p_device_id",
            "device_claim_nonce=gen_random_uuid()",
            "device_claim_nonce=p_claim_nonce",
            "status='queued'",
            "status='running'",
        ):
            self.assertIn(required, SQL)

    def test_client_roles_have_no_direct_task_writes(self):
        self.assertIn("REVOKE ALL ON public.bridge_tasks FROM anon, authenticated", SQL)
        self.assertIn("REVOKE ALL ON public.bridge_devices FROM PUBLIC, anon, authenticated", SQL)
        self.assertNotIn("GRANT UPDATE ON public.bridge_tasks", SQL)

    def test_only_command_mode_is_claimable_initially(self):
        self.assertIn("t.execution_mode='command'", SQL)

if __name__ == "__main__":
    unittest.main()
