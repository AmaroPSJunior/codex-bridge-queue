# Code Bridge resilient recovery

This directory defines an independent recovery plane for Code Bridge.

## Invariants

- The active worker never updates or repairs its own checkout.
- Recovery runs outside the active checkout.
- Exactly one supervisor/worker generation may be active.
- Existing queue, dashboard, executors, providers, receipts and device routing remain compatible.
- Updates are prepared and validated before activation.
- Failed activation rolls back to the last known-good generation.
- Unknown locks are fail-closed: never delete a lock merely because a PID is absent.
- Local untracked/operator files are never silently overwritten.
- Official launches force fail-closed device routing.

## Target layout

```
~/.local/share/codex-bridge/
  current -> slots/A | slots/B
  slots/A/
  slots/B/
~/.local/bin/bridge-recover
~/.config/codex-bridge/recovery/
```

The installer/recovery controller must be copied to `~/.local/bin`, so it survives a broken active checkout.

## Recovery state machine

1. Observe active supervisor/worker and queue/receipt state.
2. Refuse mutation while a legitimate task is running.
3. Reconcile orphan/uncertain state using process ownership, task state, receipts and control journal.
4. Fetch into the inactive slot.
5. Run syntax + full repository tests there.
6. Atomically switch `current`.
7. Start the new supervisor with fail-closed device routing.
8. Require one healthy worker and a matching boot generation.
9. Roll back if health validation fails.

No BYD/ADB action belongs to this recovery plane.
