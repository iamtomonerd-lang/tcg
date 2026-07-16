#!/usr/bin/env node

import { spawn } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 3000;
const URL = `http://localhost:${PORT}`;
const MAX_RETRIES = 120;
const RETRY_DELAY = 1000;

const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';

// Run a command and wait for it to finish.
// On Windows, npm is npm.cmd, so run through the shell as a single string.
function run(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      stdio: 'inherit',
      shell: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"${command}" exited with code ${code}`));
    });
  });
}

function openBrowser() {
  try {
    if (isWindows) {
      const child = spawn('cmd', ['/c', 'start', '', URL], { stdio: 'ignore', detached: true });
      child.on('error', () => {
        // Browser open failed, silently continue
      });
    } else if (isMac) {
      const child = spawn('open', [URL], { stdio: 'ignore', detached: true });
      child.on('error', () => {
        // Browser open failed, silently continue
      });
    } else {
      const child = spawn('xdg-open', [URL], { stdio: 'ignore', detached: true });
      child.on('error', () => {
        // Browser open failed, silently continue (expected in headless environments)
      });
    }
  } catch (err) {
    // Browser open failed, silently continue
  }
}

function checkServerReady() {
  return new Promise((resolve) => {
    const req = http.get(URL, { timeout: 1000 }, () => {
      req.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    if (await checkServerReady()) return true;
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
  }
  return false;
}

async function main() {
  console.log('🎮 Starting Battle Spirits AI...\n');

  // Install dependencies on first run
  if (!existsSync(join(__dirname, 'node_modules'))) {
    console.log('📦 First run: installing dependencies (this may take a few minutes)...\n');
    await run('npm install', __dirname);
  }
  if (!existsSync(join(__dirname, 'web', 'node_modules'))) {
    console.log('📦 First run: installing web dependencies (this may take a few minutes)...\n');
    await run('npm install', join(__dirname, 'web'));
  }

  // Build the web app if dist doesn't exist or is outdated
  const distPath = join(__dirname, 'web', 'dist');
  if (!existsSync(distPath)) {
    console.log('🔨 Building web application...\n');
    await run('npm run web:build', __dirname);
    console.log('✅ Web build complete!\n');
  }

  console.log('🚀 Starting server...\n');

  // Start the server (single command string avoids arg-escaping warnings)
  const server = spawn('tsx src/server.ts', {
    cwd: __dirname,
    stdio: 'inherit',
    shell: true,
  });

  server.on('error', (err) => {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  });

  server.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n❌ Server stopped with code ${code}. See errors above.`);
      process.exit(code);
    }
  });

  // Wait for server to be ready, then open browser
  console.log('⏳ Waiting for server to be ready');
  const isReady = await waitForServer();

  if (!isReady) {
    console.error('\n❌ Server did not start in time. Check error messages above.');
    server.kill();
    process.exit(1);
  }

  console.log('\n✅ Server is ready!');
  console.log(`✨ Opening browser at ${URL}...\n`);
  console.log('ℹ️  To stop the game, close this window or press Ctrl+C.\n');
  openBrowser();

  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    server.kill();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
