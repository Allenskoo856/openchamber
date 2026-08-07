'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');

console.log('[parent] NODE_CHANNEL_FD =', JSON.stringify(process.env.NODE_CHANNEL_FD));
const child = fork(path.join(__dirname, 'worker.cjs'), [], {
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});
const timeout = setTimeout(() => {
  console.error('[parent] TIMEOUT: worker never sent a message');
  child.kill('SIGKILL');
  process.exit(2);
}, 10000);
child.on('message', (m) => {
  clearTimeout(timeout);
  console.log('[parent] received message:', m);
  child.kill();
});
child.on('exit', (code, signal) => {
  if (code !== 0) {
    console.error('[parent] worker exited unexpectedly:', { code, signal });
    process.exit(1);
  }
});
