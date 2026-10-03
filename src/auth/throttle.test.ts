import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Throttle, describeWait, recoveryThrottle } from './throttle.ts';

const options = { free: 5, baseMs: 1_000, maxMs: 15 * 60_000, forgetAfterMs: 60 * 60_000 };

test('the first few failures cost nothing, so a typo is not punished', () => {
  const throttle = new Throttle(options);
  for (let i = 1; i <= 5; i++) {
    assert.deepEqual(throttle.failed('k', 0), { failures: i, waitMs: 0 });
    assert.equal(throttle.waitFor('k', 0), 0);
  }
});

test('after that each failure doubles the wait, up to the cap', () => {
  const throttle = new Throttle(options);
  assert.deepEqual(
    [5, 6, 7, 8, 15, 16, 40].map((n) => throttle.delayAfter(n)),
    [0, 1_000, 2_000, 4_000, 512_000, 900_000, 900_000],
  );
});

test('the wait runs from the last failure, and ends', () => {
  const throttle = new Throttle(options);
  for (let i = 0; i < 7; i++) throttle.failed('k', 10_000);
  assert.equal(throttle.waitFor('k', 10_000), 2_000);
  assert.equal(throttle.waitFor('k', 11_500), 500);
  assert.equal(throttle.waitFor('k', 12_000), 0);
});

test('an hour without a failure forgets them all', () => {
  const throttle = new Throttle(options);
  for (let i = 0; i < 10; i++) throttle.failed('k', 0);
  assert.equal(throttle.failed('k', 60 * 60_000).failures, 1, 'counting starts again');
});

test('a success clears the count', () => {
  const throttle = new Throttle(options);
  for (let i = 0; i < 9; i++) throttle.failed('k', 0);
  throttle.succeeded('k');
  assert.equal(throttle.waitFor('k', 0), 0);
  assert.equal(throttle.failed('k', 0).failures, 1);
});

test('keys are counted apart', () => {
  const throttle = new Throttle(options);
  for (let i = 0; i < 9; i++) throttle.failed('a', 0);
  assert.equal(throttle.waitFor('b', 0), 0);
});

test('the recovery throttle is the one the issue describes', () => {
  assert.equal(recoveryThrottle.delayAfter(5), 0);
  assert.equal(recoveryThrottle.delayAfter(6), 1_000);
  assert.equal(recoveryThrottle.delayAfter(100), 15 * 60_000);
});

test('a wait reads as a person would say it, rounded up', () => {
  assert.equal(describeWait(1), '1 second');
  assert.equal(describeWait(1_500), '2 seconds');
  assert.equal(describeWait(59_000), '59 seconds');
  assert.equal(describeWait(60_000), '1 minute');
  assert.equal(describeWait(60_001), '2 minutes');
  assert.equal(describeWait(900_000), '15 minutes');
});
