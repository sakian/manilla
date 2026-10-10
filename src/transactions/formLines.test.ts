import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fillBlankLine, leftToAssign, linesToSave, restFor, splitLines } from './formLines.ts';

describe('the envelope lines a transaction form means (#37)', () => {
  test('an envelope chosen with no amount typed takes the whole amount', () => {
    assert.deepEqual(linesToSave([{ envelopeId: 'gas', amount: '' }], 4537), [
      { envelopeId: 'gas', amount: '45.37' },
    ]);
  });

  test('no envelope chosen is still left for the review queue', () => {
    assert.deepEqual(linesToSave([{ envelopeId: '', amount: '' }], 4537), []);
  });

  test('an amount typed is kept as typed', () => {
    assert.deepEqual(linesToSave([{ envelopeId: 'gas', amount: '40' }], 4537), [
      { envelopeId: 'gas', amount: '40' },
    ]);
  });

  test('in a split, the one blank line takes what the others leave', () => {
    assert.deepEqual(
      linesToSave(
        [
          { envelopeId: 'groceries', amount: '' },
          { envelopeId: 'household', amount: '20.00' },
        ],
        10000,
      ),
      [
        { envelopeId: 'groceries', amount: '80.00' },
        { envelopeId: 'household', amount: '20.00' },
      ],
    );
  });

  test('two blank lines are not guessed between', () => {
    assert.deepEqual(
      linesToSave(
        [
          { envelopeId: 'groceries', amount: '' },
          { envelopeId: 'household', amount: '' },
        ],
        10000,
      ),
      [],
    );
  });

  test('nothing is filled when the others already take it all', () => {
    const drafts = [
      { envelopeId: 'groceries', amount: '' },
      { envelopeId: 'household', amount: '100.00' },
    ];
    assert.deepEqual(fillBlankLine(drafts, 10000), drafts);
  });

  test('lines stay in place, so the form can show each one its amount', () => {
    assert.deepEqual(
      fillBlankLine(
        [
          { envelopeId: '', amount: '' },
          { envelopeId: 'gas', amount: '' },
        ],
        1250,
      ),
      [
        { envelopeId: '', amount: '' },
        { envelopeId: 'gas', amount: '12.50' },
      ],
    );
  });
});

describe('setting one part to the rest', () => {
  test('a part takes the total less every other part', () => {
    const lines = [
      { envelopeId: 'groceries', amount: '100.00' },
      { envelopeId: 'household', amount: '20.00' },
      { envelopeId: 'pharmacy', amount: '15.50' },
    ];
    assert.equal(restFor(lines, 0, 10000), '64.50', 'the auto-selected line, still holding the whole amount');
    assert.equal(restFor(lines, 2, 10000), null, 'the others already use more than the total');
  });

  test('blank and half-typed parts count as nothing, and a part without an envelope still counts', () => {
    assert.equal(
      restFor(
        [
          { envelopeId: 'groceries', amount: '' },
          { envelopeId: '', amount: '20' },
          { envelopeId: 'pharmacy', amount: 'abc' },
        ],
        0,
        5000,
      ),
      '30.00',
    );
  });

  test('nothing is left when the others use it all', () => {
    assert.equal(restFor([{ envelopeId: 'a', amount: '' }, { envelopeId: 'b', amount: '50.00' }], 0, 5000), null);
  });
});

describe('a split staged in the review queue', () => {
  test('spending stays spending: the parts take the sign of the transaction', () => {
    assert.deepEqual(
      splitLines(
        [
          { envelopeId: 'groceries', amount: '' },
          { envelopeId: 'household', amount: '20' },
        ],
        -5000,
      ),
      [
        { envelopeId: 'groceries', amountCents: -3000 },
        { envelopeId: 'household', amountCents: -2000 },
      ],
    );
  });

  test('income splits as income', () => {
    assert.deepEqual(
      splitLines(
        [
          { envelopeId: 'a', amount: '10' },
          { envelopeId: 'b', amount: '15.50' },
        ],
        2550,
      ),
      [
        { envelopeId: 'a', amountCents: 1000 },
        { envelopeId: 'b', amountCents: 1550 },
      ],
    );
  });

  test('anything unfinished is not a split yet', () => {
    const cases: [string, Parameters<typeof splitLines>[0]][] = [
      ['a part with no envelope', [{ envelopeId: 'a', amount: '' }, { envelopeId: '', amount: '20' }]],
      ['parts short of the whole', [{ envelopeId: 'a', amount: '10' }, { envelopeId: 'b', amount: '20' }]],
      ['parts over the whole', [{ envelopeId: 'a', amount: '40' }, { envelopeId: 'b', amount: '20' }]],
      ['one part only', [{ envelopeId: 'a', amount: '' }]],
      ['two blank parts', [{ envelopeId: 'a', amount: '' }, { envelopeId: 'b', amount: '' }]],
      ['an ambiguous amount', [{ envelopeId: 'a', amount: '1.234' }, { envelopeId: 'b', amount: '' }]],
      ['a zero part', [{ envelopeId: 'a', amount: '50' }, { envelopeId: 'b', amount: '0' }]],
    ];
    for (const [what, drafts] of cases) assert.equal(splitLines(drafts, -5000), null, what);
  });

  test('what is left counts the blank part as taking the rest', () => {
    assert.equal(leftToAssign([{ envelopeId: 'a', amount: '' }, { envelopeId: 'b', amount: '20' }], 5000), 0);
    assert.equal(leftToAssign([{ envelopeId: 'a', amount: '10' }, { envelopeId: 'b', amount: '20' }], 5000), 2000);
    assert.equal(leftToAssign([{ envelopeId: '', amount: '10' }], 5000), 5000, 'no envelope, not assigned');
  });
});
