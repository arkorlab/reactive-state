import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import type { RouteRegistration } from '../src/routing.ts';
import { type Evaluation, evaluate, type TableRead } from '../src/server/context.ts';
import { followDrizzle, followedDb } from '../src/sql/index.ts';
import { type LocalD1, localD1 } from '../src/sql/sqlite/local-d1.ts';
import { textOf } from './support/frames.ts';

/**
 * A route every visitor shares, whose render reads the application's tables in D1 through its
 * Drizzle, where D1 answers no plan of a statement: no `EXPLAIN` at all, or no plan's batch. The
 * render reads every followed table whole, and the framework's client reads the clock to tell when
 * it asks D1 again — a read of its own, of no answer of the render's. The view is every visitor's
 * still where the statement's words say it reads followed tables alone: a text read plainly, each
 * table it names followed. Otherwise — a table nothing follows, whose change no log tells, or a
 * text not read plainly — it is the request's, rendered again for each request once the memo lets
 * it go. A read of the clock by the application's own code makes it the request's, as ever. Of a
 * file in D1's shape (`localD1`), each test of a follow of its own, whose plans no other test
 * asked.
 */

const cards = sqliteTable('cards', { id: text().primaryKey(), title: text().notNull() });
/** Another followed table, which no root reads but where every followed table is read. */
const labels = sqliteTable('labels', { id: text().primaryKey(), name: text().notNull() });
/** A table of the application's that the schema the follow is given holds not. */
const notes = sqliteTable('notes', { id: text().primaryKey(), body: text().notNull() });
const schema = { cards, labels };
const DDL = [
  'CREATE TABLE cards (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)',
  'CREATE TABLE labels (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)',
  'CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)',
  // A virtual table of FTS5's, nothing follows, whose reads no b-tree of the bytecode names.
  'CREATE VIRTUAL TABLE notes_fts USING fts5(body)',
];
const SEED = [
  "INSERT INTO cards VALUES ('c1', 'First')",
  "INSERT INTO labels VALUES ('l1', 'Urgent')",
  "INSERT INTO notes VALUES ('n1', 'N1')",
  "INSERT INTO notes_fts VALUES ('N1')",
];
const BUILD = 'b_d1_fallbacks';
const COMPONENT = 'components/card';
/** Another root of the same statements, under a route of its own. */
const AGAIN = 'components/card-again';
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;
/** Past the while D1 is asked no plan again after it answered none. */
const PAST_THE_WHILE_MS = 61_000;
/** Past the while the memo keeps a rendering, whatever commits. */
const PAST_THE_MEMO_MS = 31_000;
/** The probe of a D1 whose plan's batch failed: asked of no D1 that answers each plan. */
const PROBE = 'EXPLAIN SELECT 1';
/** What a D1 that refuses an `EXPLAIN` runs in its place: a statement of a table there is not. */
const REFUSED = 'SELECT * FROM "refused EXPLAIN"';

/** Which statements D1 refuses: every `EXPLAIN`, or those of plans, `EXPLAIN SELECT 1` answered. */
type Refused = 'every-explain' | 'plans' | 'none';
type Orm = ReturnType<typeof drizzle<typeof schema>>;
/** A row of a statement of the application's own text: its one value. */
interface Row {
  readonly v: unknown;
}

/**
 * What a root may read beside the card, each answering the text it shows: of a table nothing
 * follows, as Drizzle writes a read of one (`note`), and joined with the card's (`mixed`); of the
 * card's table alone, by a `WITH`, which is not read plainly (`chosen`), a join of it with itself
 * (`joined`), a subquery (`nested`), by a name of other capitals (`upper`), and as Drizzle writes an
 * order, a limit, a group and a `DISTINCT` (`ordered`, `grouped`, `distinct`); of the card's table
 * beside JSON's table function, in texts not read plainly (`comma`, `bare`, `cross`, `unquoted`,
 * `commented`); of a table nothing follows beside it (`virtual`); of a virtual table of FTS5's,
 * which no word accounts for (`fts`), beside a function of JSON that reads no table (`extracted`),
 * beside the name of JSON's table function in a string and a comment (`worded`), and beside a table
 * nothing follows (`indexed`); and of `sqlite_master`, whose b-tree no row of the schema names
 * (`master`).
 */
const ALSO = {
  bare: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "cards"."title" as "v" from "cards" join json_each(${'[1]'}) "j" where "cards"."id" = ${'c1'}`,
    );
  },
  comma: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "cards"."title" as "v" from "cards", json_each(${'[1]'}) where "cards"."id" = ${'c1'}`,
    );
  },
  commented: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "cards"."title" as "v" /* the card's */ from "cards", json_each(${'[1]'}) where "cards"."id" = ${'c1'}`,
    );
  },
  cross: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "cards"."title" as "v" from "cards" cross join json_each(${'[1]'}) where "cards"."id" = ${'c1'}`,
    );
  },
  distinct: (orm: Orm) => orm.selectDistinct({ v: cards.title }).from(cards),
  extracted: (orm: Orm) => {
    return orm.all<Row>(
      sql`select json_extract(${'{"a":"N1"}'}, '$.a') as "v" from "notes_fts" where "notes_fts" match ${'N1'}`,
    );
  },
  fts: (orm: Orm) =>
    orm.all<Row>(sql`select "body" as "v" from "notes_fts" where "notes_fts" match ${'N1'}`),
  grouped: (orm: Orm) => orm.select({ v: cards.title }).from(cards).groupBy(cards.title),
  indexed: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "notes"."body" as "v" from "notes", "notes_fts" where "notes_fts" match ${'N1'}`,
    );
  },
  master: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "name" as "v" from "sqlite_master" where "name" = ${'cards'} and "type" = ${'table'}`,
    );
  },
  ordered: (orm: Orm) => orm.select({ v: cards.title }).from(cards).orderBy(cards.title).limit(1),
  unquoted: (orm: Orm) => {
    return orm.all<Row>(
      sql`select cards.title as v from cards, json_each(${'[1]'}) where json_each.value = 1 and cards.id = ${'c1'}`,
    );
  },
  worded: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "body" as "v" from "notes_fts" where "notes_fts" match ${'N1'} and 'json_each(' <> '' -- json_each(`,
    );
  },
  upper: (orm: Orm) =>
    orm.all<Row>(sql`select "title" as "v" from "CARDS" where "CARDS"."id" = ${'c1'}`),
  chosen: (orm: Orm) => {
    return orm.all<Row>(
      sql`with "chosen" as (select "title" from "cards") select "title" as "v" from "chosen"`,
    );
  },
  joined: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "a"."title" as "v" from "cards" "a" inner join "cards" "b" on "b"."id" = "a"."id" where "a"."id" = ${'c1'}`,
    );
  },
  mixed: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "n"."body" as "v" from "cards" "c" inner join "notes" "n" on "n"."id" = ${'n1'} where "c"."id" = ${'c1'}`,
    );
  },
  nested: (orm: Orm) => {
    return orm.all<Row>(
      sql`select "title" as "v" from "cards" where "id" in (select "id" from "cards" where "id" = ${'c1'})`,
    );
  },
  note: (orm: Orm) => orm.select({ v: notes.body }).from(notes).where(eq(notes.id, 'n1')),
  virtual: (orm: Orm) => orm.all<Row>(sql`select "body" as "v" from "notes", json_each(${'[1]'})`),
} as const;

/** Whether a D1 that refuses `refused` refuses `statement`. */
function refuses(refused: Refused, statement: string): boolean {
  if (refused === 'none' || !/^EXPLAIN\b/u.test(statement)) return false;
  return refused === 'every-explain' || statement !== PROBE;
}

/**
 * A database of memory alone of the card `c1`, titled `First`, the note `n1`, `N1`, and the
 * follow's log, closed as the test ends: as the D1 the application reads, which refuses `refused`,
 * as D1 in production may — a statement of a table no database holds in its place — and counts
 * each `EXPLAIN` it is asked. A plan's batch waits for `held`, where given.
 */
async function databaseOf(
  follow: ReturnType<typeof followOf>,
  refused: Refused,
  held?: Promise<void>,
): Promise<{ readonly binding: LocalD1; readonly explained: string[] }> {
  const local = localD1(':memory:');
  onTestFinished(() => {
    local.close();
  });
  const statements = [...DDL, ...follow.captureSql()];
  await local.batch(statements.map((statement) => local.prepare(statement)));
  await local.batch(SEED.map((statement) => local.prepare(statement)));
  const explained: string[] = [];
  const binding: LocalD1 = {
    ...local,
    batch: async (asked) => {
      // A plan's batch begins with the statement's `EXPLAIN`, or what runs in its place.
      const first = (asked as readonly { readonly sql: string }[])[0]?.sql ?? '';
      if (first === REFUSED || first.startsWith('EXPLAIN ')) await held;
      return local.batch(asked);
    },
    prepare: (statement) => {
      if (/^EXPLAIN\b/u.test(statement)) explained.push(statement);
      return local.prepare(refuses(refused, statement) ? REFUSED : statement);
    },
  };
  return { binding, explained };
}

/** A follow of the card's table, whose plans no other test asked. */
function followOf() {
  return followDrizzle(schema, { store: 'cards' });
}

/** What a root renders beside the card's title: what it reads besides, and the application's clock. */
interface Reads {
  readonly also?: keyof typeof ALSO | undefined;
  readonly clocked?: boolean | undefined;
}

/**
 * The root `component`: the card's title, what `also` names, and the time, of `clocked`; each
 * evaluation counted in `counted`.
 */
function cardProgram(
  component: string,
  orm: Orm,
  { also, clocked = false }: Reads,
  counted: { evaluations: number },
): ComponentProgram {
  return {
    buildId: BUILD,
    component,
    evaluate: async (_props: unknown, $: RenderScope) => {
      counted.evaluations += 1;
      const [card] = await orm.select().from(cards).where(eq(cards.id, 'c1'));
      const more = also === undefined ? [] : await ALSO[also](orm);
      const shown = more.map(({ v }) => ` ${String(v)}`).join('');
      const at = clocked ? ` at ${String(Date.now())}` : '';
      return $.h('p', null, `${card?.title ?? 'none'}${shown}${at}`);
    },
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
}

/** A route every visitor shares of the root `component`, at `/<name>`. */
function routeOf(name: string, component: string): RouteRegistration {
  return {
    blocking: true,
    middleware: [],
    page: `${name}/page.tsx`,
    params: [],
    props: {},
    root: component,
    route: `/${name}`,
    shared: true,
  };
}

/**
 * An engine of the card's routes over a D1 that refuses `refused`, its log read once, of the
 * engine's `clock` where given: how a visitor of no session is answered each route — `/card`, or
 * `/again` of another root of the same statements — and how a session's render of the root reads,
 * which notes nothing of what it reads untracked.
 */
async function opened(refused: Refused, reads: Reads & { readonly clock?: () => number } = {}) {
  const follow = followOf();
  const { binding, explained } = await databaseOf(follow, refused);
  const orm = drizzle(follow.client(binding) as never, { schema });
  const counted = { evaluations: 0 };
  const engine = new Engine({
    buildId: BUILD,
    ...(reads.clock !== undefined && { clock: reads.clock }),
    database: followedDb(follow),
    externalPollMs: IDLE_POLL_MS,
    programs: [
      cardProgram(COMPONENT, orm, reads, counted),
      cardProgram(AGAIN, orm, reads, counted),
    ],
    routes: [routeOf('card', COMPONENT), routeOf('again', AGAIN)],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  await engine.poke();
  const shared = (route = '/card') => engine.renderShared(null, { build: BUILD, props: {}, route });
  const ofSession = async () => {
    const session = (await engine.login('alice')).sessionId;
    return engine.render(session, { build: BUILD, component: COMPONENT, props: {} });
  };
  return { binding, counted, engine, explained, ofSession, orm, shared };
}

/** Each warning of a D1 that answers no plan, kept out of the output. */
function quiet(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {
    // The client's warning of a D1 that answers no plan, which these do on purpose.
  });
}

/**
 * A render every visitor shares of `read`, as an evaluation of one takes it in: what it noted of
 * the request, and what it read of the tables. `asked` is told once its reads are being noted.
 */
async function sharedRender(
  read: () => Promise<unknown>,
  asked: () => void,
): Promise<{ readonly noted: readonly string[]; readonly reads: readonly TableRead[] }> {
  const noted: string[] = [];
  const reads: TableRead[] = [];
  const evaluation = {
    readTables: async (taken: () => Promise<readonly TableRead[]>) => {
      const reading = taken();
      asked();
      reads.push(...(await reading));
    },
    shared: {
      boundToRequest: (what: string) => {
        noted.push(what);
      },
    },
  } as unknown as Evaluation;
  await evaluate(evaluation, async () => {
    await read();
  });
  return { noted, reads };
}

describe('a shared route over a D1 that answers no plan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is every visitor’s where D1 answers each plan', async () => {
    const { explained, shared } = await opened('none');
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(textOf(answer.result.tree)).toBe('First');
    expect(explained).not.toContain(PROBE);
  });

  it('is every visitor’s where D1 refuses every EXPLAIN, which its render finds first', async () => {
    quiet();
    const { explained, shared } = await opened('every-explain');
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(textOf(answer.result.tree)).toBe('First');
    expect(explained).toContain(PROBE);
  });

  it('is every visitor’s in the while after D1 refused EXPLAIN to another render', async () => {
    quiet();
    const { explained, ofSession, shared } = await opened('every-explain');
    await ofSession();
    const asked = explained.length;
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(explained).toContain(PROBE);
    // Within the while: D1 asked for no plan again.
    expect(explained).toHaveLength(asked);
  });

  it('is every visitor’s where D1 fails the plan but answers EXPLAIN SELECT 1', async () => {
    quiet();
    const { explained, shared } = await opened('plans');
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(explained).toContain(PROBE);
  });

  it('is every visitor’s of a plan another render kept for a while, its batch failed', async () => {
    quiet();
    const { explained, ofSession, shared } = await opened('plans');
    await ofSession();
    const asked = explained.length;
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(explained).toContain(PROBE);
    // The kept plan, of every followed table: D1 asked for none again.
    expect(explained).toHaveLength(asked);
  });

  it('is every visitor’s again once a change of the card it read whole renders it', async () => {
    quiet();
    const { engine, explained, orm, shared } = await opened('every-explain');
    await shared();

    await orm.update(cards).set({ title: 'Renamed' }).where(eq(cards.id, 'c1'));
    await engine.poke();
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(textOf(answer.result.tree)).toBe('Renamed');
    expect(explained).toContain(PROBE);
  });

  it('asks D1 for a plan again past the while, by the clock a spy of `Date.now` moves', async () => {
    quiet();
    const { engine, explained, ofSession, orm } = await opened('every-explain');
    // A change of the card, which the root is rendered again of, not taken from the memo.
    const renamed = async (title: string) => {
      await orm.update(cards).set({ title }).where(eq(cards.id, 'c1'));
      await engine.poke();
    };
    await ofSession();
    const asked = explained.length;
    await renamed('Second');
    await ofSession();

    expect(explained).toHaveLength(asked);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PAST_THE_WHILE_MS);
    await renamed('Third');
    await ofSession();

    expect(explained.length).toBeGreaterThan(asked);
  });

  it('is the request’s where the render reads the clock itself', async () => {
    quiet();
    const { shared } = await opened('every-explain', { clocked: true });

    await expect(shared()).resolves.toMatchObject({ kind: 'session' });
  });

  it('is the request’s where the render reads the clock itself, of a D1 that answers', async () => {
    const { shared } = await opened('none', { clocked: true });

    await expect(shared()).resolves.toMatchObject({ kind: 'session' });
  });
});

describe('a shared route over a D1 that answers no plan, of what its words show not followed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['a read of a table nothing follows', 'note', 'First N1'],
    ['a join of the card’s table with one nothing follows', 'mixed', 'First N1'],
    ['a `WITH` of the card’s table alone, not read plainly', 'chosen', 'First First'],
  ] as const)('is the request’s where D1 refuses every EXPLAIN, of %s', async (_, also, shown) => {
    quiet();
    const { explained, shared } = await opened('every-explain', { also });
    const answer = await shared();

    expect(answer.kind).toBe('session');
    expect(textOf(answer.result.tree)).toBe(shown);
    expect(explained).toContain(PROBE);
  });

  it('is the request’s of each render that takes the plan kept of such a read', async () => {
    quiet();
    const { explained, shared } = await opened('plans', { also: 'note' });
    const first = await shared('/card');
    const asked = explained.length;
    // Another root of the same statements, within the while: of the plans the first render kept.
    const again = await shared('/again');

    expect([first.kind, again.kind]).toStrictEqual(['session', 'session']);
    expect(explained).toContain(PROBE);
    expect(explained).toHaveLength(asked);
  });

  it('is the request’s of a render that awaits the plan another render asks', async () => {
    quiet();
    const follow = followOf();
    const both = Promise.withResolvers<undefined>();
    let asking = 0;
    const joined = () => {
      asking += 1;
      if (asking === 2) both.resolve(undefined);
    };
    // The plan's batch waits until the second render awaits the ask the first one began.
    const { binding, explained } = await databaseOf(follow, 'plans', both.promise);
    const orm = drizzle(follow.client(binding) as never, { schema });
    const read = () => ALSO.note(orm);

    const [first, second] = await Promise.all([
      sharedRender(read, joined),
      sharedRender(read, joined),
    ]);

    // One ask of the text, which both awaited.
    expect(explained.filter((each) => each !== PROBE)).toHaveLength(1);
    expect(first.noted).toStrictEqual([expect.stringContaining('from "notes"')]);
    expect(second.noted).toStrictEqual(first.noted);
  });

  it('faults a render of a table nothing follows beside JSON’s table function, of a plan', async () => {
    const { explained, ofSession, shared } = await opened('none', { also: 'virtual' });
    const fault = 'A render read notes, which reactive-state does not follow';

    await expect(shared()).rejects.toThrow(fault);
    await expect(ofSession()).rejects.toThrow(fault);
    expect(explained).not.toContain(PROBE);
  });

  it('faults a render of a table nothing follows beside a virtual table its words call not', async () => {
    const { ofSession, shared } = await opened('none', { also: 'indexed' });
    const fault = 'A render read notes, which reactive-state does not follow';

    await expect(shared()).rejects.toThrow(fault);
    await expect(ofSession()).rejects.toThrow(fault);
  });

  it.each([
    ['a comma join', 'comma'],
    ['a join of no ON', 'bare'],
    ['a cross join', 'cross'],
    ['names without quotes', 'unquoted'],
    ['a comment', 'commented'],
  ] as const)(
    'is every visitor’s of JSON’s table function over the card, by %s',
    async (_, also) => {
      const { explained, shared } = await opened('none', { also });
      const answer = await shared();

      expect(answer.kind).toBe('shared');
      expect(textOf(answer.result.tree)).toBe('First First');
      expect(explained).not.toContain(PROBE);
    },
  );

  it('renders such a read again of a change of the card, not of another followed table', async () => {
    const { counted, engine, orm, shared } = await opened('none', { also: 'comma' });
    const first = await shared();
    const evaluated = counted.evaluations;

    await orm.update(labels).set({ name: 'Later' }).where(eq(labels.id, 'l1'));
    await engine.poke();
    const unchanged = await shared();

    expect([first.kind, unchanged.kind]).toStrictEqual(['shared', 'shared']);
    expect(counted.evaluations).toBe(evaluated);

    await orm.update(cards).set({ title: 'Renamed' }).where(eq(cards.id, 'c1'));
    await engine.poke();
    const renamed = await shared();

    expect(textOf(renamed.result.tree)).toBe('Renamed Renamed');
    expect(counted.evaluations).toBeGreaterThan(evaluated);
  });

  it.each([
    ['a virtual table of FTS5’s', 'fts', 'First N1'],
    ['one beside a function of JSON that reads no table', 'extracted', 'First N1'],
    [
      'one beside the name of JSON’s table function in a string and a comment',
      'worded',
      'First N1',
    ],
    ['`sqlite_master`', 'master', 'First cards'],
  ] as const)(
    'is the request’s of a plan that does not say it reads %s',
    async (_, also, shown) => {
      const { explained, shared } = await opened('none', { also });
      const answer = await shared();

      expect(answer.kind).toBe('session');
      expect(textOf(answer.result.tree)).toBe(shown);
      expect(explained).not.toContain(PROBE);
    },
  );

  it.each([
    ['an order and a limit', 'ordered'],
    ['a group', 'grouped'],
    ['a DISTINCT', 'distinct'],
  ] as const)('is every visitor’s of the card read with %s, of a plan', async (_, also) => {
    const { shared } = await opened('none', { also });
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(textOf(answer.result.tree)).toBe('First First');
  });

  it('is every visitor’s of a name of other capitals than the followed table’s, of no plan', async () => {
    quiet();
    const { explained, shared } = await opened('every-explain', { also: 'upper' });
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(textOf(answer.result.tree)).toBe('First First');
    expect(explained).toContain(PROBE);
  });

  it('shows a change of a table nothing follows once the memo lets its rendering go', async () => {
    quiet();
    let now = Date.now();
    const { binding, engine, shared } = await opened('every-explain', {
      also: 'note',
      clock: () => now,
    });
    const before = await shared();

    // A change no log tells of: the table has no triggers of the follow's.
    await binding.prepare("UPDATE notes SET body = 'N2' WHERE id = 'n1'").run();
    await engine.poke();
    now += PAST_THE_MEMO_MS;
    const after = await shared();

    expect(textOf(before.result.tree)).toBe('First N1');
    expect(textOf(after.result.tree)).toBe('First N2');
  });

  it.each([
    ['every-explain', 'joined'],
    ['every-explain', 'nested'],
    ['plans', 'joined'],
    ['plans', 'nested'],
  ] as const)('is every visitor’s where D1 refuses %s, of the card %s', async (refused, also) => {
    quiet();
    const { explained, shared } = await opened(refused, { also });
    const answer = await shared();

    expect(answer.kind).toBe('shared');
    expect(textOf(answer.result.tree)).toBe('First First');
    expect(explained).toContain(PROBE);
  });

  it('faults a render that reads a table nothing follows, of a plan D1 answers', async () => {
    const { ofSession } = await opened('none', { also: 'note' });

    await expect(ofSession()).rejects.toThrow(
      'A render read notes, which reactive-state does not follow',
    );
  });

  it('renders a session’s read of a table nothing follows of no plan, as no fault', async () => {
    quiet();
    const { ofSession } = await opened('every-explain', { also: 'note' });
    const rendered = await ofSession();

    expect(textOf(rendered.tree)).toBe('First N1');
  });
});
