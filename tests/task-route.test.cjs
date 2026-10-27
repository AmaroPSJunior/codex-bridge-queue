'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTask, ROUTES } = require('../routing/task-route.cjs');

test('explicit code work belongs to GitHub', () => {
  for (const action of ['inspect','edit','pull_request','test','build','deploy_review']) {
    assert.equal(classifyTask({ execution_target:'github', action }).route, ROUTES.GITHUB);
  }
});
test('explicit ADB actions belong to the local device lane only', () => {
  for (const action of ['adb_shell','adb_install','adb_diagnostics']) {
    assert.equal(classifyTask({ execution_target:'device_adb', action }).route, ROUTES.DEVICE_ADB);
    assert.notEqual(classifyTask({ execution_target:'github', action }).route, ROUTES.GITHUB);
  }
});
test('legacy and untrusted free text do not trigger execution', () => {
  for (const input of [
    {instruction:'adb install update.apk'},
    {instruction:'edit the dashboard'},
    {execution_mode:'agent', instruction:'fix issue'},
    {execution_target:'device_adb', action:'edit'},
    {execution_target:'github', action:'adb_install'},
    {execution_target:'github', action:'run_arbitrary_shell'},
    null, [], 'edit', {}
  ]) assert.equal(classifyTask(input).route, ROUTES.REVIEW);
});
test('target and action are exact and type-checked', () => {
  assert.equal(classifyTask({execution_target:' GitHub', action:'edit'}).route, ROUTES.REVIEW);
  assert.equal(classifyTask({execution_target:'github', action:['edit']}).route, ROUTES.REVIEW);
});
