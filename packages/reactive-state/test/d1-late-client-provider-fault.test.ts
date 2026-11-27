import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import { followDrizzle, followedDb } from '../src/sql/index.ts';
import { type LocalD1, localD1 } from '../src/sql/sqlite/local-d1.ts';
import { faultsOf } from './cloudflare/d1-drizzle-render.ts';
import { textOf } from './support/frames.ts';

/**
 * A D1 follow's function that throws as it is asked for its binding — an environment not there
 * yet, a host that is not ready — is a fault of the render that asked, whatever the render's code
 * does with the error, as the function's answer of none is: the render whose component draws a
 * fallback for it would otherwise depend on nothing of the store, and show the fallback after the
 * binding is there.
 */

const cards = sqliteTable('cards', { id: text().primaryKey(), title: text().notNull() });
const schema = { cards };
const DDL = 'CREATE TABLE cards (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)';
const BUILD = 'b_late_provider_fault';
const COMPONENT = 'components/late-provider-fault';
const ROOT = { build: BUILD, component: COMPONENT, props: {} };
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;

/** A database of memory alone, with the table, the follow's log and the card `c1`. */
async function opened(follow: ReturnType<typeof followDrizzle<typeof schema>>): Promise<LocalD1> {
  const binding = localD1(':memory:');
  onTestFinished(() => {
    binding.close();
  });
  const statements = [DDL, ...follow.captureSql()];
  await binding.batch(statements.map((statement) => binding.prepare(statement)));
  await binding.prepare("INSERT INTO cards VALUES ('c1', 'First')").run();
  return binding;
}

describe('a D1 follow whose function throws as it is asked for the binding', () => {
  it.each([
    ['a statement', (orm: ReturnType<typeof drizzle>) => orm.select().from(cards)],
    ['a batch', (orm: ReturnType<typeof drizzle>) => orm.batch([orm.select().from(cards)])],
  ])('notes the error as the render’s fault, of %s the render caught', async (_what, query) => {
    const thrown = new Error('No environment yet.');
    const follow = followDrizzle(schema, { store: 'sql' });
    const orm = drizzle(
      follow.client((): LocalD1 => {
        throw thrown;
      }) as never,
      { schema },
    );

    await expect(
      faultsOf(async () => {
        await query(orm);
      }),
    ).resolves.toStrictEqual([thrown]);
  });

  it('throws it as it is of a call outside a render', () => {
    const thrown = new Error('No environment yet.');
    const follow = followDrizzle(schema, { store: 'sql' });
    const client = follow.client((): LocalD1 => {
      throw thrown;
    });

    expect(() => client.prepare('SELECT 1')).toThrow(thrown);
  });

  it('fails a render that caught it, and renders it once the function answers', async () => {
    const follow = followDrizzle(schema, { store: 'sql' });
    const connection: { binding?: LocalD1 } = {};
    const provider = vi.fn((): LocalD1 => {
      if (connection.binding === undefined) throw new Error('No environment yet.');
      return connection.binding;
    });
    const orm = drizzle(follow.client(provider) as never, { schema });
    const evaluate = async (_props: unknown, $: RenderScope) => {
      try {
        const [card] = await orm.select().from(cards).where(eq(cards.id, 'c1'));
        return $.h('p', null, card?.title);
      } catch {
        return $.h('p', null, 'Unavailable');
      }
    };
    const program: ComponentProgram = {
      buildId: BUILD,
      component: COMPONENT,
      evaluate,
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const engine = new Engine({
      buildId: BUILD,
      database: followedDb(follow),
      externalPollMs: IDLE_POLL_MS,
      programs: [program],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const session = (await engine.login('alice')).sessionId;
    const render = async () => textOf((await engine.render(session, ROOT)).tree);

    await expect(render()).rejects.toThrow('No environment yet.');

    connection.binding = await opened(follow);
    await engine.poke();

    await expect(render()).resolves.toBe('First');
  });
});
