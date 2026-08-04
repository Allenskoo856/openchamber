// Reproduction for https://github.com/openchamber/openchamber/issues/2609
//
// [Bug] Mobile Android: QR pairing fails on old devices whose WebView
// mis-parses openchamber:// links.
//
// Old Android System WebView builds (Chromium < 121) do not treat `//` after a
// non-special scheme (`openchamber:`) as an authority, so
//   new URL('openchamber://connect?v=2&p=...')  →  hostname: "", pathname: "//connect"
// while modern runtimes (Bun/Node/newer WebViews) report hostname: "connect".
//
// parsePairingConnectionPayload (packages/ui/src/lib/connectionPayload.ts)
// requires url.hostname === 'connect', so on those devices the identical QR
// string is rejected and the scan surfaces mobile.connect.scan.invalid.
//
// This test simulates the legacy WebView URL behavior and proves the same
// encoded (valid) payload parses fine in a modern URL environment but is
// rejected once the legacy parse is in effect.

import { afterEach, describe, expect, test } from 'bun:test';

import { parseConnectionPayload, scanConnectionQr } from '@/apps/mobileQrScan';
import {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
} from '@/lib/connectionPayload';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as const;

// Mimics Chromium < 121 (older Android System WebView) parsing for NON-special
// schemes: the authority is not consumed as a host, the whole `//connect` tail
// becomes the opaque path. Special schemes (http/https/ws/wss/...) still parse
// normally and are delegated to the real URL.
const LEGACY_SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);
const RealUrl = globalThis.URL;

function legacyWebViewUrl(this: unknown, input: string): URL {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (scheme && LEGACY_SPECIAL_SCHEMES.has(scheme)) return new RealUrl(input);
  if (!schemeMatch) throw new TypeError('Invalid URL');

  const rest = input.slice(schemeMatch[0].length);
  const hashIndex = rest.indexOf('#');
  const hash = hashIndex === -1 ? '' : rest.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const searchIndex = withoutHash.indexOf('?');
  const search = searchIndex === -1 ? '' : withoutHash.slice(searchIndex);
  const pathname = searchIndex === -1 ? withoutHash : withoutHash.slice(0, searchIndex);

  return {
    protocol: `${scheme}:`,
    hostname: '', // legacy WebView: no authority host for non-special schemes
    pathname, // legacy WebView: "//connect" stays in the path
    search,
    hash,
    searchParams: new URLSearchParams(search),
    toString: () => `${schemeMatch[0]}${pathname}${search}${hash}`,
  } as unknown as URL;
}

const installLegacyWebViewUrl = () => {
  Object.defineProperty(globalThis, 'URL', { configurable: true, value: legacyWebViewUrl });
};

const restoreUrl = () => {
  Object.defineProperty(globalThis, 'URL', { configurable: true, value: RealUrl });
};

describe('reproduce #2609: legacy WebView URL parsing rejects a valid pairing QR', () => {
  const validQr = encodePairingConnectionPayload(
    buildPairingConnectionPayload({
      pairingId: 'pair_2609',
      secret: 'one-time-secret',
      label: 'Desktop',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 20 },
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_2609', hostEncPubJwk, priority: 30 },
      ],
    }),
  );

  afterEach(() => {
    restoreUrl();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
  });

  test('modern URL environment parses the payload (hostname === "connect")', () => {
    expect(new URL(validQr).hostname).toBe('connect');
    expect(parsePairingConnectionPayload(validQr)?.pairingId).toBe('pair_2609');
  });

  test('legacy WebView resolves the link to hostname "" / pathname "//connect"', () => {
    installLegacyWebViewUrl();
    const legacy = new URL(validQr);
    expect(legacy.hostname).toBe('');
    expect(legacy.pathname).toBe('//connect');
    // Query is still intact, so only the hostname gate fails.
    expect(legacy.searchParams.get('v')).toBe('2');
    expect(legacy.searchParams.get('p')).toBeTruthy();
  });

  test('legacy WebView rejects the SAME valid payload (the reported bug)', () => {
    installLegacyWebViewUrl();
    // url.hostname !== 'connect' → parsePairingConnectionPayload returns null.
    expect(parsePairingConnectionPayload(validQr)).toBeNull();
    // The scan layer then treats the QR as not-an-OpenChamber-code.
    expect(parseConnectionPayload(validQr)).toBeNull();
  });

  test('Android scan surfaces { status: "invalid" } for the valid QR under legacy WebView', async () => {
    const listeners = new Map<string, (info: { barcodes?: Array<{ rawValue?: string }> }) => void>();
    const plugin = {
      requestPermissions: async () => ({ camera: 'granted' }),
      startScan: async () => {
        listeners.get('barcodesScanned')?.({ barcodes: [{ rawValue: validQr }] });
      },
      stopScan: async () => undefined,
      addListener: (event: string, cb: (info: { barcodes?: Array<{ rawValue?: string }> }) => void) => {
        listeners.set(event, cb);
        return Promise.resolve({ remove: () => undefined });
      },
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { Capacitor: { getPlatform: () => 'android', Plugins: { BarcodeScanner: plugin } } },
    });

    installLegacyWebViewUrl();
    // Bug: a valid pairing QR scanned on Android → invalid-code result.
    expect(await scanConnectionQr()).toEqual({ status: 'invalid' });

    restoreUrl();
    // Control: the same QR on a modern URL environment redeems as a pairing.
    const result = await scanConnectionQr();
    if (result.status !== 'pairing') throw new Error('expected pairing under modern URL');
    expect(result.pairing.pairingId).toBe('pair_2609');
  });
});
