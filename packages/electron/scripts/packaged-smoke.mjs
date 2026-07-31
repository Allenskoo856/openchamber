import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(electronRoot, 'dist');
const timeoutMs = Number(process.env.OPENCHAMBER_PACKAGED_SMOKE_TIMEOUT_MS || 90000);

const fail = (message) => { throw new Error(`[electron smoke] ${message}`); };
const firstExisting = (candidates) => candidates.find((candidate) => fs.existsSync(candidate));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const resolveApp = () => {
  if (process.env.OPENCHAMBER_PACKAGED_SMOKE_EXECUTABLE) return path.resolve(process.env.OPENCHAMBER_PACKAGED_SMOKE_EXECUTABLE);
  if (process.platform === 'darwin') {
    const appPath = firstExisting([path.join(dist, 'mac', 'OpenChamber.app'), path.join(dist, 'mac-arm64', 'OpenChamber.app')]);
    return appPath && path.join(appPath, 'Contents', 'MacOS', 'OpenChamber');
  }
  if (process.platform === 'win32') return firstExisting([path.join(dist, 'win-unpacked', 'OpenChamber.exe'), path.join(dist, 'win-arm64-unpacked', 'OpenChamber.exe')]);
  return firstExisting([path.join(dist, 'linux-unpacked', 'openchamber'), path.join(dist, 'linux-arm64-unpacked', 'openchamber')]);
};

const resolveResources = (executable) => process.platform === 'darwin'
  ? path.join(path.dirname(path.dirname(path.dirname(executable))), 'Resources')
  : path.join(path.dirname(executable), 'resources');

const assertResources = (resources) => {
  const plugin = path.join(resources, 'opencode-container-workspace', 'package.json');
  const cli = path.join(resources, 'opencode-cli', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  for (const [name, file] of [['workspace plugin', plugin], ['OpenCode CLI', cli]]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`missing bundled ${name}: ${file}`);
  }
};

const main = async () => {
  const executable = resolveApp();
  if (!executable) fail('packaged executable not found; package with --dir before running the smoke');
  const appImage = process.platform === 'linux' && executable.endsWith('.AppImage');
  if (!appImage) assertResources(resolveResources(executable));
  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-packaged-smoke-'));
  const marker = path.join(smokeDir, 'ready.json');
  const childEnv = { ...process.env, OPENCHAMBER_PACKAGED_SMOKE: '1', OPENCHAMBER_PACKAGED_SMOKE_DIR: smokeDir };
  const requireWorkspace = process.env.OPENCHAMBER_PACKAGED_SMOKE_WORKSPACE === '1';
  if (requireWorkspace) {
    const password = process.env.OPENCHAMBER_PACKAGED_SMOKE_PASSWORD;
    if (!password) fail('OPENCHAMBER_PACKAGED_SMOKE_PASSWORD is required for Secure Workspace validation');
    const dataDir = path.join(smokeDir, 'data');
    const projectDir = path.join(smokeDir, 'project');
    const isolatedHome = path.join(smokeDir, 'home');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dataDir, 'settings.json'), `${JSON.stringify({ desktopUiPassword: password })}\n`, { mode: 0o600 });
    childEnv.OPENCHAMBER_DATA_DIR = dataDir;
    childEnv.OPENCHAMBER_OPENCODE_CWD = projectDir;
    childEnv.OPENCHAMBER_PACKAGED_SMOKE_PROJECT = projectDir;
    childEnv.OPENCODE_CONFIG = path.join(dataDir, 'opencode.json');
    childEnv.DOCKER_CONFIG = path.join(dataDir, 'docker');
    childEnv.HOME = isolatedHome;
    if (process.platform === 'win32') {
      childEnv.USERPROFILE = isolatedHome;
      childEnv.APPDATA = path.join(isolatedHome, 'AppData', 'Roaming');
      childEnv.LOCALAPPDATA = path.join(isolatedHome, 'AppData', 'Local');
    }
  }
  if (process.platform === 'linux') {
    if (appImage) delete childEnv.APPIMAGE_EXTRACT_AND_RUN;
    else childEnv.APPIMAGE_EXTRACT_AND_RUN = '1';
  }
  const child = spawn(executable, [`--user-data-dir=${path.join(smokeDir, 'chromium')}`, '--openchamber-packaged-smoke'], { env: childEnv, stdio: 'ignore', windowsHide: true });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) {
        const result = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (result.serverReady !== true || result.rendererReady !== true) fail('invalid readiness marker');
        if (requireWorkspace && (result.workspaceReady !== true || result.cleanupComplete !== true)) fail('invalid Secure Workspace marker');
        const evidencePath = process.env.OPENCHAMBER_PHYSICAL_DESKTOP_EVIDENCE;
        if (evidencePath) {
          const commit = process.env.OPENCHAMBER_COMMIT || process.env.GITHUB_SHA;
          const version = process.env.OPENCHAMBER_VERSION;
          const artifact = process.env.OPENCHAMBER_PACKAGED_SMOKE_ARTIFACT;
          if (!/^[a-f0-9]{40}$/i.test(commit || '') || !version || !artifact) fail('physical desktop evidence identity is incomplete');
          fs.writeFileSync(evidencePath, `${JSON.stringify({
            schemaVersion: 1,
            commit,
            platform: process.platform === 'win32' ? 'windows' : process.platform,
            deviceClass: 'physical',
            version,
            artifactSha256: sha256(artifact),
            signerIdentity: process.env.OPENCHAMBER_PACKAGED_SMOKE_SIGNER || null,
            checksumVerified: process.env.OPENCHAMBER_PACKAGED_SMOKE_CHECKSUM_VERIFIED === '1',
            serverReady: true,
            rendererReady: true,
            secureWorkspaceFlow: result.workspaceReady === true ? 'passed' : 'not-run',
            cleanup: result.cleanupComplete === true ? 'passed' : 'not-run',
            completedAt: new Date().toISOString(),
          }, null, 2)}\n`, { mode: 0o600 });
        }
        child.kill();
        return;
      }
      if (child.exitCode !== null) fail(`packaged app exited before readiness with code ${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill();
    fail(`timed out after ${timeoutMs}ms waiting for server and renderer readiness`);
  } finally {
    child.kill();
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }
};

main().catch((error) => { console.error(error.message); process.exit(1); });
