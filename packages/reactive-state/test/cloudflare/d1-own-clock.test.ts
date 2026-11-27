import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthorityEngine } from '../../src/authority/engine.ts';
import { durableObjectSql } from '../../src/cloudflare/sql.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../../src/program.ts';
import type { RouteRegistration } from '../../src/routing.ts';
import { followDrizzle, followedDb } from '../../src/sql/index.ts';
import { textOf } from '../support/frames.ts';
import { bindingValue } from './d1-drizzle-binding.ts';
import { authority } from './helpers.ts';

/**
 * A route every visitor shares, whose render reads the application's tables in D1 through its
 * Drizzle, where D1 answers no plan of a statement, run in workerd by an engine over a Durable
 * Object's storage: the client reads its own clock to tell when it asks D1 again, which is no read
 * of the render's — the view is every visitor's still, of statements whose words say they read
 * followed tables alone. One that reads a table nothing follows makes it the request's, and so does
 * a read of the clock by the application's code, as ever. Each test of a follow of its own, whose
 * plans no other test asked.
 */

const cards = sqliteTable('clock_cards', { id: text().primaryKey(), title: text().notNull() });
/** A table of the application's that the schema the follow is given holds not. */
const notes = sqliteTable('clock_notes', { id: text().primaryKey(), body: text().notNull() });
const schema = { cards };
const BUILD = 'b_d1_own_clock';
const COMPONENT = 'components/clock-card';
const ROUTE: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'card/page.tsx',
  params: [],
  props: {},
  root: COMPONENT,
  route: '/card',
  shared: true,
};
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;
/** The probe of a D1 whose plan's batch failed: asked of no D1 that answers each plan. */
const PROBE = 'EXPLAIN SELECT 1';
const db = env.REACTIVE_D1;

/** Which statements D1 refuses: every `EXPLAIN`, or those of plans, `EXPLAIN SELECT 1` answered. */
type Refused = 'every-explain' | 'none' | 'plans';

/**
 * `db`, of a D1 that refuses `refused`, as D1 in production may — a statement of a table no
 * database holds in its place — each `EXPLAIN` it is asked told to `explained`.
 */
function refusing(refused: Refused, explained: string[]): D1Database {
  return new Proxy(db, {
    get: (target, key) => {
      if (key !== 'prepare') return bindingValue(target, key);
      return (statement: string) => {
        const explain = /^EXPLAIN\b/u.test(statement);
        if (explain) explained.push(statement);
        const answered = refused === 'none' || (refused === 'plans' && statement === PROBE);
        return target.prepare(explain && !answered ? 'SELECT * FROM "refused EXPLAIN"' : statement);
      };
    },
  });
}

/**
 * The root: the card's title, what `also` names — the note's body, or the card's title again beside
 * JSON's table function, in a text not read plainly — and the time by the application's own clock,
 * of `clocked`.
 */
function cardProgram(
  orm: ReturnType<typeof drizzle<typeof schema>>,
  { also, clocked }: { readonly also: Also; readonly clocked: boolean },
): ComponentProgram {
  return {
    buildId: BUILD,
    component: COMPONENT,
    evaluate: async (_props: unknown, $: RenderScope) => {
      const [card] = await orm.select().from(cards).where(eq(cards.id, 'c1'));
      const at = clocked ? ` at ${String(Date.now())}` : '';
      const more = also === undefined ? [] : await alsoRead(orm, also);
      const shown = more.map((value) => ` ${value}`).join('');
      return $.h('p', null, `${card?.title ?? 'none'}${shown}${at}`);
    },
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
}

/** What a root reads beside the card: the note, or the card beside JSON's table function. */
type Also = 'json' | 'note' | undefined;

/** The text of what `also` names, as the root reads it. */
async function alsoRead(
  orm: ReturnType<typeof drizzle<typeof schema>>,
  also: 'json' | 'note',
): Promise<readonly string[]> {
  if (also === 'note') {
    const rows = await orm.select({ body: notes.body }).from(notes).where(eq(notes.id, 'n1'));
    return rows.map(({ body }) => body);
  }
  const rows = await orm.all<{ readonly v: string }>(
    sql`select "clock_cards"."title" as "v" from "clock_cards", json_each(${'[1]'}) where "clock_cards"."id" = ${'c1'}`,
  );
  return rows.map(({ v }) => v);
}

/** What a visitor of no session is answered, and the `EXPLAIN`s D1 was asked. */
interface Answered {
  readonly kind: string;
  readonly text: string;
  readonly explained: readonly string[];
  /** How many of them were asked before the visitor's render. */
  readonly before: number;
}

/**
 * How a visitor of no session is answered the card's route by an engine over a D1 that refuses
 * `refused`, its log read once — after a session's render of the root, which notes nothing of what
 * it reads untracked, of `sessionFirst` — of a root that reads what `also` names too.
 */
async function sharedAnswer(
  refused: Refused,
  { also = undefined as Also, clocked = false, sessionFirst = false } = {},
): Promise<Answered> {
  return runInDurableObject(authority(), async (_instance, state) => {
    const follow = followDrizzle(schema, { store: 'clock' });
    const explained: string[] = [];
    const orm = drizzle(follow.client(refusing(refused, explained)), { schema });
    const engine = new AuthorityEngine({
      buildId: BUILD,
      database: followedDb(follow),
      externalPollMs: IDLE_POLL_MS,
      programs: [cardProgram(orm, { also, clocked })],
      routes: [ROUTE],
      sql: durableObjectSql(state.storage),
    });
    try {
      await engine.poke();
      if (sessionFirst) {
        const { sessionId } = await engine.login('alice');
        await engine.render(sessionId, { build: BUILD, component: COMPONENT, props: {} });
      }
      const before = explained.length;
      const answer = await engine.renderShared(null, { build: BUILD, props: {}, route: '/card' });
      return { before, explained, kind: answer.kind, text: textOf(answer.result.tree) };
    } finally {
      await engine.close();
    }
  });
}

describe('a shared route over a D1 that answers no plan, in workerd', () => {
  beforeEach(async () => {
    const follow = followDrizzle(schema, { store: 'clock' });
    await db.batch(
      [
        'DROP TABLE IF EXISTS clock_cards',
        'DROP TABLE IF EXISTS clock_notes',
        'DROP TABLE IF EXISTS _rs_changes',
        'DROP TABLE IF EXISTS _rs_meta',
        'CREATE TABLE clock_cards (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)',
        'CREATE TABLE clock_notes (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)',
        "INSERT INTO clock_cards VALUES ('c1', 'First')",
        "INSERT INTO clock_notes VALUES ('n1', 'N1')",
      ].map((statement) => db.prepare(statement)),
    );
    await db.batch(follow.captureSql().map((statement) => db.prepare(statement)));
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // The client's warning of a D1 that answers no plan, which these do on purpose.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is every visitor’s where D1 answers each plan', async () => {
    const answer = await sharedAnswer('none');

    expect(answer).toMatchObject({ kind: 'shared', text: 'First' });
    expect(answer.explained).not.toContain(PROBE);
  });

  it('is every visitor’s where D1 refuses every EXPLAIN', async () => {
    const answer = await sharedAnswer('every-explain');

    expect(answer).toMatchObject({ kind: 'shared', text: 'First' });
    expect(answer.explained).toContain(PROBE);
  });

  it('is every visitor’s in the while after D1 refused EXPLAIN to another render', async () => {
    const answer = await sharedAnswer('every-explain', { sessionFirst: true });

    expect(answer.kind).toBe('shared');
    expect(answer.explained).toContain(PROBE);
    // Within the while: D1 asked for no plan again.
    expect(answer.explained).toHaveLength(answer.before);
  });

  it('is every visitor’s where D1 fails the plan but answers EXPLAIN SELECT 1', async () => {
    const answer = await sharedAnswer('plans');

    expect(answer.kind).toBe('shared');
    expect(answer.explained).toContain(PROBE);
  });

  it('is every visitor’s of a plan another render kept for a while, its batch failed', async () => {
    const answer = await sharedAnswer('plans', { sessionFirst: true });

    expect(answer.kind).toBe('shared');
    expect(answer.explained).toContain(PROBE);
    // The kept plan, of every followed table: D1 asked for none again.
    expect(answer.explained).toHaveLength(answer.before);
  });

  it('is the request’s where it reads a table nothing follows, D1 refusing every EXPLAIN', async () => {
    const answer = await sharedAnswer('every-explain', { also: 'note' });

    expect(answer).toMatchObject({ kind: 'session', text: 'First N1' });
    expect(answer.explained).toContain(PROBE);
  });

  it('is every visitor’s of JSON’s table function over the card, in a text not read plainly', async () => {
    const answer = await sharedAnswer('none', { also: 'json' });

    expect(answer).toMatchObject({ kind: 'shared', text: 'First First' });
    expect(answer.explained).not.toContain(PROBE);
  });

  it('is the request’s where the render reads the clock itself', async () => {
    const answer = await sharedAnswer('every-explain', { clocked: true });

    expect(answer.kind).toBe('session');
    expect(answer.explained).toContain(PROBE);
  });
});
