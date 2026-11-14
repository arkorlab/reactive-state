import { describe, expect, it } from 'vitest';

import { ExternalTail, pollIntervalOf } from '../src/authority/external-tail.ts';
import type { ExternalStore } from '../src/authority/external.ts';
import { database, definitionOf, table, text } from '../src/server/schema.ts';

/**
 * How often an external store's log is read, as the host gives it: a wait a timer takes, or the
 * tail is refused as it is made. Node runs a timer asked to wait longer than 2 ** 31 - 1 ms after
 * 1 ms instead, and each turn of a tail that waited so would find its read not due, and wait again.
 */

const db = database({ items: table({ title: text() }, { external: 'remote' }) });
const tables = definitionOf(db).tables;

/** A store no test reads: a tail is only made. */
const STORE: ExternalStore = {
  changes: () => Promise.reject(new Error('No log is read.')),
  count: () => Promise.reject(new Error('No record is counted.')),
  find: () => Promise.reject(new Error('No record is found.')),
  get: () => Promise.reject(new Error('No record is read.')),
};

/** A tail of `everyMs`, on Node: no host schedules its turns. */
function tailOf(everyMs: number | undefined): ExternalTail {
  return new ExternalTail({
    everyMs,
    ingest: () => Promise.resolve(),
    stores: new Map([['items', STORE]]),
    tables,
  });
}

describe('how often an external store’s log is read', () => {
  it.each([2 ** 31, 30 * 24 * 60 * 60 * 1000, Number.MAX_SAFE_INTEGER])(
    'refuses %s ms, longer than a timer waits, as the tail is made',
    (everyMs) => {
      expect(() => pollIntervalOf(everyMs)).toThrow(TypeError);
      expect(() => tailOf(everyMs)).toThrow('externalPollMs');
    },
  );

  it.each([undefined, 1, 2 ** 31 - 1])('takes %s', (everyMs) => {
    expect(() => tailOf(everyMs)).not.toThrow();
  });
});
