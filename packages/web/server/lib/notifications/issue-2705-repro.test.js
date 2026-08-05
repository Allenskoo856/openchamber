import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';
import { createNotificationTriggerRuntime } from './runtime.js';
import { createPushRuntime } from './push-runtime.js';

// ---------------------------------------------------------------------------
// Reproduction for https://github.com/openchamber/openchamber/issues/2705
//
// "[Bug] Getting notifications on mobile even though the server is not reachable"
//
// Reported scenario:
//   - OpenChamber runs on a machine at home, reachable from outside only via VPN.
//   - User is actively using the web app from a WIN11 PC over the VPN.
//   - The phone (PWA) is on a different network and CANNOT reach the server.
//   - Every time an agent completes, the phone still shows a notification.
//
// Root cause this reproduction demonstrates:
//   - The phone PWA registers a web-push subscription (platform 'web' — a phone
//     browser reports 'web', see packages/ui/src/lib/platform.ts getClientPlatform()).
//   - On agent completion the server calls webPush.sendNotification() for every
//     stored subscription (server/lib/notifications/runtime.js -> fanoutPush ->
//     push-runtime.js sendPushToAllUiSessions).
//   - Delivery then goes over the internet push service (Google FCM endpoint),
//     NOT over any phone<->server connection. There is NO connectivity check in
//     the push path — the server never verifies that the phone can reach it.
//   - The only guard is the presence beacon: non-mobile ('web') subscriptions are
//     suppressed only while ANY UI client reported visible within the last 30s,
//     and a client only reports visible while its window is focused
//     (document.hasFocus(), see packages/ui/src/hooks/usePushVisibilityBeacon.ts).
// ---------------------------------------------------------------------------

const PHONE_PWA_ENDPOINT = 'https://fcm.googleapis.com/gcm/send/phone-pwa-subscription';

// An agent-completion event as emitted by the OpenCode watcher
// (message.updated with assistant finish 'stop').
const agentCompletionEvent = {
  type: 'message.updated',
  properties: {
    info: {
      sessionID: 'sess_home_agent',
      role: 'assistant',
      finish: 'stop',
      mode: 'agent',
      modelID: 'gpt-4o-mini',
      id: 'msg_1',
    },
  },
};

const baseSettings = {
  nativeNotificationsEnabled: true,
  notifyOnCompletion: true,
  notifyOnSubtasks: true,
  notifyOnError: true,
  notificationMode: 'hidden-only',
  notificationTemplates: {},
};

const phonePwaSubscription = {
  endpoint: PHONE_PWA_ENDPOINT,
  p256dh: 'p256dh-phone-pwa',
  auth: 'auth-phone-pwa',
  createdAt: 1,
  // A phone PWA reports 'web' (getClientPlatform() returns 'web' for any plain
  // browser — only the Capacitor shell reports 'ios'/'android').
  platform: 'web',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari',
};

const createFixtures = () => {
  const sendNotification = vi.fn(async () => {});

  const pushRuntime = createPushRuntime({
    fsPromises: {
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async () => JSON.stringify({
        version: 1,
        subscriptionsBySession: {
          'phone-ui-token': [phonePwaSubscription],
        },
      })),
      writeFile: vi.fn(async () => {}),
    },
    path: { dirname: () => '/tmp' },
    webPush: {
      generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
      sendNotification,
      setVapidDetails: vi.fn(),
    },
    PUSH_SUBSCRIPTIONS_FILE_PATH: '/tmp/push-subscriptions.json',
    readSettingsFromDiskMigrated: vi.fn(async () => baseSettings),
    writeSettingsToDisk: vi.fn(async () => {}),
  });

  const sendApnsToAllUiSessions = vi.fn(async () => {});

  const templateRuntime = createNotificationTemplateRuntime({
    readSettingsFromDisk: vi.fn(async () => baseSettings),
    buildOpenCodeUrl: vi.fn((route) => `http://127.0.0.1:1/opencode${route}`),
    getOpenCodeAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test' })),
    resolveGitBinaryForSpawn: vi.fn(),
  });

  const triggerRuntime = createNotificationTriggerRuntime({
    readSettingsFromDisk: vi.fn(async () => baseSettings),
    prepareNotificationLastMessage: vi.fn(async ({ message }) => typeof message === 'string' ? message : ''),
    buildTemplateVariables: vi.fn(async () => ({ agent_name: 'Agent', model_name: 'Gpt 4o Mini', session_name: 'home agent session' })),
    extractLastMessageText: vi.fn(() => 'The agent finished the work.'),
    fetchLastAssistantMessageText: vi.fn(async () => 'The agent finished the work.'),
    resolveNotificationTemplate: templateRuntime.resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage: templateRuntime.shouldApplyResolvedTemplateMessage,
    emitDesktopNotification: vi.fn(() => false),
    broadcastUiNotification: vi.fn(),
    sendPushToAllUiSessions: pushRuntime.sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    isAnyInteractiveClientVisible: pushRuntime.isAnyInteractiveClientVisible,
    buildOpenCodeUrl: vi.fn((route) => `http://127.0.0.1:1/opencode${route}`),
    getOpenCodeAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test' })),
    getIsWindowFocused: null,
  });

  return { pushRuntime, triggerRuntime, sendNotification, sendApnsToAllUiSessions };
};

describe('issue 2705 reproduction: notifications on mobile while the server is unreachable', () => {
  beforeEach(() => {
    // fetchSessionParentId / hasActiveSessionGoal queries the (unreachable)
    // opencode server. 404 makes both helpers fail open (return undefined/false),
    // which is exactly what happens when the server can't be reached.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends a web push to the phone PWA when the agent completes, even though the phone cannot reach the server', async () => {
    const { triggerRuntime, sendNotification } = createFixtures();
    // No client is visible: the phone is on another network (its beacon expired
    // long ago) and the PC client's window is not focused at completion time.
    // There is no connectivity check — push is sent to every stored subscription.

    await triggerRuntime.maybeSendPushForTrigger(agentCompletionEvent);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [subscription, payloadText] = sendNotification.mock.calls[0];
    expect(subscription.endpoint).toBe(PHONE_PWA_ENDPOINT);
    // Delivery goes through Google's push infrastructure, not through the phone's
    // (broken) connection to the home server:
    expect(PHONE_PWA_ENDPOINT).toMatch(/^https:\/\/fcm\.googleapis\.com/);
    const payload = JSON.parse(payloadText);
    expect(payload.title).toContain('Agent is ready');
    expect(payload.tag).toBe('ready-sess_home_agent');
  });

  it('still pushes to the phone while the user is "using" the PC if the PC window is not focused', async () => {
    const { pushRuntime, triggerRuntime, sendNotification } = createFixtures();

    // The user is using the web app from the PC over the VPN; the PC client
    // reports visible while its window is focused...
    pushRuntime.updateUiVisibility('pc-vpn-client', true, 'web');
    expect(pushRuntime.isAnyUiVisible()).toBe(true);

    // ...but the browser window is not focused at the moment the agent completes
    // (user alt-tabbed / another window is on top). The blur handler reports
    // visible=false (usePushVisibilityBeacon.ts: blur -> sendVisibility(false)),
    // so the 30s presence gate opens and the push leaks to the phone.
    pushRuntime.updateUiVisibility('pc-vpn-client', false, 'web');
    expect(pushRuntime.isAnyUiVisible()).toBe(false);

    await triggerRuntime.maybeSendPushForTrigger(agentCompletionEvent);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0].endpoint).toBe(PHONE_PWA_ENDPOINT);
  });

  it('suppresses the phone push only while the interactive client window stays focused (control)', async () => {
    const { pushRuntime, triggerRuntime, sendNotification } = createFixtures();

    // PC window visible AND focused at the moment the agent completes:
    pushRuntime.updateUiVisibility('pc-vpn-client', true, 'web');
    expect(pushRuntime.isAnyUiVisible()).toBe(true);

    await triggerRuntime.maybeSendPushForTrigger(agentCompletionEvent);

    expect(sendNotification).not.toHaveBeenCalled();
  });
});
