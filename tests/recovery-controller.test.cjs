const fs=require('fs');
const path=require('path');
const assert=require('assert');

const src=fs.readFileSync(path.join(__dirname,'..','recovery','bridge-recover.py'),'utf8');

assert.match(src,/fcntl\.flock\(fd,fcntl\.LOCK_EX\|fcntl\.LOCK_NB\)/,'recovery must be singleton');
assert.match(src,/active_worker_present_use_controlled_drain_first/,'must refuse self-update while worker is active');
assert.match(src,/CODEX_BRIDGE_DEVICE_ROUTING_V1.*=.*"1"/s,'official recovery launch must force safe routing');
assert.match(src,/os\.replace\(tmp,CURRENT\)/,'slot promotion must be atomic');
assert.match(src,/rolled_back/,'failed health check must journal rollback');
assert.match(src,/npm","test/,'inactive slot must pass repository tests before promotion');
assert.match(src,/\.local\/bin\/bridge-recover/,'controller must install outside checkout');
assert.doesNotMatch(src,/reset","--hard|git clean/,'controller must not destroy local work');
console.log('recovery-controller tests passed');
