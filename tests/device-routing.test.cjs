'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {legacyQueuePath}=require('../executors/device-routing');
test('old database remains usable with feature off',()=>{
 assert.equal(legacyQueuePath({}), 'bridge_tasks?status=eq.queued&select=*&order=created_at.asc&limit=1');
});
test('legacy worker excludes new device targets only after activation',()=>{
 assert.equal(legacyQueuePath({CODEX_BRIDGE_DEVICE_ROUTING_V1:'1'}),'bridge_tasks?status=eq.queued&executor_device_id=is.null&select=*&order=created_at.asc&limit=1');
});
test('unexpected flag values fail to legacy behavior',()=>{
 assert.equal(legacyQueuePath({CODEX_BRIDGE_DEVICE_ROUTING_V1:'true'}),legacyQueuePath({}));
});
