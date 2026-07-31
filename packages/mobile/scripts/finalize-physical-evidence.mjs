import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyPassingJunit(content) {
  if (!/<testcase\b/i.test(content)) throw new Error('Maestro JUnit evidence has no test cases');
  if (/<(?:failure|error)\b/i.test(content)) throw new Error('Maestro JUnit evidence contains a failure');
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function main() {
  const candidatePath = process.env.OPENCHAMBER_PHYSICAL_CANDIDATE_EVIDENCE;
  const junitPath = process.env.OPENCHAMBER_PHYSICAL_JUNIT;
  const outputPath = process.env.OPENCHAMBER_PHYSICAL_EVIDENCE;
  if (!candidatePath || !junitPath || !outputPath) throw new Error('Candidate, JUnit, and final physical evidence paths are required');

  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  const junit = readFileSync(junitPath);
  verifyPassingJunit(junit.toString('utf8'));
  writeFileSync(outputPath, `${JSON.stringify({
    ...candidate,
    completedAt: new Date().toISOString(),
    secureWorkspaceFlow: 'passed',
    cleanup: 'passed',
    maestroJunitSha256: sha256(junit),
  }, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
