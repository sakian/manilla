import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fillBlankLine, linesToSave } from './formLines.ts';

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
