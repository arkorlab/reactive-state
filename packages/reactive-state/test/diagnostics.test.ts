import { eq } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { Dependencies } from '../src/authority/dependencies.ts';
import { Diagnostics, diagnosticsEveryOf } from '../src/authority/diagnostics.ts';
import { Engine } from '../src/authority/index.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../src/program.ts';
import { tableReads } from '../src/server/context.ts';
import { engineOf, openedWith } from './support/drizzle.ts';
import { logStore } from './support/follow-store.ts';
import { itemsReadThrough } from './support/followed-items.ts';

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text() });
const schema = { tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text);
  INSERT INTO tasks VALUES ('t1', 'First'), ('t2', 'Second');
`;

/** A component every visitor shares, whose statement reads a table whole. */
const SHARED: ComponentProgram = {
  buildId: 'b',
  component: 'components/shared',
  evaluate: async (_props, $) => {
    await tableReads()?.(() => Promise.resolve([{ table: 'items', where: {} }]));
    return $.h('p', null, 'shared');
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** A page reading one task by its key, or every task, whose open stream hears every commit. */
async function rendering(read: 'one' | 'every') {
  const setup = await openedWith(schema, DDL);
  const rendered = await engineOf(setup, async (_props, $) => {
    const rows =
      read === 'one'
        ? await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'))
        : await setup.orm.select().from(tasks);
    return $.h('p', null, rows[0]?.title ?? '');
  });
  const shown = await rendered.rendered();
  const stream = await rendered.engine.watch(rendered.session, shown.frame.subscription);
  rendered.engine.onCommit((event) => {
    stream.dependsOn(event);
  });
  return { ...rendered, setup };
}

/** The reads and wakes the authority counted so far, of the one component of `rendering`. */
async function followed({ engine }: Awaited<ReturnType<typeof rendering>>) {
  const { follow } = await engine.stats();
  return { reads: follow.reads, again: follow.rendersAgain['components/drizzle'] };
}

/** A report of its own clock, and what it writes to the log. */
function reporting(everyMs: number | undefined) {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {
    // Asserted in each test, kept out of the output.
  });
  let now = 0;
  const clock = (): number => now;
  return {
    diagnostics: new Diagnostics(clock, everyMs),
    info,
    pass: (ms: number): void => {
      now += ms;
    },
  };
}

describe('what the authority counts of what it follows', { timeout: 20_000 }, () => {
  it('counts a read by its rows, and leaves the table of the schema out', async () => {
    const { reads } = await followed(await rendering('one'));

    expect(reads['tasks']?.whole).toBe(0);
    expect(reads['tasks']?.keyed).toBeGreaterThan(0);
    expect(Object.keys(reads)).toStrictEqual(['tasks']);
  });

  it('counts a read of a table whole', async () => {
    const { reads } = await followed(await rendering('every'));

    expect(reads['tasks']?.keyed).toBe(0);
    expect(reads['tasks']?.whole).toBeGreaterThan(0);
  });

  it('counts the reads of a render every visitor shares', async () => {
    const store = logStore(() => Promise.resolve({ changes: [], epoch: 'e', floor: 0, head: 0 }));
    const engine = new Engine({
      buildId: 'b',
      database: itemsReadThrough(store),
      programs: [SHARED],
      routes: [
        {
          blocking: true,
          middleware: [],
          page: 'items/page.tsx',
          params: [],
          props: {},
          root: SHARED.component,
          route: '/items',
          shared: true,
        },
      ],
    });
    onTestFinished(async () => {
      await engine.close();
    });

    await engine.renderShared(null, { build: 'b', props: {}, route: '/items' });

    expect((await engine.stats()).follow.reads).toStrictEqual({ items: { keyed: 0, whole: 1 } });
  });

  it('says a stream woke for a row it named, and slept through one it did not', async () => {
    const rendered = await rendering('one');

    await rendered.setup.pg.query("UPDATE tasks SET title = 'x' WHERE id = 't2'");
    await rendered.engine.poke();

    expect((await followed(rendered)).again).toBeUndefined();

    await rendered.setup.pg.query("UPDATE tasks SET title = 'y' WHERE id = 't1'");
    await rendered.engine.poke();

    expect((await followed(rendered)).again).toStrictEqual({ tasks: { row: 1 } });
  });

  it('says a stream woke because it read a table whole', async () => {
    const rendered = await rendering('every');

    await rendered.setup.pg.query("UPDATE tasks SET title = 'x' WHERE id = 't2'");
    await rendered.engine.poke();

    expect((await followed(rendered)).again).toStrictEqual({ tasks: { whole: 1 } });
  });

  it('says a stream woke because the log told of the table alone', async () => {
    const rendered = await rendering('one');

    await rendered.setup.pg.query('TRUNCATE tasks');
    await rendered.engine.poke();

    expect((await followed(rendered)).again).toStrictEqual({ tasks: { table: 1 } });
  });
});

describe('why a commit changed what was read', () => {
  const row = { table: 'tasks', id: 't1', before: { k: 'a' }, after: { k: 'a' } };

  it('names a row a query named before one it reads of a table whole', () => {
    const dependencies = new Dependencies();
    dependencies.query('tasks', {});
    dependencies.query('tasks', { k: 'a' });

    expect(dependencies.causeOf([row])).toStrictEqual({ table: 'tasks', cause: 'row' });
  });

  it('names a row a query named, though another row of the commit tells not which', () => {
    const dependencies = new Dependencies();
    dependencies.query('tasks', { k: 'a' });
    const unknown = {
      table: 'tasks',
      id: '',
      before: null,
      after: null,
      unknown: 'table',
    } as const;

    expect(dependencies.causeOf([unknown, row])).toStrictEqual({ table: 'tasks', cause: 'row' });
  });

  it('names a record read by its id', () => {
    const dependencies = new Dependencies();
    dependencies.record('tasks', 't1');

    expect(dependencies.causeOf([row])).toStrictEqual({ table: 'tasks', cause: 'record' });
  });

  it('names a read of a table, of a row that tells not which record', () => {
    const dependencies = new Dependencies();
    dependencies.record('tasks', 't1');
    const unknown = {
      table: 'tasks',
      id: '',
      before: null,
      after: null,
      unknown: 'table',
    } as const;

    expect(dependencies.causeOf([unknown])).toStrictEqual({ table: 'tasks', cause: 'table' });
  });

  it('names nothing of a commit that changed nothing read', () => {
    const dependencies = new Dependencies();
    dependencies.query('tasks', { k: 'b' });

    expect(dependencies.causeOf([row])).toBeUndefined();
  });

  it('agrees with `changedBy`', () => {
    const dependencies = new Dependencies();
    dependencies.query('tasks', { k: 'a' });

    expect(dependencies.causeOf([row]) !== undefined).toBe(dependencies.changedBy([row]));
  });
});

describe('the report of what the authority counts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, '', 'off', '1', 'ON', true])('is not asked for by %s', (setting) => {
    expect(diagnosticsEveryOf(setting)).toBeUndefined();
  });

  it('is asked for by `on`, a minute apart', () => {
    expect(diagnosticsEveryOf('on')).toBe(60_000);
  });

  it('says nothing unless it was asked to', () => {
    const { diagnostics, info, pass } = reporting(undefined);

    pass(1_000_000);
    diagnostics.read([{ table: 'tasks', where: {} }]);
    diagnostics.report();

    expect(info).not.toHaveBeenCalled();
    expect(diagnostics.stats.reads).toStrictEqual({ tasks: { keyed: 0, whole: 1 } });
  });

  it('reports at most once an interval, and not of an interval of nothing', () => {
    const { diagnostics, info, pass } = reporting(60_000);

    diagnostics.report();

    expect(info).not.toHaveBeenCalled();

    diagnostics.read([{ table: 'tasks', where: { k_id: 'secret-value' } }]);
    diagnostics.report();
    diagnostics.read([{ table: 'tasks', where: { k_id: 'secret-value' } }]);
    diagnostics.report();

    expect(info).toHaveBeenCalledTimes(1);

    pass(60_000);
    diagnostics.report();

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.lastCall?.[0]).toContain('"keyed":2');

    pass(60_000);
    diagnostics.report();

    expect(info).toHaveBeenCalledTimes(2);
  });

  it('holds tables and counts, and no value a read named', () => {
    const { diagnostics, info } = reporting(60_000);

    diagnostics.read([{ table: 'tasks', where: { k_email: 'someone@example.test' } }]);
    diagnostics.report();

    expect(info.mock.lastCall?.[0]).not.toContain('example.test');
    expect(info.mock.lastCall?.[0]).not.toContain('k_email');
  });

  it('leaves no report in the way of the call it follows', () => {
    const { diagnostics, info } = reporting(60_000);
    info.mockImplementation(() => {
      throw new Error('no console');
    });

    diagnostics.read([{ table: 'tasks', where: {} }]);

    expect(() => {
      diagnostics.report();
    }).not.toThrow();
  });

  it('hands out what it counted so far, which a later count leaves as it was', () => {
    const { diagnostics } = reporting(undefined);
    diagnostics.read([{ table: 'tasks', where: {} }]);
    const { reads } = diagnostics.stats;

    diagnostics.read([{ table: 'tasks', where: {} }]);

    expect(reads).toStrictEqual({ tasks: { keyed: 0, whole: 1 } });
  });

  describe('a render', () => {
    let render: Awaited<ReturnType<typeof engineOf>>['render'];
    let info: ReturnType<typeof reporting>['info'];

    // Database startup and capture installation have their own setup lifecycle.
    beforeEach(async () => {
      info = vi.spyOn(console, 'info').mockImplementation(() => {
        // Asserted below, kept out of the output.
      });
      const setup = await openedWith(schema, DDL);
      ({ render } = await engineOf(
        setup,
        async (_props, $) => {
          await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'));
          await setup.orm.select().from(tasks);
          return $.h('p', null, 'read');
        },
        {},
        { diagnosticsEveryMs: 60_000 },
      ));
    });

    it('writes no report in a render, of a read by rows its next statement reads whole', async () => {
      await render();

      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.lastCall?.[0]).toContain('"keyed":1,"whole":1');
    });
  });
});
