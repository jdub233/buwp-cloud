/**
 * Tests for copying files over ECS Exec. The container-side functions run in a local sh, with stand-ins
 * on PATH for php, for chown (tests don't run as root), and, where the machine lacks GNU coreutils
 * (macOS), for sha256sum, stat -c and chmod --reference.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, symlinkSync, existsSync, mkdirSync,
  rmSync, readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseLocation, chunks, appendCommand, dropFunction, readFunction, parseDropReport, parseReadOutput,
  stagingPath, sha256, newCopyId, CHUNK_CHARS,
} from '../lib/index.js';

describe('parseLocation', () => {
  test('reads target:path as a container location, and anything else as local', () => {
    assert.deepEqual(parseLocation('wp-x-example-test:/var/www/html/a.php'), { target: 'wp-x-example-test', path: '/var/www/html/a.php' });
    assert.deepEqual(parseLocation('wp-x-example-test:relative'), { target: 'wp-x-example-test', path: 'relative' });
    assert.deepEqual(parseLocation('./a:b.php'), { local: './a:b.php' });
    assert.deepEqual(parseLocation('/abs/a:b'), { local: '/abs/a:b' });
    assert.deepEqual(parseLocation('-'), { local: '-' });
  });
});

describe('chunks', () => {
  test('splits into request-sized pieces, and an empty file into one empty piece', () => {
    assert.deepEqual(chunks('abcdefg', 3), ['abc', 'def', 'g']);
    assert.deepEqual(chunks(''), ['']);
    assert.equal(chunks('x'.repeat(CHUNK_CHARS + 1)).length, 2);
  });
});

describe('parseDropReport', () => {
  test('reads the report line, and a new file has no old sha256', () => {
    const line = 'buwp-cp path=/var/www/a b.php old=- new=abc bytes=12 owner=www-data:www-data mode=644';
    assert.deepEqual(parseDropReport(`noise\n${line}\n`), {
      path: '/var/www/a b.php', old: null, sha256: 'abc', bytes: 12, owner: 'www-data:www-data', mode: '644',
    });
    assert.equal(parseDropReport('nothing here'), null);
  });
});

describe('parseReadOutput', () => {
  test('decodes the file and checks it against the sha256 sent before it', () => {
    const data = Buffer.from('hello\n');
    const b64 = data.toString('base64');
    assert.deepEqual(parseReadOutput(`${sha256(data)}\n${b64.slice(0, 4)}\n${b64.slice(4)}\n`).data, data);
    assert.throws(() => parseReadOutput(`${'0'.repeat(64)}\n${b64}\n`), /damaged on the way/);
    assert.throws(() => parseReadOutput('oops\n'), /didn't send a sha256/);
  });
});

describe('in the container (a local sh)', () => {
  let bin, work;
  const has = (cmd) => spawnSync('sh', ['-c', cmd]).status === 0;

  before(() => {
    bin = mkdtempSync(join(tmpdir(), 'buwp-bin-'));
    work = mkdtempSync(join(tmpdir(), 'buwp-work-'));
    const shim = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    // php -l fails on a file that says SYNTAX_ERROR, like php's own message.
    shim('php', 'input=$(cat); case "$input" in *SYNTAX_ERROR*) echo "PHP Parse error:  syntax error in Standard input code on line 2"; exit 255;; esac; echo "No syntax errors detected in Standard input code"');
    shim('chown', 'exit 0');
    if (!has('sha256sum /dev/null')) {
      shim('sha256sum', 'exec shasum -a 256 "$@"');
    }
    if (!has('stat -c %a /')) {
      shim('stat', 'fmt=$2; f=$3; case "$fmt" in %a) exec /usr/bin/stat -f %Lp "$f";; %U:%G) exec /usr/bin/stat -f %Su:%Sg "$f";; esac; exit 1');
      shim('chmod', 'case "$1" in --reference=*) m=$(/usr/bin/stat -f %Lp "${1#--reference=}") && exec /bin/chmod "$m" "$2";; esac; exec /bin/chmod "$@"');
    }
  });

  after(() => {
    rmSync(bin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  /** Run buwp_cp for `data` to `dest`, after earlier pieces, as the container would. */
  function drop(dest, data, { name = 'local.php', claimed = sha256(data), earlier = 0 } = {}) {
    const id = newCopyId();
    const b64 = data.toString('base64');
    const pieces = earlier ? chunks(b64, Math.ceil(b64.length / (earlier + 1))) : [b64];
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const piece of pieces.slice(0, -1)) {
      assert.equal(spawnSync('sh', ['-c', appendCommand(id), 'sh', piece], { env }).status, 0);
    }
    const script = [...dropFunction({ id, dest, name, sha256: claimed }), 'buwp_cp "$1"'].join('\n');
    const run = spawnSync('sh', ['-c', script, 'sh', pieces[pieces.length - 1]], { encoding: 'utf8', env });
    return { ...run, id, report: parseDropReport(run.stdout) };
  }
  const leftovers = (dir, id) => [
    ...readdirSync(dir).filter((f) => f.startsWith('.buwp-cp-')),
    ...(existsSync(stagingPath(id)) ? [stagingPath(id)] : []),
  ];

  test('writes a new file with mode 644, and reports it', () => {
    const dir = mkdtempSync(join(work, 'new-'));
    const data = Buffer.from('<?php\necho "hi";\n');
    const { status, report, id } = drop(join(dir, 'a.php'), data);

    assert.equal(status, 0);
    assert.equal(readFileSync(join(dir, 'a.php'), 'utf8'), data.toString());
    assert.equal((statSync(join(dir, 'a.php')).mode & 0o777).toString(8), '644');
    assert.deepEqual([report.old, report.sha256, report.bytes, report.mode], [null, sha256(data), data.length, '644']);
    assert.deepEqual(leftovers(dir, id), []);
  });

  test('keeps the mode of the file it replaces, and reports the old sha256', () => {
    const dir = mkdtempSync(join(work, 'replace-'));
    const dest = join(dir, 'a.php');
    writeFileSync(dest, 'old');
    chmodSync(dest, 0o664);
    const { status, report } = drop(dest, Buffer.from('<?php echo 2;'));

    assert.equal(status, 0);
    assert.equal((statSync(dest).mode & 0o777).toString(8), '664');
    assert.equal(report.old, sha256(Buffer.from('old')));
  });

  test('puts pieces sent earlier back together', () => {
    const dir = mkdtempSync(join(work, 'pieces-'));
    const data = Buffer.from('x'.repeat(5000));
    const { status, id } = drop(join(dir, 'big.txt'), data, { earlier: 3 });

    assert.equal(status, 0);
    assert.equal(readFileSync(join(dir, 'big.txt'), 'utf8'), data.toString());
    assert.deepEqual(leftovers(dir, id), []);
  });

  test('a sha256 mismatch leaves the old file and no temporary files', () => {
    const dir = mkdtempSync(join(work, 'sha-'));
    const dest = join(dir, 'a.txt');
    writeFileSync(dest, 'old');
    const { status, stderr, id } = drop(dest, Buffer.from('new'), { claimed: '0'.repeat(64) });

    assert.equal(status, 1);
    assert.match(stderr, /The copy's sha256 is \w+, not 0{64}\. .* is unchanged\./);
    assert.equal(readFileSync(dest, 'utf8'), 'old');
    assert.deepEqual(leftovers(dir, id), []);
  });

  test('a PHP file that fails php -l leaves the old file and no temporary files', () => {
    const dir = mkdtempSync(join(work, 'lint-'));
    const dest = join(dir, 'a.php');
    writeFileSync(dest, '<?php echo "old";');
    const { status, stderr, id } = drop(dest, Buffer.from('<?php SYNTAX_ERROR'));

    assert.equal(status, 1, 'the failure comes back as the function\'s status');
    assert.match(stderr, /PHP Parse error: .* in Standard input code/);
    assert.match(stderr, /failed php -l\. .*a\.php is unchanged\./);
    assert.equal(readFileSync(dest, 'utf8'), '<?php echo "old";');
    assert.deepEqual(leftovers(dir, id), []);
  });

  test('only .php files are linted', () => {
    const dir = mkdtempSync(join(work, 'nolint-'));
    assert.equal(drop(join(dir, 'notes.txt'), Buffer.from('SYNTAX_ERROR is fine here')).status, 0);
  });

  test('a directory destination gets the local file\'s name', () => {
    const dir = mkdtempSync(join(work, 'dir-'));
    const { status, report } = drop(dir, Buffer.from('x'), { name: 'from-local.txt' });

    assert.equal(status, 0);
    assert.equal(report.path, join(dir, 'from-local.txt'));
  });

  test('refuses a missing directory and a symbolic link', () => {
    const dir = mkdtempSync(join(work, 'refuse-'));
    const missing = drop(join(dir, 'nope', 'a.txt'), Buffer.from('x'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /There's no directory .*nope in the container/);
    assert.equal(existsSync(stagingPath(missing.id)), false);

    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'target.txt'), 'keep');
    symlinkSync(join(dir, 'real', 'target.txt'), join(dir, 'link.txt'));
    const link = drop(join(dir, 'link.txt'), Buffer.from('x'));
    assert.equal(link.status, 1);
    assert.match(link.stderr, /is a symbolic link; cp won't replace it/);
    assert.equal(readFileSync(join(dir, 'real', 'target.txt'), 'utf8'), 'keep');
  });

  test('buwp_get prints the sha256 and base64 that parseReadOutput turns back into the file', () => {
    const file = join(work, 'out.bin');
    const data = Buffer.from([0, 1, 2, 255, 10, 13]);
    writeFileSync(file, data);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const run = spawnSync('sh', ['-c', [...readFunction(file), 'buwp_get'].join('\n')], { encoding: 'utf8', env });

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(parseReadOutput(run.stdout).data, data);

    const missing = spawnSync('sh', ['-c', [...readFunction(join(work, 'nope')), 'buwp_get'].join('\n')], { encoding: 'utf8', env });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /There's no file .*nope in the container/);
  });
});
