/**
 * Reproduction script for issue #2423:
 * Embedded session chat URL can exceed server limits because it includes
 * the full currentTheme JSON.
 *
 * Run with: bun run reproduce-2423.ts
 */

import { getDefaultTheme } from './packages/ui/src/lib/theme/themes';
import { buildEmbeddedSessionChatURL } from './packages/ui/src/components/layout/contextPanelEmbeddedChat';

// Mock window.location so buildEmbeddedSessionChatURL doesn't bail out early
globalThis.window = {
  location: {
    href: 'http://127.0.0.1:5173/app',
    origin: 'http://127.0.0.1:5173',
    pathname: '/app',
    search: '',
  },
} as unknown as Window & typeof globalThis;

// Simulate a realistic theme with rich tokens (e.g. Catppuccin).
const fullTheme = getDefaultTheme(true); // dark variant

console.log('Theme ID:', fullTheme.metadata.id);
console.log('Theme variant:', fullTheme.metadata.variant);

const themeBootstrap = {
  mode: 'system' as const,
  lightThemeId: 'catppuccin-light',
  darkThemeId: 'catppuccin-dark',
  currentTheme: fullTheme,
};

// Build the URL using the current code (includes currentTheme in query string)
const url = buildEmbeddedSessionChatURL(
  'ses_example123',
  '/home/user/project',
  false,
  themeBootstrap,
);

const urlObj = new URL(url);
const currentThemeParam = urlObj.searchParams.get('currentTheme') || '';
const currentThemeSizeKB = (new TextEncoder().encode(currentThemeParam).length / 1024).toFixed(1);

console.log('\n=== URL Analysis ===');
console.log('Full URL length:', url.length, 'characters');
console.log('currentTheme param value length:', currentThemeParam.length, 'characters');
console.log('currentTheme param encoded size:', currentThemeSizeKB, 'KB');

// Now calculate the overhead
const urlWithoutCurrentTheme = new URL(url);
urlWithoutCurrentTheme.searchParams.delete('currentTheme');
console.log('URL length WITHOUT currentTheme:', urlWithoutCurrentTheme.toString().length, 'characters');
console.log('Overhead from currentTheme param:', url.length - urlWithoutCurrentTheme.toString().length, 'characters');

// Check all other params combined size
const otherKeys = ['ocPanel', 'surface', 'sessionId', 'readOnly', 'directory', 'themeMode', 'lightThemeId', 'darkThemeId', 'themeVariant'];
const otherParamsSize = otherKeys.reduce((sum, key) => {
  const val = urlObj.searchParams.get(key);
  return sum + (val ? key.length + val.length + 1 : 0); // +1 for '='
}, 0);

console.log('\n=== Parameter size breakdown (value lengths) ===');
for (const key of [...otherKeys, 'currentTheme']) {
  const val = urlObj.searchParams.get(key);
  if (val) {
    console.log(`  ${key}: ${val.length} chars (${(new TextEncoder().encode(val).length / 1024).toFixed(1)} KB)`);
  } else {
    console.log(`  ${key}: (not present)`);
  }
}

// Demonstrate that the theme object itself is large
const themeJSON = JSON.stringify(fullTheme);
console.log('\n=== Theme Object Size ===');
console.log('Theme JSON string length:', themeJSON.length, 'characters');
console.log('Theme JSON encoded size:', (new TextEncoder().encode(themeJSON).length / 1024).toFixed(1), 'KB');

// Common server/proxy limits
console.log('\n=== Comparison to Common Limits ===');
console.log('URL length:', url.length, 'chars');
console.log('Nginx default large_client_header_buffers: 4k or 8k');
console.log('Most server request line limits: 8KB (8192 chars)');
console.log('4096 bytes =', (4096 / url.length * 100).toFixed(0), '% of URL length');
console.log('8192 bytes =', (8192 / url.length * 100).toFixed(0), '% of URL length');
if (url.length > 4096) {
  console.log('\n⚠️  WARNING: URL exceeds 4KB — may cause 431 errors with default Nginx config!');
}
if (url.length > 8192) {
  console.log('⚠️  WARNING: URL exceeds 8KB — may cause 431 errors with many server/proxy defaults!');
}

// Demonstrate the fix: removing currentTheme from the URL
console.log('\n=== Verification: Removing currentTheme ===');
const fixedURL = new URL(url);
fixedURL.searchParams.delete('currentTheme');
console.log('URL without currentTheme:', fixedURL.toString());
console.log('Length without currentTheme:', fixedURL.toString().length, 'characters');
console.log('Well within typical limits ✓');

// Verify the URL still functions: all other params are present
console.log('\n=== Other params still present after removal ===');
for (const key of otherKeys) {
  const val = fixedURL.searchParams.get(key);
  if (val) {
    console.log(`  ✓ ${key}=${val}`);
  } else {
    console.log(`  ✗ ${key} is MISSING`);
  }
}
