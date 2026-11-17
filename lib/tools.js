/**
 * The local programs that sessions need: the AWS CLI, and the Session Manager plugin it hands
 * sessions to. shell, exec, cp and the tunnels run them; the read commands use the SDK and don't.
 */

import { spawnSync } from 'child_process';

// Exec's output capture leaves the plugin's stdin as an open pipe, which works from plugin
// 1.2.553.0 on (the mission's open item 1). Earlier versions are untested.
export const TESTED_PLUGIN_VERSION = '1.2.553.0';

/**
 * Compare dotted version numbers.
 * @returns {number} Negative, zero or positive, like a sort comparator
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
}

/**
 * Whether each tool runs, and its version.
 * @param {{run?: (cmd: string, args: string[]) => {error?: Error, stdout?: string, stderr?: string}}} deps
 * @returns {{name: string, found: boolean, version: string|null, problem: string|null,
 *   belowTested: boolean}[]}
 */
export function checkTools({
  run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 }),
} = {}) {
  return [
    toolStatus('aws', run('aws', ['--version']), /aws-cli\/(\d+(?:\.\d+)+)/),
    toolStatus('session-manager-plugin', run('session-manager-plugin', ['--version']), /(\d+(?:\.\d+)+)/,
      TESTED_PLUGIN_VERSION),
  ];
}

function toolStatus(name, result, pattern, tested = null) {
  if (result.error) {
    const problem = result.error.code === 'ENOENT' ? null : result.error.message;
    return { name, found: false, version: null, problem, belowTested: false };
  }
  const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(pattern)?.[1] ?? null;
  return {
    name,
    found: true,
    version,
    problem: null,
    belowTested: Boolean(tested && version && compareVersions(version, tested) < 0),
  };
}
