const fs=require('fs');
const path=require('path');
const assert=require('assert');

const src=fs.readFileSync(path.join(__dirname,'..','recovery','bridge-recover.py'),'utf8');

assert.match(src,/fcntl\.flock\(fd,fcntl\.LOCK_EX\|fcntl\.LOCK_NB\)/,'recovery must be singleton');
assert.match(src,/if workers\(\):[\s\S]*active_worker_present_use_controlled_drain_first/,'must fence workers from every checkout generation');
assert.match(src,/CODEX_BRIDGE_DEVICE_ROUTING_V1.*=.*"1"/s,'official recovery launch must force safe routing');
assert.match(src,/os\.replace\(tmp,CURRENT\)/,'slot promotion must be atomic');
assert.match(src,/global_workers=workers\(\)/,'health check must inspect workers globally');
assert.match(src,/len\(global_workers\)==1/,'healthy requires exactly one global worker');
assert.match(src,/global_workers==slot_workers/,'the sole global worker must belong to the promoted slot');
assert.match(src,/global_health_check_failed/,'duplicate generations must fail closed');
assert.match(src,/health_failed/,'failed global health must be journaled');
assert.match(src,/npm","test/,'inactive slot must pass repository tests before promotion');
assert.match(src,/\.local\/bin\/bridge-recover/,'controller must install outside checkout');
assert.match(src,/\.local\/bin\/bridge-reboot/,'installer must install the one-command reboot outside checkout');
assert.doesNotMatch(src,/reset","--hard|git clean/,'controller must not destroy local work');
console.log('recovery-controller tests passed');

assert.match(src,/\.termux\/boot/,'installer must migrate Termux boot entrypoint');
assert.match(src,/20-codex-bridge/,'installer must deploy canonical boot script');
