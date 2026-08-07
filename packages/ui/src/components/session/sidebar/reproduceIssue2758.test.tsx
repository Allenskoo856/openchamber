import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import type { Theme } from '@/types/theme';
import { ProjectHeaderIdentity } from './sortableItems';
import { formatProjectLabel } from './utils';

/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2758
 *
 * Bug: project names are always displayed lowercase in the sidebar project
 * headers regardless of the stored casing (e.g. `MyProject` shows as
 * `myproject`).
 *
 * Chain:
 *  1. The stored label is title-cased by formatProjectLabel() (casing kept).
 *  2. ProjectHeaderIdentity renders that label into a span that carries the
 *     Tailwind `lowercase` class (sortableItems.tsx line 96).
 *  3. The `lowercase` class compiles to `text-transform: lowercase`
 *     (verified against the installed tailwindcss@4.2.1), which forces every
 *     character to render lowercase no matter what casing was stored.
 */

// Minimal theme stub: ProjectHeaderIdentity only dereferences
// currentTheme when a custom projectIconImage is supplied, which this
// reproduction does not use. Cast is safe for the render path exercised here.
const mockTheme = {
  metadata: { id: 'mock', name: 'mock', description: '', version: '0', variant: 'light', tags: [] },
  colors: {
    primary: { base: '#000' },
    surface: {
      background: '#fff', foreground: '#000', muted: '#eee', mutedForeground: '#666',
      elevated: '#fff', elevatedForeground: '#000', overlay: '#fff', subtle: '#f5f5f5',
    },
    interactive: {
      border: '#ccc', borderHover: '#999', borderFocus: '#666', selection: '#aaa',
      selectionForeground: '#000', focus: '#000', focusRing: '#000', cursor: '#000',
      hover: '#eee', active: '#ddd',
    },
    status: {
      error: '#f00', errorForeground: '#fff', errorBackground: '#fdd', errorBorder: '#f00',
      warning: '#f80', warningForeground: '#fff', warningBackground: '#fec', warningBorder: '#f80',
      success: '#0a0', successForeground: '#fff', successBackground: '#dfd', successBorder: '#0a0',
      info: '#00f', infoForeground: '#fff', infoBackground: '#ddf', infoBorder: '#00f',
    },
    syntax: {
      base: { background: '#fff', foreground: '#000', comment: '#888', keyword: '#00f', string: '#0a0', number: '#f80', function: '#909', variable: '#000', type: '#0aa' },
    },
  },
} as unknown as Theme;

const mockThemeContext = {
  currentTheme: mockTheme,
  availableThemes: [mockTheme],
  setTheme: () => {},
  customThemesLoading: false,
  reloadCustomThemes: async () => {},
  isSystemPreference: false,
  setSystemPreference: () => {},
  themeMode: 'system',
  setThemeMode: () => {},
  lightThemeId: 'mock',
  darkThemeId: 'mock',
  setLightThemePreference: () => {},
  setDarkThemePreference: () => {},
} satisfies ThemeContextValue;

const renderProjectHeader = (label: string) =>
  renderToStaticMarkup(
    <ThemeSystemContext.Provider value={mockThemeContext}>
      <ProjectHeaderIdentity id="p1" projectLabel={label} projectIcon="folder" />
    </ThemeSystemContext.Provider>,
  );

describe('issue #2758: project label casing in sidebar project headers', () => {
  test('formatProjectLabel() preserves the stored casing of a custom name', () => {
    // User renames the project to `MyProject`.
    expect(formatProjectLabel('MyProject')).toBe('MyProject');
    // (It only prettifies auto-derived directory names.)
    expect(formatProjectLabel('my-project')).toBe('My Project');
  });

  test('ProjectHeaderIdentity renders the title-cased label into a span carrying the `lowercase` class', () => {
    const markup = renderProjectHeader(formatProjectLabel('MyProject'));

    // The DOM text keeps the stored casing...
    expect(markup).toContain('>MyProject</span>');

    // ...but the label span is forced to render lowercase by the Tailwind
    // `lowercase` class (text-transform: lowercase), which overrides any
    // casing the label carries.
    const labelSpan = markup.match(/<span[^>]*class="[^"]*lowercase[^"]*"[^>]*>MyProject<\/span>/);
    expect(labelSpan).not.toBeNull();
  });

  test('`lowercase` class semantics: text-transform: lowercase renders MyProject as myproject', () => {
    // Matches the compiled Tailwind v4 utility `.lowercase { text-transform: lowercase }`
    // (verified against tailwindcss@4.2.1 in this repo): every glyph is lowercased
    // regardless of the text content, which is exactly the reported symptom.
    const transformLowercase = (text: string) => text.toLowerCase();
    expect(transformLowercase('MyProject')).toBe('myproject');
  });
});
