const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const required = [
  'AGENTS.md',
  'docs/ARCHITECTURE.md',
  'docs/PROJECT_STATE.md',
  'docs/OPERATING-RULES.md',
  'docs/RUNBOOK.md',
  'docs/DEFINITION-OF-DONE.md',
];

test('canonical governance documents exist and are linked from AGENTS', () => {
  const agents = read('AGENTS.md');
  for (const name of required) {
    assert.ok(fs.existsSync(path.join(root, name)), `missing ${name}`);
    if (name !== 'AGENTS.md') assert.ok(agents.includes(name), `AGENTS must link ${name}`);
  }
});

test('architecture preserves recovery invariants', () => {
  const architecture = read('docs/ARCHITECTURE.md');
  for (const contract of [
    '~/.local/share/codex-bridge/',
    'current -> slots/A | slots/B',
    'Exatamente uma geração',
    'lock do worker é global',
    'CI verde prova o código no GitHub; não prova Android',
  ]) assert.ok(architecture.includes(contract), `missing architecture contract: ${contract}`);
});

test('operating contract requires evidence and capability check', () => {
  const rules = read('docs/OPERATING-RULES.md');
  assert.ok(rules.includes('Evidência antes de suposição'));
  assert.ok(rules.includes('Antes de responder “não consigo”'));
  assert.ok(rules.includes('Erro → evidência → hipótese'));
  const dod = read('docs/DEFINITION-OF-DONE.md');
  assert.ok(dod.includes('CI isoladamente não conta como E2E'));
  assert.ok(dod.includes('não 100%'));
});
