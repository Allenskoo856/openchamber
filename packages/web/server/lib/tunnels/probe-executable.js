import { execFile } from 'node:child_process';

/**
 * Runs a short command and reports what it printed, without stopping the server while it
 * runs. `spawnSync` blocks the event loop for the whole duration of the child process,
 * so a dependency probe measured at ~370ms on Windows stalled every other request for
 * that long — including the sibling requests the same page issues in parallel, which
 * made a page that looks like it fetches concurrently behave as if it were serial.
 */
export function probeExecutable(command, args, { env, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile(command, args, { encoding: 'utf8', windowsHide: true, env, timeout: timeoutMs }, (error, stdout, stderr) => {
        finish({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
      child.on('error', () => finish({ status: 1, stdout: '', stderr: '' }));
    } catch {
      finish({ status: 1, stdout: '', stderr: '' });
    }
  });
}
