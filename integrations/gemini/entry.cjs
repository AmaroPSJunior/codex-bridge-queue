#!/usr/bin/env node
'use strict';
// Installed extension is a launcher for the reviewed, local repository code.
const path=require('node:path'),os=require('node:os');
const root=path.resolve(process.env.CODEX_BRIDGE_ROOT||path.join(os.homedir(),'codex-bridge'));
try{require(path.join(root,'integrations/gemini/server.cjs')).start({root});}
catch{process.stderr.write('Ponte Gemini indisponível; verifique o caminho local do projeto.\n');process.exitCode=1;}
