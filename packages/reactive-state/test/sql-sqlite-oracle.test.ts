import { describe, expect, it, vi } from 'vitest';

import { ExternalFollower } from '../src/authority/external.ts';
import { database, definitionOf } from '../src/server/schema.ts';
import type { StatementRead } from '../src/sql/sqlite/scopes.ts';
import { rendered } from './cloudflare/d1-drizzle-render.ts';
import { leftTableTerm, type Picks, type Shape, SHAPES } from './support/sqlite-oracle-shapes.ts';
import {
  GITHUB,
  mutate,
  type OracleDatabase,
  oracleDatabase,
  ORGANIZATIONS,
  populate,
  Random,
  SLUGS,
  USERS,
} from './support/sqlite-oracle.ts';

/**
 * The oracle of what a render follows of more than one table: of random rows and random writes of a
 * real SQLite, under the log's real triggers, a statement's answer may change only where the rows the
 * log names render it again, by the engine's own matching. A write that changes the answer of a
 * render it renders not again is the one thing a follow may never do.
 *
 * Its control reads a `LEFT JOIN`'s `ON` as an inner join's, the reader's likeliest mistake, of which
 * the oracle must find what it misses: an oracle that finds nothing of it proves nothing.
 */

const { reader } = vi.hoisted(() => ({ reader: { loose: false } }));

/** `read`, of each term of a `LEFT JOIN`'s `ON` taken as an inner join's. */
function loosened(read: StatementRead | undefined): StatementRead | undefined {
  if (read === undefined) return undefined;
  for (const scope of read.scopes) {
    const facts = scope.facts.map((fact) => ({ ...fact, on: undefined }));
    scope.facts.splice(0, facts.length, ...facts);
  }
  return read;
}

vi.mock(import('../src/sql/sqlite/scopes.ts'), async (original) => {
  const actual = await original();
  return {
    ...actual,
    statementRead: (sql: string) => {
      const read = actual.statementRead(sql);
      return reader.loose ? loosened(read) : read;
    },
  };
});

const RUN = { control: 200, steps: 5, timeoutMs: 60_000, trials: 20 } as const;

/** Values of the ids the rows are written of. */
function picked(random: Random): Picks {
  return {
    github: random.of(GITHUB),
    organization: random.of(ORGANIZATIONS),
    other: random.of(USERS),
    slug: random.of(SLUGS),
    user: random.of(USERS),
  };
}

/** One trial: what it found, of a write that changed the answer and rendered nothing again. */
async function trial(
  of: OracleDatabase,
  shape: Shape,
  random: Random,
): Promise<string | undefined> {
  const { binding, db, follow, followed, plain } = of;
  populate(db, random);
  const picks = picked(random);
  const read = await rendered(() => shape(followed, picks));
  const answer = JSON.stringify(await shape(plain, picks));
  const tables = definitionOf(database(follow.tables)).tables;
  const follower = new ExternalFollower(follow.store(binding), tables);
  await follower.changed();
  const writes: string[] = [];
  for (let step = 0; step < RUN.steps; step += 1) {
    const write = mutate(db, random);
    if (write === undefined) continue;
    writes.push(write);
    if (read.changedBy(await follower.changed())) return undefined;
    const now = JSON.stringify(await shape(plain, picks));
    if (now !== answer) {
      return `${JSON.stringify(picks)}: ${writes.join('; ')}: ${answer} became ${now}`;
    }
  }
  return undefined;
}

/** What `trials` of `shape` missed, of a database of its own. */
async function missedOf(shape: Shape, seed: number, foreignKeys: boolean, trials: number) {
  const of = oracleDatabase(foreignKeys);
  const random = new Random(seed);
  const missed: string[] = [];
  for (let at = 0; at < trials; at += 1) {
    of.db.exec('SAVEPOINT trial');
    const found = await trial(of, shape, random);
    of.db.exec('ROLLBACK TO trial');
    of.db.exec('RELEASE trial');
    if (found !== undefined) missed.push(found);
  }
  return missed;
}

const named = Object.entries(SHAPES).map(([name, shape], at) => ({ at, name, shape }));

describe('what a render follows of a statement of more than one table', () => {
  it.each(named)(
    'misses no write that changes $name',
    async ({ at, shape }) => {
      await expect(missedOf(shape, at, true, RUN.trials)).resolves.toStrictEqual([]);
      await expect(missedOf(shape, at, false, RUN.trials)).resolves.toStrictEqual([]);
    },
    RUN.timeoutMs,
  );

  it('finds what a reader of a looser `ON` misses', { timeout: RUN.timeoutMs }, async () => {
    reader.loose = true;
    try {
      const missed = await missedOf(leftTableTerm, 0, true, RUN.control);

      expect(missed).not.toHaveLength(0);
    } finally {
      reader.loose = false;
    }
  });
});
