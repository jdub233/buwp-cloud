/**
 * Port-forward tunnels through a running WordPress task.
 *
 * ECS injects an SSM agent into each exec-enabled container, and that agent also serves the
 * AWS-StartPortForwardingSessionToRemoteHost document. So SSM can open a local port and forward it
 * through the wordpress container, which connects from the task's own network (whose security
 * group the database already allows). Source of record: bu-wp-ecs,
 * docs-new/rds-developer-access-ssm-port-forwarding.md.
 */

import net from 'net';
import { withTargetAccount } from './session.js';

export const PORT_FORWARD_DOCUMENT = 'AWS-StartPortForwardingSessionToRemoteHost';
const LOCALHOST = '127.0.0.1';

/**
 * The SSM target for a task's wordpress container: ecs:<cluster>_<task id>_<runtime id>.
 * @param {object} target
 * @param {object} task - From pickTask(); its wordpress runtime ID changes with every task
 * @returns {string}
 */
export function ssmTarget(target, task) {
  return `ecs:${target.cluster}_${task.taskId}_${task.wordpress.runtimeId}`;
}

/**
 * Arguments for `aws` to forward a local port to a remote host through the task.
 * @param {object} target
 * @param {object} task
 * @param {{host: string, port: number, localPort: number}} forward
 * @returns {string[]}
 */
export function portForwardArgs(target, task, { host, port, localPort }) {
  const parameters = { host: [host], portNumber: [String(port)], localPortNumber: [String(localPort)] };
  return withTargetAccount(target, [
    'ssm', 'start-session',
    '--target', ssmTarget(target, task),
    '--document-name', PORT_FORWARD_DOCUMENT,
    '--parameters', JSON.stringify(parameters),
  ]);
}

/**
 * Whether nothing is listening on a local port yet.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err)));
    server.listen(port, LOCALHOST, () => server.close(() => resolve(true)));
  });
}

/**
 * Connect to a local port and return the first bytes the other end sends.
 * @param {number} port
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<Buffer|null>} null when the connection closes or times out without data.
 *   Rejects when the connection is refused.
 */
export function probePort(port, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, LOCALHOST);
    let settled = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        fn(value);
      }
    };
    socket.setTimeout(timeoutMs, () => finish(resolve, null));
    socket.once('data', (data) => finish(resolve, data));
    socket.once('end', () => finish(resolve, null));
    socket.once('close', () => finish(resolve, null));
    socket.once('error', (err) => finish(reject, err));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a tunnel's local port to open, then return what the remote end sends first.
 * @param {number} port
 * @param {{deadlineMs?: number, intervalMs?: number, stillRunning?: () => boolean,
 *   probe?: Function}} opts - stillRunning stops the wait early when the tunnel process exits
 * @returns {Promise<Buffer|null>} As probePort()
 * @throws When the deadline passes or the tunnel exits first
 */
export async function waitForTunnel(port, {
  deadlineMs = 30_000, intervalMs = 500, stillRunning = () => true, probe = probePort,
} = {}) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (!stillRunning()) {
      throw new Error('The tunnel closed before it was ready');
    }
    try {
      return await probe(port);
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') {
        throw err;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`The tunnel didn't open local port ${port} within ${Math.round(deadlineMs / 1000)}s`);
    }
    await sleep(intervalMs);
  }
}
