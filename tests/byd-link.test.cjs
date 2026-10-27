'use strict';
const {test}=require('node:test');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
test('BYD discovery, shell quoting and responder reject malformed input',()=>{
 execFileSync('python3',['-B','-c',`
import importlib.util, json, shlex
from pathlib import Path
def load(name, file):
 s=importlib.util.spec_from_file_location(name,file)
 m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
c=load('client','scripts/byd-link.py')
s=load('service','scripts/byd-link-service.py')
assert c.private_ip('10.51.86.181')
for ip in ('127.0.0.1','0.0.0.0','8.8.8.8','::1','-oProxyCommand=bad'):
 assert not c.private_ip(ip), ip
for data in (b'null',b'[]',b'{}',b'bad',b'\\xff',b'{"service":"byd-link-v1","nonce":2}'):
 assert s.reply(data) is None
req={'service':'byd-link-v1','nonce':'a'*32}
assert json.loads(s.reply(json.dumps(req).encode())) == req
for p in ('~/../secret','~/a//b','relative'):
 try: c.codex_command(['--cwd',p,'hello'])
 except ValueError: pass
 else: raise AssertionError(p)
cmd,prompt=c.codex_command(['--cwd',"~/a 'quoted' path",'one','two'])
assert prompt=='one two' and 'flock -n -E 75' in cmd
assert '--sandbox workspace-write' in cmd
assert shlex.quote("a 'quoted' path") in cmd
args=c.ssh_args({'host_key_alias':'pinned'},'10.0.0.1')
assert 'StrictHostKeyChecking=yes' in args and 'ProxyCommand=none' in args
`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,LD_LIBRARY_PATH:''},stdio:'pipe'});
});
