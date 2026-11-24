import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addToDate, localDate, parseShownDate, resolveDateExpr } from '../src/dates.js';
import { judge } from '../src/runner.js';

test('local date follows the time zone, not UTC', () => {
  const at = Date.parse('2026-06-15T23:30:00Z');
  assert.deepEqual(localDate(at, 'Asia/Tokyo'), { y: 2026, m: 6, d: 16 });
  assert.deepEqual(localDate(at, 'America/New_York'), { y: 2026, m: 6, d: 15 });
  assert.deepEqual(localDate(Date.parse('2026-04-09T23:30:00Z'), 'Europe/London'), { y: 2026, m: 4, d: 10 });
});

test('month arithmetic clamps to the end of the month', () => {
  assert.deepEqual(addToDate({ y: 2027, m: 1, d: 31 }, 1, 'mo'), { y: 2027, m: 2, d: 28 });
  assert.deepEqual(addToDate({ y: 2028, m: 1, d: 31 }, 1, 'mo'), { y: 2028, m: 2, d: 29 });
  assert.deepEqual(addToDate({ y: 2026, m: 12, d: 25 }, 14, 'd'), { y: 2027, m: 1, d: 8 });
});

test('date expressions', () => {
  const at = Date.parse('2027-01-31T17:00:00Z');
  assert.deepEqual(resolveDateExpr('today+1mo', at, 'America/New_York'), { y: 2027, m: 2, d: 28 });
  assert.deepEqual(resolveDateExpr('today-1d', at, 'America/New_York'), { y: 2027, m: 1, d: 30 });
  assert.throws(() => resolveDateExpr('tomorrow', at, 'UTC'));
});

test('parses the date formats pages actually show', () => {
  assert.deepEqual(parseShownDate('2026-06-15'), { y: 2026, m: 6, d: 15 });
  assert.deepEqual(parseShownDate('June 29, 2026'), { y: 2026, m: 6, d: 29 });
  assert.deepEqual(parseShownDate('Friday, April 10, 2026'), { y: 2026, m: 4, d: 10 });
  assert.deepEqual(parseShownDate('10 April 2026'), { y: 2026, m: 4, d: 10 });
  assert.deepEqual(parseShownDate('4/9/2026'), { y: 2026, m: 4, d: 9 });
  assert.deepEqual(parseShownDate('4/9/2026', 'dmy'), { y: 2026, m: 9, d: 4 });
  assert.deepEqual(parseShownDate('25/12/2026'), { y: 2026, m: 12, d: 25 });
  assert.equal(parseShownDate('not a date'), null);
  assert.equal(parseShownDate('2026-02-30'), null);
});

const cell = {
  clock: { tz: 'Asia/Tokyo', at: '2026-06-15T23:30:00Z' },
  flow: { expect: { today: 'today' } },
};

test('Kane saying "passed" does not make a wrong date pass', () => {
  const { verdict, checks } = judge(cell, { exitCode: 0, runEnd: { status: 'passed' }, finalState: { today: '2026-06-15' } }, 'mdy');
  assert.equal(verdict, 'fail');
  assert.match(checks[0].reason, /expected 2026-06-16 \(-1 day\)/);
});

test('a missing value or a Kane error is unknown, never pass', () => {
  assert.equal(judge(cell, { exitCode: 0, runEnd: { status: 'passed' }, finalState: {} }, 'mdy').verdict, 'unknown');
  assert.equal(judge(cell, { exitCode: 2, runEnd: null, finalState: { today: '2026-06-16' } }, 'mdy').verdict, 'unknown');
});

test('correct dates pass', () => {
  assert.equal(judge(cell, { exitCode: 0, runEnd: { status: 'passed' }, finalState: { today: 'June 16, 2026' } }, 'mdy').verdict, 'pass');
});
