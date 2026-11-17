/**
 * Running one command in a task's wordpress container and getting its output and exit status back.
 *
 * ECS Exec gives the command a terminal, which merges its stdout and stderr, turns \n into \r\n,
 * and drops its exit status: the local `aws` exits 0 either way (the mission's open item 1). So the
 * command runs inside a small sh script that:
 * - prints a start marker, so the Session Manager plugin's banners around the output can be dropped
 * - tags each stderr line, so stderr can be split back out
 * - prints the exit status after the output
 * The markers carry a random nonce per run, so nothing the command prints can be mistaken for them.
 *
 * The script travels base64-encoded inside `sh -c`, which avoids the quoting layers between the
 * local shell, the `--command` parser and the container's shell. Bulk data, such as a file being
 * copied in, travels beside it as an argument to `sh -s`, already base64, so it isn't encoded twice.
 *
 * ECS refuses an ExecuteCommand request somewhere between 107 KB and 171 KB of `--command`
 * (measured against a nonprod cluster, 2026-11-16), and Linux caps a single argument at 128 KB.
 */

import { randomBytes } from 'crypto';
import { shellQuote, execArgs, formatCommandLine, startSession } from './session.js';

// Like ssh: the exit code when the session ended without reporting the command's exit status.
export const NO_STATUS_EXIT_CODE = 255;

const BASE64 = /^[A-Za-z0-9+/=]*$/;

/** A fresh marker prefix: letters, digits and underscores only, so sed and the parser take it literally. */
export function newNonce() {
  return `__buwp_${randomBytes(6).toString('hex')}_`;
}

/**
 * A readable name for the run, passed as the outer sh's $0. ECS records the `--command` string in
 * CloudTrail, so the name shows what ran without decoding the base64. It takes up to three leading
 * words, stopping at the first flag or anything that isn't a plain name, so code, values and
 * passwords stay out of it: `wp option get home` is buwp:wp-option-get, `wp eval '...'` is
 * buwp:wp-eval.
 * @param {string[]} words - The command, one argument per word
 * @returns {string}
 */
export function sessionLabel(words) {
  const leading = [];
  for (const word of words) {
    if (leading.length === 3 || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(word)) {
      break;
    }
    leading.push(word);
  }
  return `buwp:${leading.join('-') || 'exec'}`;
}

/**
 * The command as one sh command line. Every word stays a separate argument, as with docker exec, so
 * shell syntax (pipes, globs, ;) needs an explicit `sh -c '...'`.
 * @param {string[]} words
 * @returns {string}
 */
export function commandLine(words) {
  return words.map(shellQuote).join(' ');
}

/**
 * Environment for the command, the same in a captured run and a printed one.
 * - PAGER=cat: wp-cli pages help output when it sees a terminal, and a pager would wait for keys
 *   that never come.
 * - SHELL_PIPE=1 when local stdout isn't a terminal: wp-cli then behaves as it does when piped
 *   locally, with no color and tab-separated tables, because the container side always has a
 *   terminal.
 * @param {{piped?: boolean}} opts
 * @returns {string[]} Script lines
 */
function environmentLines({ piped = false } = {}) {
  return ['export PAGER=cat', ...(piped ? ['export SHELL_PIPE=1'] : [])];
}

/**
 * Wrap a shell command line in the capture script.
 *
 * The command's stdout goes straight to the terminal (fd 3). Its stderr goes through sed, which
 * tags each line. The exit status leaves through fd 4 into $rc, and is printed only after sed has
 * finished, so the status always comes last. The command's stdin is /dev/null: local stdin isn't
 * forwarded, and a command that prompts gets end-of-file instead of waiting forever.
 * @param {string} command - A shell command line; it can use the script's positional arguments
 * @param {{nonce: string, piped?: boolean, preamble?: string[]}} opts - preamble lines come before
 *   the command, for example a function it calls
 * @returns {string}
 */
export function wrapCapture(command, { nonce, piped = false, preamble = [] }) {
  return [
    ...environmentLines({ piped }),
    ...preamble,
    `printf '%s\\n' '${nonce}BEGIN'`,
    'exec 3>&1',
    // The command sits in its own { } so the redirections cover all of it, even a list with ;.
    `rc=$( { { { ${command}\n} </dev/null 2>&1 1>&3 3>&- 4>&-; echo $? >&4; } | sed 's/^/${nonce}E /' >&3; } 4>&1 )`,
    // The leading newline ends a last line the command left open, such as JSON without a trailing
    // newline. The parser drops it again.
    `printf '\\n%sRC=%s\\n' '${nonce}' "$rc"`,
  ].join('\n');
}

/**
 * The script a captured run of `words` sends.
 * @param {string[]} words
 * @param {{nonce: string, piped?: boolean}} opts
 * @returns {string}
 */
export function captureScript(words, opts) {
  return wrapCapture(commandLine(words), opts);
}

/**
 * The script --print shows: the command and its environment, plus a line that reports the exit
 * status, since the AWS CLI doesn't. No markers, so a human running it sees plain output.
 * @param {string} command - A shell command line
 * @param {{piped?: boolean, preamble?: string[]}} opts
 * @returns {string}
 */
export function printableScriptFor(command, { piped = false, preamble = [] } = {}) {
  return [
    ...environmentLines({ piped }),
    ...preamble,
    `${command} </dev/null`,
    'echo "exit status: $?"',
  ].join('\n');
}

/**
 * printableScriptFor() for a command given as words.
 * @param {string[]} words
 * @param {{piped?: boolean}} opts
 * @returns {string}
 */
export function printableScript(words, opts) {
  return printableScriptFor(commandLine(words), opts);
}

/**
 * The `--command` value for ECS Exec. ECS splits it on spaces, honoring quotes, and runs it without
 * a shell, so the script rides inside `sh -c` as base64, which has no characters that need quoting.
 * @param {string} script
 * @param {string} label - The outer sh's $0
 * @param {string[]} [args] - Positional arguments for the script ($1, $2...). They have to be base64
 *   already, so they need no quoting either.
 * @returns {string}
 */
export function remoteCommand(script, label, args = []) {
  if (!args.every((a) => BASE64.test(a))) {
    throw new Error('Arguments for a remote script have to be base64.');
  }
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const rest = args.length ? ` -s ${args.join(' ')}` : '';
  return `sh -c "echo ${encoded} | base64 -d | sh${rest}" ${label}`;
}

/**
 * The same `--command` value as a shell expression that encodes the readable script at run time,
 * so a printed command shows the script instead of base64. It expects a shell function,
 * buwp_script, that prints the script.
 * @param {string} label
 * @param {string} [argsExpression] - Shell text for the script's arguments, such as `$b64`
 * @returns {string}
 */
export function remoteCommandExpression(label, argsExpression = '') {
  const rest = argsExpression ? ` -s ${argsExpression}` : '';
  return `"sh -c \\"echo $(buwp_script | base64 | tr -d '\\n') | base64 -d | sh${rest}\\" ${label}"`;
}

/**
 * What --print shows: the readable script in a quoted heredoc, then an `aws` command per task that
 * sends it. Nothing in the script needs escaping, and pasting it all into bash or zsh runs it.
 * The heredoc sits in a function rather than inside $( ): macOS's bash 3.2 ends a $( ) early at a
 * ) inside a heredoc, such as a case pattern's.
 * @param {object} target - From findTarget()
 * @param {object|object[]} tasks - One task or several, from pickTask()
 * @param {string} script - From printableScript() or printableScriptFor()
 * @param {string} label - From sessionLabel()
 * @param {{setup?: string[], argsExpression?: string}} [opts] - setup lines run first, for example
 *   to read a local file into a variable that argsExpression passes on
 * @returns {string}
 */
export function printedCommand(target, tasks, script, label, { setup = [], argsExpression = '' } = {}) {
  const placeholder = '__BUWP_COMMAND__';
  const commands = (Array.isArray(tasks) ? tasks : [tasks]).map((task) =>
    formatCommandLine('aws', execArgs(target, task, placeholder))
      .replace(placeholder, remoteCommandExpression(label, argsExpression)));
  const lines = script.split('\n');
  let delimiter = 'BUWP_SCRIPT';
  while (lines.includes(delimiter)) {
    delimiter += '_';
  }
  return [
    ...setup,
    'buwp_script() {',
    `cat <<'${delimiter}'`,
    script,
    delimiter,
    '}',
    ...commands,
    '',
  ].join('\n');
}

/**
 * Run a script over ECS Exec in a task's wordpress container, passing its output on as it arrives.
 *
 * As with db tunnel, the child's stdin is a pipe that stays open and unwritten: with stdin at
 * end-of-file, the plugin can end the session early. The AWS CLI's own errors go straight to
 * stderr.
 * @param {object} target - From findTarget()
 * @param {object} task - From pickTask()
 * @param {{script: string, nonce: string, label: string, args?: string[]}} run - script from
 *   wrapCapture() with the same nonce
 * @param {{start?: Function, stdout: Function, stderr: Function}} deps
 * @returns {Promise<{awsExit: number, started: boolean, status: number|null, other: string[]}>}
 *   Rejects when `aws` can't be started
 */
export async function runCaptured(target, task, { script, nonce, label, args = [] }, {
  start = startSession, stdout, stderr,
}) {
  const splitter = createOutputSplitter(nonce, { stdout, stderr });
  const session = start('aws', execArgs(target, task, remoteCommand(script, label, args)),
    { stdio: ['pipe', 'pipe', 'inherit'] });
  session.child.stdout?.setEncoding('utf8');
  session.child.stdout?.on('data', (chunk) => splitter.push(chunk));
  try {
    const awsExit = await session.exited;
    return { awsExit, ...splitter.end() };
  } finally {
    session.child.stdin?.destroy();
  }
}

/**
 * What went wrong when a captured run has no exit status, or null when it has one.
 * @param {{awsExit: number, started: boolean, status: number|null, other: string[]}} result
 * @returns {{code: number, message: string, hint: string|null, details: string[]}|null} details are
 *   lines the plugin printed instead of the command's output
 */
export function sessionFailure({ awsExit, started, status, other }) {
  if (status !== null) {
    return null;
  }
  if (!started) {
    return {
      code: awsExit || 1,
      message: `The session ended before the command started (aws exited ${awsExit}).`,
      hint: null,
      details: other.filter((t) => t.trim()),
    };
  }
  return {
    code: NO_STATUS_EXIT_CODE,
    message: 'The session ended before the command finished, so its exit status is unknown.',
    hint: 'It may have finished, or may still be running, in the container. Check before running it again.',
    details: [],
  };
}

/**
 * Split a captured run's output back into the command's stdout, its stderr and its exit status.
 *
 * Feed it the session's stdout as it arrives. Lines before the start marker and after the status
 * are the plugin's banners and are set aside. Line endings come back as \n. Lines are passed on as
 * they complete, so long-running commands stream; a line with no newline yet waits for one.
 * @param {string} nonce
 * @param {{stdout: (s: string) => void, stderr: (s: string) => void}} out
 * @returns {{push: (chunk: string) => void, end: () => {started: boolean, status: number|null, other: string[]}}}
 */
export function createOutputSplitter(nonce, { stdout, stderr }) {
  const begin = `${nonce}BEGIN`;
  const errTag = `${nonce}E `;
  const statusLine = new RegExp(`^${nonce}RC=(\\d+)$`);
  const other = [];
  let buffer = '';
  let started = false;
  let status = null;
  // The newline after the last stdout line is held back until more output shows it was the
  // command's. If the status line comes next, the newline was the script's own, and is dropped.
  let heldNewline = false;

  const release = () => {
    if (heldNewline) {
      stdout('\n');
      heldNewline = false;
    }
  };

  function line(text) {
    if (!started) {
      if (text.endsWith(begin)) {
        started = true;
      } else {
        other.push(text);
      }
      return;
    }
    if (status !== null) {
      other.push(text);
      return;
    }
    const done = statusLine.exec(text);
    if (done) {
      status = Number(done[1]);
      heldNewline = false;
      return;
    }
    // Stderr goes through sed, so it can land after stdout that hasn't ended its line. The tag then
    // sits mid-line, and what comes before it is stdout. A held newline is the command's: the
    // script's own comes only after all of stderr.
    const at = text.indexOf(errTag);
    if (at >= 0) {
      release();
      if (at > 0) {
        stdout(text.slice(0, at));
      }
      stderr(`${text.slice(at + errTag.length)}\n`);
      return;
    }
    release();
    if (text) {
      stdout(text);
    }
    heldNewline = true;
  }

  return {
    push(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
    },
    end() {
      if (buffer) {
        line(buffer.replace(/\r$/, ''));
        buffer = '';
      }
      if (status === null) {
        release();
      }
      return { started, status, other };
    },
  };
}
