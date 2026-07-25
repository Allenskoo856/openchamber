import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import { registerHarnessRoutes } from './routes.js';
import { createHarnessRouter } from './router.js';
import {
  configureSessionBindings,
  resetSessionBindings,
  getSessionBinding,
} from './session-bindings.js';
import {
  createCanUseTool,
  resetPendingPermissions,
} from './translators/claude-code/permissions.js';

beforeAll(() => {
  configureSessionBindings({ persist: false, load: true });
});

afterEach(() => {
  resetSessionBindings();
  resetPendingPermissions();
  configureSessionBindings({ persist: false, load: true });
});

async function withServer(register, run) {
  const app = express();
  register(app);
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

describe('harness routes', () => {
  it('lists engines and returns 404 for unknown harness', async () => {
    await withServer((app) => {
      registerHarnessRoutes(app, {
        initBindings: false,
        detectAll: async () => ([
          { engine: { id: 'opencode' }, status: 'ready', sections: [] },
          { engine: { id: 'claude-code' }, status: 'missing-cli', sections: [] },
        ]),
        detectOne: async (id) => {
          if (id === 'claude-code') {
            return { engine: { id: 'claude-code' }, status: 'missing-cli', sections: [] };
          }
          return null;
        },
      });
    }, async (base) => {
      const list = await fetch(`${base}/api/harness`);
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.engines).toHaveLength(2);
      expect(body.engines[1].status).toBe('missing-cli');

      const missing = await fetch(`${base}/api/harness/nope`);
      expect(missing.status).toBe(404);

      const detect = await fetch(`${base}/api/harness/claude-code/detect`, { method: 'POST' });
      expect(detect.status).toBe(200);
      expect((await detect.json()).status).toBe('missing-cli');
    });
  });

  it('prompts with a mocked translator and keeps binding sticky', async () => {
    const broadcasts = [];
    const router = createHarnessRouter({
      getBroadcast: () => (payload, options) => {
        broadcasts.push({ payload, options });
      },
      claudeTranslator: {
        async prompt(body) {
          const { bindSession } = await import('./session-bindings.js');
          bindSession({
            sessionId: body.sessionId,
            harnessId: 'claude-code',
            directory: body.directory,
            target: body.target,
          });
          return {
            ok: true,
            sessionId: body.sessionId,
            harnessId: 'claude-code',
            messageId: body.messageId || 'msg_user',
            assistantMessageId: body.assistantMessageId || 'msg_assistant',
            status: 'started',
          };
        },
        async abort(body) {
          return { ok: true, sessionId: body.sessionId, aborted: false, reason: 'no-active-turn' };
        },
        async replyPermission() {
          return { ok: true };
        },
      },
    });

    await withServer((app) => {
      registerHarnessRoutes(app, { router, initBindings: false });
    }, async (base) => {
      const response = await fetch(`${base}/api/harness/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'ses_test',
          directory: '/tmp/project',
          target: { harnessId: 'claude-code', modelRef: 'sonnet' },
          text: 'hello',
        }),
      });
      expect(response.status).toBe(202);
      const json = await response.json();
      expect(json.ok).toBe(true);
      expect(getSessionBinding('ses_test')?.harnessId).toBe('claude-code');

      const bindingRes = await fetch(`${base}/api/harness/sessions/ses_test`);
      expect(bindingRes.status).toBe(200);
      expect((await bindingRes.json()).binding.harnessId).toBe('claude-code');

      const abortRes = await fetch(`${base}/api/harness/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses_test' }),
      });
      expect(abortRes.status).toBe(200);
      expect((await abortRes.json()).ok).toBe(true);
    });
  });

  it('rejects prompt validation errors from the router', async () => {
    const router = createHarnessRouter({
      claudeTranslator: {
        async prompt() {
          const error = new Error('Claude Code is not ready (missing-cli)');
          error.code = 'CLAUDE_MISSING_CLI';
          error.statusCode = 503;
          error.status = 'missing-cli';
          throw error;
        },
        async abort() {
          return { ok: true, aborted: false };
        },
        async replyPermission() {
          return { ok: true };
        },
      },
    });

    await withServer((app) => {
      registerHarnessRoutes(app, { router, initBindings: false });
    }, async (base) => {
      const response = await fetch(`${base}/api/harness/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'ses_x',
          directory: '/tmp/project',
          target: { harnessId: 'claude-code' },
          text: 'hi',
        }),
      });
      expect(response.status).toBe(503);
      const json = await response.json();
      expect(json.code).toBe('CLAUDE_MISSING_CLI');
    });
  });

  it('permission reply route resolves bridged canUseTool', async () => {
    const events = [];
    createCanUseTool({
      sessionId: 'ses_perm',
      directory: '/tmp/project',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'perm_route',
      timeoutMs: 5_000,
    })('Bash', { command: 'echo route' }, {});

    const router = createHarnessRouter({
      claudeTranslator: {
        async prompt() {
          return { ok: true };
        },
        async abort() {
          return { ok: true, aborted: false };
        },
        async replyPermission(body) {
          const { replyPermission } = await import('./translators/claude-code/permissions.js');
          return replyPermission(body);
        },
      },
    });

    await withServer((app) => {
      registerHarnessRoutes(app, { router, initBindings: false });
    }, async (base) => {
      const response = await fetch(`${base}/api/harness/permission/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'ses_perm',
          requestId: 'perm_route',
          reply: 'once',
          directory: '/tmp/project',
        }),
      });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toMatchObject({
        ok: true,
        sessionId: 'ses_perm',
        requestId: 'perm_route',
        reply: 'once',
      });
      expect(events.some((event) => event.type === 'permission.replied')).toBe(true);
    });
  });
});
