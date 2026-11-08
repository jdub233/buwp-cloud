/**
 * Tests for the status command: gathering, formatting and the command itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import statusCommand, { gatherStatus, formatStatus } from '../lib/commands/status.js';
import { toTarget } from '../lib/index.js';
import {
  wordpressContext, contextBucket, fakeAws, awsError,
  ecsTask, ecsService, ecsTaskDefinition, taskDefinitionArn,
} from './fixtures.js';

const target = () => toTarget(wordpressContext(), { profile: 'example-nprd' });
const NOW = new Date('2026-01-01T05:30:00Z');

/** ECS answers for a healthy two-task service on revision 2. */
function healthyEcs() {
  return {
    service: ecsService({ desired: 2, running: 2 }),
    tasks: [
      ecsTask({ id: 'newer', startedAt: '2026-01-01T03:00:00Z' }),
      ecsTask({ id: 'older', startedAt: '2026-01-01T00:00:00Z' }),
    ],
    taskDefinitions: { [taskDefinitionArn(2)]: ecsTaskDefinition({ image: 'example/wordpress:7' }) },
  };
}

describe('gatherStatus', () => {
  test('reads the service, deployments, tasks and the wordpress image', async () => {
    const aws = fakeAws({}, healthyEcs());

    const status = await gatherStatus(target(), aws);

    assert.equal(status.service.name, 'wp-x-wp-service-example-test');
    assert.equal(status.service.runningCount, 2);
    assert.deepEqual(status.service.deployments.map((d) => [d.status, d.taskDefinition, d.rolloutState]),
      [['PRIMARY', 'wp-x-wp:2', 'COMPLETED']]);
    assert.equal(status.image, 'example/wordpress:7', 'the wordpress image, not the sidecar listed first');
    assert.deepEqual(status.tasks.map((t) => [t.taskId, t.blocker]), [['newer', null], ['older', null]]);
    assert.deepEqual(status.pick, { taskId: 'older', reason: 'oldest ready task on the current deployment' });
  });

  test('asks ECS about the target\'s own cluster and service, in its region and profile', async () => {
    const aws = fakeAws({}, healthyEcs());

    await gatherStatus(target(), aws);

    assert.deepEqual(aws.calls[0],
      ['describeService', 'example-nprd', 'us-east-1', 'wp-x-wp-cluster-example-test', 'wp-x-wp-service-example-test']);
  });

  test('a missing service is reported, not thrown', async () => {
    const status = await gatherStatus(target(), fakeAws({}, { service: null }));

    assert.equal(status.service, null);
    assert.equal(status.pick.taskId, null);
    assert.match(status.pick.reason, /no service wp-x-wp-service-example-test/);
  });
});

describe('formatStatus', () => {
  test('shows the target, service, deployment, image and the task sessions will use', async () => {
    const status = await gatherStatus(target(), fakeAws({}, healthyEcs()));

    const text = formatStatus(status, { now: NOW });

    assert.match(text, /^Target {7}wp-x-example-test \(development\)$/m);
    assert.match(text, /^Profile {6}example-nprd, us-east-1$/m);
    assert.match(text, /^Service {6}wp-x-wp-service-example-test: ACTIVE, 2 running of 2 desired$/m);
    assert.match(text, /^Deployments {2}PRIMARY wp-x-wp:2, rollout COMPLETED, 2 running of 2$/m);
    assert.match(text, /^Image {8}example\/wordpress:7$/m);
    assert.match(text, /^Job runner {3}rate\(5 minutes\)$/m);
    assert.match(text, /^older +5h 30m +wp-x-wp:2 +ready +<- sessions use this$/m);
    assert.match(text, /^newer +2h 30m +wp-x-wp:2 +ready$/m);
    assert.match(text, /Sessions will use task older: oldest ready task on the current deployment\.$/);
  });

  test('says why a task can\'t take a session', async () => {
    const ecs = { ...healthyEcs(), tasks: [ecsTask({ id: 'stuck', agent: 'PENDING' })] };
    const text = formatStatus(await gatherStatus(target(), fakeAws({}, ecs)), { now: NOW });

    assert.match(text, /^stuck .* no: the exec agent is PENDING$/m);
    assert.match(text, /No session possible: no task can take a session/);
  });

  test('flags production, including an unset environmentType', async () => {
    const prod = toTarget(wordpressContext({ WORDPRESS: { env: {} } }), {});
    const text = formatStatus(await gatherStatus(prod, fakeAws({}, healthyEcs())), {
      now: NOW, paintProd: (s) => `<${s}>`,
    });

    assert.match(text, /^Target +wp-x-example-test \(unset\) {2}<PROD \(environmentType unset or unknown\)>$/m);
  });

  test('a service with no tasks says so', async () => {
    const ecs = { ...healthyEcs(), service: ecsService({ desired: 0, running: 0 }), tasks: [] };
    const text = formatStatus(await gatherStatus(target(), fakeAws({}, ecs)), { now: NOW });

    assert.doesNotMatch(text, /^TASK/m);
    assert.match(text, /No session possible: the service has no running tasks\.$/);
  });
});

describe('statusCommand', () => {
  const buckets = { [contextBucket('wp-x-example-test')]: wordpressContext() };

  async function runStatus(name, options, ecs, byProfile = { 'example-nprd': { buckets } }) {
    let out = '';
    let err = '';
    const code = await statusCommand(name, options, {
      aws: fakeAws(byProfile, ecs),
      env: {},
      readConfig: () => ({ config: { profiles: ['example-nprd'] }, files: [] }),
      now: () => NOW,
      stdout: (s) => { out += s; },
      stderr: (s) => { err += s; },
    });
    return { code, out, err };
  }

  test('prints the status and exits 0', async () => {
    const { code, out, err } = await runStatus('wp-x-example-test', {}, healthyEcs());

    assert.equal(code, 0);
    assert.match(out, /^Target +wp-x-example-test/);
    assert.equal(err, '');
  });

  test('--json prints the gathered status', async () => {
    const { out } = await runStatus('wp-x-example-test', { json: true }, healthyEcs());

    const parsed = JSON.parse(out);
    assert.equal(parsed.target.cluster, 'wp-x-wp-cluster-example-test');
    assert.equal(parsed.pick.taskId, 'older');
    assert.equal(parsed.tasks[0].wordpress.runtimeId, 'newer-wordpress');
  });

  test('an unknown target exits 1 and lists the real ones', async () => {
    const { code, out, err } = await runStatus('wp-x', {}, healthyEcs());

    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /No target named "wp-x"/);
    assert.match(err, /Targets: wp-x-example-test/);
  });

  test('an ECS failure exits 1 with a credential hint when it is one', async () => {
    const { code, err } = await runStatus('wp-x-example-test', {}, { error: awsError('ExpiredToken', 'expired') });

    assert.equal(code, 1);
    assert.match(err, /ExpiredToken: expired/);
    assert.match(err, /Check that AWS profile "example-nprd"/);
  });
});
