/**
 * Tests for the plain-text output helpers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatTable, formatDuration, formatJobRunner } from '../lib/index.js';

describe('formatTable', () => {
  test('pads columns to the widest cell and trims trailing space', () => {
    const text = formatTable(['A', 'BB'], [['long cell', 'x'], ['s', '']]);
    assert.equal(text, 'A          BB\nlong cell  x\ns');
  });

  test('paints padded cells by row and column', () => {
    const text = formatTable(['A', 'B'], [['1', '2'], ['3', '4']], {
      paint: (cell, r, c) => (r === 1 && c === 0 ? `[${cell}]` : cell),
    });
    assert.equal(text, 'A  B\n1  2\n[3]  4');
  });
});

describe('formatDuration', () => {
  test('picks the two largest units', () => {
    assert.equal(formatDuration(30_000), '<1m');
    assert.equal(formatDuration(7 * 60_000), '7m');
    assert.equal(formatDuration((5 * 60 + 12) * 60_000), '5h 12m');
    assert.equal(formatDuration(((3 * 24 + 4) * 60 + 59) * 60_000), '3d 4h');
  });
});

describe('formatJobRunner', () => {
  test('shows the schedule, marks it disabled, or a dash without one', () => {
    assert.equal(formatJobRunner({ schedule: 'rate(3 minutes)', enabled: true }), 'rate(3 minutes)');
    assert.equal(formatJobRunner({ schedule: 'rate(1 hour)', enabled: false }), 'rate(1 hour) (disabled)');
    assert.equal(formatJobRunner(null), '-');
  });
});
