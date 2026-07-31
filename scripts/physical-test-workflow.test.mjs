import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('physical tests are manual, protected, and detached from release workflows', async () => {
  const [manual, release, mobileRelease, certification] = await Promise.all([
    read('.github/workflows/secure-workspace-physical-tests.yml'),
    read('.github/workflows/release.yml'),
    read('.github/workflows/mobile-release.yml'),
    read('.github/workflows/release-certification.yml'),
  ]);

  assert.match(manual, /workflow_dispatch:/);
  assert.doesNotMatch(manual, /pull_request:|\npush:|workflow_call:/);
  assert.match(manual, /runs-on: \[self-hosted, desktop-windows\]/);
  assert.match(manual, /runs-on: \[self-hosted, desktop-linux\]/);
  assert.match(manual, /runs-on: \[self-hosted, mobile-android\]/);
  assert.match(manual, /runs-on: \[self-hosted, mobile-ios\]/);
  assert.match(manual, /repos\/\$REPOSITORY\/actions\/runs\/\$SOURCE_RUN_ID/);
  assert.match(manual, /\[\[ '\$\{\{ github\.actor \}\}' == 'yulia-ivashko' \]\]/);

  assert.doesNotMatch(release, /desktop-windows-physical:|desktop-linux-physical:/);
  assert.doesNotMatch(mobileRelease, /runs-on: \[self-hosted, mobile-(?:ios|android)\]/);
  assert.doesNotMatch(certification, /physical-evidence|PHYSICAL_EVIDENCE/);
});
