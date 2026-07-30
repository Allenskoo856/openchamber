/**
 * Verify body forwarding through the proxy with the exact middleware setup
 * from registerCommonRequestMiddleware.
 */
const http = require('node:http');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

async function main() {
  // OpenCode mock that records body
  let receivedBody = null;
  const opencode = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8');
      console.log(`[OpenCode] Received body: ${receivedBody}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  
  const upstreamPort = await new Promise(resolve => {
    opencode.listen(0, '127.0.0.1', () => resolve(opencode.address().port));
  });
  
  // OpenChamber server with exact middleware from core-routes.js
  const app = express();
  
  // Exact copy of registerCommonRequestMiddleware body parser
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/behavior')) {
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
      next();
    } else {
      express.json({ limit: '50mb' })(req, res, next);
    }
  });
  
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  
  app.use((req, _res, next) => {
    console.log(`[req.body] type=${typeof req.body}, value=${JSON.stringify(req.body)}`);
    next();
  });
  
  const apiProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${upstreamPort}`,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    on: {
      proxyReq: (proxyReq, req) => {
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        if (req.body !== undefined && req.body !== null) {
          const body = ct.includes('application/json')
            ? Buffer.from(JSON.stringify(req.body))
            : Buffer.from(String(req.body));
          proxyReq.setHeader('content-length', String(body.length));
          proxyReq.write(body);
          console.log(`[proxy] REPLAYED body: ${body.toString()}`);
        } else {
          console.log(`[proxy] req.body=${req.body}, raw stream will be piped by http-proxy`);
        }
      },
    },
  });
  
  app.use('/api', apiProxy);
  
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  
  const serverPort = server.address().port;
  
  console.log(`\n=== Test: POST /api/session with JSON body ===`);
  const testBody = JSON.stringify({ parentID: null, title: 'New Chat', metadata: {} });
  
  const r = await fetch(`http://127.0.0.1:${serverPort}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: testBody,
  });
  
  // Wait for response
  const respBody = await r.text();
  
  console.log(`\n=== Result ===`);
  console.log(`Client response: ${r.status} ${respBody}`);
  console.log(`OpenCode received body: ${receivedBody}`);
  console.log(`Body forwarded correctly: ${receivedBody === testBody ? 'YES ✓' : 'NO ✗'}`);
  
  opencode.close();
  server.close();
  process.exit(receivedBody === testBody ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
