import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const requestControlAction = async (port, action, input, options = {}) => {
  const { response, body } = await requestJson(port, '/api/openchamber/control', {
    ...options,
    method: 'POST',
    body: JSON.stringify({ action, input }),
  });
  if (response?.ok) return body;
  const isPartial = body?.partial === true;
  const partialSessionId = isPartial ? asNonEmptyString(body?.sessionId) : null;
  const partialDirectory = isPartial ? asNonEmptyString(body?.directory) : null;
  const partialSubject = body?.partialAction === 'goal-configured' ? 'Goal on session' : 'Forked session';
  const partial = partialSessionId
    ? ` ${partialSubject} ${partialSessionId} remains available${partialDirectory ? ` in ${partialDirectory}` : ''}.`
    : '';
  const message = `${asNonEmptyString(body?.error) || `Failed to execute ${action}`}${partial}`;
  const status = Number(response?.status);
  throw new TunnelCliError(message, status === 400 || status === 404 ? EXIT_CODE.USAGE_ERROR : EXIT_CODE.GENERAL_ERROR);
};
