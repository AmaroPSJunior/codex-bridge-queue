import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('generator',ROOT/'scripts/generate-docs.py')
generator=importlib.util.module_from_spec(spec);spec.loader.exec_module(generator)


class DocsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='bridge-docs-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        names=set(generator.source_paths(ROOT))|{'docs/model.json','README.md','docs/GUIA.md','docs/SLIDES.md','docs/apresentacao/README.md','docs/apresentacao/ROTEIRO-AUDIO.md'}
        for artifact in json.loads((ROOT/'docs/model.json').read_text())['presentation']['artifacts']:
            name='docs/apresentacao/'+artifact['file']
            if (ROOT/name).exists():names.add(name)
        for name in names:
            target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)

    def test_generation_is_current_and_deterministic(self):
        self.assertEqual(generator.check(self.root),[])
        self.assertEqual(generator.render(self.root),generator.render(self.root))

    def test_stale_slide_is_rejected(self):
        (self.root/'docs/SLIDES.md').write_text('old')
        self.assertIn('docs/SLIDES.md',generator.check(self.root))

    def test_source_change_invalidates_all_generated_files(self):
        p=self.root/'remote-worker.js';p.write_text(p.read_text()+'\n// change\n')
        self.assertEqual(len(generator.check(self.root)),5)

    def test_onboarding_is_indexed_and_change_invalidates_outputs(self):
        name='docs/integrations/AI-QUEUE-ONBOARDING-PROMPT.md'
        self.assertIn(name, generator.source_paths(self.root))
        outputs=generator.render(self.root)
        self.assertIn('('+name+')', outputs['README.md'])
        self.assertIn('(integrations/AI-QUEUE-ONBOARDING-PROMPT.md)', outputs['docs/GUIA.md'])
        p=self.root/name
        p.write_text(p.read_text()+'\nAtualização do contrato.\n')
        self.assertEqual(len(generator.check(self.root)),5)

    def test_removed_contract_fails_even_after_regeneration(self):
        p=self.root/'remote-worker.js';p.write_text(p.read_text().replace('codex-bridge/v1','v2'))
        with self.assertRaises(ValueError):generator.render(self.root)

    def test_missing_downloads_are_not_advertised_as_existing(self):
        for artifact in json.loads((self.root/'docs/model.json').read_text())['presentation']['artifacts']:
            (self.root/'docs/apresentacao'/artifact['file']).unlink(missing_ok=True)
        text=generator.render(self.root)['docs/apresentacao/README.md']
        self.assertEqual(text.count('Ainda não disponível'),3)
        self.assertNotIn('?raw=1',text)
        self.assertIn('não foi alterada',text)

    def test_stale_audio_script_is_rejected(self):
        (self.root/'docs/apresentacao/ROTEIRO-AUDIO.md').write_text('old narration')
        self.assertIn('docs/apresentacao/ROTEIRO-AUDIO.md',generator.check(self.root))

    def test_invalid_binary_is_rejected(self):
        (self.root/'docs/apresentacao/apresentacao.pdf').write_text('not a PDF')
        with self.assertRaises(ValueError):generator.render(self.root)

    def test_real_artifact_presence_updates_link_and_signature(self):
        # Format fixture only, isolated in the test directory; never a release artifact.
        (self.root/'docs/apresentacao/apresentacao.pdf').write_bytes(b'%PDF-1.4\nfixture\n%%EOF')
        text=generator.render(self.root)['docs/apresentacao/README.md']
        self.assertIn('[Baixar arquivo](apresentacao.pdf?raw=1)',text)
        self.assertTrue(generator.check(self.root))

    def test_narration_length_and_notification_limit(self):
        model=json.loads((self.root/'docs/model.json').read_text())
        narration=model['presentation']['narration']
        self.assertTrue(120 <= len(narration.split()) <= 160)
        self.assertIn('não estamos afirmando',narration)
        self.assertIn('GitHub ou o Supabase',narration)

    def test_sql_identity_contract(self):
        sql=(ROOT/'database/task-identity.sql').read_text()
        for contract in ['GENERATED ALWAYS AS IDENTITY','CREATE UNIQUE INDEX','lock_timeout','SECURITY INVOKER','task_number is immutable','REVOKE ALL','COMMIT;']:
            self.assertIn(contract,sql)
        self.assertNotIn('SECURITY DEFINER',sql)
        self.assertNotIn('DISABLE ROW LEVEL SECURITY',sql)


if __name__=='__main__':unittest.main()
