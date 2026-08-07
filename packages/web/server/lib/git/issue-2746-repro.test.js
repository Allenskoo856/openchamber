import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorktree, getWorktreeBootstrapStatus } from './service.js';

// ---------------------------------------------------------------------------
// Reproduction for https://github.com/openchamber/openchamber/issues/2746
//
// "[Bug] new worktree， Filename too long"
//
// When OpenChamber creates a worktree it places it in a fixed, deep location:
//   <XDG_DATA_HOME>/opencode/worktree/<40-char root commit hash>/<worktree name>
// and then populates it with `git reset --hard` (git worktree add
// --no-checkout + populateWorktreeWithLockRecovery). For repositories whose
// checked-out paths approach the OS path-length limit, the full path
// worktreeRoot + repo-relative path exceeds the limit and git aborts the
// checkout with:
//
//   error: unable to create file <relpath>: Filename too long
//   fatal: cannot create directory at '<relpath>': Filename too long
//   Command failed: git reset --hard
//
// On the reporter's Windows machine the limit is MAX_PATH (260), and the
// app-chosen deep worktree location (data dir + 40-char hash) tips the total
// path over it for repos with deeply nested files (the reported yudao file is
// ~173 chars, so data dir + hash + name + 173 easily exceeds 260).
//
// On Linux the same git failure occurs when a single path component exceeds
// NAME_MAX (255). This test drives the *actual* OpenChamber createWorktree
// flow against such a repo and asserts the observable bug: worktree creation
// succeeds, but the background bootstrap (git reset --hard) fails with
// "File name too long" and the worktree is left broken.
// ---------------------------------------------------------------------------

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-issue2746-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args, input) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('issue #2746 - new worktree fails with "Filename too long"', () => {
  it('leaves the worktree bootstrap failed when checkout paths exceed the OS path-length limit', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);

      // Commit a file whose path component exceeds NAME_MAX (255) without ever
      // materializing it on disk (the filesystem cannot create it). This is
      // the Linux equivalent of the reporter's Windows MAX_PATH failure: git
      // cannot create the file during checkout and reports ENAMETOOLONG.
      const longComponent = 'x'.repeat(300);
      const longPath = `server/${longComponent}/YudaoDataPermissionAutoConfiguration.java`;
      const blobHash = runGit(repo, ['hash-object', '-w', '--stdin'], '// test\n').trim();
      runGit(repo, ['update-index', '--add', '--cacheinfo', `100644,${blobHash},${longPath}`]);
      runGit(repo, ['commit', '-qm', 'init']);

      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-qm', 'add readme']);

      // OpenChamber worktree creation (same flow as POST /api/git/worktrees).
      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'issue-2746',
        branchName: 'openchamber/issue-2746',
      });
      expect(created.directoryCreated).toBe(true);

      // The API reports success, but the background bootstrap then runs
      // `git reset --hard` in the worktree, which fails exactly like the
      // issue log: "Filename too long" / "cannot create directory".
      await expect.poll(async () => {
        const status = await getWorktreeBootstrapStatus(created.path);
        return status?.status;
      }, { timeout: 10_000 }).toBe('failed');

      const status = await getWorktreeBootstrapStatus(created.path);
      expect(status?.error).toMatch(/file name too long|filename too long/i);

      // The worktree is left broken: git created the short paths (README.md,
      // server/) but aborted before the long component — the tree is
      // incomplete, exactly like the reporter's log (some files created,
      // then "cannot create directory ... Filename too long").
      const deepDir = path.join(created.path, 'server', longComponent);
      let deepDirExists = true;
      try {
        process.chdir(path.join(created.path, 'server'));
        deepDirExists = fs.existsSync(longComponent);
        process.chdir(created.path);
      } catch {
        deepDirExists = false;
        process.chdir(created.path);
      }
      expect(deepDirExists).toBe(false);
      // And git reports the worktree as dirty/broken: HEAD content is not on
      // disk, so `git status` in the worktree shows the deep file as deleted.
      expect(fs.existsSync(path.join(created.path, 'README.md'))).toBe(true);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });
});
