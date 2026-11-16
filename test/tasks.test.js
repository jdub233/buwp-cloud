/**
 * Tests for summarizing service tasks and picking the one a session uses.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  taskIdFromArn, taskDefinitionLabel, summarizeTask, execBlocker, pickTask,
} from '../lib/index.js';
import { ecsTask, taskDefinitionArn, IMAGE_DIGEST } from './fixtures.js';

const summary = (opts) => summarizeTask(ecsTask(opts));

describe('taskIdFromArn and taskDefinitionLabel', () => {
  test('take the last path segment', () => {
    assert.equal(taskIdFromArn('arn:aws:ecs:us-east-1:123456789012:task/c/abc123'), 'abc123');
    assert.equal(taskIdFromArn('abc123'), 'abc123');
    assert.equal(taskDefinitionLabel(taskDefinitionArn(7)), 'wp-x-wp:7');
    assert.equal(taskDefinitionLabel(undefined), null);
  });
});

describe('summarizeTask', () => {
  test('reads the wordpress container by name, not by position', () => {
    const s = summary({ id: 't1' });
    assert.equal(s.taskId, 't1');
    assert.equal(s.taskDefinition, 'wp-x-wp:2');
    assert.equal(s.execEnabled, true);
    assert.deepEqual(s.wordpress, {
      runtimeId: 't1-wordpress',
      lastStatus: 'RUNNING',
      execAgent: 'RUNNING',
      image: 'example/wordpress:7',
      imageDigest: IMAGE_DIGEST,
    });
  });

  test('a task without a wordpress container has none', () => {
    assert.equal(summary({ id: 't1', wordpress: false }).wordpress, null);
  });
});

describe('execBlocker', () => {
  test('a running task with exec and a running agent is ready', () => {
    assert.equal(execBlocker(summary({ id: 't1' })), null);
  });

  test('names what is wrong', () => {
    assert.match(execBlocker(summary({ id: 't', lastStatus: 'PROVISIONING' })), /task is PROVISIONING/);
    assert.match(execBlocker(summary({ id: 't', exec: false })), /ECS Exec is not enabled/);
    assert.match(execBlocker(summary({ id: 't', wordpress: false })), /no wordpress container/);
    assert.match(execBlocker(summary({ id: 't', wordpressStatus: 'PENDING' })), /wordpress container is PENDING/);
    assert.match(execBlocker(summary({ id: 't', agent: 'PENDING' })), /exec agent is PENDING/);
    assert.match(execBlocker(summary({ id: 't', agent: null })), /exec agent is missing/);
  });
});

describe('pickTask', () => {
  const primary = taskDefinitionArn(2);

  test('takes the oldest ready task on the current deployment', () => {
    const tasks = [
      summary({ id: 'newer', startedAt: '2026-01-02T00:00:00Z' }),
      summary({ id: 'older', startedAt: '2026-01-01T00:00:00Z' }),
    ];
    const { task, reason } = pickTask(tasks, { primaryTaskDefinitionArn: primary });
    assert.equal(task.taskId, 'older');
    assert.match(reason, /current deployment/);
  });

  test('prefers the current deployment over an older task from a previous one', () => {
    const tasks = [
      summary({ id: 'draining', revision: 1, startedAt: '2025-12-01T00:00:00Z' }),
      summary({ id: 'current', revision: 2, startedAt: '2026-01-01T00:00:00Z' }),
    ];
    assert.equal(pickTask(tasks, { primaryTaskDefinitionArn: primary }).task.taskId, 'current');
  });

  test('falls back to any ready task when none on the current deployment is ready', () => {
    const tasks = [
      summary({ id: 'old-def', revision: 1 }),
      summary({ id: 'new-def', revision: 2, lastStatus: 'PENDING' }),
    ];
    const { task, reason } = pickTask(tasks, { primaryTaskDefinitionArn: primary });
    assert.equal(task.taskId, 'old-def');
    assert.match(reason, /none on the current deployment is ready/);
  });

  test('skips tasks that cannot take a session', () => {
    const tasks = [
      summary({ id: 'no-agent', agent: 'PENDING', startedAt: '2025-01-01T00:00:00Z' }),
      summary({ id: 'ok', startedAt: '2026-01-01T00:00:00Z' }),
    ];
    assert.equal(pickTask(tasks, { primaryTaskDefinitionArn: primary }).task.taskId, 'ok');
  });

  test('explains when no task is ready, and when there are none', () => {
    const blocked = pickTask([summary({ id: 't1', exec: false })], { primaryTaskDefinitionArn: primary });
    assert.equal(blocked.task, null);
    assert.match(blocked.reason, /no task can take a session \(t1: ECS Exec is not enabled/);

    const empty = pickTask([], { primaryTaskDefinitionArn: primary });
    assert.equal(empty.task, null);
    assert.match(empty.reason, /no running tasks/);
  });

  test('--task pins a task by ID or ARN', () => {
    const tasks = [summary({ id: 'a' }), summary({ id: 'b', startedAt: '2027-01-01T00:00:00Z' })];
    assert.equal(pickTask(tasks, { taskId: 'b' }).task.taskId, 'b');
    assert.equal(pickTask(tasks, { taskId: tasks[1].taskArn }).task.taskId, 'b');
    assert.equal(pickTask(tasks, { taskId: 'b' }).reason, 'pinned with --task');
  });

  test('a pinned task must belong to the service and be ready', () => {
    const tasks = [summary({ id: 'a' }), summary({ id: 'blocked', agent: 'STOPPED' })];
    const notOurs = pickTask(tasks, { taskId: 'zzz' }).reason;
    assert.match(notOurs, /zzz isn't one of this service's running tasks/);
    assert.match(notOurs, /Job-runner tasks.*can't take sessions/, 'explains the likely case');
    assert.match(pickTask(tasks, { taskId: 'blocked' }).reason, /blocked can't take a session: the exec agent is STOPPED/);
  });
});
