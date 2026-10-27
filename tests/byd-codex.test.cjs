'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, remoteWorkingDirectory, shellQuote } = require('../scripts/byd-codex.cjs');

test('SSH shell quoting preserves spaces and single quotes', () => {
  assert.equal(shellQuote("BYD's central"), "'BYD'\\''s central'");
});

test('remote working directory supports home and absolute paths', () => {
  assert.equal(remoteWorkingDirectory('~'), '"$HOME"');
  assert.equal(remoteWorkingDirectory('~/code bridge'), '"$HOME"/' + "'code bridge'");
  assert.equal(remoteWorkingDirectory('/data/work space'), "'/data/work space'");
});

test('remote working directory rejects relative and traversal paths', () => {
  assert.throws(() => remoteWorkingDirectory('relative/path'), /absolute path/);
  assert.throws(() => remoteWorkingDirectory('~/../outside'), /must not contain/);
});

test('CLI options preserve prompt text', () => {
  assert.deepEqual(parseArgs(['--cwd', '~/project', 'inspect', 'the', 'workspace']), {
    cwd: '~/project', prompt: 'inspect the workspace',
  });
  assert.deepEqual(parseArgs(['--help']), { help: true });
});
