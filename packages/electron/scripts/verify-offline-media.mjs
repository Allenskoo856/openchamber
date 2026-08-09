import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..', 'dist', 'offline-media');

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const resolveMediaDir = (rawPath) => {
  const candidate = rawPath ? path.resolve(rawPath) : defaultRoot;
  if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  const children = fs.existsSync(candidate)
    ? fs.readdirSync(candidate, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  if (children.length !== 1) throw new Error(`Expected one offline media directory under ${candidate}`);
  return path.join(candidate, children[0].name);
};

const mediaDir = resolveMediaDir(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(mediaDir, 'manifest.json'), 'utf8'));
assert.equal(manifest.target, 'uos1070-debian10');
assert.equal(manifest.architecture, 'x86_64');
assert.equal(manifest.buildBaseline, 'debian:10');
assert.equal(manifest.offlineMode, true);

const appImagePath = path.join(mediaDir, manifest.appImage);
assert.ok(fs.existsSync(appImagePath), `Missing AppImage: ${appImagePath}`);
assert.ok((fs.statSync(appImagePath).mode & 0o111) !== 0, 'AppImage must be executable');
assert.equal(sha256(appImagePath), manifest.appImageSha256, 'AppImage checksum mismatch');
const iconPath = path.join(mediaDir, manifest.icon);
assert.ok(fs.existsSync(iconPath), `Missing desktop icon: ${iconPath}`);
assert.equal(sha256(iconPath), manifest.iconSha256, 'Desktop icon checksum mismatch');

const checksumLines = fs.readFileSync(path.join(mediaDir, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/);
assert.ok(checksumLines.some((line) => line.trim() === `${manifest.appImageSha256}  ${manifest.appImage}`), 'SHA256SUMS does not cover the AppImage');
assert.ok(checksumLines.some((line) => line.trim() === `${manifest.iconSha256}  ${manifest.icon}`), 'SHA256SUMS does not cover the desktop icon');

const installerPath = path.join(mediaDir, 'install.sh');
const installer = fs.readFileSync(installerPath, 'utf8');
assert.ok((fs.statSync(installerPath).mode & 0o111) !== 0, 'install.sh must be executable');
assert.match(installer, /OPENCHAMBER_OFFLINE_MODE=1/);
assert.match(installer, /APPIMAGE_EXTRACT_AND_RUN/);
assert.doesNotMatch(installer, /^\s*(?:curl|wget|git|npm|pnpm|bun|apt(?:-get)?|apk|yum|dnf|pip|docker|nc)\b/m, 'installer must not invoke a package/network tool');
assert.doesNotMatch(installer, /\|\s*(?:curl|wget|git|npm|pnpm|bun|apt(?:-get)?|apk|yum|dnf|pip|docker|nc)\b/m, 'installer must not pipe to a package/network tool');

for (const name of ['README.md', 'offline.env.example', 'uninstall.sh']) {
  assert.ok(fs.existsSync(path.join(mediaDir, name)), `Missing media file: ${name}`);
}

console.log(`[offline-media] verified ${mediaDir}`);
console.log(`[offline-media] ${manifest.appImage} sha256=${manifest.appImageSha256}`);
