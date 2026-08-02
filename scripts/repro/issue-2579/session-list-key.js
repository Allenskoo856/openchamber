// Reproduction (part 2) for issue #2579 — session list mismatch on network disks.
//
// The OpenChamber proxy canonicalizes `directory=` query params to their realpath
// (packages/web/server/lib/opencode/proxy.js createDirectoryQueryCanonicalizer)
// before forwarding to the OpenCode server. On Windows a mapped drive
// (`Y:\web_server`) realpaths to the UNC share (`\\server\share\web_server`), so
// OpenCode keys sessions under the UNC form. The UI, however, keeps the
// drive-letter spelling (`Y:/web_server`, see normalizePath in
// packages/ui/src/lib/pathNormalization.ts) as its directory store key. The two
// spellings never match, so the sessions OpenCode returns are not associated with
// the UI's directory and the list stays empty.
//
// On Linux we reproduce the identical mechanism with a symlink:
//   `/tmp/oc-repro-2579/link/web_server` (UI spelling) realpaths to
//   `/tmp/oc-repro-2579/real/web_server`.
//
// Run from the repo root:
//   node scripts/repro/issue-2579/session-list-key.js
import { createDirectoryQueryCanonicalizer } from '../../../packages/web/server/lib/opencode/proxy.js';
import fs from 'node:fs/promises';
import nodePath from 'node:path';

const root = '/tmp/oc-repro-2579';
const realProject = nodePath.join(root, 'real', 'web_server');
const linkProject = nodePath.join(root, 'link', 'web_server');

const main = async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(realProject, { recursive: true });
  await fs.mkdir(nodePath.dirname(linkProject), { recursive: true });
  await fs.symlink(realProject, linkProject, 'dir');

  // UI-spelling directory that the UI uses as its store key:
  const uiDirectory = linkProject; // analog of "Y:/web_server"
  // Server/OpenCode canonical (realpath) form:
  const canonicalDirectory = await fs.realpath(uiDirectory); // analog of "//server/share/web_server"

  console.log('UI directory store key (drive-letter analog):', uiDirectory);
  console.log('OpenCode canonical key (UNC/realpath analog) :', canonicalDirectory);
  console.log('keys match:', uiDirectory === canonicalDirectory, '\n');

  const canonicalize = createDirectoryQueryCanonicalizer({
    realpath: fs.realpath.bind(fs),
  });

  // The proxy rewrites the directory the UI sends to the canonical form:
  const rewritten = await canonicalize(`/session?directory=${encodeURIComponent(uiDirectory)}`);
  console.log('UI sends      : /session?directory=' + encodeURIComponent(uiDirectory));
  console.log('proxy rewrites: ' + rewritten);
  console.log('-> OpenCode stores/lists sessions under:', new URL(rewritten, 'http://localhost').searchParams.get('directory'), '\n');

  const match = rewritten.includes(encodeURIComponent(canonicalDirectory));
  console.log('proxy forwarded the canonical (realpath/UNC) form to OpenCode:', match);

  // Because OpenCode keys by the canonical form and the UI keys by the
  // drive-letter form, sessions created for this project are not visible in the
  // UI session list.
  const uiStoreKey = uiDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
  const openCodeKey = canonicalDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
  console.log('\nUI store key          :', uiStoreKey);
  console.log('OpenCode session key :', openCodeKey);
  console.log('session list match   :', uiStoreKey === openCodeKey, '  <-- false => empty session list');
};

main().catch((err) => { console.error(err); process.exit(1); });
