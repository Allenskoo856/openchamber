#!/usr/bin/env node
import path from 'node:path';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rebuild } from '@electron/rebuild';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const electronDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronDir, '..', '..');
const require = createRequire(import.meta.url);

const electronPkg = require('electron/package.json');
const electronVersion = electronPkg.version;
const targetArchitecture = resolveTargetArchitecture();

const copyDirectory = async (src, dst) => {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else {
      await fsp.copyFile(from, to);
    }
  }
};

const getWindowsShortPath = (target) => {
  if (process.platform !== 'win32') return target;
  try {
    const escaped = target.replace(/'/g, "''");
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder('${escaped}').ShortPath`],
      { encoding: 'utf8' },
    ).trim();
    return output || target;
  } catch {
    return target;
  }
};

const createWindowsRebuildPath = (target) => {
  if (process.platform !== 'win32') {
    return { buildPath: target, cleanup: () => {} };
  }

  for (const letter of 'ZYXWVUTSRQPONMLKJIHGFED') {
    const drive = `${letter}:`;
    if (existsSync(`${drive}\\`)) continue;
    try {
      execFileSync('subst.exe', [drive, target], { stdio: 'ignore' });
      return {
        buildPath: `${drive}\\`,
        cleanup: () => {
          try {
            execFileSync('subst.exe', [drive, '/d'], { stdio: 'ignore' });
          } catch {
            // Best-effort cleanup. The build result should not depend on this.
          }
        },
      };
    } catch {
      // Try the next drive letter.
    }
  }

  const shortPath = getWindowsShortPath(target);
  if (shortPath === target && /\s/.test(target)) {
    throw new Error(
      `Unable to create a space-free Windows rebuild path for ${target}. `
      + 'All subst drive letters are unavailable and the volume did not return an 8.3 short path.',
    );
  }

  return { buildPath: shortPath, cleanup: () => {} };
};

const getPythonVersion = () => {
  const pythonCommand = process.env.npm_config_python || process.env.PYTHON || 'python3';
  try {
    const output = execFileSync(
      pythonCommand,
      ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
      { encoding: 'utf8' },
    ).trim();
    const match = output.match(/^(\d+)\.(\d+)$/);
    if (!match) return null;
    return { command: pythonCommand, major: Number(match[1]), minor: Number(match[2]) };
  } catch {
    return null;
  }
};

const patchElectronNodeGypForPython37 = async () => {
  const python = getPythonVersion();
  if (!python || python.major > 3 || (python.major === 3 && python.minor >= 8)) {
    return async () => {};
  }

  let packageJsonPath;
  try {
    packageJsonPath = require.resolve('@electron/node-gyp/package.json');
  } catch {
    throw new Error(
      `Python ${python.major}.${python.minor} is too old for @electron/node-gyp, and its package path could not be resolved. `
      + 'Use Python 3.8+ for native Electron builds.',
    );
  }

  const commonPath = path.join(path.dirname(packageJsonPath), 'gyp', 'pylib', 'gyp', 'common.py');
  const original = await fsp.readFile(commonPath, 'utf8');
  const python37Compatible = original.replace(
    `    if CC := os.environ.get("CC_target") or os.environ.get("CC"):\n`
      + `        cmd += shlex.split(replace_sep(CC))\n`
      + `        if CFLAGS := os.environ.get("CFLAGS"):\n`
      + `            cmd += shlex.split(replace_sep(CFLAGS))\n`
      + `    elif CXX := os.environ.get("CXX_target") or os.environ.get("CXX"):\n`
      + `        cmd += shlex.split(replace_sep(CXX))\n`
      + `        if CXXFLAGS := os.environ.get("CXXFLAGS"):\n`
      + `            cmd += shlex.split(replace_sep(CXXFLAGS))\n`
      + `    else:\n`
      + `        return {}\n`,
    `    CC = os.environ.get("CC_target") or os.environ.get("CC")\n`
      + `    if CC:\n`
      + `        cmd += shlex.split(replace_sep(CC))\n`
      + `        CFLAGS = os.environ.get("CFLAGS")\n`
      + `        if CFLAGS:\n`
      + `            cmd += shlex.split(replace_sep(CFLAGS))\n`
      + `    else:\n`
      + `        CXX = os.environ.get("CXX_target") or os.environ.get("CXX")\n`
      + `        if CXX:\n`
      + `            cmd += shlex.split(replace_sep(CXX))\n`
      + `            CXXFLAGS = os.environ.get("CXXFLAGS")\n`
      + `            if CXXFLAGS:\n`
      + `                cmd += shlex.split(replace_sep(CXXFLAGS))\n`
      + `        else:\n`
      + `            return {}\n`,
  );

  if (python37Compatible === original) {
    throw new Error(
      `Python ${python.major}.${python.minor} is too old for this @electron/node-gyp version, `
      + 'but the known Python 3.7 compatibility block was not found. Use Python 3.8+ for native Electron builds.',
    );
  }

  await fsp.writeFile(commonPath, python37Compatible, 'utf8');
  console.log(`[electron] patched @electron/node-gyp for Python ${python.major}.${python.minor}`);
  return async () => {
    await fsp.writeFile(commonPath, original, 'utf8');
  };
};

const writeWindowsNodeAddonApiIndex = async (nodeAddonApiDir, exportedNodeAddonApiDir) => {
  if (process.platform !== 'win32') return;

  const shortDir = getWindowsShortPath(exportedNodeAddonApiDir);
  await fsp.writeFile(
    path.join(nodeAddonApiDir, 'index.js'),
    `const path = require('path');

const includeDir = ${JSON.stringify(shortDir)};

module.exports = {
  include: \`"${shortDir}"\`,
  include_dir: includeDir,
  gyp: path.join(includeDir, 'node_api.gyp:nothing'),
  targets: path.join(includeDir, 'node_addon_api.gyp'),
  isNodeApiBuiltin: true,
  needsFlag: false
};
`,
  );
};

const ensureWindowsNodeAddonApiForNodePty = async (rebuildRootPath) => {
  if (process.platform !== 'win32') return async () => {};

  const nodePtyPackagePath = require.resolve('node-pty/package.json');
  const nodePtyDir = path.dirname(nodePtyPackagePath);
  const rootNodeAddonApiDir = path.dirname(require.resolve('node-addon-api/package.json'));
  const tempNodeAddonApiDir = path.join(repoRoot, 'node_modules', '.openchamber-node-addon-api-7.1.1');
  const exportedTempNodeAddonApiDir = path.join(rebuildRootPath, 'node_modules', '.openchamber-node-addon-api-7.1.1');
  const localNodeAddonApiDir = path.join(nodePtyDir, 'node_modules', 'node-addon-api');

  await fsp.rm(tempNodeAddonApiDir, { recursive: true, force: true });
  await copyDirectory(rootNodeAddonApiDir, tempNodeAddonApiDir);
  await fsp.access(path.join(tempNodeAddonApiDir, 'package.json'));

  await fsp.rm(localNodeAddonApiDir, { recursive: true, force: true });
  await copyDirectory(rootNodeAddonApiDir, localNodeAddonApiDir);
  await writeWindowsNodeAddonApiIndex(localNodeAddonApiDir, exportedTempNodeAddonApiDir);
  await fsp.access(path.join(localNodeAddonApiDir, 'package.json'));

  return async () => {
    await fsp.rm(localNodeAddonApiDir, { recursive: true, force: true });
    await fsp.rm(tempNodeAddonApiDir, { recursive: true, force: true });
  };
};

console.log(`[electron] rebuilding native modules against Electron ${electronVersion}...`);

// Rebuild against the hoisted root node_modules (bun workspace layout).
// force=true re-links regardless of cached state; prebuild-install lookup is
// bypassed by @electron/rebuild in favor of direct node-gyp builds.
const rebuildPath = createWindowsRebuildPath(repoRoot);
let cleanupNodeAddonApi = async () => {};
let restorePython37Patch = async () => {};
try {
  restorePython37Patch = await patchElectronNodeGypForPython37();
  cleanupNodeAddonApi = await ensureWindowsNodeAddonApiForNodePty(rebuildPath.buildPath);
  await rebuild({
    buildPath: rebuildPath.buildPath,
    electronVersion,
    force: true,
    arch: targetArchitecture.electronBuilder,
    onlyModules: ['node-pty', 'bun-pty'],
  });
} finally {
  try {
    await restorePython37Patch();
  } finally {
    try {
      await cleanupNodeAddonApi();
    } finally {
      rebuildPath.cleanup();
    }
  }
}

console.log('[electron] native modules rebuilt successfully');
