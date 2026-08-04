/**
 * Reproduction harness for issue #2627: "File tree only expands at depth 1".
 *
 * The right-panel file tree (SidebarFilesTree) is reported to only expand
 * depth-1 directories; directories nested inside an expanded directory do
 * not expand when clicked.
 *
 * This test mounts the real SidebarFilesTree against a minimal DOM stub and
 * an in-memory files API, then clicks a depth-1 directory and a depth-2
 * directory exactly like the user would in the desktop app.
 */

import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Mock the sync context so useEffectiveDirectory resolves to the directory
// store fallback without requiring a full SyncProvider/sdk.
mock.module('@/sync/sync-context', () => ({
  useSessionDirectory: () => undefined,
}));

import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SidebarFilesTree } from '../SidebarFilesTree';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore } from '@/stores/useGitStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';

// --- Minimal DOM stub ------------------------------------------------------

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  classList: FakeClassList;
  textContent: string;
  attributes: Record<string, string>;
  appendChild(c: FakeNode): FakeNode;
  insertBefore(c: FakeNode, ref: FakeNode | null): FakeNode;
  removeChild(c: FakeNode): FakeNode;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  [key: string]: unknown;
}

interface FakeDocument extends FakeNode {
  defaultView: FakeWindow;
  body: FakeNode;
  documentElement: FakeNode;
  createElement(tag: string): FakeNode;
  createElementNS(_: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  createRange(): unknown;
  getElementById(_: string): FakeNode | null;
  activeElement: FakeNode | null;
  visibilityState: string;
}

interface FakeWindow {
  document: FakeDocument;
  navigator: { userAgent: string; platform: string; maxTouchPoints: number };
  matchMedia(query: string): { matches: boolean; addEventListener(): void; removeEventListener(): void };
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
  getComputedStyle(): Record<string, unknown>;
  devicePixelRatio: number;
}

class FakeClassList {
  private readonly classes = new Set<string>();
  add(...c: string[]): void { c.forEach((x) => this.classes.add(x)); }
  remove(...c: string[]): void { c.forEach((x) => this.classes.delete(x)); }
  contains(c: string): boolean { return this.classes.has(c); }
  toggle(c: string): boolean {
    if (this.classes.has(c)) { this.classes.delete(c); return false; }
    this.classes.add(c); return true;
  }
  toString(): string { return [...this.classes].join(' '); }
}

function makeNode(tag: string, owner: FakeDocument): FakeNode {
  const style: Record<string, unknown> = {
    setProperty() { /* noop */ },
    getPropertyValue() { return ''; },
  };
  const node: FakeNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [],
    get children() { return this.childNodes; },
    style,
    classList: new FakeClassList(),
    attributes: {},
    document: owner,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
    setAttribute(name: string, value: string) { this.attributes[name] = value; this[name] = value; },
    setAttributeNS(ns: string, name: string, value: string) { this.attributes[`${ns}:${name}`] = value; this[name] = value; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    hasAttribute(name: string) { return name in this.attributes; },
    getAttribute(name: string) { return this.attributes[name] ?? null; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    dispatchEvent() { return true; },
    appendChild(c: FakeNode) { this.childNodes.push(c); c.parentNode = this; return c; },
    insertBefore(c: FakeNode, ref: FakeNode) {
      const i = this.childNodes.indexOf(ref);
      if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      return c;
    },
    removeChild(c: FakeNode) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    contains() { return false; },
    cloneNode() { return node; },
    compareDocumentPosition() { return 0; },
    focus() { /* noop */ },
    blur() { /* noop */ },
    click() { /* noop */ },
    getBoundingClientRect() {
      return { width: 100, height: 28, left: 0, top: 0, right: 100, bottom: 28, x: 0, y: 0, toJSON() { return {}; } };
    },
    textContent: '',
    innerHTML: '',
  };
  return node;
}

function collectText(node: FakeNode): string {
  let out = node.textContent || '';
  for (const child of node.childNodes ?? []) out += collectText(child as FakeNode);
  return out;
}

function installDomStub(): { document: FakeDocument; restore: () => void } {
  const document = {
    nodeType: 9,
    nodeName: '#document',
    tagName: '#document',
    parentNode: null,
    childNodes: [],
    style: {},
    classList: new FakeClassList(),
    attributes: {},
    setAttribute() { /* noop */ },
    getAttribute() { return null; },
    hasAttribute() { return false; },
    removeAttribute() { /* noop */ },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    dispatchEvent() { return true; },
    appendChild() { return undefined; },
    insertBefore() { return undefined; },
    removeChild() { return undefined; },
    getElementById() { return null; },
    visibilityState: 'visible',
    createRange() {
      return {
        setStart() { /* noop */ },
        setEnd() { /* noop */ },
        getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 }; },
      };
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeName: '#text', textContent: text, parentNode: null, childNodes: [] } as unknown as FakeNode;
    },
    createElement(tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createElementNS(_: string, tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    activeElement: null,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class { setSelectionRange() { /* noop */ } },
    HTMLTextAreaElement: class { setSelectionRange() { /* noop */ } },
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  } as unknown as FakeDocument;

  document.defaultView = {
    document: document as unknown as FakeDocument,
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    dispatchEvent() { return true; },
    getComputedStyle() { return {}; },
    event: undefined,
    devicePixelRatio: 1,
    setTimeout: (...args: unknown[]) => setTimeout(...(args as [() => void, number])),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    innerWidth: 1024,
    innerHeight: 768,
    location: { search: '', protocol: 'http:', hostname: 'localhost' },
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
    Element: class {},
    HTMLElement: class {},
  } as unknown as FakeWindow;
  (document.defaultView as unknown as FakeWindow).document = document as unknown as FakeDocument;

  document.body = makeNode('body', document as unknown as FakeDocument);
  document.documentElement = makeNode('html', document as unknown as FakeDocument);

  const g = globalThis as unknown as {
    document?: FakeDocument;
    window?: FakeWindow;
    navigator?: FakeWindow['navigator'];
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    ResizeObserver?: unknown;
    MutationObserver?: unknown;
    requestAnimationFrame?: unknown;
    cancelAnimationFrame?: unknown;
    Element?: unknown;
    HTMLElement?: unknown;
  };
  const previous = {
    document: g.document,
    window: g.window,
    navigator: g.navigator,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    ResizeObserver: g.ResizeObserver,
    MutationObserver: g.MutationObserver,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    Element: g.Element,
    HTMLElement: g.HTMLElement,
  };

  class NoopObserver {
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  }
  class ElementStub {}
  class HTMLElementStub {}
  g.ResizeObserver = NoopObserver;
  g.MutationObserver = NoopObserver;
  g.Element = ElementStub;
  g.HTMLElement = HTMLElementStub;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.document = document;
  g.window = document.defaultView;
  g.navigator = document.defaultView.navigator;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);

  return {
    document,
    restore() {
      g.document = previous.document;
      g.window = previous.window;
      g.navigator = previous.navigator;
      g.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT;
      g.ResizeObserver = previous.ResizeObserver;
      g.MutationObserver = previous.MutationObserver;
      g.requestAnimationFrame = previous.requestAnimationFrame;
      g.cancelAnimationFrame = previous.cancelAnimationFrame;
      g.Element = previous.Element;
      g.HTMLElement = previous.HTMLElement;
    },
  };
}

// --- In-memory files API ---------------------------------------------------

type Entry = { name: string; path: string; isDirectory: boolean };

const FS_TREE: Record<string, Entry[]> = {
  '/repo': [
    { name: 'a.txt', path: '/repo/a.txt', isDirectory: false },
    { name: 'src', path: '/repo/src', isDirectory: true },
    { name: 'docs', path: '/repo/docs', isDirectory: true },
  ],
  '/repo/src': [
    { name: 'index.ts', path: '/repo/src/index.ts', isDirectory: false },
    { name: 'components', path: '/repo/src/components', isDirectory: true },
  ],
  '/repo/src/components': [
    { name: 'Button.tsx', path: '/repo/src/components/Button.tsx', isDirectory: false },
    { name: 'Card.tsx', path: '/repo/src/components/Card.tsx', isDirectory: false },
  ],
  '/repo/docs': [
    { name: 'guide.md', path: '/repo/docs/guide.md', isDirectory: false },
  ],
};

const listCalls: string[] = [];

function createMockApis(opts: { delayMs?: number; relative?: boolean } = {}): RuntimeAPIs {
  const { delayMs = 0, relative = false } = opts;
  return {
    runtime: { platform: 'desktop', isDesktop: true, isVSCode: false },
    files: {
      async listDirectory(path: string) {
        listCalls.push(path);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const entries = (FS_TREE[path] ?? []).map((entry) => relative
          ? { name: entry.name, path: entry.name, isDirectory: entry.isDirectory }
          : entry);
        return { directory: path, entries };
      },
      async search() { return []; },
      async createDirectory() { return { success: true, path: '' }; },
      async writeFile() { return { success: true, path: '' }; },
      async delete() { return { success: true }; },
      async rename() { return { success: true, path: '' }; },
      async revealPath() { return { success: true }; },
      async downloadFile() { /* noop */ },
    },
    terminal: {} as RuntimeAPIs['terminal'],
    git: {} as RuntimeAPIs['git'],
    settings: {} as RuntimeAPIs['settings'],
    permissions: {} as RuntimeAPIs['permissions'],
    notifications: {} as RuntimeAPIs['notifications'],
    tools: {} as RuntimeAPIs['tools'],
  } as unknown as RuntimeAPIs;
}

// --- Tree traversal helpers ------------------------------------------------

function walk(node: FakeNode | null, visit: (n: FakeNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.childNodes ?? []) walk(child as FakeNode, visit);
}

/** Find the row <button> for a node path (its span carries title=path). */
function findRowButtonByPath(path: string): FakeNode | null {
  const root = (globalThis as unknown as { document: FakeDocument }).document.body as unknown as FakeNode;
  let found: FakeNode | null = null;
  walk(root, (node) => {
    if (found) return;
    if (node.nodeType !== 1 || node.tagName !== 'BUTTON') return;
    const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps'));
    if (!propsKey) return;
    const props = node[propsKey] as { onClick?: unknown };
    if (typeof props?.onClick !== 'function') return;
    let hasTitle = false;
    walk(node, (desc) => {
      if (desc.attributes?.title === path) hasTitle = true;
    });
    if (hasTitle) found = node;
  });
  return found;
}

function clickRowButton(path: string): void {
  const button = findRowButtonByPath(path);
  if (!button) throw new Error(`row button not found for path ${path}`);
  const propsKey = Object.keys(button).find((k) => k.startsWith('__reactProps'))!;
  const props = button[propsKey] as { onClick?: (e: unknown) => void };
  props.onClick?.({});
}

function rowExists(name: string): boolean {
  const root = (globalThis as unknown as { document: FakeDocument }).document.body as unknown as FakeNode;
  let found = false;
  walk(root, (node) => {
    if (found || node.nodeType !== 1 || node.tagName !== 'BUTTON') return;
    const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps'));
    if (!propsKey) return;
    const props = node[propsKey] as { onClick?: unknown };
    if (typeof props?.onClick !== 'function') return;
    if (collectText(node).trim() === name) found = true;
  });
  return found;
}

function dumpTreeTexts(): string[] {
  const root = (globalThis as unknown as { document: FakeDocument }).document.body as unknown as FakeNode;
  const out: string[] = [];
  walk(root, (node) => {
    if (node.nodeType !== 1 || node.tagName !== 'BUTTON') return;
    const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps'));
    if (!propsKey) return;
    const props = node[propsKey] as { onClick?: unknown };
    if (typeof props?.onClick !== 'function') return;
    out.push(collectText(node).trim());
  });
  return out;
}

// --- Tests ------------------------------------------------------------------

const scenario = (name: string, opts: { delayMs?: number; relative?: boolean; strictMode?: boolean }) => {
  test(`${name}: expanding a directory nested inside an expanded directory reveals its children`, async () => {
    const dom = installDomStub();
    try {
      // Reset shared stores to a known state.
      useFilesViewTabsStore.setState({ byRoot: {}, activeRuntimeKey: 'local', runtimeSnapshots: {} });
      useDirectoryStore.setState({ currentDirectory: '/repo' });
      useGitStore.setState({ directories: new Map() });
      useSessionUIStore.setState({ currentSessionId: null });
      useUIStore.setState({ contextPanelByDirectory: {} });
      useFileSearchStore.setState({ searchFiles: async () => [] });

      const container = dom.document.createElement('div');
      const bodyNode = dom.document.body as unknown as FakeNode;
      bodyNode.appendChild(container);
      const reactRoot: Root = createRoot(container as unknown as Element);

      const apis = createMockApis(opts);
      const tree = (
        <I18nProvider>
          <RuntimeAPIProvider apis={apis}>
            <SidebarFilesTree />
          </RuntimeAPIProvider>
        </I18nProvider>
      );

      const flush = async () => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, (opts.delayMs ?? 0) + 40));
        });
      };

      await act(async () => {
        reactRoot.render(opts.strictMode ? <React.StrictMode>{tree}</React.StrictMode> : tree);
      });
      await flush();

      // Root children are listed.
      expect(rowExists('a.txt')).toBe(true);
      expect(rowExists('src')).toBe(true);
      expect(rowExists('docs')).toBe(true);

      // 1) Expand depth-1 directory 'src'.
      await act(async () => {
        clickRowButton('/repo/src');
      });
      await flush();

      expect(rowExists('index.ts')).toBe(true);
      expect(rowExists('components')).toBe(true);

      // 2) Expand depth-2 directory 'components' (nested inside 'src').
      await act(async () => {
        clickRowButton('/repo/src/components');
      });
      await flush();

      const texts = dumpTreeTexts();
      expect(texts).toContain('Button.tsx');
      expect(texts).toContain('Card.tsx');

      // The children of the depth-2 dir must actually render.
      expect(rowExists('Button.tsx')).toBe(true);
      expect(rowExists('Card.tsx')).toBe(true);

      reactRoot.unmount();
    } finally {
      // Drain any React scheduler callbacks still queued against the fake DOM
      // before tearing the stub down (avoids late `window.event` reads).
      await new Promise((r) => setTimeout(r, 60));
      dom.restore();
    }
  });
};

describe('SidebarFilesTree depth expansion (issue #2627)', () => {
  scenario('absolute paths, instant load', {});
  scenario('absolute paths, 20ms load latency', { delayMs: 20 });
  scenario('absolute paths, 50ms load latency', { delayMs: 50 });
  scenario('absolute paths, instant load, StrictMode', { strictMode: true });
  scenario('absolute paths, 20ms latency, StrictMode', { delayMs: 20, strictMode: true });
  scenario('relative paths, instant load', { relative: true });
  scenario('relative paths, 20ms latency', { relative: true, delayMs: 20 });
});
