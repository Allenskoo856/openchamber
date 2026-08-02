// Reproduction for issue #2579 — sessions for a project on a network disk
// not shown in the list + `GET /api/fs/read` → 400 "Path is outside of active workspace".
//
// The reporter's scenario: a project directory reachable via two spellings of
// the same physical directory:
//   - OpenChamber uses  `Y:\web_server`            (drive letter form)
//   - OpenCode uses     `\\server\share\web_server` (UNC / realpath form)
// The workspace-boundary check in packages/web/server/lib/fs/routes.js compares
// raw `path.resolve`d strings, so a request that uses a different spelling than
// the resolved/realpath'd workspace root is rejected with 400.
//
// On Linux we reproduce the identical mechanism with a symlink:
//   `/tmp/oc-repro-2579/real/web_server` (realpath) vs
//   `/tmp/oc-repro-2579/link/web_server`  (alternate spelling)
//
// Run from the repo root:
//   node scripts/repro/issue-2579/fs-read.js
import { registerFsRoutes } from '../../../packages/web/server/lib/fs/routes.js';
import { createProjectDirectoryRuntime } from '../../../packages/web/server/lib/opencode/project-directory-runtime.js';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

const root = '/tmp/oc-repro-2579';
const realProject = nodePath.join(root, 'real', 'web_server');
const linkProject = nodePath.join(root, 'link', 'web_server');

const setup = async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(nodePath.join(realProject, '.openchamber'), { recursive: true });
  await fs.writeFile(nodePath.join(realProject, '.openchamber', 'openchamber.json'), '{}');
  // link -> real : alternate spelling of the same physical directory
  await fs.mkdir(nodePath.dirname(linkProject), { recursive: true });
  await fs.symlink(realProject, linkProject, 'dir');
  console.log('realPath :', realProject);
  console.log('linkPath :', linkProject);
  console.log('realpath of linkProject:', await fs.realpath(linkProject));
};

const normalizeDirectoryPath = (value) => value;
const settings = {
  // The project is stored the way OpenChamber stores it (the "Y:\web_server" form = link form).
  projects: [{ id: 'p1', path: linkProject }],
  activeProjectId: 'p1',
  lastDirectory: linkProject,
};

const runtime = createProjectDirectoryRuntime({
  fsPromises: fs,
  path: nodePath,
  normalizeDirectoryPath,
  readSettingsFromDiskMigrated: async () => settings,
  getReadSettingsFromDiskMigrated: () => async () => settings,
  sanitizeProjects: (projects) => projects,
});

const registerRead = async () => {
  const routes = new Map();
  const app = {
    get(routePath, handler) { routes.set(`GET ${routePath}`, handler); },
    post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
  };
  registerFsRoutes(app, {
    os: { homedir: () => os.homedir() },
    path: nodePath,
    fsPromises: fs,
    spawn: () => { throw new Error('no spawn in repro'); },
    crypto: globalThis.crypto,
    normalizeDirectoryPath,
    resolveProjectDirectory: (req) => runtime.resolveProjectDirectory(req),
    buildAugmentedPath: () => '',
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: nodePath.join(os.homedir(), '.config', 'openchamber'),
  });
  return routes.get('GET /api/fs/read');
};

const call = async (handler, query) => {
  const res = { statusCode: 200, body: null, headers: new Map(),
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    type() { return this; },
    send(payload) { this.body = payload; return this; },
    setHeader(n, v) { this.headers.set(n.toLowerCase(), v); return this; },
  };
  const req = { query, get: (header) => null };
  await handler(req, res);
  return res;
};

const main = async () => {
  await setup();
  const readHandler = await registerRead();

  // 1) The reporter's exact request: read the project-local openchamber.json via the
  //    "drive-letter" (link) spelling while the server resolves the workspace root
  //    to the realpath.
  const target = nodePath.join(linkProject, '.openchamber', 'openchamber.json');
  const res = await call(readHandler, { path: target });
  console.log('\n--- GET /api/fs/read?path=' + target);
  console.log('status:', res.statusCode, 'body:', JSON.stringify(res.body));
  console.log('matches reported error:', res.statusCode === 400 && res.body?.error === 'Path is outside of active workspace');

  // 2) Control: the same file requested via the realpath spelling succeeds.
  const realTarget = nodePath.join(realProject, '.openchamber', 'openchamber.json');
  const res2 = await call(readHandler, { path: realTarget });
  console.log('\n--- control GET /api/fs/read?path=' + realTarget);
  console.log('status:', res2.statusCode, 'body:', JSON.stringify(res2.body));

  // 3) Show the workspace root the server resolved to.
  const resolved = await runtime.resolveProjectDirectory({ get: () => null, query: {} });
  console.log('\nserver-resolved workspace root:', resolved);
};

main().catch((err) => { console.error(err); process.exit(1); });
