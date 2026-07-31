import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';

// Issue #2546 (server layer): "Renaming a skill wipes its content".
//
// The UI rename flow (`SkillsSidebar.tsx` `handleRenameSkill`) performs:
//   1. GET /api/config/skills/<old>  → full detail fetched, then discarded
//   2. POST /api/config/skills/<new> with body
//      `{ name, description: 'Renamed skill', scope, source }`  ← no `instructions`
//   3. DELETE /api/config/skills/<old>
//
// Server-side `createSkill` writes SKILL.md via
// `writeMdFile(targetPath, frontmatter, instructions || '')`, so the payload
// sent by the rename flow produces a SKILL.md with minimal frontmatter and an
// EMPTY body. This test replays the exact sequence the UI performs against the
// real server functions and asserts the resulting file-level data loss.

const ORIGINAL_DESCRIPTION = 'Original detailed description';
const ORIGINAL_INSTRUCTIONS = [
  '# My skill',
  '',
  '## Usage',
  '',
  'Run this skill when the user asks about widgets.',
  '',
  '1. First step',
  '2. Second step with **markdown** formatting',
  '',
].join('\n');

let tempHome = '';
let originalHome;

describe('issue-2546: rename flow leaves the renamed SKILL.md with minimal content', () => {
  beforeAll(async () => {
    tempHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-issue2546-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await fsPromises.rm(tempHome, { recursive: true, force: true });
  });

  it('replays the UI rename sequence and shows the SKILL.md body is wiped', async () => {
    // Import after pointing HOME at the temp dir so all user config paths
    // (~/.config/opencode/skills, ~/.agents/skills, ~/.claude/skills) are isolated.
    const { createSkill, deleteSkill, getSkillSources } = await import('./skills.js');

    const originalSkillPath = path.join(tempHome, '.config', 'opencode', 'skills', 'my-skill', 'SKILL.md');
    const renamedSkillPath = path.join(tempHome, '.config', 'opencode', 'skills', 'my-skill-renamed', 'SKILL.md');

    // Step 0: the user has a skill with non-trivial content.
    createSkill(
      'my-skill',
      { name: 'my-skill', description: ORIGINAL_DESCRIPTION, instructions: ORIGINAL_INSTRUCTIONS },
      null,
      'user',
    );

    const originalContent = await fsPromises.readFile(originalSkillPath, 'utf8');
    expect(originalContent).toContain(ORIGINAL_DESCRIPTION);
    expect(originalContent).toContain('Run this skill when the user asks about widgets.');

    // Step 1+2 of the UI rename flow: create the new skill with exactly the
    // payload `handleRenameSkill` sends — hardcoded description, no
    // instructions — then delete the old skill.
    createSkill(
      'my-skill-renamed',
      { name: 'my-skill-renamed', description: 'Renamed skill', source: 'opencode' },
      null,
      'user',
    );
    deleteSkill('my-skill', null);

    // Old skill (with the full content) is gone.
    await expect(fsPromises.access(originalSkillPath)).rejects.toThrow();

    // The renamed SKILL.md exists…
    const renamedContent = await fsPromises.readFile(renamedSkillPath, 'utf8');
    expect(renamedContent).toContain('description: Renamed skill');

    // …but the original body content is GONE (wiped).
    expect(renamedContent).not.toContain(ORIGINAL_DESCRIPTION);
    expect(renamedContent).not.toContain('Run this skill when the user asks about widgets.');
    expect(renamedContent).not.toContain('## Usage');

    // And `getSkillSources` reports an empty body for the renamed skill.
    const sources = getSkillSources('my-skill-renamed', null);
    expect(sources.md.exists).toBe(true);
    expect(sources.md.description).toBe('Renamed skill');
    expect(sources.md.instructions).toBe('');
  });
});
