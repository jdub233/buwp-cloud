/**
 * Copying one file into a task's wordpress container, or out of one, over ECS Exec.
 *
 * In: the file travels as base64 in the `--command` argument, in pieces when it's too big for one
 * request (see capture.js for the limits). In the container it's written beside the destination
 * under a hidden temporary name, given the old file's owner and mode (a new file gets its
 * directory's owner and mode 644), checked against the local sha256, checked with `php -l` if it's
 * PHP, and only then renamed over the destination. A failed check leaves the old file untouched.
 * This is ecs-file-drop's recipe; exec runs as root, and the files WordPress serves belong to
 * www-data, so owner and mode can't be left to chance.
 *
 * Out: the container prints the file's sha256 and then its base64, and the local side checks one
 * against the other.
 */

import { createHash, randomBytes } from 'crypto';
import { shellQuote } from './session.js';

// base64 characters per request: with the script, a request stays under 100 KB, below both ECS's
// limit and Linux's 128 KB cap on one argument. About 72 KB of file.
export const CHUNK_CHARS = 96_000;
export const NEW_FILE_MODE = '644';

/**
 * Split a cp argument into a container location or a local path. `name:/path` is a container
 * location; a local path that has a colon in its first segment needs a ./ in front.
 * @param {string} spec
 * @returns {{target: string, path: string}|{local: string}}
 */
export function parseLocation(spec) {
  const match = String(spec).match(/^([^/:]+):(.*)$/);
  return match ? { target: match[1], path: match[2] } : { local: String(spec) };
}

/** An ID for one copy, used in the names of its temporary files. */
export function newCopyId() {
  return randomBytes(6).toString('hex');
}

/** Where the pieces of a large file collect in the container until the last one arrives. */
export function stagingPath(id) {
  return `/tmp/.buwp-cp-${id}`;
}

/** sha256 of a buffer, as hex. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Split base64 into request-sized pieces. Always at least one, empty for an empty file.
 * @param {string} b64
 * @param {number} [size]
 * @returns {string[]}
 */
export function chunks(b64, size = CHUNK_CHARS) {
  const out = [];
  for (let i = 0; i < b64.length; i += size) {
    out.push(b64.slice(i, i + size));
  }
  return out.length ? out : [''];
}

/** The command that adds a piece ($1) to the staging file. */
export function appendCommand(id) {
  return `printf '%s' "$1" >> ${shellQuote(stagingPath(id))}`;
}

/**
 * Shell lines defining buwp_cp, which adds the last piece ($1) to the staging file, then checks the
 * whole file and moves it into place. It prints one `buwp-cp ...` report line on success; every
 * failure says why on stderr, removes its temporary files and returns 1.
 * @param {{id: string, dest: string, name: string, sha256: string}} copy - name is the local
 *   file's, used when dest turns out to be a directory
 * @returns {string[]}
 */
export function dropFunction({ id, dest, name, sha256: expected }) {
  const q = shellQuote;
  return [
    'buwp_cp() {',
    `  staging=${q(stagingPath(id))}`,
    `  dest=${q(dest)}`,
    '  printf \'%s\' "$1" >> "$staging" || { echo "Couldn\'t write $staging." >&2; return 1; }',
    `  if [ -d "$dest" ]; then dest="\${dest%/}/"${q(name)}; fi`,
    '  dir=$(dirname -- "$dest")',
    `  tmp="$dir/.buwp-cp-${id}.tmp"`,
    '  if [ ! -d "$dir" ]; then rm -f "$staging"; echo "There\'s no directory $dir in the container." >&2; return 1; fi',
    '  if [ -L "$dest" ]; then rm -f "$staging"; echo "$dest is a symbolic link; cp won\'t replace it." >&2; return 1; fi',
    '  if ! base64 -d < "$staging" > "$tmp"; then rm -f "$staging" "$tmp"; echo "Couldn\'t write $tmp." >&2; return 1; fi',
    '  rm -f "$staging"',
    '  sha=$(sha256sum "$tmp" | cut -d " " -f 1)',
    `  if [ "$sha" != ${expected} ]; then rm -f "$tmp"; echo "The copy's sha256 is $sha, not ${expected}. $dest is unchanged." >&2; return 1; fi`,
    '  old=-',
    '  if [ -e "$dest" ]; then',
    '    old=$(sha256sum "$dest" | cut -d " " -f 1)',
    '    chown --reference="$dest" "$tmp" && chmod --reference="$dest" "$tmp"',
    '  else',
    `    chown --reference="$dir" "$tmp" && chmod ${NEW_FILE_MODE} "$tmp"`,
    '  fi || { rm -f "$tmp"; echo "Couldn\'t set the owner and mode of $tmp. $dest is unchanged." >&2; return 1; }',
    // php -l on stdin, so its messages name no temporary file.
    '  case "$dest" in *.php)',
    '    if ! lint=$(php -l < "$tmp" 2>&1); then rm -f "$tmp"; printf \'%s\\n\' "$lint" >&2; echo "The file failed php -l. $dest is unchanged." >&2; return 1; fi',
    '  esac',
    '  mv -f "$tmp" "$dest" || { rm -f "$tmp"; echo "Couldn\'t move the file into place. $dest is unchanged." >&2; return 1; }',
    '  echo "buwp-cp path=$dest old=$old new=$sha bytes=$(wc -c < "$dest" | tr -d " ") owner=$(stat -c %U:%G "$dest") mode=$(stat -c %a "$dest")"',
    '}',
  ];
}

/**
 * Shell lines defining buwp_get, which prints a file's sha256 on one line and then its base64.
 * @param {string} source - Path in the container
 * @returns {string[]}
 */
export function readFunction(source) {
  return [
    'buwp_get() {',
    `  src=${shellQuote(source)}`,
    '  if [ ! -f "$src" ]; then echo "There\'s no file $src in the container." >&2; return 1; fi',
    '  sha256sum "$src" | cut -d " " -f 1 && base64 < "$src"',
    '}',
  ];
}

/**
 * Read buwp_cp's report line.
 * @param {string} output - buwp_cp's stdout
 * @returns {{path: string, old: string|null, sha256: string, bytes: number, owner: string, mode: string}|null}
 */
export function parseDropReport(output) {
  const line = output.split('\n').find((l) => l.startsWith('buwp-cp '));
  if (!line) {
    return null;
  }
  const m = line.match(/^buwp-cp path=(.*) old=(\S+) new=(\S+) bytes=(\d+) owner=(\S+) mode=(\S+)$/);
  return m
    ? { path: m[1], old: m[2] === '-' ? null : m[2], sha256: m[3], bytes: Number(m[4]), owner: m[5], mode: m[6] }
    : null;
}

/**
 * Turn buwp_get's output back into the file, checking it against the sha256 the container sent.
 * @param {string} output - buwp_get's stdout
 * @returns {{data: Buffer, sha256: string}}
 */
export function parseReadOutput(output) {
  const [first, ...rest] = output.split('\n');
  const expected = first.trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error('The container didn\'t send a sha256 before the file.');
  }
  const data = Buffer.from(rest.join(''), 'base64');
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`The copy's sha256 is ${actual}, not ${expected}: the file was damaged on the way.`);
  }
  return { data, sha256: actual };
}
