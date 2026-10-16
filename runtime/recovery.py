"""Recovery policy: expiry diagnoses; it never proves that external effects stopped."""
import time

def decision(attempt, owner_alive, result, published, released):
    if owner_alive:return 'observe'
    if published and released:return 'complete'
    if result:return 'publish_only'
    return 'blocked'

def publication_budget(ledger, task, now=None):
    now=time.time() if now is None else now
    # Durable bounded retries survive maintenance/supervisor reboot.
    # Reserve each publication attempt atomically across maintenance processes.
    # Without BEGIN IMMEDIATE, two readers could both see the same remaining
    # budget slot and publish concurrently after a supervisor restart.
    with ledger.transaction():
        rows=ledger.db.execute("SELECT at FROM events WHERE id=? AND event='publication_retry' ORDER BY at",(task,)).fetchall()
        if len(rows)>=3:return False
        if rows and now-rows[-1][0]<min(60*2**len(rows),600):return False
        ledger.event(task,'publication_retry')
        return True

def request_inactivity_drain(ledger, attempt, silence, limit=900):
    import uuid
    if silence<limit:return False
    request_id=str(uuid.uuid5(uuid.NAMESPACE_URL,'bridge-inactivity:'+attempt['id']))
    if ledger.db.execute('SELECT 1 FROM controls WHERE id=?',(request_id,)).fetchone():return False
    ledger.control(request_id,attempt['lane'],'restart')
    ledger.event(attempt['id'],'inactivity_requires_reconciliation')
    return True
