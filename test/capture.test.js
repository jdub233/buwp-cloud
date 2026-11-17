/**
 * Tests for capturing a command's output over ECS Exec. The scripts run in a local sh here: no
 * terminal, so no \r\n, but the same fd plumbing as in the container.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  newNonce, sessionLabel, commandLine, captureScript, wrapCapture, printableScript, remoteCommand,
  printedCommand, createOutputSplitter, sessionFailure, toTarget,
} from '../lib/index.js';
import { wordpressContext } from './fixtures.js';

const NONCE = '__buwp_0123456789ab_';

/** Feed text to a splitter, in chunks of `size` characters, recording what it passes on in order. */
function split(text, { size = text.length } = {}) {
  const events = [];
  const splitter = createOutputSplitter(NONCE, {
    stdout: (s) => events.push(['out', s]),
    stderr: (s) => events.push(['err', s]),
  });
  for (let i = 0; i < text.length; i += size) {
    splitter.push(text.slice(i, i + size));
  }
  const result = splitter.end();
  const join = (stream) => events.filter(([s]) => s === stream).map(([, t]) => t).join('');
  return { ...result, events, stdout: join('out'), stderr: join('err') };
}

/** What a session prints around the script's output, with the container's \r\n line endings. */
const session = (body) => [
  '',
  'The Session Manager plugin was installed successfully. Use the AWS CLI to start a session.',
  '',
  '',
  'Starting session with SessionId: ecs-execute-command-example',
  `${NONCE}BEGIN\r`,
].join('\n') + `\n${body}\n\nExiting session with sessionId: ecs-execute-command-example.\n\n`;

describe('newNonce', () => {
  test('is a fresh, sed-safe marker each time', () => {
    const a = newNonce();
    assert.match(a, /^__buwp_[0-9a-f]{12}_$/);
    assert.notEqual(a, newNonce());
  });
});

describe('sessionLabel', () => {
  test('names the run by its leading plain words, up to three', () => {
    assert.equal(sessionLabel(['wp', 'option', 'get', 'home']), 'buwp:wp-option-get');
    assert.equal(sessionLabel(['wp', 'site', 'list', '--format=json']), 'buwp:wp-site-list');
  });

  test('stops at flags, code and values, so they stay out of the label', () => {
    assert.equal(sessionLabel(['wp', 'eval', 'echo "secret";']), 'buwp:wp-eval');
    assert.equal(sessionLabel(['wp', '--user=admin', 'user', 'list']), 'buwp:wp');
    assert.equal(sessionLabel(['sh', '-c', 'ls | wc -l']), 'buwp:sh');
    assert.equal(sessionLabel(['/bin/ls']), 'buwp:exec');
  });
});

describe('commandLine', () => {
  test('keeps each word one argument', () => {
    assert.equal(commandLine(['wp', 'option', 'get', 'home']), 'wp option get home');
    assert.equal(commandLine(['wp', 'eval', 'echo "it\'s";']), `wp eval 'echo "it'\\''s";'`);
  });
});

describe('captureScript', () => {
  test('turns off the pager, and tells wp-cli it is piped only when output here is', () => {
    assert.match(captureScript(['wp'], { nonce: NONCE }), /^export PAGER=cat$/m);
    assert.doesNotMatch(captureScript(['wp'], { nonce: NONCE }), /SHELL_PIPE/);
    assert.match(captureScript(['wp'], { nonce: NONCE, piped: true }), /^export SHELL_PIPE=1$/m);
  });

  test('in sh, splits stdout from stderr and reports the exit status last', () => {
    const script = captureScript(['sh', '-c', 'echo out; echo err >&2; printf partial; exit 3'], { nonce: NONCE });
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8' });

    const { started, status, stdout, stderr } = split(run.stdout);
    assert.equal(run.status, 0, 'the script itself succeeds; the status travels in the output');
    assert.equal(started, true);
    assert.equal(status, 3);
    assert.equal(stdout, 'out\npartial');
    assert.equal(stderr, 'err\n');
  });

  test('in sh, leaves a command\'s own redirections alone', () => {
    // cp's pieces append to a file with >>. Before the command had its own { }, the capture's
    // 1>&3 came after that >> and won, so the pieces went to the terminal instead.
    const dir = mkdtempSync(join(tmpdir(), 'buwp-capture-'));
    const file = join(dir, 'staged');
    const script = wrapCapture(`printf '%s' "$1" >> '${file}'`, { nonce: NONCE });
    const run = spawnSync('sh', ['-c', script, 'sh', 'piece-one'], { encoding: 'utf8' });

    assert.equal(split(run.stdout).status, 0);
    assert.equal(split(run.stdout).stdout, '');
    assert.equal(readFileSync(file, 'utf8'), 'piece-one');
  });

  test('in sh, captures every command of a list, and reports the last one\'s status', () => {
    const script = wrapCapture('echo one; echo two >&2; false', { nonce: NONCE });
    const { stdout, stderr, status } = split(spawnSync('sh', ['-c', script], { encoding: 'utf8' }).stdout);

    assert.equal(stdout, 'one\n');
    assert.equal(stderr, 'two\n');
    assert.equal(status, 1);
  });

  test('in sh, gives the command end-of-file on stdin instead of waiting', () => {
    const script = captureScript(['sh', '-c', 'read answer; echo "read status $?"'], { nonce: NONCE });
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', input: 'yes\n' });

    assert.equal(split(run.stdout).stdout, 'read status 1\n');
  });
});

describe('remoteCommand', () => {
  test('wraps the script in sh -c as base64, named by the label', () => {
    const script = printableScript(['wp', 'eval', 'echo "it\'s $HOME";']);
    const command = remoteCommand(script, 'buwp:wp-eval');

    const match = command.match(/^sh -c "echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh" buwp:wp-eval$/);
    assert.ok(match, command);
    assert.equal(Buffer.from(match[1], 'base64').toString('utf8'), script);
  });

  test('passes base64 arguments to sh -s, encoded once', () => {
    assert.match(remoteCommand('echo', 'buwp:cp', ['YWJj']), / \| sh -s YWJj" buwp:cp$/);
    assert.throws(() => remoteCommand('echo', 'buwp:cp', ['not base64!']), /have to be base64/);
  });

  test('carries the script\'s arguments through, in sh', () => {
    const script = 'printf "%s|" "$1"';
    const inner = remoteCommand(script, 'buwp:x', ['YWJj']).match(/^sh -c "(.*)" buwp:x$/)[1];
    const run = spawnSync('sh', ['-c', inner], { encoding: 'utf8' });

    assert.equal(run.stdout, 'YWJj|');
  });
});

describe('sessionFailure', () => {
  test('is null when the run reported a status', () => {
    assert.equal(sessionFailure({ awsExit: 0, started: true, status: 3, other: [] }), null);
  });

  test('passes on the aws exit code and what the plugin said when nothing started', () => {
    assert.deepEqual(sessionFailure({ awsExit: 254, started: false, status: null, other: ['', 'too large'] }), {
      code: 254, message: 'The session ended before the command started (aws exited 254).', hint: null, details: ['too large'],
    });
  });

  test('is 255 when the command started but its status never came back', () => {
    assert.equal(sessionFailure({ awsExit: 0, started: true, status: null, other: [] }).code, 255);
  });
});

describe('printedCommand', () => {
  const target = toTarget(wordpressContext(), { profile: 'example-nprd' });
  const task = { taskId: 'task1' };
  const words = ['wp', 'eval', 'echo "it\'s $HOME \\ `x`";'];

  test('shows the readable script and no base64', () => {
    const text = printedCommand(target, task, printableScript(words), 'buwp:wp-eval');

    assert.match(text, /^buwp_script\(\) \{\ncat <<'BUWP_SCRIPT'\nexport PAGER=cat\nwp eval /);
    assert.match(text, /^echo "exit status: \$\?"\nBUWP_SCRIPT\n\}\naws ecs execute-command /m);
    assert.match(text, /--container wordpress --interactive --command "sh -c /);
    assert.match(text, /--region us-east-1 --profile example-nprd\n$/);
  });

  // Whichever shells this machine has: sh always, and bash and zsh where installed. On macOS, bash
  // is 3.2, which once ended a $( ) early at the ) of a case pattern inside a heredoc.
  const shells = ['sh', 'bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'true']).status === 0);
  const stub = 'aws() { while [ $# -gt 0 ]; do [ "$1" = --command ] && printf %s "$2"; shift; done; }';
  /** What a printed command would pass as --command, with the script decoded. */
  const sent = (shell, text) => {
    const run = spawnSync(shell, ['-c', `${stub}\n${text}`], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${shell}: ${run.stderr}`);
    const m = run.stdout.match(/^sh -c "echo (\S+) \| base64 -d \| sh( -s [^"]*)?" (\S+)$/);
    assert.ok(m, `${shell}: ${run.stdout}`);
    return { script: Buffer.from(m[1], 'base64').toString('utf8'), args: m[2] ?? '', label: m[3] };
  };

  for (const shell of shells) {
    test(`sends exactly the script when pasted into ${shell}`, () => {
      const script = printableScript(words);
      const got = sent(shell, printedCommand(target, task, script, 'buwp:wp-eval'));

      assert.equal(got.script, `${script}\n`);
      assert.equal(got.label, 'buwp:wp-eval');
    });

    test(`survives parentheses and case patterns in the script, in ${shell}`, () => {
      const script = 'case "$1" in *.php) echo "php (yes)" ;; esac';
      const got = sent(shell, printedCommand(target, task, script, 'buwp:cp', {
        setup: ['b64=$(printf abc | base64)'], argsExpression: '$b64',
      }));

      assert.equal(got.script, `${script}\n`);
      assert.equal(got.args, ' -s YWJj');
    });
  }

  test('picks another heredoc delimiter if the script holds the usual one', () => {
    const text = printedCommand(target, task, 'echo\nBUWP_SCRIPT', 'buwp:echo');
    assert.match(text, /<<'BUWP_SCRIPT_'\n/);
  });
});

describe('createOutputSplitter', () => {
  test('drops the session banners and converts line endings', () => {
    const { started, status, stdout, stderr, other } = split(session(
      'https://example.edu\r\n\r\n' + `${NONCE}RC=0\r`
    ));

    assert.equal(started, true);
    assert.equal(status, 0);
    assert.equal(stdout, 'https://example.edu\n');
    assert.equal(stderr, '');
    assert.ok(other.includes('Starting session with SessionId: ecs-execute-command-example'));
  });

  test('keeps output that has no trailing newline as it is', () => {
    const { stdout } = split(session('[{"blog_id":"1"}]\r\n' + `${NONCE}RC=0\r`));

    assert.equal(stdout, '[{"blog_id":"1"}]');
  });

  test('sends tagged lines to stderr', () => {
    const { stdout, stderr, status } = split(session(
      `${NONCE}E PHP Warning: noise\r\n${NONCE}E Error: Could not get 'x' option.\r\n\r\n${NONCE}RC=1\r`
    ));

    assert.equal(stdout, '');
    assert.equal(stderr, "PHP Warning: noise\nError: Could not get 'x' option.\n");
    assert.equal(status, 1);
  });

  test('splits stderr that landed mid-line after unfinished stdout', () => {
    const { stdout, stderr } = split(session(
      `Success: ok\r\nno-newline${NONCE}E to-stderr\r\n\r\n${NONCE}RC=0\r`
    ));

    assert.equal(stdout, 'Success: ok\nno-newline');
    assert.equal(stderr, 'to-stderr\n');
  });

  test('ends a stdout line before stderr that follows it, so a shared terminal shows them in order', () => {
    const { events } = split(session(`out\r\n${NONCE}E err\r\n\r\n${NONCE}RC=3\r`));

    assert.deepEqual(events.map(([s, t]) => `${s}:${t}`).join('|'), 'out:out|out:\n|err:err\n');
  });

  test('gives the same result however the output is chunked', () => {
    const text = session(`one\r\n${NONCE}E two\r\nthree\r\n\r\n${NONCE}RC=0\r`);
    const whole = split(text);

    for (const size of [1, 2, 7]) {
      const chunked = split(text, { size });
      assert.equal(chunked.stdout, whole.stdout);
      assert.equal(chunked.stderr, whole.stderr);
      assert.equal(chunked.status, whole.status);
    }
    assert.equal(whole.stdout, 'one\nthree\n');
  });

  test('a session that never reached the command reports nothing started', () => {
    const { started, status, stdout, other } = split('\nAn error occurred (TargetNotConnectedException)\n');

    assert.equal(started, false);
    assert.equal(status, null);
    assert.equal(stdout, '');
    assert.ok(other.includes('An error occurred (TargetNotConnectedException)'));
  });

  test('a session cut off mid-command has no status, and keeps the output it got', () => {
    const { started, status, stdout } = split(`${NONCE}BEGIN\r\nhalf\r\n`);

    assert.equal(started, true);
    assert.equal(status, null);
    assert.equal(stdout, 'half\n');
  });
});
