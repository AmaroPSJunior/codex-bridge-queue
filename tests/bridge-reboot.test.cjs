const fs=require('fs');
const path=require('path');
const assert=require('assert');

const src=fs.readFileSync(path.join(__dirname,'..','recovery','bridge-reboot'),'utf8');
assert.match(src,/set -euo pipefail/,'reboot must fail closed');
assert.match(src,/pids\(\).*pgrep -f/s,'must discover managed processes');
assert.match(src,/upabase-worker/,'must discover active workers');
assert.match(src,/kill -TERM/,'must request graceful termination before recovery');
assert.match(src,/upabase-launcher/,'must stop supervisor generations before recovery');
assert.match(src,/termux\\/boot\\/20-codex-bridge/,'must drain an in-flight legacy boot process');
assert.match(src,/stable=.*0/,'must require a stable drained window');
assert.match(src,/stable.*-ge 3/,'must observe multiple clean checks before recovery');
assert.match(src,/mkdir -p.*\.cache/,'must create temporary clone parent safely');
assert.match(src,/bridge-recover\.py" install/,'must refresh independent recovery controller from main');
assert.match(src,/RECOVER" recover/,'must delegate A\/B validation and promotion to bridge-recover');
assert.match(src,/RECOVER" status/,'must print final status');
assert.doesNotMatch(src,/kill -KILL|reset --hard|git clean/,'must not use destructive recovery shortcuts');
console.log('bridge-reboot tests passed');
