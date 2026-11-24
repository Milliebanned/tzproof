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

test('Kane is asked to assert the expected day in plain words', async () => {
  const { withKaneAssertions } = await import('../src/runner.js');
  const text = withKaneAssertions('Go to the page.', {
    clock: { tz: 'Asia/Tokyo', at: '2026-06-15T23:30:00Z' },
    flow: { expect: { today: 'today', trial_end: 'today+14d' } },
  }, {});
  assert.match(text, /'today' is Tuesday 16 June 2026|'today' is Tuesday, 16 June 2026/);
  assert.match(text, /'trial_end' is Tuesday,? 30 June 2026/);
  assert.match(text, /Store all of those values first/);
  assert.equal(withKaneAssertions('Go.', { clock: {}, flow: { expect: { a: 'today' } } }, { kaneAssert: false }), 'Go.');
});

test('values come from the Kane run context when its own check failed', async () => {
  const { valuesRead } = await import('../src/runner.js');
  const runEnd = { status: 'failed', final_state: {}, context: { variables: {
    today: { value: '2026-04-09', type: 'memory' },
    password: { value: 'x', type: 'global', secret: true },
  } } };
  assert.deepEqual(valuesRead(runEnd), { today: '2026-04-09' });
  assert.deepEqual(valuesRead({ final_state: { today: 'a' }, context: { variables: { today: { value: 'b', type: 'memory' } } } }), { today: 'a' });
});
