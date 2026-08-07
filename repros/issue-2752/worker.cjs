'use strict';
// Mirrors node_modules/tinypool/dist/entry/process.js:12
const send = process.send.bind(process);
console.log('[worker] process.send bind OK, NODE_CHANNEL_FD=', JSON.stringify(process.env.NODE_CHANNEL_FD));
if (process.send) process.send('hello-from-worker');
else process.exit(1);
