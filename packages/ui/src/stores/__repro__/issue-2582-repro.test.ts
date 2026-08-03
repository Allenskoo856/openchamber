// Reproduction attempt for issue #2582: "Fail to add a project" in the VS Code extension.
//
// Hypothesis: In the VS Code runtime, `useProjectsStore.addProject()` returns `null`
// unconditionally (packages/ui/src/stores/useProjectsStore.ts), so the
// DirectoryExplorerDialog's finalizeSelection() path hits the
// "Failed to add project" toast every time.

// Simulate the VS Code runtime bootstrap config BEFORE the store module loads,
// mirroring packages/vscode/src/webviewHtml.ts which sets window.__VSCODE_CONFIG__.
(globalThis as Record<string, unknown>).window ??= globalThis;

import { describe, expect, mock, test } from "bun:test";

// VS Code runtime detection reads window.__VSCODE_CONFIG__ at module load time.
// Set it before importing the store.
const windowRef = globalThis.window as unknown as {
  __VSCODE_CONFIG__?: unknown;
  __OPENCHAMBER_LOCAL_ORIGIN__?: string;
};
windowRef.__VSCODE_CONFIG__ = {
  workspaceFolder: "/workspace/project-one",
  workspaceFolders: [{ name: "project-one", path: "/workspace/project-one" }],
};

// Transitive imports read window.location.search / navigator at load time.
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { href: "https://example.test/", search: "", pathname: "/", hash: "" },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { platform: "linux", userAgent: "bun-test", language: "en-US" },
});

// Some transitively-imported stores read localStorage at module load time.
const fakeStorage = (() => {
  let store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
})();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: fakeStorage,
});

// The store also calls opencodeClient.setDirectory and updateDesktopSettings on
// mutations; stub them out so the test only exercises addProject.
const noop = () => {};
const opencodeClientStub = new Proxy(
  {
    setDirectory: noop,
    getDirectory: () => null,
    getFilesystemHome: async () => null,
    getSystemInfo: async () => null,
    listLocalDirectory: async () => [],
    cloneRepository: async () => ({}),
    createDirectory: async () => {},
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      return noop;
    },
  },
);
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: opencodeClientStub,
}));
mock.module("@/lib/persistence", () => ({
  updateDesktopSettings: async () => {},
}));

const { useProjectsStore } = await import("@/stores/useProjectsStore");

describe("issue #2582: addProject in the VS Code runtime", () => {
  test("addProject returns null (project not added) even for a valid path", () => {
    const before = useProjectsStore.getState().projects.length;

    const added = useProjectsStore.getState().addProject("/home/user/my-project");

    // Bug: returns null and never adds the project, so the dialog shows
    // 'directoryExplorerDialog.toast.failedToAddProject' ("Failed to add project").
    expect(added).toBeNull();
    expect(useProjectsStore.getState().projects.length).toBe(before);
    expect(useProjectsStore.getState().projects.find((p) => p.path === "/home/user/my-project")).toBeFalsy();
  });

  test("addProject also rejects the currently open workspace folder", () => {
    const added = useProjectsStore.getState().addProject("/workspace/project-one");
    expect(added).toBeNull();
  });

  test("addProject keeps failing when the project list is empty (e.g. empty VS Code window)", () => {
    // When no projects exist (empty VS Code window with no workspace folder),
    // SessionDialogs auto-opens the DirectoryExplorerDialog (initial directory
    // prompt). Selecting a folder there still fails.
    useProjectsStore.setState({ projects: [], activeProjectId: null });
    expect(useProjectsStore.getState().projects).toEqual([]);

    const added = useProjectsStore.getState().addProject("/home/user/my-project");
    expect(added).toBeNull();
    expect(useProjectsStore.getState().projects).toEqual([]);
  });
});
