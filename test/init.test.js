/**
 * Tests for init. The menus are answered by a scripted stand-in for prompts, and the AWS files
 * live in a throwaway home directory.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import initCommand, { describeReach } from '../lib/commands/init.js';
import { CONFIG_FILE_NAME } from '../lib/index.js';
import { wordpressContext, contextBucket, fakeAws, awsError } from './fixtures.js';

const OTHER_ACCOUNT = '210987654321';

const AWS_CONFIG = `[default]
region = us-east-1
[profile example-nprd]
region = us-east-1
[profile example-prd]
region = us-east-1
[profile example-tool]
credential_process = /usr/local/bin/example-login
`;
const AWS_CREDENTIALS = `[example-nprd]
aws_session_token = not-a-real-token
[example-other]
aws_session_token = not-a-real-token
`;

const sharedBuckets = {
  [contextBucket('wp-x-example-test')]: wordpressContext(),
  [contextBucket('wp-y-example-prod')]: wordpressContext({
    STACK_ID: 'wp-y',
    TAGS: { Landscape: 'example-prod' },
    WORDPRESS: { dockerImage: 'example/wordpress:latest', env: { environmentType: 'production' } },
  }),
};
const otherBuckets = {
  [`wp-z-example-test-context-config-${OTHER_ACCOUNT}-us-east-1`]: wordpressContext({ STACK_ID: 'wp-z', ACCOUNT: OTHER_ACCOUNT }),
};

/** default reaches the same account as example-nprd; example-tool must never be called. */
const awsByProfile = () => fakeAws({
  default: { buckets: sharedBuckets },
  'example-nprd': { buckets: sharedBuckets },
  'example-prd': { error: awsError('ExpiredToken', 'The provided token has expired.') },
  'example-other': { buckets: otherBuckets },
});

const tempDirs = [];
after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A home directory with AWS files and a project directory inside it, plus any extra files. */
function setup({ config = AWS_CONFIG, credentials = AWS_CREDENTIALS, files = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buwp-cloud-init-'));
  tempDirs.push(home);
  fs.mkdirSync(path.join(home, '.aws'));
  fs.mkdirSync(path.join(home, 'project'));
  if (config !== null) {
    fs.writeFileSync(path.join(home, '.aws', 'config'), config);
  }
  if (credentials !== null) {
    fs.writeFileSync(path.join(home, '.aws', 'credentials'), credentials);
  }
  for (const [rel, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, rel), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return { home, project: path.join(home, 'project') };
}

/** Answer each question by name: a value, or a function of the question. A missing answer cancels. */
function scripted(answers) {
  const questions = [];
  const prompt = async (question, { onCancel }) => {
    questions.push(question);
    const answer = answers[question.name];
    if (answer === undefined) {
      onCancel();
      return {};
    }
    return { [question.name]: typeof answer === 'function' ? answer(question) : answer };
  };
  return { prompt, questions };
}

const preselected = (q) => q.choices.filter((c) => c.selected).map((c) => c.value);
const reachOf = (q) => Object.fromEntries(q.choices.map((c) => [c.value, c.title.slice(c.value.length).trim()]));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function runInit(options, { home, cwd, answers = {}, aws = awsByProfile(), env = {}, terminal = true, gitIgnored = () => true }) {
  let out = '';
  let err = '';
  const { prompt, questions } = scripted(answers);
  const code = await initCommand(options, {
    aws,
    env,
    cwd,
    homedir: home,
    terminal,
    prompt,
    gitIgnored,
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    tools: () => [
      { name: 'aws', found: true, version: '2.36.40', problem: null, belowTested: false },
      { name: 'session-manager-plugin', found: false, version: null, problem: null, belowTested: false },
    ],
  });
  return { code, out, err, questions, aws };
}

describe('init', () => {
  test('lists every profile with what it reaches, and saves the selection to this directory', async () => {
    const { home, project } = setup();
    const { code, out, err, questions, aws } = await runInit({}, {
      home, cwd: project, answers: { profiles: preselected, file: (q) => q.choices[0].value },
    });

    assert.equal(code, 0, err);
    const [menu, location] = questions;
    assert.equal(menu.type, 'multiselect');
    assert.deepEqual(reachOf(menu), {
      default: 'same account as example-nprd',
      'example-nprd': '2 WordPress targets: 1 nonprod, 1 prod',
      'example-prd': 'credentials expired',
      'example-tool': 'not checked: it runs a credential_process',
      'example-other': '1 WordPress target: 1 nonprod',
    });
    assert.deepEqual(preselected(menu), ['example-nprd', 'example-other']);
    assert.equal(menu.choices[1].description, 'wp-x-example-test, wp-y-example-prod');
    assert.ok(!aws.calls.some(([call, profile]) => call === 'listBucketNames' && profile === 'example-tool'));

    assert.equal(location.type, 'select');
    assert.equal(location.initial, 0);
    assert.deepEqual(readJson(path.join(project, CONFIG_FILE_NAME)), { profiles: ['example-nprd', 'example-other'] });
    assert.match(err, /Checking 5 AWS profiles for WordPress targets/);
    assert.match(out, /Created ~\/project\/\.buwp-cloud\.json with profiles: example-nprd, example-other\n/);
    assert.match(out, /They reach 3 WordPress targets\. List them with: buwp-cloud clusters\n/);
    assert.match(out, /aws\s+2\.36\.40\n\s+session-manager-plugin\s+not found\n/);
  });

  test('starts from the config in effect, offers its location first, and keeps its other keys', async () => {
    const { home, project } = setup({ files: { [CONFIG_FILE_NAME]: { profiles: ['example-prd'], note: 'kept' } } });
    const { code, out, questions } = await runInit({}, {
      home, cwd: project, answers: { profiles: preselected, file: (q) => q.choices[q.initial].value },
    });

    assert.equal(code, 0);
    assert.deepEqual(preselected(questions[0]), ['example-nprd', 'example-prd', 'example-other']);
    assert.equal(questions[1].initial, 1);
    assert.deepEqual(readJson(path.join(home, CONFIG_FILE_NAME)), {
      profiles: ['example-nprd', 'example-prd', 'example-other'],
      note: 'kept',
    });
    assert.match(out, /Updated ~\/\.buwp-cloud\.json/);
    assert.match(out, /They reach 3 WordPress targets so far\./);
  });

  test('keeps a config profile the AWS files no longer name, selected and marked', async () => {
    const { home, project } = setup({ files: { [`project/${CONFIG_FILE_NAME}`]: { profiles: ['example-gone'] } } });
    const { questions } = await runInit({}, { home, cwd: project, answers: {} });

    assert.equal(reachOf(questions[0])['example-gone'], 'in the config file, but not in your AWS files');
    assert.ok(preselected(questions[0]).includes('example-gone'));
  });

  test('two chosen profiles on one account need a yes before anything is saved', async () => {
    const { home, project } = setup();
    const both = { profiles: ['default', 'example-nprd'], file: (q) => q.choices[0].value };

    const declined = await runInit({}, { home, cwd: project, answers: { ...both, keep: false } });
    assert.equal(declined.code, 1);
    assert.match(declined.err, /default and example-nprd reach the same AWS account/);
    assert.match(declined.err, /Cancelled\. Nothing was written\./);
    assert.equal(fs.existsSync(path.join(project, CONFIG_FILE_NAME)), false);

    const accepted = await runInit({}, { home, cwd: project, answers: { ...both, keep: true } });
    assert.equal(accepted.code, 0);
    assert.deepEqual(readJson(path.join(project, CONFIG_FILE_NAME)).profiles, ['default', 'example-nprd']);
  });

  test('cancelling a menu writes nothing', async () => {
    const { home, project } = setup();
    const { code, err } = await runInit({}, { home, cwd: project, answers: { profiles: ['example-nprd'] } });

    assert.equal(code, 1);
    assert.match(err, /Cancelled/);
    assert.equal(fs.existsSync(path.join(project, CONFIG_FILE_NAME)), false);
    assert.equal(fs.existsSync(path.join(home, CONFIG_FILE_NAME)), false);
  });

  test('notes a home file that a closer one hides, and a project file git would commit', async () => {
    const { home, project } = setup({ files: { [`project/${CONFIG_FILE_NAME}`]: { profiles: ['example-nprd'] } } });
    const toHome = await runInit({}, {
      home, cwd: project, answers: { profiles: ['example-nprd'], file: (q) => q.choices[1].value },
    });
    assert.match(toHome.err, /Note: ~\/project has a config file of its own, which is the one used there\./);

    const toProject = await runInit({}, {
      home, cwd: project, gitIgnored: () => false, answers: { profiles: ['example-nprd'], file: (q) => q.choices[0].value },
    });
    assert.match(toProject.err, /Note: ~\/project\/\.buwp-cloud\.json names AWS profiles and isn't gitignored/);
  });

  test('says when AWS_PROFILE will override what it saves', async () => {
    const { home, project } = setup();
    const { err } = await runInit({}, {
      home, cwd: project, env: { AWS_PROFILE: 'example-prd' }, answers: { profiles: ['example-nprd'], file: (q) => q.choices[0].value },
    });
    assert.match(err, /AWS_PROFILE is set \(example-prd\), and it overrides the config file/);
  });

  test('with no profiles in the AWS files, says where it looked', async () => {
    const { home, project } = setup({ config: '', credentials: null });
    const { code, err, questions } = await runInit({}, { home, cwd: project });

    assert.equal(code, 1);
    assert.match(err, /No AWS profiles found in ~\/\.aws\/config\./);
    assert.deepEqual(questions, []);
  });

  describe('without the menus', () => {
    test('saves --profile flags, to the home directory with --home', async () => {
      const { home, project } = setup();
      const { code, questions } = await runInit({ profile: ['example-nprd'], home: true }, { home, cwd: project });

      assert.equal(code, 0);
      assert.deepEqual(questions, []);
      assert.deepEqual(readJson(path.join(home, CONFIG_FILE_NAME)), { profiles: ['example-nprd'] });
    });

    test('with no terminal and no profiles, says how to name them', async () => {
      const { home, project } = setup();
      const noTerminal = await runInit({}, { home, cwd: project, terminal: false });
      assert.equal(noTerminal.code, 1);
      assert.match(noTerminal.err, /init's menus need a terminal\. Name the AWS profiles to save: buwp-cloud init --no-interactive --profile/);

      const declined = await runInit({ interactive: false }, { home, cwd: project });
      assert.equal(declined.code, 1);
      assert.doesNotMatch(declined.err, /need a terminal/);
    });
  });
});

describe('describeReach', () => {
  const base = { checked: true, targets: [], accounts: [], error: null, unreadable: 0, sameAs: null };

  test('tells bad credentials from other failures, and shortens long messages', () => {
    assert.equal(describeReach({ ...base, error: { code: 'InvalidAccessKeyId', message: 'x' } }), 'no valid credentials');
    const long = describeReach({ ...base, error: { code: 'TimeoutError', message: `TimeoutError: ${'x'.repeat(80)}` } });
    assert.match(long, /^couldn't check: TimeoutError: x+…$/);
    assert.ok(long.length < 80);
  });

  test('mentions context files it couldn\'t read', () => {
    assert.equal(describeReach({ ...base, unreadable: 2 }), 'no WordPress targets it could read (2 context files unreadable)');
  });
});
