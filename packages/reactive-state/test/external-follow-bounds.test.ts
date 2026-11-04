import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ExternalChange, ExternalChanges, ExternalStore } from '../src/authority/external.ts';
import { Engine } from '../src/authority/node-engine.ts';
import { database, table, text } from '../src/server/schema.ts';

/**
 * What following an external store's log keeps, and how long a read of the log may take: the
 * authority keeps nothing of an external record a change names — no version, which only a public
 * record's rendering is held to — and a read of the log that does not answer within the
 * authority's call timeout is a failed read, retried from where it was.
 */

const db = database({ items: table({ title: text() }, { external: 'remote' }) });
const BUILD = 'b_external_bounds';

/** A store of no records, whose log the test writes and whose next reads it may hold. */
function remote() {
  const changes: ExternalChange[] = [];
  const page: ExternalStore['changes'] = (since, limit) => {
    const answered: ExternalChanges = {
      changes: changes.filter((change) => change.seq > since).slice(0, limit),
      epoch: 'log',
      floor: changes.length === 0 ? 0 : 1,
      head: changes.at(-1)?.seq ?? 0,
    };
    return Promise.resolve(answered);
  };
  const read = vi.fn<ExternalStore['changes']>(page);
  const store: ExternalStore = {
    changes: read,
    count: () => Promise.resolve(0),
    find: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
  };
  return { changes, page, read, store };
}

/** A read of the log no answer ends. */
async function unanswered(): Promise<never> {
  return new Promise<never>(() => {
    // Never answered.
  });
}

/** How long a poke is waited for: far past the call timeout below, far short of the test's. */
const WAIT_MS = 1000;

/** Whether `pending` settles within `WAIT_MS`, and how. */
async function settledWithin(pending: Promise<unknown>): Promise<string> {
  const settled = (async () => {
    try {
      await pending;
      return 'answered';
    } catch {
      return 'refused';
    }
  })();
  const timer = new Promise<string>((resolve) => {
    setTimeout(() => {
      resolve('pending');
    }, WAIT_MS);
  });
  return Promise.race([settled, timer]);
}

describe('following an external store', () => {
  it('keeps no version of an external record a change names', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-external-'));
    onTestFinished(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    const filename = path.join(dir, 'authority.sqlite');
    const source = remote();
    const engine = new Engine({
      buildId: BUILD,
      database: db,
      filename,
      programs: [],
      stores: { remote: source.store },
    });
    // The first read finds where the log is, and takes every record for changed: a commit.
    await engine.poke();
    const started = engine.revision();
    for (let seq = 1; seq <= 1000; seq += 1) {
      source.changes.push({
        after: null,
        before: { title: `item ${String(seq)}` },
        id: `item-${String(seq)}`,
        seq,
        table: 'items',
      });
    }

    await engine.poke();
    const revision = engine.revision();
    await engine.close();
    const kept = new DatabaseSync(filename, { readOnly: true });
    onTestFinished(() => {
      kept.close();
    });

    // The deletes were announced, and nothing of the records they named was kept.
    expect(revision).toBeGreaterThan(started);
    expect(kept.prepare('SELECT COUNT(*) AS kept FROM versions').get()?.['kept']).toBe(0);
  });

  it('takes a read of the log that never answers for a failed one, and reads again', async () => {
    const source = remote();
    const engine = new Engine({
      buildId: BUILD,
      database: db,
      programs: [],
      stores: { remote: source.store },
      timeoutMs: 50,
    });
    onTestFinished(async () => {
      await engine.close();
    });
    await engine.poke();
    source.read.mockImplementationOnce(unanswered);

    const held = await settledWithin(engine.poke());
    source.changes.push({
      after: null,
      before: { title: 'gone' },
      id: 'gone',
      seq: 1,
      table: 'items',
    });
    const before = engine.revision();
    const next = await settledWithin(engine.poke());

    expect(held).toBe('refused');
    expect(next).toBe('answered');
    expect(engine.revision()).toBeGreaterThan(before);
    // From where it was: a cursor let go of would read the log as a first read does, from its head.
    expect(source.read.mock.calls.slice(1).map(([since]) => since)).toStrictEqual([0, 0]);
  });

  it('takes nothing of a read whose later page never answers, and reads again from where it was', async () => {
    const source = remote();
    const engine = new Engine({
      buildId: BUILD,
      database: db,
      programs: [],
      stores: { remote: source.store },
      timeoutMs: 50,
    });
    onTestFinished(async () => {
      await engine.close();
    });
    await engine.poke();
    // One more change than a page of the log holds (200): its second page is the one that hangs.
    for (let seq = 1; seq <= 201; seq += 1) {
      source.changes.push({
        after: null,
        before: { title: 'gone' },
        id: `gone-${String(seq)}`,
        seq,
        table: 'items',
      });
    }
    source.read.mockImplementationOnce(source.page).mockImplementationOnce(unanswered);
    const before = engine.revision();

    const held = await settledWithin(engine.poke());
    const afterFailure = engine.revision();
    const next = await settledWithin(engine.poke());

    expect(held).toBe('refused');
    // The page that answered was not taken: a cursor past it would lose its 200 changes.
    expect(afterFailure).toBe(before);
    expect(next).toBe('answered');
    expect(engine.revision()).toBeGreaterThan(before);
    expect(source.read.mock.calls.slice(1).map(([since]) => since)).toStrictEqual([0, 200, 0, 200]);
  });
});
