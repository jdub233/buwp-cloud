/**
 * Tests for port-forward arguments and the tunnel readiness checks. The socket tests use real
 * listeners on 127.0.0.1 with ports the OS picks.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import {
  toTarget, ssmTarget, portForwardArgs, isPortFree, probePort, waitForTunnel, PORT_FORWARD_DOCUMENT,
} from '../lib/index.js';
import { wordpressContext, mysqlGreeting } from './fixtures.js';

const target = toTarget(wordpressContext(), { profile: 'example-nprd' });
const task = { taskId: 'task1', wordpress: { runtimeId: 'task1-2684718236' } };

/** Listen on a free local port; `onConnection` handles each socket. */
function listen(onConnection = () => {}) {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

/** A port nothing is listening on (very likely), found by listening and closing. */
async function unusedPort() {
  const server = await listen();
  const { port } = server.address();
  await close(server);
  return port;
}

describe('ssmTarget and portForwardArgs', () => {
  test('the target names the cluster, task and wordpress runtime ID', () => {
    assert.equal(ssmTarget(target, task), 'ecs:wp-x-wp-cluster-example-test_task1_task1-2684718236');
  });

  test('forwards a local port to the remote host with the port-forward document', () => {
    assert.deepEqual(portForwardArgs(target, task, { host: 'db.example.internal', port: 3306, localPort: 13306 }), [
      'ssm', 'start-session',
      '--target', 'ecs:wp-x-wp-cluster-example-test_task1_task1-2684718236',
      '--document-name', PORT_FORWARD_DOCUMENT,
      '--parameters', '{"host":["db.example.internal"],"portNumber":["3306"],"localPortNumber":["13306"]}',
      '--region', 'us-east-1',
      '--profile', 'example-nprd',
    ]);
  });
});

describe('isPortFree', () => {
  test('false while something listens, true after it stops', async () => {
    const server = await listen();
    const { port } = server.address();

    assert.equal(await isPortFree(port), false);
    await close(server);
    assert.equal(await isPortFree(port), true);
  });
});

describe('probePort', () => {
  test('returns the first bytes the other end sends', async () => {
    const server = await listen((socket) => socket.write(mysqlGreeting()));
    try {
      const data = await probePort(server.address().port);
      assert.deepEqual(data, mysqlGreeting());
    } finally {
      await close(server);
    }
  });

  test('returns null when the other end closes without sending', async () => {
    const server = await listen((socket) => socket.end());
    try {
      assert.equal(await probePort(server.address().port), null);
    } finally {
      await close(server);
    }
  });

  test('returns null when nothing arrives before the timeout', async () => {
    const server = await listen(() => {});
    try {
      assert.equal(await probePort(server.address().port, { timeoutMs: 50 }), null);
    } finally {
      server.close();
    }
  });

  test('rejects when the connection is refused', async () => {
    await assert.rejects(probePort(await unusedPort()), { code: 'ECONNREFUSED' });
  });
});

describe('waitForTunnel', () => {
  const refused = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });

  test('retries while the port is refused, then returns what arrives', async () => {
    let attempts = 0;
    const probe = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw refused();
      }
      return Buffer.from('hi');
    };

    assert.deepEqual(await waitForTunnel(13306, { probe, intervalMs: 1 }), Buffer.from('hi'));
    assert.equal(attempts, 3);
  });

  test('stops when the tunnel process has exited', async () => {
    await assert.rejects(
      waitForTunnel(13306, { probe: async () => { throw refused(); }, stillRunning: () => false }),
      /closed before it was ready/
    );
  });

  test('gives up at the deadline', async () => {
    await assert.rejects(
      waitForTunnel(13306, { probe: async () => { throw refused(); }, deadlineMs: 20, intervalMs: 5 }),
      /didn't open local port 13306/
    );
  });

  test('passes other connection errors through', async () => {
    const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    await assert.rejects(waitForTunnel(13306, { probe: async () => { throw reset; } }), { code: 'ECONNRESET' });
  });
});
