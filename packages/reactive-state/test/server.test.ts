import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import {
  type ComponentProgram,
  type Json,
  type OperationModule,
  type OperationReceipt,
  PROTOCOL_VERSION,
  REFERENCE,
  type RenderScope,
} from '../src/program.ts';
import {
  type AnyDatabase,
  boolean,
  database,
  forbidden,
  integer,
  MAX_TEXT_LENGTH,
  requireUser,
  table,
  text,
} from '../src/server/index.ts';
import { checkValue, definitionOf } from '../src/server/schema.ts';
import { db } from './support/app/db.ts';
import { deferred } from './support/frames.ts';
import { application, BUILD } from './support/program.ts';

/** A module of server operations the test gives the authority, under `test/db`. */
async function opened(
  operations: OperationModule,
  programs: readonly ComponentProgram[] = application.programs,
): Promise<{ readonly engine: Engine; readonly session: string }> {
  const engine = new Engine({ ...application, operations: { 'test/db': operations }, programs });
  onTestFinished(async () => {
    await engine.close();
  });
  const { sessionId } = await engine.login('alice');
  return { engine, session: sessionId };
}

/** Runs the operation `name` of `test/db` with `args`, under a fresh operation id. */
async function run(
  engine: Engine,
  session: string,
  name: string,
  ...args: readonly Json[]
): Promise<OperationReceipt> {
  return engine.operate(session, {
    args: args.map((json) => ({ json })),
    build: BUILD,
    module: 'test/db',
    name,
    operationId: crypto.randomUUID(),
  });
}

/** A database of one project, `p1`, which Alice owns and which is titled `title`. */
function owned(title: string): AnyDatabase {
  return database(
    { projects: table({ ownerId: text(), title: text() }) },
    { seed: { projects: { p1: { ownerId: 'alice', title } } } },
  );
}

function program(
  component: string,
  evaluate: (props: Readonly<Record<string, Json>>, $: RenderScope) => unknown,
): ComponentProgram {
  return {
    buildId: BUILD,
    component,
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
}

describe('what an application reads inside the authority', () => {
  it('refuses a read, a write and the session’s user outside the authority', async () => {
    await expect(db.todos.get('t1')).rejects.toThrow('db.todos.get is read in the authority alone');
    await expect(db.todos.findMany({ where: {} })).rejects.toThrow('authority alone');
    await expect(db.transaction(() => Promise.resolve(1))).rejects.toThrow(
      'db.transaction is read',
    );
    await expect(requireUser()).rejects.toThrow('requireUser is read in the authority alone');
  });

  it('refuses a read a callback makes after the evaluation that started it settled', async () => {
    const late = deferred<Promise<readonly PromiseSettledResult<unknown>[]>>();
    const leaving = program('test/leaving', async (_, $) => {
      await requireUser();
      // A timer the component leaves behind runs in its evaluation's context, after it is over.
      setTimeout(() => {
        late.resolve(Promise.allSettled([db.todos.get('t1'), requireUser()]));
      }, 10);
      return $.h('p', null, 'left');
    });
    const { engine, session } = await opened({}, [...application.programs, leaving]);

    await engine.render(session, { build: BUILD, component: 'test/leaving', props: {} });
    const [read, user] = await late.promise;

    expect(read).toMatchObject({
      reason: { message: expect.stringContaining('db.todos.get was read after the evaluation') },
      status: 'rejected',
    });
    expect(user).toMatchObject({ status: 'rejected' });
  });

  it('answers the reads of two engines’ components, each waiting on a timer, from their own records', async () => {
    const seen: string[] = [];
    const waiting = (waitMs: number): ComponentProgram => {
      return program('test/waiting', async (_, $) => {
        await sleep(waitMs);
        const user = await requireUser();
        const project = await db.projects.get('p1');
        seen.push(`${user.id}: ${project?.title ?? 'none'}`);
        return $.h('p', null, project?.title ?? 'none');
      });
    };
    const first = new Engine({ buildId: BUILD, database: owned('first'), programs: [waiting(30)] });
    const second = new Engine({
      buildId: BUILD,
      database: owned('second'),
      programs: [waiting(5)],
    });
    onTestFinished(async () => {
      await Promise.all([first.close(), second.close()]);
    });
    const root = { build: BUILD, component: 'test/waiting', props: {} };
    const alice = await first.login('alice');
    const bob = await second.login('bob');

    await Promise.all([first.render(alice.sessionId, root), second.render(bob.sessionId, root)]);

    expect(seen).toStrictEqual(['bob: second', 'alice: first']);
  });

  it('answers a component that does not settle in time as a fault, refuses what it reads then, and serves the next request', async () => {
    const late = deferred<PromiseSettledResult<unknown>>();
    const hanging = program('test/hanging', async () => {
      await sleep(80);
      late.resolve((await Promise.allSettled([db.todos.get('t1')]))[0]);
      return null;
    });
    const engine = new Engine({ ...application, programs: [hanging], timeoutMs: 20 });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');

    await expect(
      engine.render(sessionId, { build: BUILD, component: 'test/hanging', props: {} }),
    ).rejects.toThrow('did not settle within 20 ms');
    await expect(engine.login('bob')).resolves.toMatchObject({ userId: 'bob' });
    await expect(late.promise).resolves.toMatchObject({ status: 'rejected' });
  });

  it('answers as a fault a read the application caught, whatever it did after, and keeps nothing of it', async () => {
    let faulty = true;
    const catching = program('test/catching', async (_, $) => {
      let said = 'read';
      try {
        await db.todos.count({ where: faulty ? { completed: 'yes' } : {} } as never);
      } catch {
        // The application swallows what it was answered.
        said = 'caught';
      }
      return $.h('p', null, said);
    });
    const { engine, session } = await opened({}, [catching]);
    const root = { build: BUILD, component: 'test/catching', props: {} };

    await expect(engine.render(session, root)).rejects.toBeInstanceOf(TypeError);

    faulty = false;

    // What the component rendered once it caught the fault is no rendering the memo may keep.
    await expect(engine.render(session, root)).resolves.toMatchObject({
      tree: { children: [{ children: ['read'] }] },
    });
  });

  it('refuses, as the authority’s own refusal, what `forbidden()` refuses', () => {
    expect(() => forbidden('Not yours.')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', message: 'Not yours.', status: 403 }),
    );
  });
});

describe('the database a server operation reads and writes', () => {
  const reads: OperationModule = {
    get: async (id: Json) => db.todos.get(id as string),
    find: async (query: Json) => db.todos.findMany(query as never),
    count: async (query: Json) => db.todos.count(query as never),
  };

  it('reads a record as its id beside its fields, and an id no record could have as none', async () => {
    const { engine, session } = await opened(reads);

    await expect(run(engine, session, 'get', 't1')).resolves.toMatchObject({
      result: { completed: false, estimate: 2, id: 't1', projectId: 'p1', title: '一覧を作る' },
    });
    await expect(run(engine, session, 'get', 'missing')).resolves.toMatchObject({ result: null });
    await expect(run(engine, session, 'get', 'a/b')).resolves.toMatchObject({ result: null });
  });

  it('finds what `where` names, in the order asked for, ties broken by id, selecting what is asked', async () => {
    const { engine, session } = await opened(reads);

    const byCompleted = await run(engine, session, 'find', {
      orderBy: [{ completed: 'desc' }],
      select: { id: true },
      where: {},
    });
    const byEstimate = await run(engine, session, 'find', {
      orderBy: [{ estimate: 'desc' }],
      select: { estimate: true, id: true },
      where: { projectId: 'p1' },
    });
    const counted = await run(engine, session, 'count', {
      where: { completed: false, projectId: 'p1' },
    });

    expect(byCompleted.result).toStrictEqual([{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
    expect(byEstimate.result).toStrictEqual([
      { estimate: 3, id: 't2' },
      { estimate: 2, id: 't1' },
    ]);
    expect(counted.result).toBe(2);
  });

  it('finds nothing for a value no record could hold, and faults on a field or a type the table does not have', async () => {
    const { engine, session } = await opened(reads);

    await expect(run(engine, session, 'find', { where: { id: 'a.b' } })).resolves.toMatchObject({
      result: [],
    });
    await expect(
      run(engine, session, 'count', { where: { projectId: 'x'.repeat(65) } }),
    ).resolves.toMatchObject({ result: 0 });
    await expect(run(engine, session, 'find', { where: { owner: 'x' } })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      run(engine, session, 'find', { where: { completed: 'yes' } }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      run(engine, session, 'find', { orderBy: [{ id: 'asc', title: 'asc' }], where: {} }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('keeps nothing of an operation that faulted, which may be sent again', async () => {
    const { engine, session } = await opened(reads);

    await expect(
      run(engine, session, 'count', { where: { completed: 'yes' } }),
    ).rejects.toBeInstanceOf(TypeError);

    expect((await engine.stats()).operations).toBe(0);
  });

  it('makes a record with an id of the authority’s, each field it leaves out holding its default', async () => {
    const { engine, session } = await opened({
      make: async () =>
        db.transaction(async () => db.todos.insert({ projectId: 'p1', title: 'あとで' })),
    });

    const { result } = await run(engine, session, 'make');

    expect(result).toMatchObject({
      completed: false,
      estimate: 0,
      projectId: 'p1',
      title: 'あとで',
    });
    expect((result as { readonly id: string }).id).toMatch(/^[\w-]{16}$/u);
  });

  it('gives a field it leaves out its default, though the field is named as an object’s method is', async () => {
    const named = database({ notes: table({ text: text(), valueOf: integer() }) });
    const engine = new Engine({
      buildId: BUILD,
      database: named,
      operations: {
        'test/db': {
          make: async () => {
            return named.transaction(async () => {
              // As JavaScript sends it: no `valueOf` of its own, which a type takes for the method.
              const fields = JSON.parse('{"text":"x"}') as {
                readonly text: string;
                readonly valueOf?: number;
              };
              return named.notes.insert(fields);
            });
          },
        },
      },
      programs: [],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');

    const { result } = await run(engine, sessionId, 'make');

    expect(result).toMatchObject({ text: 'x', valueOf: 0 });
  });

  it('refuses a change or a deletion of a record there is not, and makes none', async () => {
    const { engine, session } = await opened({
      remove: async () => db.transaction(async () => db.todos.delete('missing')),
      retitle: async () => db.transaction(async () => db.todos.update('missing', { title: 'x' })),
    });

    await expect(run(engine, session, 'retitle')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(run(engine, session, 'remove')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect((await engine.stats()).commits).toBe(0);
  });

  it('refuses a record that holds what another holds of a `unique` group (409)', async () => {
    const { engine, session } = await opened({
      join: async () => {
        return db.transaction(async () =>
          db.memberships.insert({ canEdit: false, projectId: 'p1', userId: 'bob' }),
        );
      },
      rejoin: async () => {
        return db.transaction(async () => {
          await db.memberships.delete('p1-bob');
          return db.memberships.insert({ canEdit: false, projectId: 'p1', userId: 'bob' });
        });
      },
    });

    await expect(run(engine, session, 'join')).rejects.toMatchObject({
      code: 'UNIQUE_VIOLATION',
      status: 409,
    });
    // The record it would have held the same as is gone in the same transaction.
    await expect(run(engine, session, 'rejoin')).resolves.toMatchObject({ committedRevision: 1 });
  });

  it('refuses a write that names `id`, a field the table does not declare, or one outside its transaction', async () => {
    const { engine, session } = await opened({
      outside: async () => db.todos.update('t1', { title: 'x' }),
      renamed: async () => db.transaction(async () => db.todos.update('t1', { id: 't9' } as never)),
      twice: async () => {
        await db.transaction(async () => db.todos.update('t1', { title: 'x' }));
        await db.transaction(async () => db.todos.update('t1', { title: 'y' }));
      },
      undeclared: async () => db.transaction(async () => db.todos.insert({ owner: 'x' } as never)),
    });

    await expect(run(engine, session, 'renamed')).rejects.toBeInstanceOf(TypeError);
    await expect(run(engine, session, 'undeclared')).rejects.toBeInstanceOf(TypeError);
    await expect(run(engine, session, 'outside')).rejects.toThrow('in its transaction');
    await expect(run(engine, session, 'twice')).rejects.toThrow('one transaction');
  });

  it('reads its own writes in its transaction, through every read', async () => {
    const { engine, session } = await opened({
      mixed: async () => {
        return db.transaction(async () => {
          const made = await db.todos.insert({ projectId: 'p1', title: 'あとで' });
          await db.todos.update('t1', { completed: true });
          await db.todos.delete('t2');
          return {
            done: await db.todos.count({ where: { completed: true, projectId: 'p1' } }),
            gone: await db.todos.get('t2'),
            listed: (
              await db.todos.findMany({ select: { title: true }, where: { projectId: 'p1' } })
            ).map((todo) => todo.title),
            made: (await db.todos.get(made.id))?.title ?? null,
          };
        });
      },
    });

    const { result } = await run(engine, session, 'mixed');

    expect(result).toStrictEqual({
      done: 1,
      gone: null,
      listed: expect.arrayContaining(['一覧を作る', 'あとで']),
      made: 'あとで',
    });
  });

  it('lets go of every write of a transaction that throws, and rejects the operation', async () => {
    const { engine, session } = await opened({
      get: async () => db.todos.get('t1'),
      halfway: async () => {
        return db.transaction(async () => {
          await db.todos.update('t1', { completed: true });
          await db.todos.update('t2', { estimate: -1 });
        });
      },
      thrown: async () => {
        return db.transaction(async () => {
          await db.todos.update('t1', { completed: true });
          throw new Error('changed my mind');
        });
      },
    });

    await expect(run(engine, session, 'halfway')).rejects.toMatchObject({
      code: 'INVALID_VALUE',
      status: 422,
    });
    await expect(run(engine, session, 'thrown')).rejects.toMatchObject({
      code: 'OPERATION_REJECTED',
      message: 'changed my mind',
      status: 422,
    });
    await expect(run(engine, session, 'get')).resolves.toMatchObject({
      result: { completed: false },
    });
    expect((await engine.stats()).commits).toBe(0);
  });

  it('runs a component’s writes nowhere: a render that writes is a fault', async () => {
    const writing = program('test/writing', async () => {
      await db.todos.update('t1', { title: 'x' });
      return null;
    });
    const { engine, session } = await opened({}, [writing]);

    await expect(
      engine.render(session, { build: BUILD, component: 'test/writing', props: {} }),
    ).rejects.toThrow('writes nothing as it renders');
  });
});

describe('a database’s declaration', () => {
  it.each([
    ['a field named `id`', () => table({ id: text() })],
    ['a field whose name is no name', () => table({ 'a-b': text() })],
    [
      'a public field the table does not have',
      () => table({ a: text() }, { public: ['b' as 'a'] }),
    ],
    [
      'a unique group of a field the table does not have',
      () => table({ a: text() }, { unique: [['b' as 'a']] }),
    ],
    ['an empty unique group', () => table({ a: text() }, { unique: [[]] })],
    ['a unique group naming a field twice', () => table({ a: text() }, { unique: [['a', 'a']] })],
    [
      'a table named as the authority’s sessions',
      () => database({ session: table({ a: text() }) }),
    ],
    [
      'a table named as the database’s transaction',
      () => database({ transaction: table({ a: text() }) }),
    ],
    ['a table whose name is no name', () => database({ '1st': table({ a: text() }) })],
    ['text longer than any field holds', () => text({ maxLength: MAX_TEXT_LENGTH + 1 })],
    ['a default longer than the field', () => text({ default: 'abc', maxLength: 2 })],
    ['a minimum above the maximum', () => integer({ max: 1, min: 2 })],
    ['a default out of range', () => integer({ default: 5, max: 4 })],
    ['a boolean default that is no boolean', () => boolean({ default: 'yes' as never })],
    [
      'a field of a type the authority does not know',
      () => table({ due: { default: 0, type: 'date' } as never }),
    ],
  ])('refuses %s', (_, declare) => {
    expect(declare).toThrow(TypeError);
  });

  it.each([
    ['a table it does not declare', { notes: { a: {} } }],
    ['a field the table does not have', { todos: { 't-1': { done: true } } }],
    ['a value the field may not hold', { todos: { 't-1': { completed: 'yes' } } }],
    ['a record id that is no id', { todos: { 'a/b': {} } }],
    [
      'two records holding the same of a unique group',
      { todos: { a: { title: 'x' }, b: { title: 'x' } } },
    ],
  ])('refuses a seed with %s', (_, seed) => {
    const declare = (): AnyDatabase => {
      return database(
        {
          todos: table(
            { title: text({ maxLength: 3 }), completed: boolean() },
            { unique: [['title']] },
          ),
        },
        { seed: seed as never },
      );
    };

    expect(declare).toThrow(TypeError);
  });

  it('keeps a table as it was declared, whatever becomes of the objects it was declared with', () => {
    const fields = { title: text({ maxLength: 10 }) };
    const unique = [['title' as const]];
    const todos = table(fields, { public: ['title'], unique });
    const declared = definitionOf(database({ todos }));

    fields.title = text({ default: 'x', maxLength: 1 });
    unique.push(['title']);

    expect(todos.fields.title).toMatchObject({ default: '', maxLength: 10 });
    expect(declared.tables.get('todos')).toMatchObject({ public: ['title'], unique: [['title']] });
    expect(() => {
      (todos.fields as Record<string, unknown>)['title'] = text();
    }).toThrow(TypeError);
  });

  it('keeps each seed record whole, a field left out holding its default', () => {
    const declaration = database(
      {
        todos: table({
          title: text({ default: 'untitled' }),
          completed: boolean(),
          rank: integer(),
        }),
      },
      { seed: { todos: { 't-1': { completed: true } } } },
    );

    expect(definitionOf(declaration).seed).toStrictEqual([
      { id: 't-1', table: 'todos', values: { completed: true, rank: 0, title: 'untitled' } },
    ]);
  });

  it('refuses, as the authority’s database, anything `database()` did not declare', () => {
    expect(() => definitionOf({} as never)).toThrow(TypeError);
  });

  it('refuses a reference to a record whose id is no id, though it reads one as none', () => {
    expect(() => db.todos.ref('a/b')).toThrow(TypeError);
    // Marked as a reference, which JSON shaped as one is not.
    expect(db.todos.ref('t1').title).toStrictEqual({
      [REFERENCE]: true,
      field: 'title',
      id: 't1',
      kind: 'field',
      table: 'todos',
    });
  });
});

describe('what a field may hold', () => {
  const title = text({ maxLength: 5 });
  const done = boolean();
  const rank = integer({ max: 10, min: -10 });

  it.each([
    ['text within the length', title, 'abcde'],
    ['empty text', title, ''],
    ['false', done, false],
    ['an integer at the bottom of the range', rank, -10],
  ])('takes %s', (_, field, value) => {
    expect(checkValue(field, value)).toBeUndefined();
  });

  it.each([
    ['a number for text', title, 5, 'The value is not text.'],
    ['text longer than the field', title, 'abcdef', 'The text is longer than 5.'],
    ['a lone surrogate', title, '\u{D800}', 'The text is not well formed.'],
    ['a number for a boolean', done, 1, 'The value is not a boolean.'],
    ['a fraction', rank, 1.5, 'The value is not an integer.'],
    ['an integer out of range', rank, 11, 'The value is not between -10 and 10.'],
  ])('refuses %s', (_, field, value, why) => {
    expect(checkValue(field, value)).toBe(why);
  });
});
