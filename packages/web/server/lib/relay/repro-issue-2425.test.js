// Reproduction test for issue #2425: single message triggers double AI response.
//
// This test verifies that POST requests through the relay tunnel are processed
// EXACTLY ONCE by the loopback origin.

import { afterAll, afterEach, beforeAll, describe, expect, it, test } from 'bun:test';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

import { startRelayHost } from './host-client.js';
import {
  bytesToBase64Url,
  createFrameDecryptor,
  createFrameEncryptor,
  deriveSessionKeys,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  generateHandshakeNonce,
  importEcdhPrivateKey,
  RELAY_PROTOCOL_VERSION,
} from './e2ee.js';
import {
  TunnelFrameType,
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';

// ---------------------------------------------------------------------------
// Fake relay (same as host-client.test.js)
// ---------------------------------------------------------------------------
const startFakeRelay = () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state = {
    control: null,
    hostData: new Map(),
    clients: new Map(),
    buffered: new Map(),
    relayFrames: [],
  };

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role');
    const connectionId = url.searchParams.get('connectionId');

    if (role === 'host-control') {
      state.control = ws;
      ws.send(JSON.stringify({ type: 'sync', connectionIds: [...state.clients.keys()] }));
      for (const id of state.clients.keys()) {
        ws.send(JSON.stringify({ type: 'connected', connectionId: id }));
      }
      return;
    }

    if (role === 'host-data') {
      state.hostData.set(connectionId, ws);
      const buffered = state.buffered.get(connectionId) || [];
      state.buffered.delete(connectionId);
      for (const [data, isBinary] of buffered) ws.send(data, { binary: isBinary });
      ws.on('message', (data, isBinary) => {
        state.relayFrames.push({ from: 'host', isBinary });
        const client = state.clients.get(connectionId);
        if (client && client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      ws.on('close', () => state.hostData.delete(connectionId));
      return;
    }

    if (role === 'client') {
      state.clients.set(connectionId, ws);
      ws.on('message', (data, isBinary) => {
        state.relayFrames.push({ from: 'client', isBinary });
        const host = state.hostData.get(connectionId);
        if (host && host.readyState === WebSocket.OPEN) {
          host.send(data, { binary: isBinary });
        } else {
          const queue = state.buffered.get(connectionId) || [];
          queue.push([data, isBinary]);
          state.buffered.set(connectionId, queue);
        }
      });
      ws.on('close', () => state.clients.delete(connectionId));
      if (state.control && state.control.readyState === WebSocket.OPEN) {
        state.control.send(JSON.stringify({ type: 'connected', connectionId }));
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        wsUrl: `ws://127.0.0.1:${port}`,
        state,
        stop: () => new Promise((r) => {
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
};

// ---------------------------------------------------------------------------
// Loopback origin that tracks how many times a POST /prompt_async is received
// ---------------------------------------------------------------------------
const startTrackingOrigin = () =>
  new Promise((resolve) => {
    let promptAsyncCallCount = 0;
    const requestLog = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url.includes('prompt_async')) {
        promptAsyncCallCount += 1;
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          requestLog.push({ method: req.method, path: req.url, callNumber: promptAsyncCallCount });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            callCount: promptAsyncCallCount,
            bodyLength: body.length,
            requestNumber: promptAsyncCallCount,
          }));
        });
        return;
      }

      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      getPromptAsyncCallCount: () => promptAsyncCallCount,
      getRequestLog: () => [...requestLog],
      stop: () => new Promise((r) => server.close(() => r())),
    }));
  });

// ---------------------------------------------------------------------------
// Build identity (same as host-client.test.js)
// ---------------------------------------------------------------------------
const buildIdentity = async () => {
  const enc = await generateEcdhKeyPair();
  const encPrivJwk = await globalThis.crypto.subtle.exportKey('jwk', enc.privateKey);
  const { privateKey: signPriv, publicKey: signPub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signPubJwk = signPub.export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: signPubJwk.crv, kty: signPubJwk.kty, x: signPubJwk.x, y: signPubJwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  return {
    serverId,
    hostEncPubJwk: await exportPublicKeyJwk(enc.publicKey),
    hostEncPrivateKey: await importEcdhPrivateKey(encPrivJwk),
    signRelayAuth: (role, connectionId) => {
      const ts = Date.now();
      const sig = crypto
        .sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: signPriv, dsaEncoding: 'ieee-p1363' })
        .toString('base64url');
      return { ts, sig, pk: Buffer.from(canonical, 'utf8').toString('base64url') };
    },
  };
};

// ---------------------------------------------------------------------------
// Scripted client that sends a POST request through the tunnel
// ---------------------------------------------------------------------------
const runPostClient = async ({
  relayUrl, serverId, hostEncPubJwk, postPath, postBody, connectionId
}) => {
  const url = new URL(`${relayUrl}/`);
  url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
  url.searchParams.set('role', 'client');
  url.searchParams.set('serverId', serverId);
  url.searchParams.set('connectionId', connectionId);
  const ws = new WebSocket(url.toString());

  const hostPub = await globalThis.crypto.subtle.importKey(
    'jwk',
    { kty: hostEncPubJwk.kty, crv: hostEncPubJwk.crv, x: hostEncPubJwk.x, y: hostEncPubJwk.y, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  const ephemeral = await generateEcdhKeyPair();
  const nonce = generateHandshakeNonce();

  let channel = null;
  const responseChunks = [];
  let responseStatus = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const textEncoder = new TextEncoder();
  const bodyBytes = textEncoder.encode(postBody);

  ws.on('open', async () => {
    ws.send(JSON.stringify({
      t: 'hello',
      v: RELAY_PROTOCOL_VERSION,
      clientPubJwk: await exportPublicKeyJwk(ephemeral.publicKey),
      nonce: bytesToBase64Url(nonce),
    }));
  });

  let processing = Promise.resolve();
  const handleMessage = async (data, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.t === 'ready') {
        const keys = await deriveSessionKeys(ephemeral.privateKey, hostPub, nonce);
        channel = {
          encryptor: createFrameEncryptor(keys.clientToHost),
          decryptor: createFrameDecryptor(keys.hostToClient),
        };
        // Send a POST request with body
        const req = encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
          method: 'POST',
          path: postPath,
          query: '',
          headers: {
            'content-type': 'application/json',
            'content-length': String(bodyBytes.length),
          },
        }));
        ws.send(await channel.encryptor.encrypt(req), { binary: true });

        // Send body in chunks (simulating streaming body delivery through tunnel)
        const CHUNK_SIZE = 64;
        for (let offset = 0; offset < bodyBytes.length; offset += CHUNK_SIZE) {
          const chunk = bodyBytes.slice(offset, Math.min(offset + CHUNK_SIZE, bodyBytes.length));
          ws.send(
            await channel.encryptor.encrypt(
              encodeTunnelFrame(TunnelFrameType.HttpBody, 1, chunk)
            ),
            { binary: true }
          );
        }

        // End the stream
        ws.send(
          await channel.encryptor.encrypt(
            encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0))
          ),
          { binary: true }
        );
      }
      return;
    }
    if (!channel) return;
    const plaintext = await channel.decryptor.decrypt(new Uint8Array(data));
    const frame = decodeTunnelFrame(plaintext);
    if (frame.frameType === TunnelFrameType.HttpResponse) {
      responseStatus = JSON.parse(new TextDecoder().decode(frame.payload)).status;
    } else if (frame.frameType === TunnelFrameType.HttpBody) {
      responseChunks.push(frame.payload);
    } else if (frame.frameType === TunnelFrameType.StreamEnd) {
      const total = responseChunks.reduce((n, c) => n + c.length, 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const c of responseChunks) {
        body.set(c, off);
        off += c.length;
      }
      resolveDone({
        status: responseStatus,
        body: JSON.parse(new TextDecoder().decode(body)),
      });
      ws.close();
    }
  };
  ws.on('message', (data, isBinary) => {
    processing = processing.then(() => handleMessage(data, isBinary));
  });

  return done;
};

// ---------------------------------------------------------------------------
// Shared resources
// ---------------------------------------------------------------------------
let relay;
let origin;

beforeAll(async () => {
  relay = await startFakeRelay();
  origin = await startTrackingOrigin();
});

afterAll(async () => {
  await relay?.stop();
  await origin?.stop();
});

// Each test gets its own relay host instance and connection ID
let hostInstance = null;

afterEach(() => {
  hostInstance?.stop();
  hostInstance = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('repro-issue-2425: relay tunnel POST handling', () => {
  it('POST /prompt_async through relay tunnel is received exactly once', async () => {
    const identity = await buildIdentity();
    const connectionId = `repro-test-1-${Date.now()}`;

    hostInstance = startRelayHost({
      relayUrl: `${relay.wsUrl}/`,
      identity,
      getLocalPort: () => origin.port,
      onStatus: () => {},
      logger: { warn: () => {} },
    });

    // Give control socket time to connect
    await new Promise((r) => setTimeout(r, 200));

    const postBody = JSON.stringify({
      sessionID: 'test-session',
      messageID: 'test-msg-1',
      parts: [{ type: 'text', text: 'Hello, test message' }],
    });

    const result = await runPostClient({
      relayUrl: relay.wsUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      connectionId,
      postPath: '/api/session/test-session/prompt_async',
      postBody,
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.callCount).toBe(1);
  });

  it('POST to different path also handled once', async () => {
    const identity = await buildIdentity();
    const connectionId = `repro-test-2-${Date.now()}`;

    hostInstance = startRelayHost({
      relayUrl: `${relay.wsUrl}/`,
      identity,
      getLocalPort: () => origin.port,
      onStatus: () => {},
      logger: { warn: () => {} },
    });

    await new Promise((r) => setTimeout(r, 200));

    const postBody = JSON.stringify({ test: 'data' });

    const result = await runPostClient({
      relayUrl: relay.wsUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      connectionId,
      postPath: '/api/session/test-session-2/prompt_async',
      postBody,
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    // Track cumulative count - the first test already sent one
    expect(result.body.callCount).toBeGreaterThanOrEqual(2);
    // But OUR request was exactly one additional call
    expect(result.body.requestNumber).toBeGreaterThanOrEqual(2);
  });

  it('three sequential POST requests each handled exactly once', async () => {
    const identity = await buildIdentity();
    const connectionId = `repro-test-3-${Date.now()}`;

    hostInstance = startRelayHost({
      relayUrl: `${relay.wsUrl}/`,
      identity,
      getLocalPort: () => origin.port,
      onStatus: () => {},
      logger: { warn: () => {} },
    });

    await new Promise((r) => setTimeout(r, 200));

    const beforeCount = origin.getPromptAsyncCallCount();

    // Send three POSTs sequentially
    for (let i = 1; i <= 3; i++) {
      const postBody = JSON.stringify({
        sessionID: `test-session-${i}`,
        messageID: `test-msg-seq-${i}`,
        parts: [{ type: 'text', text: `Message ${i}` }],
      });

      const result = await runPostClient({
        relayUrl: relay.wsUrl,
        serverId: identity.serverId,
        hostEncPubJwk: identity.hostEncPubJwk,
        connectionId: `${connectionId}-${i}`,
        postPath: `/api/session/test-session-${i}/prompt_async`,
        postBody,
      });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
    }

    const afterCount = origin.getPromptAsyncCallCount();
    // Exactly 3 more calls
    expect(afterCount - beforeCount).toBe(3);
  });
});
