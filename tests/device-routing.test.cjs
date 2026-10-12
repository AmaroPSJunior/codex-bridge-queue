'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {legacyQueuePath}=require('../executors/device-routing');
const base='bridge_tasks?status=eq.queued';
const safe=base+'&executor_device_id=is.null&select=*&order=created_at.asc&limit=1';
const legacy=base+'&select=*&order=created_at.asc&limit=1';

test('legacy worker fails closed when routing flag is absent',()=>{
 assert.equal(legacyQueuePath(base,{}),safe);
});
test('routing flag 1 keeps device targets isolated',()=>{
 assert.equal(legacyQueuePath(base,{CODEX_BRIDGE_DEVICE_ROUTING_V1:'1'}),safe);
});
test('only explicit routing flag 0 enables legacy compatibility',()=>{
 assert.equal(legacyQueuePath(base,{CODEX_BRIDGE_DEVICE_ROUTING_V1:'0'}),legacy);
});
test('unexpected routing values remain fail closed',()=>{
 assert.equal(legacyQueuePath(base,{CODEX_BRIDGE_DEVICE_ROUTING_V1:'true'}),safe);
 assert.equal(legacyQueuePath(base,{CODEX_BRIDGE_DEVICE_ROUTING_V1:''}),safe);
});
test('unexpected queue route is rejected',()=>{
 assert.throws(()=>legacyQueuePath('bridge_tasks?status=eq.running',{}),/Unexpected queue route/);
});
