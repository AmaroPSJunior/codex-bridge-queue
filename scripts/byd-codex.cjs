'use strict';

const { spawn } = require('node:child_process');

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function remoteWorkingDirectory(cwd) {
  if (!cwd || cwd === '~') return '"$HOME"';
  if (cwd.startsWith('~/')) {
    const segments = cwd.slice(2).split('/');
    if (segments.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Remote --cwd must not contain empty, . or .. path segments.');
    }
    return '"$HOME"/' + segments.map(shellQuote).join('/');
  }
  if (!cwd.startsWith('/')) {
    throw new Error('Remote --cwd must be an absolute path or start with ~/.');
  }
  return shellQuote(cwd);
}

function parseArgs(argv) {
  let cwd = '~';
  const promptParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--cwd') {
      if (!argv[index + 1]) throw new Error('--cwd requires a path.');
      cwd = argv[++index];
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      return { help: true };
    } else {
      promptParts.push(argv[index]);
    }
  }
  return { cwd, prompt: promptParts.length ? promptParts.join(' ') : null };
}

function run(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      io.stdout.write('Usage: node scripts/byd-codex.cjs [--cwd PATH] [PROMPT]\n');
      io.stdout.write('If PROMPT is omitted, read it from stdin. PATH may be absolute or ~/relative.\n');
      return 0;
    }
    const remoteCwd = remoteWorkingDirectory(options.cwd);
    if (options.prompt === null && io.stdin.isTTY) {
      throw new Error('Provide a prompt argument or pipe one through stdin.');
    }
    const command = `cd -- ${remoteCwd} && exec codex exec --sandbox workspace-write -`;
    const env = { ...process.env };
    // The mobile Codex launcher injects a private library path that can break
    // unrelated Termux binaries such as ssh.
    delete env.LD_LIBRARY_PATH;
    const child = spawn('ssh', ['-T', 'byd-central', command], {
      env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin.on('error', () => {});
    if (options.prompt !== null) {
      child.stdin.end(options.prompt);
    } else {
      io.stdin.pipe(child.stdin);
    }
    child.on('error', (error) => {
      io.stderr.write(`Unable to start SSH: ${error.message}\n`);
      io.exitCode = 1;
    });
    child.on('close', (code, signal) => {
      io.exitCode = code === null ? 1 : code;
      if (signal) io.stderr.write(`SSH ended after signal ${signal}.\n`);
    });
    return null;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  const result = run();
  if (result !== null) process.exitCode = result;
}

module.exports = { parseArgs, remoteWorkingDirectory, run, shellQuote };
