#!/usr/bin/env node

import { spawn } from 'child_process';
import { platform } from 'os';
import { createServer } from 'http';

const PORT = 3000;
const URL = `http://localhost:${PORT}`;

function openBrowser() {
  const isWindows = platform() === 'win32';
  const isMac = platform() === 'darwin';

  let command;
  if (isWindows) {
    command = `start ${URL}`;
  } else if (isMac) {
    command = `open ${URL}`;
  } else {
    command = `xdg-open ${URL}`;
  }

  spawn(command, { shell: true, stdio: 'ignore' });
}

async function main() {
  console.log('🎮 Starting Battle Spirits AI...\n');

  // Start the server
  const server = spawn('npm', ['run', 'web'], {
    stdio: 'inherit',
    shell: true,
  });

  // Wait for server to start, then open browser
  setTimeout(() => {
    console.log(`\n✨ Opening browser at ${URL}...\n`);
    openBrowser();
  }, 3000);

  // Handle process termination
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    server.kill();
    process.exit(0);
  });
}

main().catch(console.error);
