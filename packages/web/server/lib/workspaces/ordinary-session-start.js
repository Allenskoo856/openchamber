import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ORDINARY_SESSION_ERRORS = Object.freeze({
  INVALID_REQUEST: 'WORKSPACE_SESSION_INVALID_REQUEST',
  UNSUPPORTED_RUNTIME: 'WORKSPACE_SESSION_UNSUPPORTED_RUNTIME',
  UNAUTHORIZED: 'WORKSPACE_SESSION_UNAUTHORIZED',
  WORKSPACE_UNAVAILABLE: 'WORKSPACE_SESSION_WORKSPACE_UNAVAILABLE',
  CONNECTION_TIMEOUT: 'WORKSPACE_SESSION_CONNECTION_TIMEOUT',
  SESSION_PARTIAL: 'WORKSPACE_SESSION_PARTIAL',
  IDEMPOTENCY_CONFLICT: 'WORKSPACE_SESSION_IDEMPOTENCY_CONFLICT',
});

const safe = (value) => typeof value === 'string' ? value : '';
const STATES = new Set(['starting', 'workspace-created', 'connecting', 'session-created', 'completed', 'partial']);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class OrdinarySessionJournal {
  constructor({ rootDirectory }) {
    this.rootDirectory = rootDirectory;
    this.writes = new Map();
    this.operations = new Map();
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(rootDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Ordinary session journal root is unsafe');
    fs.chmodSync(rootDirectory, 0o700);
  }

  async exclusive(principal, operationID, task) {
    const key = `${principal}:${operationID}`;
    const previous = this.operations.get(key) ?? Promise.resolve();
    const current = previous.then(task, task);
    this.operations.set(key, current);
    try { return await current; } finally {
      if (this.operations.get(key) === current) this.operations.delete(key);
    }
  }

  file(principal, operationID) {
    const principalID = crypto.createHash('sha256').update(principal).digest('hex');
    return path.join(this.rootDirectory, principalID, `${operationID}.json`);
  }

  async read(principal, operationID) {
    try {
      const file = this.file(principal, operationID);
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('journal entry is not a regular file');
      const value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (value?.version !== 1 || value.operationID !== operationID || !STATES.has(value.state)
        || typeof value.directory !== 'string' || typeof value.projectID !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestHash)
        || typeof value.createdAt !== 'number') {
        throw new Error('journal entry is invalid or expired');
      }
      if (value.createdAt + MAX_AGE_MS < Date.now()) { await fs.promises.rm(file, { force: true }); return null; }
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(principal, operationID, value) {
    const file = this.file(principal, operationID);
    const directory = path.dirname(file);
    const previous = this.writes.get(file) ?? Promise.resolve();
    const write = previous.then(async () => {
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(directory, 0o700);
      const temporary = path.join(directory, `.${operationID}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
      let handle;
      try {
        handle = await fs.promises.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(value), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.promises.rename(temporary, file);
        await fs.promises.chmod(file, 0o600);
        const directoryHandle = await fs.promises.open(directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
      }
    });
    this.writes.set(file, write);
    await write;
    if (this.writes.get(file) === write) this.writes.delete(file);
  }
}

function fail(code, message, statusCode = 409, details = {}) {
  throw Object.assign(new Error(message), { code, statusCode, ...details });
}

function validateOperationID(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) fail(ORDINARY_SESSION_ERRORS.INVALID_REQUEST, 'operationID is invalid', 400);
}

function validateJournalBinding(journal, input) {
  if (!journal) return;
  if (journal.directory !== input.directory || journal.projectID !== input.projectID || journal.provider !== input.provider || journal.requestHash !== input.requestHash) {
    fail(ORDINARY_SESSION_ERRORS.IDEMPOTENCY_CONFLICT, 'operationID was already used with a different request', 409);
  }
}

async function startOrdinaryWorkspaceSessionUnlocked({
  operationID, principal, directory, projectID, title, provider, client, journal,
  maxAttempts = 20, pollIntervalMs = 250, authorizeCreation,
}) {
  validateOperationID(operationID);
  if (!principal || !directory || !projectID || !client) fail(ORDINARY_SESSION_ERRORS.INVALID_REQUEST, 'operationID, project, and client are required', 400);
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ directory, projectID, title: safe(title), provider })).digest('hex');
  let operation = await journal.read(principal, operationID);
  if (operation) validateJournalBinding(operation, { directory, projectID, provider, requestHash });
  if (!operation) {
    operation = { version: 1, operationID, directory, projectID, requestHash, provider, state: 'starting', workspaceID: null, sessionID: null, createdAt: Date.now() };
    await journal.write(principal, operationID, operation);
  }
  if (operation.sessionID) {
    const existing = await client.session.get({ sessionID: operation.sessionID, directory, ...(operation.workspaceID ? { workspace: operation.workspaceID } : {}) });
    if (existing?.data?.id === operation.sessionID && existing.data.workspaceID !== undefined && existing.data.workspaceID !== operation.workspaceID) fail(ORDINARY_SESSION_ERRORS.SESSION_PARTIAL, 'Recovered session has incorrect workspace routing', 202, { retryable: true, operationID, workspaceID: operation.workspaceID, sessionID: operation.sessionID });
    if (existing?.data?.id === operation.sessionID) return { status: 'completed', operationID, workspaceID: operation.workspaceID, sessionID: operation.sessionID, session: { ...existing.data, workspaceID: operation.workspaceID } };
    fail(ORDINARY_SESSION_ERRORS.SESSION_PARTIAL, 'Session was created but could not be verified; retry recovery', 202, { retryable: true, operationID, workspaceID: operation.workspaceID, sessionID: operation.sessionID });
  }

  const listed = await client.experimental.workspace.list({ directory });
  if (listed?.error || !Array.isArray(listed?.data)) fail(ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE, 'Authoritative workspace list is unavailable', 503, { retryable: true });
  const statusSnapshot = await client.experimental.workspace.status({ directory });
  if (statusSnapshot?.error || !Array.isArray(statusSnapshot?.data)) fail(ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE, 'Authoritative workspace status is unavailable', 503, { retryable: true });
  const usableIDs = new Set(statusSnapshot.data.filter((item) => item?.status === 'connected' || item?.status === 'connecting').map((item) => item.workspaceID));
  let workspace = operation.workspaceID
    ? listed.data.find((item) => item?.id === operation.workspaceID && item?.projectID === projectID && item?.type === provider)
    : listed.data.filter((item) => item?.projectID === projectID && item?.type === provider && usableIDs.has(item.id)).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  if (operation.workspaceID && !workspace) fail(ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE, 'The journaled workspace is no longer authoritative', 409, { retryable: true, operationID, workspaceID: operation.workspaceID });
  if (!workspace) {
    if (typeof authorizeCreation !== 'function') fail(ORDINARY_SESSION_ERRORS.UNAUTHORIZED, 'Workspace creation authorization is required', 403);
    await authorizeCreation();
    const created = await client.experimental.workspace.create({ id: `wrk_${crypto.randomUUID().replaceAll('-', '')}`, type: provider, directory, branch: null });
    if (created?.error || !created?.data) fail(ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE, 'Workspace creation failed', 409, { retryable: true });
    workspace = created.data;
    operation.workspaceID = workspace.id;
    operation.state = 'workspace-created';
    await journal.write(principal, operationID, operation);
  }
  if (!workspace?.id || workspace.projectID !== projectID || workspace.type !== provider) fail(ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE, 'Workspace identity is invalid', 409, { retryable: true });
  operation.workspaceID = workspace.id;
  operation.state = 'connecting';
  await journal.write(principal, operationID, operation);
  const sync = client.experimental.workspace.sync;
  if (typeof sync?.start === 'function') {
    const started = await sync.start({ directory });
    if (started?.error) fail(ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE, 'Workspace synchronization could not be started', 503, { retryable: true });
  } else if (typeof client.experimental.workspace.syncStart === 'function') {
    const started = await client.experimental.workspace.syncStart({ directory });
    if (started?.error) fail(ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE, 'Workspace synchronization could not be started', 503, { retryable: true });
  }
  let connected = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await client.experimental.workspace.status({ directory });
    const row = Array.isArray(status?.data) ? status.data.find((item) => item?.workspaceID === workspace.id) : null;
    if (row?.status === 'connected') { connected = true; break; }
    if (row?.status === 'error' || row?.status === 'disconnected') break;
    if (attempt + 1 < maxAttempts && pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (!connected) fail(ORDINARY_SESSION_ERRORS.CONNECTION_TIMEOUT, 'Workspace did not become connected before the bounded wait', 202, { retryable: true, operationID, workspaceID: workspace.id });
  const createdSession = await client.session.create({ directory, workspace: workspace.id, ...(safe(title) ? { title: safe(title) } : {}) });
  if (createdSession?.error || !createdSession?.data?.id) fail(ORDINARY_SESSION_ERRORS.SESSION_PARTIAL, 'Session creation returned no authoritative session', 202, { retryable: true, operationID, workspaceID: workspace.id });
  operation.sessionID = createdSession.data.id;
  operation.state = 'session-created';
  await journal.write(principal, operationID, operation);
  const verified = await client.session.get({ sessionID: operation.sessionID, directory, workspace: workspace.id });
  if (verified?.error || verified?.data?.id !== operation.sessionID || (verified.data.workspaceID !== undefined && verified.data.workspaceID !== workspace.id)) fail(ORDINARY_SESSION_ERRORS.SESSION_PARTIAL, 'Created session routing could not be verified', 202, { retryable: true, operationID, workspaceID: workspace.id, sessionID: operation.sessionID });
  operation.state = 'completed';
  await journal.write(principal, operationID, operation);
  return { status: 'completed', operationID, workspaceID: workspace.id, sessionID: operation.sessionID, session: { ...verified.data, workspaceID: workspace.id } };
}

export async function startOrdinaryWorkspaceSession(input) {
  if (!input.journal || typeof input.journal.exclusive !== 'function') return startOrdinaryWorkspaceSessionUnlocked(input);
  return input.journal.exclusive(input.principal, input.operationID, () => startOrdinaryWorkspaceSessionUnlocked(input));
}
