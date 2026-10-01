import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('smoke',ROOT/'scripts/smoke.py');smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)


class SmokeTests(unittest.TestCase):
    def test_network_requires_explicit_opt_in(self):
        with patch('sys.argv',['smoke','github']),patch.object(smoke.subprocess,'run') as run,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(smoke.main(),2);run.assert_not_called()

    def test_github_only_reads_and_does_not_print_response(self):
        config=json.dumps({'repository':'owner/test'})
        def run(args,**kwargs):
            self.assertEqual(args[args.index('--method')+1],'GET')
            return subprocess.CompletedProcess(args,0,json.dumps({'private':True,'has_issues':True}) if args[4]=='repos/owner/test' else '[]','')
        with patch('sys.argv',['smoke','github','--allow-network']),patch.object(Path,'read_text',return_value=config),patch.object(smoke.subprocess,'run',side_effect=run),contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(smoke.main(),0)
        self.assertNotIn('private',out.getvalue())

    def test_supabase_get_has_deadline_and_redacts_records(self):
        class Response(io.BytesIO):
            status=200
        class Opener:
            def open(inner,request,timeout):
                self.assertEqual(request.method,'GET');self.assertEqual(timeout,20)
                self.assertIn('select=id&limit=1',request.full_url)
                return Response(b'[{"id":"record-not-for-output"}]')
        with patch('sys.argv',['smoke','supabase','--allow-network']),patch.object(Path,'read_text',return_value=json.dumps({'supabase':{'url':'https://example.invalid'}})),patch.dict(smoke.os.environ,{'CODEX_SUPABASE_SERVICE_ROLE_KEY':'synthetic-only'}),patch.object(smoke.urllib.request,'build_opener',return_value=Opener()),contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(smoke.main(),0)
        self.assertNotIn('record-not-for-output',out.getvalue());self.assertNotIn('synthetic-only',out.getvalue())


if __name__=='__main__':unittest.main()
