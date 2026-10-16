#!/usr/bin/env python3
"""Fail-closed Codex Bridge watchdog. Standard library only; no AI/tokens."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "supabase-state" / "watchdog"
CONTROL = ROOT / "supabase-state" / "control"
PRIVATE = Path.home() / ".config" / "codex-bridge"
def now():
    return datetime.now(timezone.utc).isoformat()
def emit(event, **data):
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = {"id": str(uuid.uuid4()), "at": now(), "event": event, **data}
    with (STATE / "events.jsonl").open("a", encoding="utf8") as log:
        log.write(json.dumps(payload, ensure_ascii=False) + "\n")
        log.flush()
        os.fsync(log.fileno())
    return payload
def proc_alive(pid):
    if type(pid) is not int or pid < 2:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
def config():
    return json.loads((ROOT / "remote-config.json").read_text())
def supabase_rows(route):
    cfg = config()
    url = os.getenv("CODEX_SUPABASE_URL") or cfg["supabase"]["url"]
    key = os.getenv("CODEX_SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        secret = PRIVATE / "supabase-service-role.key"
        st = secret.lstat()
        if not secret.is_file() or secret.is_symlink() or st.st_mode & 0o077:
            raise RuntimeError("Unsafe private credential")
        key = secret.read_text().strip()
    request = urllib.request.Request(url.rstrip("/") + "/rest/v1/" + route,
        headers={"apikey": key, "Authorization": "Bearer " + key})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)
def snapshot():
    tasks = supabase_rows("bridge_tasks?status=in.(queued,running)&select=id,status,updated_at,claimed_at,activity_seq,last_activity_at&limit=100")
    # A truncated result cannot justify restarting a worker.
    if len(tasks) >= 100:
        return {"safe": False, "reason": "queue_scan_truncated"}
    active = [t for t in tasks if t["status"] == "running"]
    supervisor_path = CONTROL / "supervisor.json"
    try:
        supervisor = json.loads(supervisor_path.read_text())
    except (OSError, ValueError):
        supervisor = {}
    pid = supervisor.get("pid")
    return {"safe": True, "queued": len(tasks) - len(active), "running": len(active),
            "supervisor_alive": proc_alive(pid), "supervisor_pid": pid}
def decide(snap, confirmations=3):
    if not snap["safe"]:
        return "unknown"
    if snap["running"]:
        return "running_do_not_restart"
    if snap["supervisor_alive"]:
        return "supervisor_alive"
    if not snap["queued"]:
        return "idle"
    if confirmations < 3:
        return "suspect"
    return "recovery_candidate"
def check(apply=False, consecutive=3):
    try:
        snap = snapshot()
        verdict = decide(snap, consecutive)
        event = emit("watchdog_check", verdict=verdict, **snap)
        if verdict != "recovery_candidate":
            return event
        if not apply:
            return emit("recovery_skipped", reason="dry_run", **snap)
        # Never run bridge reboot automatically: it kills workers and changes the checkout.
        # Use the existing singleton launcher, which takes a global lock.
        launcher = ROOT / "autostart" / "supabase-launcher.py"
        if not launcher.is_file():
            return emit("recovery_failed", reason="launcher_missing")
        emit("recovery_started", action="start_supervisor")
        result = subprocess.run(["python3", str(launcher)], cwd=ROOT,
                                timeout=30, capture_output=True, text=True)
        emit("recovery_attempt", returncode=result.returncode)
        time.sleep(3)
        after = snapshot()
        return emit("recovery_verified" if after.get("supervisor_alive") else "recovery_unconfirmed",
                    **after)
    except Exception as exc:
        return emit("check_failed", error_type=type(exc).__name__)
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Allow safe supervisor bootstrap")
    parser.add_argument("--once", action="store_true", help="Run one inspection")
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args()
    if args.interval < 10:
        parser.error("interval must be >= 10 seconds")
    streak = 0
    while True:
        # Count failures only after distinct checks; never act on a single stale snapshot.
        try:
            s = snapshot()
            decision = decide(s, streak + 1)
            streak = streak + 1 if s["safe"] and s.get("queued") and not s.get("running") and not s.get("supervisor_alive") else 0
            if decision == "recovery_candidate" and streak >= 3:
                check(apply=args.apply, consecutive=streak)
                streak = 0
            else:
                emit("watchdog_observation", verdict=decide(s, streak), **s)
        except Exception as exc:
            streak = 0
            emit("watchdog_check_failed", error_type=type(exc).__name__)
        if args.once:
            break
        time.sleep(args.interval)
if __name__ == "__main__":
    main()
