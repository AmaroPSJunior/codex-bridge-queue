"""Existing Supabase CAS protocol; no schema/status changes, no automatic requeue."""
import datetime
import json
import urllib.request
import urllib.parse
import urllib.error

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Queue redirect refused")

class Queue:
    def __init__(self, url, key):
        if not url.startswith('https://') or not key:
            raise ValueError('HTTPS/credential required')
        self.url, self.key = url.rstrip('/'), key

    def request(self, route, method='GET', payload=None):
        req=urllib.request.Request(self.url+'/rest/v1/'+route,
            data=json.dumps(payload).encode() if payload is not None else None, method=method,
            headers={'apikey':self.key,'Authorization':'Bearer '+self.key,'Content-Type':'application/json','Prefer':'return=representation'})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
            return json.loads(response.read(4*1024*1024))

    def candidates(self, lane):
        mode='execution_mode=eq.command' if lane=='command' else 'or=(execution_mode.is.null,execution_mode.eq.agent,execution_mode.eq.plan)'
        return self.request('bridge_tasks?status=eq.queued&'+mode+'&order=created_at.asc&limit=20')

    def claim(self, task):
        now=datetime.datetime.now(datetime.timezone.utc).isoformat()
        rows=self.request('bridge_tasks?id=eq.'+urllib.parse.quote(task['id'])+'&status=eq.queued','PATCH',
                          {'status':'running','claimed_at':now,'updated_at':now})
        return rows[0] if rows else None
