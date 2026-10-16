'use strict';

/**
 * Conservative classification at the task admission boundary.
 * Do not infer authority from free-text instructions.
 * Classification does not execute, claim or publish tasks.
 */
const ROUTES = Object.freeze({
  GITHUB: 'github',
  DEVICE_ADB: 'device_adb',
  REVIEW: 'review'
});
const GITHUB_ACTIONS = new Set(['inspect', 'edit', 'pull_request', 'test', 'build', 'deploy_review']);
const DEVICE_ACTIONS = new Set(['adb_shell', 'adb_install', 'adb_diagnostics']);

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) &&
    (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
}
function classifyTask(task) {
  if (!isPlainObject(task)) return { route: ROUTES.REVIEW, reason: 'invalid_task' };
  const { execution_target: target, action } = task;
  if (typeof target !== 'string' || typeof action !== 'string') {
    return { route: ROUTES.REVIEW, reason: 'explicit_target_and_action_required' };
  }
  // Do not silently route a legacy agent/plan/command task to GitHub.
  if (target === 'github' && GITHUB_ACTIONS.has(action)) {
    return { route: ROUTES.GITHUB, reason: 'explicit_github_action' };
  }
  if (target === 'device_adb' && DEVICE_ACTIONS.has(action)) {
    return { route: ROUTES.DEVICE_ADB, reason: 'requires_local_device_executor' };
  }
  return { route: ROUTES.REVIEW, reason: 'unsupported_target_or_action' };
}
module.exports = { ROUTES, classifyTask };
