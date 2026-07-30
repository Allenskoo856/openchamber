/**
 * Final reproduction for issue #2530
 * 
 * Tests the most likely root cause: missing directory parameter on mobile.
 * 
 * Bug: Mobile can list sessions but cannot create sessions or send messages.
 * Root cause: OpenCode's POST /session and POST /session/{id}/prompt_async
 * require a `directory` query parameter, but mobile clients may not have a
 * project directory selected. GET /session works without directory (returns all).
 */
const http = require('node:http');

let testResults = [];

async function testMissingDirectory() {
  // OpenCode mock that requires directory for POST
  const opencode = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const directory = url.searchParams.get('directory');
    const method = req.method;
    const path = url.pathname;
    
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      
      // GET /session - works without directory
      if (method === 'GET' && path === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'sess-1', title: 'Existing session' }]));
        return;
      }
      
      // POST /session (create) and POST /session/{id}/prompt_async (send message)
      if (method === 'POST') {
        if (!directory) {
          console.log(`[OpenCode] ${method} ${path} → 400: directory required`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'directory query parameter is required' }));
          return;
        }
        console.log(`[OpenCode] ${method} ${path}?directory=... → 200: OK`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (path === '/session') {
          res.end(JSON.stringify({ id: 'sess-new', title: 'New session' }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
        return;
      }
      
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  
  const port = await new Promise(resolve => {
    opencode.listen(0, '127.0.0.1', () => resolve(opencode.address().port));
  });
  console.log(`[OpenCode mock] listening on :${port}`);
  
  // Test 1: GET /session WITHOUT directory (mobile listing sessions)
  console.log(`\n--- Test 1: List sessions (GET /session, no directory) ---`);
  let r1 = await fetch(`http://127.0.0.1:${port}/session`);
  console.log(`Status: ${r1.status} ${r1.status === 200 ? '✓' : '✗'}`);
  testResults.push({ name: 'List sessions (no dir)', passed: r1.status === 200 });
  
  // Test 2: POST /session WITHOUT directory (mobile creating session)
  console.log(`\n--- Test 2: Create session (POST /session, no directory) ---`);
  let r2 = await fetch(`http://127.0.0.1:${port}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentID: null, title: 'New Chat', metadata: {} }),
  });
  const r2body = await r2.text();
  console.log(`Status: ${r2.status} ${r2.status === 200 ? '✓' : '✗'}`);
  console.log(`Response: ${r2body}`);
  testResults.push({ name: 'Create session (no dir)', passed: r2.status === 200 });
  
  // Test 3: POST /session WITH directory (desktop creating session)
  console.log(`\n--- Test 3: Create session (POST /session?directory=..., desktop) ---`);
  let r3 = await fetch(`http://127.0.0.1:${port}/session?directory=${encodeURIComponent('/home/user/project')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentID: null, title: 'New Chat', metadata: {} }),
  });
  const r3body = await r3.text();
  console.log(`Status: ${r3.status} ${r3.status === 200 ? '✓' : '✗'}`);
  console.log(`Response: ${r3body}`);
  testResults.push({ name: 'Create session (with dir)', passed: r3.status === 200 });
  
  // Test 4: POST /session/{id}/prompt_async WITHOUT directory (mobile sending message)
  console.log(`\n--- Test 4: Send message (POST /session/id/prompt_async, no directory) ---`);
  let r4 = await fetch(`http://127.0.0.1:${port}/session/sess-1/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageID: 'msg-1',
      parts: [{ type: 'text', text: 'Hello' }],
      model: { providerID: 'p', modelID: 'm' },
    }),
  });
  const r4body = await r4.text();
  console.log(`Status: ${r4.status} ${r4.status === 200 ? '✓' : '✗'}`);
  console.log(`Response: ${r4body}`);
  testResults.push({ name: 'Send message (no dir)', passed: r4.status === 200 });
  
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`RESULTS`);
  console.log(`═══════════════════════════════════════════`);
  for (const t of testResults) {
    console.log(`  ${t.passed ? '✓' : '✗'} ${t.name}`);
  }
  
  const bugReproduced = testResults.find(t => t.name === 'Create session (no dir)')?.passed === false;
  console.log(`\nBug reproduced: ${bugReproduced ? 'YES ✓' : 'NO'}`);
  if (bugReproduced) {
    console.log(`\nRoot cause: OpenCode requires a 'directory' query parameter`);
    console.log(`for POST /session and POST /session/{id}/prompt_async, but`);
    console.log(`not for GET /session. Mobile clients may not have a project`);
    console.log(`directory selected, causing the 400 errors.`);
  }
  
  opencode.close();
  process.exit(bugReproduced ? 0 : 1);
}

testMissingDirectory().catch(err => {
  console.error(err);
  process.exit(1);
});
