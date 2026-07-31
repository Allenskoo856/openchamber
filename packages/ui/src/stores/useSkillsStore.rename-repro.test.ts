import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const originalFetch = globalThis.fetch;

// Issue #2546: "Renaming a skill wipes its content".
//
// The rename handler in `SkillsSidebar.tsx` (handleRenameSkill) performs:
//   1. const detail = await getSkillDetail(oldName);   // full SKILL.md fetched
//   2. createSkill({ name: newName, description: 'Renamed skill', scope, source })
//      // ^ the fetched `detail` is DISCARDED — no instructions, no original description
//   3. deleteSkill(oldName);
//
// The server-side `createSkill` writes SKILL.md as
// `writeMdFile(targetPath, frontmatter, instructions || '')`, so a create
// payload without `instructions` produces a SKILL.md with minimal frontmatter
// and an empty body. This test replays the exact store-call sequence the
// rename handler makes and asserts that the create payload for the renamed
// skill drops the original instructions/description — the data-loss bug.

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => null,
    checkHealth: async () => true,
  },
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
  updateConfigUpdateMessage: mock(() => undefined),
}));

// mock.module is process-global in bun: another test file may have replaced
// '@/lib/runtime-fetch' with its own stub before this file runs. Register our
// own mock so this suite always reaches its fetch double regardless of test
// file ordering.
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const { useSkillsStore, invalidateSkillsLoadCache } = await import('./useSkillsStore');

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

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

const skillDetailPayload = {
  name: 'my-skill',
  sources: {
    md: {
      exists: true,
      path: '/home/user/.config/opencode/skills/my-skill/SKILL.md',
      dir: '/home/user/.config/opencode/skills/my-skill',
      fields: ['name', 'description', 'instructions'],
      scope: 'user',
      source: 'opencode',
      supportingFiles: [],
      name: 'my-skill',
      description: ORIGINAL_DESCRIPTION,
      instructions: ORIGINAL_INSTRUCTIONS,
    },
  },
  scope: 'user',
  source: 'opencode',
  exists: true,
};

const mutationOkPayload = {
  success: true,
  requiresReload: true,
  message: 'ok',
};

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };
const fetchCalls: FetchCall[] = [];
let queuedResponses: Response[] = [];

const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  fetchCalls.push({ input, init });
  const queued = queuedResponses.shift();
  if (queued) return queued;
  throw new Error(`Unexpected fetch: ${String(input)} (${init?.method ?? 'GET'})`);
});

const queueFetchResponses = (responses: Response[]) => {
  queuedResponses = [...responses];
};

const requestBody = (callIndex: number): unknown => {
  const init = fetchCalls[callIndex]?.init;
  return init?.body ? JSON.parse(String(init.body)) : undefined;
};

// Faithful replay of `SkillsSidebar.tsx` `handleRenameSkill` store calls.
const runRenameFlow = async (oldName: string, newName: string) => {
  // Step 1 of the handler: fetch the full skill detail (content is available
  // here but the handler never forwards it to createSkill).
  const detail = await useSkillsStore.getState().getSkillDetail(oldName);
  expect(detail).not.toBeNull();
  // The component's `detail` variable is dead weight — instructions fetched
  // here are never passed to the create call below.

  // Step 2 of the handler: create the new skill. The component hardcodes
  // description and passes NO instructions.
  const created = await useSkillsStore.getState().createSkill({
    name: newName,
    description: 'Renamed skill', // hardcoded in SkillsSidebar.tsx handleRenameSkill
    scope: 'user',
    source: 'opencode',
  });
  expect(created).toBe(true);

  // Step 3 of the handler: delete the old skill.
  const deleted = await useSkillsStore.getState().deleteSkill(oldName);
  expect(deleted).toBe(true);
};

describe('issue-2546: renaming a skill wipes its SKILL.md content', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    queuedResponses = [];
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    invalidateSkillsLoadCache(null);
    useSkillsStore.setState({ skills: [], selectedSkillName: null, isLoading: false, skillDraft: null });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test('rename handler creates the renamed skill without the original instructions (content loss)', async () => {
    queueFetchResponses([
      jsonResponse(skillDetailPayload), // GET /api/config/skills/my-skill (detail)
      jsonResponse(mutationOkPayload), // POST /api/config/skills/my-skill-renamed
      jsonResponse({ skills: [] }), // GET /api/config/skills (reload after create)
      jsonResponse(mutationOkPayload), // DELETE /api/config/skills/my-skill
      jsonResponse({ skills: [] }), // GET /api/config/skills (reload after delete)
    ]);

    await runRenameFlow('my-skill', 'my-skill-renamed');

    // The detail fetch returned the full original body…
    expect(String(fetchCalls[0]?.input)).toContain('/api/config/skills/my-skill');
    expect(String(fetchCalls[0]?.init?.method ?? 'GET')).toBe('GET');

    // …but the create request that represents the renamed skill does NOT
    // contain the instructions or the original description:
    const createCallIndex = fetchCalls.findIndex((call) => String(call.input).includes('/api/config/skills/my-skill-renamed'));
    expect(createCallIndex).not.toBe(-1);
    expect(fetchCalls[createCallIndex]?.init?.method).toBe('POST');
    expect(requestBody(createCallIndex)).toEqual({
      name: 'my-skill-renamed',
      description: 'Renamed skill', // hardcoded placeholder — original description lost
      scope: 'user',
      source: 'opencode',
    });
    // No `instructions` key → server writes SKILL.md with an empty body.
    const body = requestBody(createCallIndex) as Record<string, unknown>;
    expect('instructions' in body).toBe(false);

    // The old skill (with the full content) is deleted.
    const deleteCallIndex = fetchCalls.findIndex(
      (call) => String(call.input).includes('/api/config/skills/my-skill') && call.init?.method === 'DELETE',
    );
    expect(deleteCallIndex).toBeGreaterThan(createCallIndex);
  });

  test('the discarded detail contained the full instructions that should have been preserved', async () => {
    queueFetchResponses([
      jsonResponse(skillDetailPayload),
      jsonResponse(mutationOkPayload),
      jsonResponse({ skills: [] }),
      jsonResponse(mutationOkPayload),
      jsonResponse({ skills: [] }),
      jsonResponse(skillDetailPayload), // final getSkillDetail below
    ]);

    await runRenameFlow('my-skill', 'my-skill-renamed');

    // Sanity: the fetched detail really did include the full body — so the
    // rename flow had the content available and still dropped it.
    const detail = await useSkillsStore.getState().getSkillDetail('my-skill');
    expect(detail?.sources?.md?.instructions).toBe(ORIGINAL_INSTRUCTIONS);
    expect(detail?.sources?.md?.description).toBe(ORIGINAL_DESCRIPTION);
  });
});
