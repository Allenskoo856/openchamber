import { describe, expect, test } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { listLocalMcpTools, listMcpTools } from './mcp-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureServer = path.join(__dirname, 'mcp-tools.fixture-server.mjs');

describe('listMcpTools', () => {
  test('lists tools from a local newline-framed MCP server', async () => {
    const result = await listLocalMcpTools({
      type: 'local',
      command: [process.execPath, fixtureServer],
      timeout: 10_000,
    });

    expect(result.serverInfo?.name).toBe('fixture-mcp');
    expect(result.tools.map((tool) => tool.name)).toEqual(['alpha', 'beta']);
    expect(result.tools[0]?.description).toBe('Alpha tool');
    expect(result.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    });
  });

  test('rejects disabled servers', async () => {
    await expect(listMcpTools({
      type: 'local',
      enabled: false,
      command: [process.execPath, fixtureServer],
    })).rejects.toThrow(/disabled/i);
  });

  test('rejects local servers without a command', async () => {
    await expect(listMcpTools({
      type: 'local',
      command: [],
    })).rejects.toThrow(/command is required/i);
  });

  test('rejects oauth-configured remote probes', async () => {
    await expect(listMcpTools({
      type: 'remote',
      url: 'https://example.com/mcp',
      oauth: { clientId: 'demo' },
    })).rejects.toThrow(/OAuth-protected/i);
  });
});
