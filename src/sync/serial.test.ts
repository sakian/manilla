import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentActor, runAs } from '../audit/actor.ts';
import { oneAtATime } from './serial.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A promise and the means to settle it, made before any work waits on it. */
function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => (open = resolve));
  return { closed, open };
}

test('work under one key runs one at a time, in the order it came', async () => {
  const seen: string[] = [];
  const job = (name: string) => async () => {
    seen.push(`${name} starts`);
    await tick();
    seen.push(`${name} ends`);
    return name;
  };
  const results = await Promise.all([oneAtATime('k', job('a')), oneAtATime('k', job('b'))]);
  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(seen, ['a starts', 'a ends', 'b starts', 'b ends']);
});

test('different keys do not wait for each other', async () => {
  const seen: string[] = [];
  const slow = gate();
  const held = oneAtATime('slow', () => slow.closed);
  await oneAtATime('fast', async () => {
    seen.push('fast');
  });
  assert.deepEqual(seen, ['fast']);
  slow.open();
  await held;
});

test('a failure is its caller’s, and what queued behind it still runs', async () => {
  const first = oneAtATime('f', async () => {
    throw new Error('bank down');
  });
  const second = oneAtATime('f', async () => 'ran');
  await assert.rejects(first, /bank down/);
  assert.equal(await second, 'ran');
});

test('queued work still knows who it is acting for, for the audit trail', async () => {
  const first = gate();
  const blocker = oneAtATime('who', () => first.closed);
  const queued = runAs({ id: null, name: 'Plaid webhook' }, () =>
    oneAtATime('who', async () => currentActor()?.name),
  );
  first.open();
  await blocker;
  assert.equal(await queued, 'Plaid webhook');
});
