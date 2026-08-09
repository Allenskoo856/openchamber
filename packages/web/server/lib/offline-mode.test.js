import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isOfflineAllowedUrl,
  isOfflineModeEnabled,
  shouldBlockExternalNetworkUrl,
} from './offline-mode.js';

test('offline mode is opt-in and recognizes supported truthy values', () => {
  assert.equal(isOfflineModeEnabled({}), false);
  assert.equal(isOfflineModeEnabled({ OPENCHAMBER_OFFLINE_MODE: '1' }), true);
  assert.equal(isOfflineModeEnabled({ OPENCHAMBER_DISABLE_EXTERNAL_NETWORK: 'true' }), true);
  assert.equal(isOfflineModeEnabled({ OPENCHAMBER_OFFLINE_MODE: '0' }), false);
});

test('offline policy allows loopback and private/internal model endpoints', () => {
  const environment = { OPENCHAMBER_OFFLINE_MODE: '1' };
  for (const url of [
    'http://127.0.0.1:4096',
    'http://192.168.10.20:8080/v1',
    'https://model-gateway.internal/v1',
    'ws://[fd00::10]:4096',
  ]) {
    assert.equal(isOfflineAllowedUrl(url, environment), true, url);
    assert.equal(shouldBlockExternalNetworkUrl(url, environment), false, url);
  }
});

test('offline policy blocks public destinations unless explicitly allowlisted', () => {
  const environment = { OPENCHAMBER_OFFLINE_MODE: '1' };
  assert.equal(shouldBlockExternalNetworkUrl('https://models.dev/api.json', environment), true);
  assert.equal(shouldBlockExternalNetworkUrl('wss://relay.openchamber.dev/ws', environment), true);
  assert.equal(
    shouldBlockExternalNetworkUrl('https://models.example/api.json', {
      ...environment,
      OPENCHAMBER_OFFLINE_ALLOWED_HOSTS: 'models.example',
    }),
    false,
  );
});
