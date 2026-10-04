'use strict';
const {defineExecutor} = require('./contract');

// Raw transport envelopes stay private: never serialize them as provider metadata.
const legacyRuns = new WeakMap();
function normalize(run) {
  let parsed;
  try { parsed = JSON.parse(run.stdout.trim()); } catch {}
  const completed = run.code === 0 && parsed?.status === 'completed';
  const status = completed ? 'completed' : 'failed';
  const message = parsed?.error || run.error || run.stderr || 'Codex terminou sem um resultado válido.';
  const result = {
    provider: 'codex',
    session: {provider: 'codex', id: typeof parsed?.threadId === 'string' && parsed.threadId ? parsed.threadId : null, state: status},
    status,
    answer: typeof parsed?.answer === 'string' ? parsed.answer : run.stdout || '',
    error: completed ? null : {code: parsed ? 'execution' : 'protocol', message: String(message), retryable: false}
  };
  legacyRuns.set(result, run);
  return result;
}
function toLegacyRun(result) {
  if (!legacyRuns.has(result)) throw new TypeError('Result was not produced by the Codex adapter');
  return legacyRuns.get(result);
}
/**
 * Wrap the established bridge runner without reimplementing its transport, timers,
 * thread storage, permissions, validation, TTS or Git boundaries.
 * run(input) must await progress callbacks; it returns {code, stdout, stderr, error?}.
 * AbortSignal is deliberately unsupported until remote interruption is acknowledged.
 */
function createCodexExecutor(run) {
  if (typeof run !== 'function') throw new TypeError('Codex runner must be a function');
  return defineExecutor({version: 1, provider: {id: 'codex'}, async execute(input) {
    if (input.signal !== undefined) throw new TypeError('Codex adapter does not support AbortSignal yet');
    return normalize(await run(input));
  }});
}
module.exports = {createCodexExecutor, toLegacyRun};
