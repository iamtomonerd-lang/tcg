#!/usr/bin/env node

import { spawn } from 'child_process';
import { platform } from 'os';
import http from 'http';

const PORT = 3000;
const URL = `http://localhost:${PORT}`;
const MAX_RETRIES = 60;
const RETRY_DELAY = 1000;

function openBrowser() {
  const isWindows = platform() === 'win32';
  const isMac = platform() === 'darwin';

  if (isWindows) {
    spawn('cmd', ['/c', `start "" "${URL}"`], { stdio: 'ignore' });
  } else if (isMac) {
    spawn('open', [URL], { stdio: 'ignore' });
  } else {
    spawn('xdg-open', [URL], { stdio: 'ignore' });
  }
}

function checkServerReady() {
  return new Promise((resolve) => {
    const req = http.get(URL, { timeout: 1000 }, (res) => {
      req.abort();
      resolve(true);
    });

    req.on('error', () => {
      resolve(false);
    });

    req.on('timeout', () => {
      req.abort();
      resolve(false);
    });
  });
}

async function waitForServer(retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    const isReady = await checkServerReady();
    if (isReady) {
      return true;
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
  }
  return false;
}

async function main() {
  console.log('🎮 Starting Battle Spirits AI...');
  console.log('📦 Building and starting server...');

  // Start the server (use shell on Windows for npm compatibility)
  const isWindows = platform() === 'win32';
  const server = spawn('npm', ['run', 'web'], {
    stdio: 'pipe',
    shell: isWindows,
  });

  let hasError = false;

  server.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  server.stderr.on('data', (data) => {
    process.stderr.write(data);
    hasError = true;
  });

  server.on('error', (err) => {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  });

  // Wait for server to be ready
  console.log('\n⏳ Waiting for server to be ready');
  const isReady = await waitForServer();

  if (!isReady) {
    console.error('\n❌ Server failed to start. Check error messages above.');
    server.kill();
    process.exit(1);
  }

  console.log('\n✅ Server is ready!\n');
  console.log(`✨ Opening browser at ${URL}...\n`);
  openBrowser();

  // Handle process termination
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    server.kill();
    process.exit(0);
  });
}

main().catch(console.error);
