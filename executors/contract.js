'use strict';

// Pure boundary definitions: no provider discovery, execution, retries or queue writes.
const VERSION = 1;
const SESSION_STATES = Object.freeze(['created', 'running', 'completed', 'failed', 'cancelled', 'uncertain']);
const RESULT_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'uncertain']);
const ERROR_CODES = Object.freeze(['payload_too_large', 'rate_limit', 'quota', 'network', 'http', 'invalid_input', 'unavailable', 'authentication', 'permission', 'timeout', 'cancelled', 'execution', 'protocol', 'unknown']);
const PROGRESS_TYPES = Object.freeze(['output', 'stage', 'command_end']);

/**
 * @typedef {{id:string}} Provider Stable adapter ID, not a model name or credential.
 * @typedef {{provider:string,id:string|null,state:string}} Session Provider-scoped opaque ID.
 * @typedef {{code:string,message:string,retryable:boolean}} ExecutionError Sanitized by caller.
 * @typedef {{provider:string,session:Session,status:string,answer:string,error:ExecutionError|null}} Result
 * @typedef {{type:'output',text:string,stream:'stdout'|'stderr'}|{type:'stage',text:string}|{type:'command_end',code:number|null}} Progress
 * @typedef {{instruction:string,signal?:AbortSignal,onProgress?:(event:Progress)=>Promise<void>}} Input
 * @typedef {{version:1,provider:Provider,execute:(input:Input)=>Promise<Result>}} Executor
 * execute owns no queue claim, TTS or Git policy. Implementations await onProgress;
 * cancellation is not proof that remote work stopped. Use uncertain if unknown.
 */
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function check(condition, field) { if (!condition) throw new TypeError('Invalid executor contract: ' + field); }
function provider(value) { check(typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value), 'provider'); }
function state(value, values, field) { check(values.includes(value), field); }
function validateInput(input) {
  check(object(input), 'input');
  check(typeof input.instruction === 'string' && input.instruction.trim().length > 0, 'instruction');
  check(input.onProgress === undefined || typeof input.onProgress === 'function', 'onProgress');
  check(input.signal === undefined || (object(input.signal) && typeof input.signal.aborted === 'boolean' && typeof input.signal.addEventListener === 'function'), 'signal');
  return input; // Never trim or interpolate instructions; preserve literal contents.
}
function validateSession(session) {
  check(object(session), 'session'); provider(session.provider);
  check(session.id === null || (typeof session.id === 'string' && session.id.length > 0), 'session.id');
  state(session.state, SESSION_STATES, 'session.state'); return session;
}
function validateError(error) {
  check(object(error), 'error'); state(error.code, ERROR_CODES, 'error.code');
  check(typeof error.message === 'string' && error.message.trim().length > 0, 'error.message');
  check(typeof error.retryable === 'boolean', 'error.retryable'); return error;
}
function validateResult(result) {
  check(object(result), 'result'); provider(result.provider); validateSession(result.session);
  check(result.provider === result.session.provider, 'session.provider');
  state(result.status, RESULT_STATES, 'result.status');
  check(result.session.state === result.status, 'session.state/result.status');
  check(typeof result.answer === 'string', 'answer');
  if (result.status === 'completed') check(result.error === null, 'completed.error');
  else validateError(result.error);
  return result;
}
function validateProgress(event) {
  check(object(event), 'progress'); state(event.type, PROGRESS_TYPES, 'progress.type');
  if (event.type === 'command_end') check(event.code === null || Number.isInteger(event.code), 'progress.code');
  else check(typeof event.text === 'string', 'progress.text');
  if (event.type === 'output') state(event.stream, ['stdout', 'stderr'], 'progress.stream');
  return event;
}
function defineExecutor(adapter) {
  check(object(adapter) && adapter.version === VERSION, 'version');
  check(object(adapter.provider), 'provider'); provider(adapter.provider.id);
  check(typeof adapter.execute === 'function', 'execute');
  const id = adapter.provider.id;
  return Object.freeze({version: VERSION, provider: Object.freeze({id}), async execute(input) {
    validateInput(input);
    const onProgress = input.onProgress;
    const result = await adapter.execute({...input, onProgress: async event => {
      validateProgress(event);
      if (onProgress) await onProgress(event);
    }});
    validateResult(result); check(result.provider === id, 'result.provider'); return result;
  }});
}
module.exports = {VERSION, SESSION_STATES, RESULT_STATES, ERROR_CODES, PROGRESS_TYPES,
  validateInput, validateSession, validateError, validateResult, validateProgress, defineExecutor};
