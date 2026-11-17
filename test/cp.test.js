/**
 * Tests for the cp command. Nothing here opens a session: `start` is a fake that answers each call
 * from what the script asked for.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import cpCommand from '../lib/commands/cp.js';
import { sha256, CHUNK_CHARS } from '../lib/index.js';
import {
  wordpressContext, contextBucket, fakeAws, ecsTask, ecsService,
} from './fixtures.js';

const NONCE = '__buwp_0123456789ab_';
const FILE = Buffer.from('<?php echo "fix";\n');
const DEST = '/var/www/html/wp-content/mu-plugins/fix.php';

/** Decode what a recorded call sent: the script, its positional arguments and its label. */
function decode(args) {
  const command = args[args.indexOf('--command') + 1];
  const m = command.match(/^sh -c "echo (\S+) \| base64 -d \| sh(?: -s ([^"]*))?" (\S+)$/);
  return {
    task: args[args.indexOf('--task') + 1],
    script: Buffer.from(m[1], 'base64').toString('utf8'),
    args: m[2] === undefined ? [] : m[2].split(' '),
    label: m[3],
  };
}

/** Session output for a script that wrote `stdout` and `stderr` and exited `status`. */
const reply = ({ stdout = '', stderr = '', status = 0 }) => [
  `${NONCE}BEGIN\r\n`,
  stdout.replace(/\n/g, '\r\n'),
  stderr.split('\n').filter(Boolean).map((l) => `${NONCE}E ${l}\r\n`).join(''),
  `\r\n${NONCE}RC=${status}\r\n`,
].join('');

/**
 * A fake startSession. `respond(call)` gets the decoded call and returns {stdout, stderr, status};
 * the default acts like a container where every copy succeeds.
 */
function fakeStart(respond = (call) => (call.script.includes('buwp_cp "$1"')
  ? { stdout: `buwp-cp path=${DEST} old=- new=${sha256(FILE)} bytes=${FILE.length} owner=www-data:www-data mode=644\n` }
  : {})) {
  const calls = [];
  const start = (command, args) => {
    const call = decode(args);
    calls.push(call);
    const child = { stdout: new PassThrough(), stdin: new PassThrough() };
    const exited = new Promise((resolve) => {
      setImmediate(() => {
        child.stdout.on('end', () => resolve(0));
        child.stdout.end(reply(respond(call)));
        child.stdout.resume();
      });
    });
    return { child, exited };
  };
  return { start, calls };
}

const twoTasks = () => ({
  service: ecsService({ desired: 2, running: 2 }),
  tasks: [ecsTask({ id: 'a', startedAt: '2026-01-01T00:00:00Z' }), ecsTask({ id: 'b', startedAt: '2026-01-02T00:00:00Z' })],
});

async function runCp(source, destination, options = {}, {
  context = wordpressContext(), ecs = { service: ecsService(), tasks: [ecsTask({ id: 'task1' })] },
  session = fakeStart(), files = {},
} = {}) {
  let out = '';
  let err = '';
  const written = {};
  const code = await cpCommand(source, destination, options, {
    aws: fakeAws({ 'example-nprd': { buckets: { [contextBucket('wp-x-example-test')]: context } } }, ecs),
    env: {},
    readConfig: () => ({ config: { profiles: ['example-nprd'] }, files: [] }),
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    start: session.start,
    nonce: () => NONCE,
    copyId: () => 'c0ffee',
    files: {
      read: (p) => {
        if (p === 'fix.php') {
          return FILE;
        }
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      },
      isDirectory: (p) => p === 'downloads',
      write: (p, data) => { written[p] = data; },
      ...files,
    },
  });
  return { code, out, err, calls: session.calls, written };
}

describe('cp into a container', () => {
  test('sends the file once, as an argument, with a script that checks it before moving it into place', async () => {
    const { code, err, calls } = await runCp('fix.php', `wp-x-example-test:${DEST}`);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.task, 'task1');
    assert.equal(call.label, 'buwp:cp');
    assert.deepEqual(call.args, [FILE.toString('base64')], 'the file travels base64-encoded once');
    assert.match(call.script, new RegExp(`dest='?${DEST}'?`));
    assert.match(call.script, new RegExp(`if \\[ "\\$sha" != ${sha256(FILE)} \\]`));
    assert.match(call.script, /mv -f "\$tmp" "\$dest"/);
    assert.match(err, new RegExp(`Copied: task task1: .*fix\\.php, ${FILE.length} bytes, www-data:www-data 644, sha256 \\w{12} \\(new file\\)\\.`));
    assert.match(err, /Note: This lasts until the task is replaced\./);
    assert.match(err, /Note: Scheduled jobs \(rate\(5 minutes\)\) run in new tasks/);
  });

  test('a destination ending in / gets the local file\'s name', async () => {
    const { calls } = await runCp('fix.php', 'wp-x-example-test:/var/www/html/wp-content/mu-plugins/');

    assert.match(calls[0].script, /dest=\/var\/www\/html\/wp-content\/mu-plugins\/fix\.php/);
  });

  test('a big file goes in pieces to one staging file, then the last piece finishes the copy', async () => {
    const big = Buffer.alloc(CHUNK_CHARS, 7);
    const b64 = big.toString('base64');
    const session = fakeStart((call) => (call.script.includes('buwp_cp "$1"')
      ? { stdout: `buwp-cp path=${DEST} old=- new=${sha256(big)} bytes=${big.length} owner=www-data:www-data mode=644\n` }
      : {}));
    const { code, calls, err } = await runCp('big.bin', `wp-x-example-test:${DEST}`, {}, {
      session, files: { read: () => big },
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.match(calls[0].script, /printf '%s' "\$1" >> \/tmp\/\.buwp-cp-c0ffee/);
    assert.match(calls[1].script, /staging=\/tmp\/\.buwp-cp-c0ffee/);
    assert.equal(calls[0].args[0] + calls[1].args[0], b64);
    assert.match(err, /in 2 pieces/);
  });

  test('a failed check is reported, and nothing claims success', async () => {
    const session = fakeStart(() => ({ stderr: 'The file failed php -l. fix.php is unchanged.\n', status: 1 }));
    const { code, err } = await runCp('fix.php', `wp-x-example-test:${DEST}`, {}, { session });

    assert.equal(code, 1);
    assert.match(err, /The file failed php -l\./);
    assert.match(err, /Error: The copy to task task1 failed\./);
    assert.doesNotMatch(err, /Copied:|Note:/);
  });

  test('labels production before copying', async () => {
    const context = wordpressContext({ WORDPRESS: { env: { environmentType: 'production' } } });
    const { err } = await runCp('fix.php', `wp-x-example-test:${DEST}`, {}, { context });

    assert.match(err, /^PRODUCTION: wp-x-example-test /);
  });

  test('notes that an autoscaling service\'s new tasks won\'t have the file', async () => {
    const { err } = await runCp('fix.php', `wp-x-example-test:${DEST}`, {}, {
      context: wordpressContext({ AUTOSCALING: true }),
    });

    assert.match(err, /Note: wp-x-wp-service-example-test autoscales/);
  });

  describe('on a service with more than one task', () => {
    test('refuses until --task or --all-tasks says which', async () => {
      const { code, err, calls } = await runCp('fix.php', `wp-x-example-test:${DEST}`, {}, { ecs: twoTasks() });

      assert.equal(code, 1);
      assert.deepEqual(calls, []);
      assert.match(err, /runs 2 tasks, and the ALB spreads requests across them/);
      assert.match(err, /--task <id> to patch one task .* or --all-tasks so every request sees the change/);
    });

    test('--task copies to that task alone', async () => {
      const { code, calls } = await runCp('fix.php', `wp-x-example-test:${DEST}`, { task: 'b' }, { ecs: twoTasks() });

      assert.equal(code, 0);
      assert.deepEqual(calls.map((c) => c.task), ['b']);
    });

    test('--all-tasks copies to every task, one at a time', async () => {
      const { code, calls, err } = await runCp('fix.php', `wp-x-example-test:${DEST}`, { allTasks: true }, { ecs: twoTasks() });

      assert.equal(code, 0);
      assert.deepEqual(calls.map((c) => c.task), ['a', 'b']);
      assert.match(err, /on task a, b\./);
      assert.match(err, /This lasts until the tasks are replaced/);
    });

    test('--all-tasks stops at the first failure and says which tasks have the file', async () => {
      const ecs = { ...twoTasks(), tasks: [...twoTasks().tasks, ecsTask({ id: 'c' })] };
      let n = 0;
      const session = fakeStart(() => {
        n += 1;
        return n === 2
          ? { stderr: 'Couldn\'t move the file into place.\n', status: 1 }
          : { stdout: `buwp-cp path=${DEST} old=- new=${sha256(FILE)} bytes=${FILE.length} owner=www-data:www-data mode=644\n` };
      });
      const { code, calls, err } = await runCp('fix.php', `wp-x-example-test:${DEST}`, { allTasks: true }, { ecs, session });

      assert.equal(code, 1);
      assert.equal(calls.length, 2, 'task c was never tried');
      assert.match(err, /Warning: stopped\. a already has the new file; the other tasks don't\./);
    });

    test('--all-tasks warns about a task that started while it was copying', async () => {
      const ecs = twoTasks();
      const session = fakeStart(() => {
        ecs.tasks = [...ecs.tasks.filter((t) => !t.taskArn.endsWith('/z')), ecsTask({ id: 'z' })];
        return { stdout: `buwp-cp path=${DEST} old=- new=${sha256(FILE)} bytes=${FILE.length} owner=www-data:www-data mode=644\n` };
      });
      const { code, err } = await runCp('fix.php', `wp-x-example-test:${DEST}`, { allTasks: true }, { ecs, session });

      assert.equal(code, 0);
      assert.match(err, /Warning: z started while copying and doesn't have the file/);
    });

    test('--all-tasks refuses when a task can\'t take a session, rather than patch only some', async () => {
      const ecs = { ...twoTasks(), tasks: [ecsTask({ id: 'a' }), ecsTask({ id: 'b', agent: 'PENDING' })] };
      const { code, err, calls } = await runCp('fix.php', `wp-x-example-test:${DEST}`, { allTasks: true }, { ecs });

      assert.equal(code, 1);
      assert.deepEqual(calls, []);
      assert.match(err, /Not every task can take a session \(b: the exec agent is PENDING\)/);
    });
  });

  describe('--print', () => {
    test('prints a runnable script that reads the local file, one aws command per task, and runs nothing', async () => {
      const { code, out, err, calls } = await runCp('fix.php', `wp-x-example-test:${DEST}`, { print: true, allTasks: true }, { ecs: twoTasks() });

      assert.equal(code, 0);
      assert.deepEqual(calls, []);
      assert.match(out, /^b64=\$\(base64 < \/\S*fix\.php \| tr -d '\\n'\)\nbuwp_script\(\) \{\ncat <<'BUWP_SCRIPT'\n/);
      assert.match(out, /^buwp_cp "\$1" <\/dev\/null$/m);
      assert.equal(out.match(/^aws ecs execute-command /gm).length, 2);
      assert.match(out, /\| sh -s \$b64\\" buwp:cp"/);
      assert.doesNotMatch(out, new RegExp(FILE.toString('base64').replace(/[+/=]/g, '\\$&')), 'no base64 of the file');
      assert.match(err, new RegExp(`# The copy is refused unless the file's sha256 is still ${sha256(FILE)}\\.`));
    });

    test('refuses a file too big for one command', async () => {
      const { code, err } = await runCp('big.bin', `wp-x-example-test:${DEST}`, { print: true }, {
        files: { read: () => Buffer.alloc(CHUNK_CHARS) },
      });

      assert.equal(code, 1);
      assert.match(err, /too big for one printed command/);
    });
  });
});

describe('cp out of a container', () => {
  const sent = Buffer.from([0, 1, 2, 255]);
  const container = (data = sent, claimed = sha256(data)) => fakeStart(() => ({
    stdout: `${claimed}\n${data.toString('base64')}\n`,
  }));

  test('writes the file locally, checked against its sha256', async () => {
    const { code, written, err, calls } = await runCp('wp-x-example-test:/tmp/wp-job-12.log', 'job.log', {}, { session: container() });

    assert.equal(code, 0);
    assert.deepEqual(written['job.log'], sent);
    assert.match(calls[0].script, /src=\/tmp\/wp-job-12\.log/);
    assert.match(err, /Copied: wp-x-example-test:\/tmp\/wp-job-12\.log from task task1 to job\.log, 4 bytes/);
  });

  test('into a local directory, under the container file\'s name', async () => {
    const { written } = await runCp('wp-x-example-test:/tmp/wp-job-12.log', 'downloads', {}, { session: container() });

    assert.deepEqual(Object.keys(written), ['downloads/wp-job-12.log']);
  });

  test('- writes it to stdout', async () => {
    const { out, written } = await runCp('wp-x-example-test:/tmp/a.txt', '-', {}, { session: container(Buffer.from('hello\n')) });

    assert.equal(out, 'hello\n');
    assert.deepEqual(written, {});
  });

  test('a damaged copy is an error, and nothing is written', async () => {
    const { code, err, written } = await runCp('wp-x-example-test:/tmp/a.txt', 'a.txt', {}, {
      session: container(sent, '0'.repeat(64)),
    });

    assert.equal(code, 1);
    assert.match(err, /damaged on the way/);
    assert.deepEqual(written, {});
  });

  test('passes on the container\'s failure', async () => {
    const session = fakeStart(() => ({ stderr: 'There\'s no file /tmp/nope in the container.\n', status: 1 }));
    const { code, err } = await runCp('wp-x-example-test:/tmp/nope', 'x', {}, { session });

    assert.equal(code, 1);
    assert.match(err, /There's no file \/tmp\/nope in the container\./);
  });

  test('--all-tasks and --print are for copying in', async () => {
    assert.match((await runCp('wp-x-example-test:/tmp/a', 'a', { allTasks: true })).err, /--all-tasks is for copying into a container/);
    assert.match((await runCp('wp-x-example-test:/tmp/a', 'a', { print: true })).err, /--print is for copying into a container/);
  });
});

describe('cp arguments', () => {
  test('rejects two local or two container paths, relative container paths, and both task flags', async () => {
    const cases = [
      [['a', 'b', {}], /One side has to be <target>:<path>/],
      [['wp-x-example-test:/a', 'wp-x-example-test:/b', {}], /One side has to be <target>:<path>/],
      [['fix.php', 'wp-x-example-test:relative/path', {}], /Container paths have to be absolute, not "relative\/path"/],
      [['fix.php', `wp-x-example-test:${DEST}`, { task: 'a', allTasks: true }], /Use --task or --all-tasks, not both/],
    ];
    for (const [[source, destination, options], message] of cases) {
      const { code, err, calls } = await runCp(source, destination, options);
      assert.equal(code, 1);
      assert.match(err, message);
      assert.deepEqual(calls, []);
    }
  });

  test('a missing local file or a directory is an error, before any AWS call', async () => {
    assert.match((await runCp('nope.php', `wp-x-example-test:${DEST}`)).err, /There's no local file nope\.php/);
    const dir = await runCp('somedir', `wp-x-example-test:${DEST}`, {}, {
      files: { read: () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); } },
    });
    assert.match(dir.err, /cp copies one file, and somedir is a directory/);
  });
});
