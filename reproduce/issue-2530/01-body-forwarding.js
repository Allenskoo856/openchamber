/**
 * Reproduction script for issue #2530:
 * Mobile can list projects and sessions but fails to create session (400)
 * 
 * This test reproduces the exact middleware setup of OpenChamber's server
 * and verifies whether POST request bodies are correctly forwarded through
 * the proxy when the body parser skips /api/* paths.
 */

const http = require('node:http');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// ── Mock OpenCode upstream ──────────────────────────────────────────────
// This server mimics what OpenCode would receive after the proxy forwards
// the request. It records the method, path, headers, and body so we can
// verify whether the proxy forwarded correctly.
let capturedRequest = null;
let upstreamReadyResolve = null;
const upstreamReady = new Promise((resolve) => { upstreamReadyResolve = resolve; });

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    capturedRequest = {
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body: Buffer.concat(chunks).toString('utf8'),
    };
    console.log('[UPSTREAM] Received:', req.method, req.url);
    console.log('[UPSTREAM] Headers:', JSON.stringify(req.headers, null, 2));
    console.log('[UPSTREAM] Body:', capturedRequest.body);
    
    // Respond success
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: 'session-123', title: 'Test' }));
  });
});

upstream.listen(0, '127.0.0.1', () => {
  const port = upstream.address().port;
  console.log(`[UPSTREAM] Mock OpenCode listening on port ${port}`);
  upstreamReadyResolve(port);
});

// ── OpenChamber server (minimal reproduction) ───────────────────────────
async function main() {
  const upstreamPort = await upstreamReady;
  
  const app = express();
  
  // 1. Body parser: exactly like registerCommonRequestMiddleware
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/behavior')) {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > 1024 * 1024) {
        return res.status(413).json({ error: 'Content exceeds maximum size of 1048576 bytes' });
      }
      express.json({ limit: '1mb' })(req, res, next);
    } else if (
      req.path.startsWith('/api/config/agents') ||
      req.path.startsWith('/api/config/commands') ||
      req.path.startsWith('/api/config/mcp') ||
      req.path.startsWith('/api/config/snippets') ||
      req.path.startsWith('/api/config/settings') ||
      req.path.startsWith('/api/config/skills') ||
      req.path.startsWith('/api/config/plugins') ||
      req.path.startsWith('/api/projects') ||
      req.path.startsWith('/api/fs') ||
      req.path.startsWith('/api/git') ||
      req.path.startsWith('/api/magic-prompts') ||
      req.path.startsWith('/api/prompts') ||
      req.path.startsWith('/api/terminal') ||
      req.path.startsWith('/api/opencode') ||
      req.path.startsWith('/api/push') ||
      req.path.startsWith('/api/notifications') ||
      req.path.startsWith('/api/permission-auto-accept') ||
      req.path.startsWith('/api/session-folders') ||
      req.path.startsWith('/api/small-model') ||
      req.path.startsWith('/api/goals') ||
      req.path.startsWith('/api/text') ||
      req.path.startsWith('/api/voice') ||
      req.path.startsWith('/api/tts') ||
      req.path.startsWith('/api/openchamber/tunnel')
    ) {
      express.json({ limit: '50mb' })(req, res, next);
    } else if (req.path.startsWith('/api')) {
      // THIS IS THE KEY LINE: body parser is SKIPPED for /api/session, /api/session/* etc.
      console.log(`[BODY_PARSER] Skipping body parse for ${req.method} ${req.path}`);
      next();
    } else {
      express.json({ limit: '50mb' })(req, res, next);
    }
  });
  
  // 2. urlencoded parser (like at line 1089 of core-routes.js)
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  
  // 3. Logging middleware (like verboseRequestLogs)
  app.use((req, _res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.path}`);
    console.log(`[REQUEST] req.body is:`, req.body);
    console.log(`[REQUEST] content-type:`, req.headers['content-type']);
    console.log(`[REQUEST] content-length:`, req.headers['content-length']);
    next();
  });
  
  // 4. Proxy middleware (simplified version of what registerOpenCodeProxy does)
  const replayParsedBody = (proxyReq, req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.body === undefined || req.body === null) {
      console.log(`[REPLAY] req.body is ${req.body}, skipping replay`);
      return;
    }
    const body = req.body;
    console.log(`[REPLAY] Replaying body:`, JSON.stringify(body));
    const contentType = String(proxyReq.getHeader?.('content-type') || req.headers['content-type'] || '').toLowerCase();
    let buffer;
    if (Buffer.isBuffer(body)) {
      buffer = body;
    } else if (contentType.includes('application/json')) {
      buffer = Buffer.from(JSON.stringify(body));
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      buffer = Buffer.from(new URLSearchParams(body).toString());
    } else if (typeof body === 'string') {
      buffer = Buffer.from(body);
    } else {
      console.log(`[REPLAY] Unknown content-type: ${contentType}, skipping`);
      return;
    }
    console.log(`[REPLAY] Writing body to proxy request:`, buffer.toString());
    proxyReq.setHeader('content-length', String(buffer.length));
    proxyReq.write(buffer);
  };
  
  const apiProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${upstreamPort}`,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    on: {
      proxyReq: (proxyReq, req) => {
        console.log(`[PROXY_REQ] Forwarding ${req.method} ${req.url} -> /session`);
        replayParsedBody(proxyReq, req);
      },
      proxyRes: (proxyRes) => {
        console.log(`[PROXY_RES] Status: ${proxyRes.statusCode}`);
      },
      error: (err, req, res) => {
        console.error('[PROXY_ERROR]', err.message);
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Proxy error' }));
        }
      },
    },
  });
  
  // Important: the proxy middleware needs to handle POST /api/session
  // which matches /api/* and falls through to the generic proxy
  app.use('/api', apiProxy);
  
  // Start the server
  const server = app.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    console.log(`\n[OPENCHAMBER] OpenChamber server listening on port ${port}\n`);
    
    // Send test requests
    runTests(port, upstreamPort);
  });
}

// ── Test runner ─────────────────────────────────────────────────────────
async function runTests(serverPort, upstreamPort) {
  const testCases = [
    {
      name: 'GET /api/session (should work - no body)',
      method: 'GET',
      path: '/api/session',
    },
    {
      name: 'POST /api/session (create session)',
      method: 'POST',
      path: '/api/session',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentID: null, title: 'New Chat from Mobile', metadata: {} }),
    },
    {
      name: 'POST /api/session/some-id/prompt_async (send message)',
      method: 'POST',
      path: '/api/session/some-id/prompt_async',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageID: 'msg-1',
        parts: [{ type: 'text', text: 'Hello' }],
        model: { providerID: 'provider-1', modelID: 'model-1' },
      }),
    },
    {
      name: 'POST /api/config/agents (control group - body IS parsed)',
      method: 'POST',
      path: '/api/config/agents',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'test' }),
    },
  ];
  
  let allPassed = true;
  
  for (const tc of testCases) {
    console.log(`\n──── Test: ${tc.name} ────`);
    
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}${tc.path}`, {
        method: tc.method,
        headers: {
          ...(tc.headers || {}),
          'Content-Type': tc.headers?.['Content-Type'] || 'application/json',
        },
        body: tc.method === 'GET' ? undefined : (tc.body || undefined),
      });
      
      const responseBody = await response.text();
      console.log(`[CLIENT] Response ${response.status}: ${responseBody}`);
      
      // Check what the upstream received
      await new Promise((r) => setTimeout(r, 500));
      
      if (capturedRequest) {
        const upstreamBody = capturedRequest.body || '(empty)';
        console.log(`[VERIFY] Upstream received body:`, upstreamBody);
        
        if (tc.body) {
          const expectedBody = tc.body;
          const isJsonMatch = upstreamBody === expectedBody;
          console.log(`[VERIFY] Body match: ${isJsonMatch ? '✓ PASS' : '✗ FAIL'}`);
          if (!isJsonMatch) {
            console.log(`[VERIFY] Expected: ${expectedBody}`);
            console.log(`[VERIFY] Got:      ${upstreamBody}`);
            allPassed = false;
          }
        }
        capturedRequest = null;
      } else {
        console.log(`[VERIFY] No upstream request captured!`);
        if (tc.method === 'POST') {
          allPassed = false;
        }
      }
    } catch (err) {
      console.error(`[ERROR] Test failed:`, err.message);
      allPassed = false;
    }
  }
  
  console.log(`\n═══════════════════════════════════════`);
  console.log(`OVERALL: ${allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'}`);
  console.log(`═══════════════════════════════════════`);
  
  // Cleanup
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
