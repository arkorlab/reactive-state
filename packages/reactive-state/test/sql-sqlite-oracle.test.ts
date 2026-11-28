import { describe, expect, it, vi } from 'vitest';

import { ExternalFollower } from '../src/authority/external.ts';
import { database, definitionOf } from '../src/server/schema.ts';
import type { StatementRead } from '../src/sql/sqlite/scopes.ts';
import { rendered } from './cloudflare/d1-drizzle-render.ts';
import {
  aliasTerm,
  leftTableTerm,
  type Picks,
  roster,
  type Shape,
  SHAPES,
} from './support/sqlite-oracle-shapes.ts';
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
 * A render runs as a page's, and as an event stream's, whose candidates name the rows of a table no
 * parameter reaches, and which other writes may land between: before a candidate is asked, and after
 * it is answered.
 *
 * Its controls read a `LEFT JOIN`'s `ON` as an inner join's, the reader's likeliest mistake, and drop
 * a row of a candidate's answer: an oracle that finds nothing of them proves nothing.
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

const RUN = { control: 200, raced: 3, steps: 5, timeoutMs: 60_000, trials: 20 } as const;

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

/** Sets writes to land around a stream's candidates, as each order of a render may: `writes` tells. */
function race(of: OracleDatabase, random: Random, writes: string[]): void {
  const { db, hooks } = of;
  const writing = () => {
    for (let left = random.int(RUN.raced); left >= 0; left -= 1) {
      const write = mutate(db, random);
      if (write !== undefined) writes.push(write);
    }
  };
  const order = random.of(['none', 'none', 'statement first', 'candidates first']);
  if (order === 'statement first') {
    hooks.asking = writing;
  } else if (order === 'candidates first') {
    hooks.late = true;
    hooks.answered = writing;
  }
}

/** Ends what `race` set, of what a control keeps. */
function raced({ hooks }: OracleDatabase): void {
  hooks.asking = undefined;
  hooks.answered = undefined;
  hooks.late = false;
}

/** How trials run: of a database of foreign keys or none, each as a stream's render or a page's. */
interface Trials {
  readonly foreignKeys: boolean;
  readonly trials: number;
  readonly streamed: boolean;
}

/** Two members of an organization, each of a person of their own, and the follower of the log. */
async function twoMembers(of: OracleDatabase) {
  const { binding, db, follow } = of;
  db.exec(`
    INSERT INTO organization (id, name, slug) VALUES ('o0', 'one', 's0');
    INSERT INTO "user" (id, name) VALUES ('u0', 'ann'), ('u1', 'bob');
    INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
      ('m0', 'o0', 'u0', 'owner', 1), ('m1', 'o0', 'u1', 'member', 2);
  `);
  const tables = definitionOf(database(follow.tables)).tables;
  const follower = new ExternalFollower(follow.store(binding), tables);
  await follower.changed();
  return follower;
}

/** What a stream's render of the organization's roster read, of a kept plan. */
async function rosterRead({ followed }: OracleDatabase) {
  const picks = { github: '', organization: 'o0', other: '', slug: '', user: '' };
  await rendered(() => roster(followed, picks));
  return rendered(() => roster(followed, picks), { streamed: true });
}

/** One trial: what it found, of a write that changed the answer and rendered nothing again. */
async function trial(
  of: OracleDatabase,
  shape: Shape,
  random: Random,
  streamed: boolean,
): Promise<string | undefined> {
  const { binding, db, follow, followed, plain } = of;
  populate(db, random);
  const picks = picked(random);
  const tables = definitionOf(database(follow.tables)).tables;
  const follower = new ExternalFollower(follow.store(binding), tables);
  await follower.changed();
  const writes: string[] = [];
  if (streamed) race(of, random, writes);
  let answer = '';
  const read = await rendered(
    async () => {
      answer = JSON.stringify(await shape(followed, picks));
    },
    { streamed },
  );
  raced(of);
  for (let step = 0; step <= RUN.steps; step += 1) {
    // The first step is of what landed around the render.
    const write = step === 0 ? '' : mutate(db, random, answer);
    if (write === undefined) continue;
    if (step > 0) writes.push(write);
    if (read.changedBy(await follower.changed())) return undefined;
    const now = JSON.stringify(await shape(plain, picks));
    if (now !== answer) {
      return `${JSON.stringify(picks)}: ${writes.join('; ')}: ${answer} became ${now}`;
    }
  }
  return undefined;
}

/** What the trials of `shape` missed, of a database of its own. */
async function missedOf(shape: Shape, seed: number, kind: Trials) {
  const { foreignKeys, streamed, trials } = kind;
  const of = oracleDatabase(foreignKeys);
  const random = new Random(seed);
  const missed: string[] = [];
  for (let at = 0; at < trials; at += 1) {
    of.db.exec('SAVEPOINT trial');
    const found = await trial(of, shape, random, streamed);
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
      const kind = { streamed: false, trials: RUN.trials };

      await expect(missedOf(shape, at, { ...kind, foreignKeys: true })).resolves.toStrictEqual([]);
      await expect(missedOf(shape, at, { ...kind, foreignKeys: false })).resolves.toStrictEqual([]);
    },
    RUN.timeoutMs,
  );

  it.each(named)(
    "misses no write that changes $name, in a stream's render",
    async ({ at, shape }) => {
      const kind = { streamed: true, trials: RUN.trials };

      await expect(missedOf(shape, at, { ...kind, foreignKeys: true })).resolves.toStrictEqual([]);
      await expect(missedOf(shape, at, { ...kind, foreignKeys: false })).resolves.toStrictEqual([]);
    },
    RUN.timeoutMs,
  );

  it("renders again for a row of a candidate's answer", async () => {
    const of = oracleDatabase(true);
    const follower = await twoMembers(of);
    const read = await rosterRead(of);

    of.db.exec(`UPDATE "user" SET name = 'cid' WHERE id = 'u0'`);

    expect(read.changedBy(await follower.changed())).toBe(true);
  });

  it("misses a write of a row dropped from a candidate's answer", async () => {
    const of = oracleDatabase(true);
    const follower = await twoMembers(of);
    let dropped = '';
    of.hooks.rows = (rows) => {
      dropped = (rows[0] as { value: string }).value;
      return rows.slice(1);
    };
    const read = await rosterRead(of);

    of.db.prepare(`UPDATE "user" SET name = 'cid' WHERE id = ?`).run(dropped);

    expect(dropped).not.toBe('');
    expect(read.changedBy(await follower.changed())).toBe(false);
  });

  // A term of a result's alias holds of no row a candidate reads: it reads nothing of it.
  it("names the driver's rows beside a term of what is no column of its table", async () => {
    const of = oracleDatabase(false);
    const follower = await twoMembers(of);
    const picks = { github: '', organization: 'o0', other: '', slug: '', user: '' };
    await rendered(() => aliasTerm(of.followed, picks));
    const read = await rendered(() => aliasTerm(of.followed, picks), { streamed: true });

    of.db.exec(`DELETE FROM "user" WHERE id = 'u0'`);

    expect(read.changedBy(await follower.changed())).toBe(true);
  });

  it('asks nothing of a row no candidate names', async () => {
    const of = oracleDatabase(true);
    const follower = await twoMembers(of);
    const read = await rosterRead(of);

    of.db.exec(`INSERT INTO "user" (id, name) VALUES ('u2', 'cid')`);

    expect(read.changedBy(await follower.changed())).toBe(false);
  });

  it('finds what a reader of a looser `ON` misses', { timeout: RUN.timeoutMs }, async () => {
    reader.loose = true;
    try {
      const missed = await missedOf(leftTableTerm, 0, {
        foreignKeys: true,
        streamed: false,
        trials: RUN.control,
      });

      expect(missed).not.toHaveLength(0);
    } finally {
      reader.loose = false;
    }
  });
});
