/**
 * Reproduction script for issue #2476:
 * Model selection menu hover text illegible (white on white) in Dark High Contrast theme.
 *
 * Run with: bun run packages/ui/reproduce-2476.ts
 *
 * How it reproduces the bug:
 * 1. Simulates the VS Code "Dark High Contrast" theme palette
 * 2. Simulates the adapter logic that maps `toolbar.hoverBackground` (white) → `interactive.hover` (white)
 * 3. Shows that ModelPickerList uses `hover:bg-interactive-hover/50` without a hover text color
 * 4. Contrast calculation proves white text on the resulting hover background is illegible
 */

// ============================================================
// Step 1: VS Code Dark High Contrast palette (simplified)
// ============================================================

// In VS Code "Dark High Contrast":
//   toolbar.hoverBackground = #FFFFFF (white)
//   editorWidget.background  = #1E1E1E  (dark)
//   editor.foreground        = #FFFFFF  (white)
//   list.hoverBackground     = #51504F  (but toolbar.hoverBackground takes priority)
//
// The adapter (adapter.ts line 406) reads in this priority order:
//   hoverBg = read('toolbar.hoverBackground', read('chat.requestBubbleHoverBackground', read('list.hoverBackground', ...)))
// So when toolbar.hoverBackground is #FFFFFF, hoverBg = #FFFFFF

const vscodePalette = {
  kind: 'high-contrast' as const,
  colors: {
    // High contrast theme colors
    'toolbar.hoverBackground': '#FFFFFF',
    'editorWidget.background': '#1E1E1E',
    'editor.foreground': '#FFFFFF',
    'list.hoverBackground': '#51504F',
    'editor.background': '#000000',
    'sideBar.background': '#000000',
    'foreground': '#FFFFFF',
  },
};

// ============================================================
// Step 2: Simulate adapter surface/hover color resolution
// ============================================================

// Adapter line 349: isDark includes high-contrast
const isDark = ['dark', 'high-contrast'].includes(vscodePalette.kind); // true

// Adapter line 359: background
const background = vscodePalette.colors['sideBar.background'] ?? '#000000';

// Adapter line 365: elevated
const elevated = vscodePalette.colors['editorWidget.background'] ?? background;

// Adapter line 366: elevatedForeground (simplified - falls back to foreground)
const foreground = vscodePalette.colors['foreground'] ?? '#FFFFFF';
const elevatedForeground = foreground; // in this theme, editorWidget.foreground is not set, falls through to foreground

// Adapter line 406: hoverBg = toolbar.hoverBackground (takes priority)
const hoverBg = vscodePalette.colors['toolbar.hoverBackground']
  ?? vscodePalette.colors['list.hoverBackground']
  ?? '#332d28'; // default dark theme interactive.hover

// ============================================================
// Step 3: Simulate CSS output
// ============================================================
console.log('=== Color Flow (simulating adapter.ts + cssGenerator) ===\n');
console.log(`palette.kind:                      ${vscodePalette.kind}`);
console.log(`isDark:                            ${isDark}`);
console.log(`toolbar.hoverBackground:           ${vscodePalette.colors['toolbar.hoverBackground']}`);
console.log(`list.hoverBackground:              ${vscodePalette.colors['list.hoverBackground']}`);
console.log(`=`);
console.log(`--surface-elevated:                ${elevated}  (from editorWidget.background)`);
console.log(`--surface-elevated-foreground:     ${elevatedForeground}  (falls through to editor.foreground)`);
console.log(`--interactive-hover:               ${hoverBg}  (from toolbar.hoverBackground - THE PROBLEM!)`);
console.log('');

// ============================================================
// Step 4: Simulate ModelPickerList hover state
// ============================================================

// ModelPickerList.tsx line 607-612:
//   className={cn(
//     '... hover:bg-interactive-hover/50 ...',
//   )}
//
// No hover:text-* class is set, so text inherits color from parent:
// Dropdown Popup (dropdown-menu.tsx line 126-127):
//   backgroundColor: 'var(--surface-elevated)',
//   color: 'var(--surface-elevated-foreground)',

// With Tailwind CSS, `bg-interactive-hover/50` when --interactive-hover is #FFFFFF
// generates: color-mix(in srgb, #FFFFFF 50%, transparent)
// This renders as 50% opaque white over the surface-elevated background.

function hexToRgb(hex: string) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function alphaBlend(foregroundHex: string, opacity: number, backgroundHex: string) {
  const fg = hexToRgb(foregroundHex);
  const bg = hexToRgb(backgroundHex);
  return {
    r: Math.round(fg.r * opacity + bg.r * (1 - opacity)),
    g: Math.round(fg.g * opacity + bg.g * (1 - opacity)),
    b: Math.round(fg.b * opacity + bg.b * (1 - opacity)),
  };
}

function rgbToHex(rgb: { r: number; g: number; b: number }) {
  return `#${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`;
}

function relativeLuminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const [rl, gl, bl] = [r, g, b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(hex1: string, hex2: string) {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// The hover background = 50% white over the elevated surface
const hoverBackgroundBlended = alphaBlend(hoverBg, 0.5, elevated);
const hoverBackgroundHex = rgbToHex(hoverBackgroundBlended);

console.log('=== Hover State Colors ===\n');
console.log(`Normal row background:             ${elevated}  (--surface-elevated)`);
console.log(`Hover overlay:                     ${hoverBg} at 50% opacity`);
console.log(`Resulting hover background:        ${hoverBackgroundHex}`);
console.log(`Text color (unchanged on hover):   ${elevatedForeground}  (--surface-elevated-foreground)`);
console.log('');

const ratio = contrastRatio(elevatedForeground, hoverBackgroundHex);
console.log(`Contrast ratio (text vs hover bg): ${ratio.toFixed(2)}:1`);
console.log(`WCAG AA large text threshold:      3.0:1`);
console.log(`WCAG AA normal text threshold:     4.5:1`);
console.log(`WCAG AAA normal text threshold:    7.0:1`);
console.log('');

if (ratio < 3.0) {
  console.log('❌ REPRODUCED: Contrast ratio is below WCAG AA large text threshold (3.0:1).');
  console.log('   Text is illegible (white on white-ish background).');
} else if (ratio < 4.5) {
  console.log('❌ REPRODUCED: Contrast ratio fails WCAG AA for normal text (4.5:1).');
  console.log('   Text is hard to read, especially at small sizes.');
} else {
  console.log('✅ Contrast passes WCAG AA for normal text. Issue may depend on specific theme values.');
}
console.log('');

// ============================================================
// Step 5: Root cause summary
// ============================================================
console.log('=== Root Cause ===\n');
console.log('1. VS Code "Dark High Contrast" sets `toolbar.hoverBackground` to #FFFFFF (white).');
console.log('2. The adapter (adapter.ts:406) reads this as `interactive.hover` (priority over list.hoverBackground).');
console.log('3. CSS var `--interactive-hover` becomes white (#FFFFFF).');
console.log('4. ModelPickerList.tsx:609 uses `hover:bg-interactive-hover/50` (50% white overlay on hover).');
console.log('5. No hover text color is set, so text inherits `--surface-elevated-foreground` (also white in high contrast).');
console.log('6. Result: white/light text on a white-ish hover background → illegible.\n');
console.log('=== How to Fix ===\n');
console.log('Option A: Set an explicit hover text color in ModelPickerList.tsx hover style,');
console.log('         e.g., add `hover:text-foreground` or a dedicated contrast color.');
console.log('');
console.log('Option B: In the adapter, detect high-contrast themes and ensure');
console.log('         `interactive.hover` has sufficient contrast against');
console.log('         `surface-elevated-foreground` (e.g., by using a darker fallback).');
console.log('');
console.log('Option C: Add a `hoverForeground` token to InteractiveColors and use it in hover styles.');
