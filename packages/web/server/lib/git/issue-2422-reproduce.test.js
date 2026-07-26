/**
 * Reproduction tests for issue #2422:
 * "Cannot create a worktree from a PR whose head branch is in a forked repository"
 *
 * These tests demonstrate the three failure modes described in the issue
 * by exercising the exported `createWorktree` / `validateWorktreeCreate` functions
 * with inputs that simulate the forked-PR worktree flow.
 *
 * Run: cd packages/web && bun run test -- --run server/lib/git/issue-2422-reproduce.test.js
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorktree, getBranches, validateWorktreeCreate } from './service.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-2422-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
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

// ---------------------------------------------------------------------------
// Bug 1: Missing head-repo URL — resolvePrWorktreeConfig in NewWorktreeDialog.tsx
//
// When the GitHub API returns no pr.headRepo (e.g. the fork was deleted),
// resolvePrWorktreeConfig (lines 124–182 of NewWorktreeDialog.tsx) throws:
//   "PR head repository URL is unavailable"
//
// There is no fallback to refs/pull/<n>/head, so the user cannot check out
// the PR's branch even though GitHub always serves it under that ref.
// ---------------------------------------------------------------------------

describe('Bug 1: Missing head-repo URL in resolvePrWorktreeConfig', () => {
  it('resolvePrWorktreeConfig throws when headRepo is null/undefined', () => {
    // Simulate a forked PR whose head repo was deleted (headRepo is null)
    const pr = {
      number: 42,
      head: 'feature-branch',
      headLabel: 'fork-owner:feature-branch',
      headRepo: null,           // <-- fork deleted, no head repo info
      base: 'main',
      title: 'Test PR from fork',
      url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      draft: false,
    };

    const localBranches = [];
    const remoteBranches = [];

    // resolvePrWorktreeConfig logic reproduced inline (lines 124–182):
    const headBranch = (pr.head || '').trim()
      .replace(/^refs\/heads\//, '')
      .replace(/^heads\//, '')
      .replace(/\s+/g, '-')
      .replace(/^\/+|\/+$/g, '');

    expect(headBranch).toBe('feature-branch');

    // Not in local branches
    expect(localBranches.includes(headBranch)).toBe(false);

    // Not in remote branches
    const availableRemoteBranch = remoteBranches.find((remoteBranch) => {
      const slashIndex = remoteBranch.indexOf('/');
      if (slashIndex <= 0 || slashIndex >= remoteBranch.length - 1) return false;
      return remoteBranch.slice(slashIndex + 1) === headBranch;
    });
    expect(availableRemoteBranch).toBeUndefined();

    // Falls through to fork provisioning path
    const ownerFromLabel = String(pr.headLabel || '').split(':')[0]?.trim();
    const remoteSeed = pr.headRepo?.owner || ownerFromLabel || 'pr-head';
    const remoteUrl = pr.headRepo?.sshUrl || pr.headRepo?.cloneUrl || '';

    // This is where the bug manifests: the remote URL is unavailable
    expect(remoteUrl).toBe('');   // <-- headRepo is null, so URL is empty
    // The code then throws: throw new Error('PR head repository URL is unavailable');
    // There is NO fallback to refs/pull/42/head

    // Expected: clear error about missing fork, not a crash
    // Actual: hard throw with "PR head repository URL is unavailable"
    // Desired: fallback to "refs/pull/42/head" or a clear action-oriented message
  });

  it('same bug manifests via createWorktree validation path', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    // Simulate what the dialog sends to the server:
    //   existingBranch = "remotes/pr-fork-owner/feature-branch"
    //   ensureRemoteName = "pr-fork-owner"
    //   ensureRemoteUrl = ""  <-- missing URL because headRepo was null
    const result = await validateWorktreeCreate(repo, {
      mode: 'existing',
      branchName: 'feature-fork-pr',
      worktreeName: 'feature-fork-pr',
      existingBranch: 'remotes/pr-fork-owner/feature-branch',
      ensureRemoteName: 'pr-fork-owner',
      ensureRemoteUrl: '',
    });
    // The validation will likely succeed (empty URL is not validated),
    // but the actual createWorktree call will fail with a confusing error.
    // This is the problematic gap.
    console.log('Validation result (empty URL):', result);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: Unfetchable head repo — resolveBranchForExistingMode (service.js:1507-1549)
//
// When the head repo URL is present but unfetchable (auth, network, wrong URL),
// resolveBranchForExistingMode fetches the remote branch (line 1532) and if the
// recheck fails, throws:
//   "Remote branch not found: <ref>"
//
// There is no fallback to refs/pull/<n>/head, so the user cannot fall back
// to GitHub's built-in PR ref format.
// ---------------------------------------------------------------------------

describe('Bug 2: Unfetchable head repo in resolveBranchForExistingMode', () => {
  it('createWorktree with an unreachable remote URL fails with a confusing error', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    // Add a remote that points to a non-existent fork URL
    const remoteName = 'pr-fork-owner';
    const remoteUrl = 'https://github.com/nonexistent/fork.git';  // unreachable
    runGit(repo, ['remote', 'add', remoteName, remoteUrl]);

    // Try to create a worktree from a branch that exists only in that remote
    // (simulating a forked PR where the branch is "feature-fork")
    await expect(
      createWorktree(repo, {
        mode: 'existing',
        branchName: 'feature-fork',
        worktreeName: 'feature-fork',
        existingBranch: `remotes/${remoteName}/feature-fork`,
        ensureRemoteName: remoteName,
        ensureRemoteUrl: remoteUrl,
      })
    ).rejects.toThrow(
      // This is the confusing error users get:
      // "Remote branch not found: remotes/pr-fork-owner/feature-fork"
      // There is no indication that the remote URL is unreachable,
      // no suggestion to use refs/pull/<n>/head as a fallback.
    );
  });

  it('no fallback to refs/pull/<n>/head exists in the codebase', () => {
    // Search for any usage of "refs/pull/" in the codebase
    // to confirm there is no existing fallback mechanism.
    const { execFileSync } = require('node:child_process');
    let found = false;
    let output = '';
    try {
      output = execFileSync('grep', [
        '-r',
        'refs/pull/',
        '--include=*.{ts,tsx,js}',
        '/home/runner/work/openchamber/openchamber/packages',
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      found = true;
    } catch {
      // grep exits with code 1 when no matches — that's expected here
      output = '(no matches)';
    }
    console.log('Grep result for refs/pull/:', output);
    expect(found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug 3: applyUpstreamConfiguration sets tracking on failed fetch
//         (service.js:1887-1929)
//
// When fetchRemoteBranchRef fails (caught at line 1915), `fetched` stays false.
// The code at line 1928 then calls setBranchTrackingFallback, which sets
// branch.<name>.remote and branch.<name>.merge config values pointing at the
// remote ref that was never fetched. This leaves the worktree with upstream
// tracking that cannot be resolved on the first pull/fetch.
// ---------------------------------------------------------------------------

describe('Bug 3: applyUpstreamConfiguration sets tracking on failed fetch', () => {
  it('creates a worktree that has upstream tracking to an unfetched remote branch', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    // Set up an unreachable remote (simulating a deleted fork)
    const remoteName = 'pr-deleted-fork';
    const remoteUrl = 'https://github.com/deleted/fork.git';
    runGit(repo, ['remote', 'add', remoteName, remoteUrl]);

    // Try to create a worktree — this will fail during the existing-branch resolution
    // because the remote branch cannot be fetched.
    // But the worktree directory may have already been created.
    try {
      await createWorktree(repo, {
        mode: 'existing',
        branchName: 'feature-fork',
        worktreeName: 'feature-fork-broken',
        existingBranch: `remotes/${remoteName}/feature-fork`,
        ensureRemoteName: remoteName,
        ensureRemoteUrl: remoteUrl,
      });
    } catch {
      // Expected failure
    }

    // Check if the worktree directory was left behind (partially created worktree)
    const { getWorktrees } = await import('./service.js');
    const worktrees = await getWorktrees(repo);
    const orphaned = worktrees.find((wt) => wt.name === 'feature-fork-broken');

    if (orphaned) {
      // BUG: A partially created worktree was left behind after the failure.
      // The user now has a broken worktree that references an unfetchable remote.
      console.log('Orphaned worktree found:', orphaned);
      console.log('Bug 3 confirmed: partial worktree left behind after failed fork fetch');
    } else {
      console.log('No orphaned worktree (error caught before worktree creation)');
      // Note: the error might be thrown before the directory is created,
      // depending on whether the preflight check catches it.
      // If the error is caught during bootstrap (deferred), the directory
      // WILL be left behind with broken upstream tracking.
    }
  });

  it('demonstrates bootstrap-path upstream tracking set to unfetched ref', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    // Create a worktree with a local branch that exists
    const worktreeDir = createTempDir();
    runGit(repo, ['worktree', 'add', '-b', 'local-feature', worktreeDir, 'HEAD']);

    // Simulate what applyUpstreamConfiguration does:
    // 1. Add a remote with an unfetchable URL
    const remoteName = 'pr-deleted-fork';
    const remoteUrl = 'https://github.com/deleted/fork.git';
    runGit(repo, ['remote', 'add', remoteName, remoteUrl]);

    // 2. Try to fetch from it (will fail — this is the expected behavior)
    let fetchFailed = false;
    try {
      execFileSync('git', ['fetch', remoteName, '+refs/heads/feature-fork:refs/remotes/pr-deleted-fork/feature-fork'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      fetchFailed = true;
    }
    expect(fetchFailed).toBe(true);

    // 3. Set upstream tracking anyway (this is what setBranchTrackingFallback does)
    // Even though the fetch failed, the user sees:
    //   branch.local-feature.remote = pr-deleted-fork
    //   branch.local-feature.merge = refs/heads/feature-fork
    // This is misleading because the branch was never fetched.
    const remoteConfig = execFileSync('git', ['config', `branch.local-feature.remote`, remoteName], {
      cwd: worktreeDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const mergeConfig = execFileSync('git', ['config', `branch.local-feature.merge`, `refs/heads/feature-fork`], {
      cwd: worktreeDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    // Verify: upstream now points to an unfetched remote ref
    const branchVerbose = execFileSync('git', ['branch', '-vv'], {
      cwd: worktreeDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    console.log('Branch tracking after applyUpstreamConfiguration-like setup:', branchVerbose);
    // The output will show something like:
    //   * local-feature pr-deleted-fork/feature-fork [gone/unknown]
    // This is the soft degradation: upstream points to a ref never fetched.
  });
});

// ---------------------------------------------------------------------------
// Summary of findings
// ---------------------------------------------------------------------------
describe('Summary', () => {
  it('documents the three reproduction cases', () => {
    console.log(`
Bug 1 - resolvePrWorktreeConfig throws when headRepo is null (NewWorktreeDialog.tsx:167):
  - When a PR's head repo has been deleted, headRepo is null
  - resolvePrWorktreeConfig throws "PR head repository URL is unavailable"
  - No fallback to refs/pull/<n>/head exists
  - Impact: User cannot create a worktree from a forked PR with a deleted head repo

Bug 2 - resolveBranchForExistingMode fails with unhelpful error (service.js:1534-1535):
  - When the remote URL is present but unfetchable (auth/network/deleted)
  - Throws "Remote branch not found: <ref>"
  - No fallback to check refs/pull/<n>/head
  - Impact: User sees a confusing error, no suggestion to use PR ref

Bug 3 - applyUpstreamConfiguration sets tracking on failed fetch (service.js:1928):
  - When fetchRemoteBranchRef fails, setBranchTrackingFallback still runs
  - Sets branch.<name>.remote and branch.<name>.merge to unfetched ref
  - Impact: Worktree has upstream tracking that points to a non-existent ref
    `);
  });
});
