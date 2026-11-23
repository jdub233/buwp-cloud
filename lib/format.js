/**
 * Plain-text output helpers.
 */

/**
 * Render rows as an aligned text table.
 * @param {string[]} headers
 * @param {string[][]} rows - Cells as plain strings
 * @param {{paint?: (cell: string, row: number, column: number) => string, widths?: number[]}}
 *   options - paint styles a padded cell, after padding so escape codes don't throw off alignment;
 *   row is the index into `rows`. widths sets minimum column widths, so several tables can line
 *   up with each other.
 * @returns {string}
 */
export function formatTable(headers, rows, { paint = (cell) => cell, widths: minimums = [] } = {}) {
  const widths = headers.map((header, i) =>
    Math.max(header.length, minimums[i] ?? 0, ...rows.map((row) => row[i].length))
  );
  const line = (cells, styler) => cells
    .map((cell, i) => styler(cell.padEnd(widths[i]), i))
    .join('  ')
    .trimEnd();

  return [
    line(headers, (cell) => cell),
    ...rows.map((row, r) => line(row, (cell, c) => paint(cell, r, c))),
  ].join('\n');
}

/**
 * A target's job runner: "rate(3 minutes)", with "(disabled)" when the schedule is off, or "-".
 * @param {{schedule: string|null, enabled: boolean}|null} jobRunner
 * @returns {string}
 */
export function formatJobRunner(jobRunner) {
  if (!jobRunner) {
    return '-';
  }
  return `${jobRunner.schedule ?? '?'}${jobRunner.enabled ? '' : ' (disabled)'}`;
}

/**
 * The first 12 hex digits of an image digest, enough to tell builds apart at a glance.
 * @param {string|null} digest - "sha256:<64 hex>"
 * @returns {string}
 */
export function shortDigest(digest) {
  if (!digest) {
    return '-';
  }
  const hex = String(digest).split(':').pop();
  return hex.slice(0, 12);
}

/**
 * A short duration: "3d 4h", "5h 12m", "7m", "<1m".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return '<1m';
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) {
    return `${days}d ${hours}h`;
  }
  return hours ? `${hours}h ${mins}m` : `${mins}m`;
}
