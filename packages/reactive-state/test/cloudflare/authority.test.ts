import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AuthorityEngine } from '../../src/authority/engine.ts';
import { authorityObject } from '../../src/cloudflare/index.ts';
import { durableObjectSql, StorageFaultError } from '../../src/cloudflare/sql.ts';
import { EventStreams } from '../../src/cloudflare/stream.ts';
import {
  type ComponentProgram,
  type Json,
  PROTOCOL_VERSION,
  type RenderResult,
  type RenderScope,
  type RootRequest,
} from '../../src/program.ts';
import { requireUser } from '../../src/server/index.ts';
import { db } from '../support/app/db.ts';
import { clientOf, clientsIn, textOf } from '../support/frames.ts';
import {
  ADD_ESTIMATE,
  application,
  BUILD,
  counterProgram,
  operations,
  programs,
  SET_CAN_EDIT,
  SET_COUNT,
  SET_TITLE,
} from '../support/program.ts';
import { SCHEMA_3_CREATED, SCHEMA_3_DATABASE } from '../support/schema-3.ts';
import {
  authority,
  type AuthorityStub,
  bindingOf,
  COUNTER,
  countWith,
  EDITOR,
  form,
  inObject,
  json,
  operate,
  PROJECT,
  retitle,
  signedIn,
  signIn,
  subscribe,
  valueOf,
  write,
} from './helpers.ts';

/** Waits `ms` on a timer, as code that waits on I/O before it reads does. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What `promise` was rejected with; a test fails when it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not rejected.');
}

/** A program of the test build with no state, for a suite that runs a component of its own. */
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

/** The root of a component of the test build that takes no props. */
function rootOf(component: string): RootRequest {
  return { build: BUILD, component, props: {} };
}

/** The ids of the todos a project's page lists, in its order. */
function listed(rendered: RenderResult): readonly (string | null)[] {
  return clientsIn(rendered.tree, 'components/todo-row').map((row) => row.key);
}

/** The ids of the records of `table` the object's SQLite holds. */
async function recordsOf(stub: AuthorityStub, table: string): Promise<readonly string[]> {
  return runInDurableObject(stub, (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ id: string }>('SELECT id FROM records WHERE tbl = ? ORDER BY id', table)
      .toArray();
    return rows.map((row) => row.id);
  });
}

/** The changes the object's log holds: each one's revision, and the resources it changed. */
async function loggedChanges(stub: AuthorityStub): Promise<readonly (readonly unknown[])[]> {
  return runInDurableObject(stub, (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ revision: number; changed: string }>(
        'SELECT revision, changed FROM changes ORDER BY revision',
      )
      .toArray();
    return rows.map((row) => [row.revision, JSON.parse(row.changed) as unknown]);
  });
}

describe('the authority as a Durable Object', () => {
  it('signs a user in, and renders a page’s root and every component its tree renders, with the frame it is shown at', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    const rendered = valueOf(await stub.render(alice, PROJECT));

    expect(rendered.status).toBe('rendered');
    expect(textOf(rendered.tree)).toContain('確定した集計: 未完了 2 件 / 完了 0 件');
    expect(listed(rendered)).toStrictEqual(['t1', 't2']);
    expect(clientOf(rendered.tree, EDITOR).part.states).toMatchObject({
      draft: { value: '' },
      title: { binding: expect.any(String), field: 'todos:t1:title', set: SET_TITLE },
    });
    expect(rendered.frame).toMatchObject({
      buildId: BUILD,
      fields: {
        'memberships:p1-bob:canEdit': true,
        'todos:t1:estimate': 2,
        'todos:t1:title': '一覧を作る',
      },
      operations: [],
      revision: 0,
    });
    expect(rendered.frame.subscription).not.toBe('');
  });

  it('renders the root a subscription names again for a page’s view, and answers a view no part reads with its refusal', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const first = valueOf(
      await stub.render(alice, {
        build: BUILD,
        component: 'components/workspace-project',
        props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
      }),
    );
    const [instance = ''] = Object.keys(first.frame.view);

    const viewed = valueOf(
      await stub.view(alice, {
        subscription: first.frame.subscription,
        view: {
          [instance]: { d0: { filter: 'done' }, d1: { selectedId: 't2', showDetails: true } },
        },
      }),
    );
    const refused = await stub.view(alice, {
      subscription: first.frame.subscription,
      view: { [instance]: { d0: { filter: 1 } } },
    });

    expect(first.frame.view).toStrictEqual({
      [instance]: { d0: { filter: 'all' }, d1: { selectedId: 't1', showDetails: true } },
    });
    expect(viewed.frame.view).toStrictEqual({
      [instance]: { d0: { filter: 'done' }, d1: { selectedId: 't2', showDetails: true } },
    });
    expect(clientOf(viewed.tree, EDITOR).key).toBe('t2');
    expect(refused).toMatchObject({ code: 'INVALID_VIEW', ok: false, status: 400 });
  });

  it('answers a root the session may not see with its status and no tree, and one without a session with nothing to follow', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    const signedOut = valueOf(await stub.render(null, PROJECT));
    const refused = valueOf(
      await stub.render(alice, { ...PROJECT, props: { filter: 'all', projectId: 'p3' } }),
    );

    expect(signedOut).toMatchObject({
      frame: { fields: {}, operations: [], subscription: '' },
      status: 'unauthenticated',
      tree: null,
    });
    // A root refused is followed all the same: access may come back.
    expect(refused).toMatchObject({ frame: { fields: {} }, status: 'forbidden', tree: null });
    expect(refused.frame.subscription).not.toBe('');
  });

  it('commits a `set` and an `apply`, and answers a resent write with its first receipt', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const rendered = valueOf(await stub.render(alice, PROJECT));
    const estimate = {
      binding: bindingOf(rendered, EDITOR, 'useEstimate#0.estimate'),
      captures: { step: 5 },
      operationId: 'op-estimate',
      updaterId: ADD_ESTIMATE,
    };

    const set = valueOf(
      await stub.update(alice, {
        binding: bindingOf(rendered, EDITOR, 'title'),
        operationId: 'op-title',
        updaterId: SET_TITLE,
        value: '一覧を直す',
      }),
    );
    const applied = valueOf(await stub.update(alice, estimate));
    const resent = valueOf(await stub.update(alice, estimate));
    const after = valueOf(await stub.render(alice, PROJECT));

    expect(set).toStrictEqual({
      committedRevision: 1,
      deduplicated: false,
      operationId: 'op-title',
    });
    expect(applied).toStrictEqual({
      committedRevision: 2,
      deduplicated: false,
      operationId: 'op-estimate',
    });
    expect(resent).toStrictEqual({ ...applied, deduplicated: true });
    // `addEstimate(2, 5)`, once.
    expect(after.frame).toMatchObject({
      fields: { 'todos:t1:estimate': 7, 'todos:t1:title': '一覧を直す' },
      operations: ['op-estimate', 'op-title'],
      revision: 2,
    });
    await expect(stub.stats()).resolves.toMatchObject({
      commits: 2,
      deduplicated: 1,
      revision: 2,
      updaterRuns: 2,
    });
  });

  it('refuses a write to a record there is not, and makes none', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    // The counter, rendered for an id no record has: its state binds a field of no record.
    const ghost = valueOf(await stub.render(alice, { ...COUNTER, props: { id: 'ghost' } }));

    const refused = await stub.update(alice, {
      binding: bindingOf(ghost, COUNTER.component, 'count'),
      operationId: 'op-ghost',
      updaterId: SET_COUNT,
      value: 5,
    });

    expect(ghost.frame.fields).toStrictEqual({ 'counters:ghost:count': 0 });
    expect(refused).toStrictEqual({
      code: 'NOT_FOUND',
      message: 'There is no such record.',
      ok: false,
      status: 404,
    });
    await expect(recordsOf(stub, 'counters')).resolves.toStrictEqual(['main', 'other']);
    await expect(stub.stats()).resolves.toMatchObject({ commits: 0, revision: 0 });
  });

  it('runs a server operation, whose one transaction lands in one transaction of the object’s storage', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const transactions = await runInDurableObject(stub, (_instance, state) =>
      vi.spyOn(state.storage, 'transactionSync'),
    );
    onTestFinished(() => {
      transactions.mockRestore();
    });

    const receipt = valueOf(
      await operate(stub, alice, {
        args: [json('p1')],
        name: 'completeProject',
        operationId: 'op-complete',
      }),
    );
    const committed = transactions.mock.calls.length;
    const after = valueOf(await stub.render(alice, PROJECT));

    expect(receipt).toStrictEqual({
      committedRevision: 1,
      deduplicated: false,
      operationId: 'op-complete',
      result: null,
    });
    // Both todos the operation wrote, with its own record and the change, in one of the storage's
    // transactions: none before its transaction was over.
    expect(committed).toBe(1);
    await expect(loggedChanges(stub)).resolves.toStrictEqual([[1, ['todos:t1', 'todos:t2']]]);
    expect(textOf(after.tree)).toContain('未完了 0 件 / 完了 2 件');
  });

  it('runs a resent operation once, answering its first receipt, and refuses its id for another', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const call = {
      args: [json('p1'), form({ title: 'あとで' })],
      name: 'createTodo',
      operationId: 'op-create',
    };

    const first = valueOf(await operate(stub, alice, call));
    const again = valueOf(await operate(stub, alice, call));
    const other = await operate(stub, alice, {
      ...call,
      args: [json('p1'), form({ title: '別' })],
    });
    const after = valueOf(await stub.render(alice, PROJECT));

    expect(first).toMatchObject({ committedRevision: 1, deduplicated: false, result: null });
    expect(again).toStrictEqual({ ...first, deduplicated: true });
    expect(other).toMatchObject({ code: 'OPERATION_REUSED', ok: false, status: 409 });
    expect(listed(after)).toHaveLength(3);
    await expect(stub.stats()).resolves.toMatchObject({
      commits: 1,
      deduplicated: 1,
      operationRuns: 1,
    });
  });

  it('refuses an operation its own checks reject, with their message, and commits nothing of it', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const call = {
      args: [json('p1'), form({ title: '  ' })],
      name: 'createTodo',
      operationId: 'op-empty',
    };

    const first = await operate(stub, alice, call);
    const again = await operate(stub, alice, call);
    const after = valueOf(await stub.render(alice, PROJECT));

    expect(first).toStrictEqual({
      code: 'OPERATION_REJECTED',
      message: 'title must contain 1..200 characters',
      ok: false,
      status: 422,
    });
    // Kept as the operation's answer: a resend is refused alike, and runs nothing again.
    expect(again).toStrictEqual(first);
    expect(after.frame.revision).toBe(0);
    expect(listed(after)).toStrictEqual(['t1', 't2']);
    await expect(stub.stats()).resolves.toMatchObject({
      commits: 0,
      deduplicated: 1,
      operationRuns: 1,
    });
  });

  it('keeps nothing an operation wrote in its transaction before it threw', async () => {
    const kept = await runInDurableObject(authority(), async (_instance, state) => {
      const regrets = {
        createAndThrow: async (): Promise<void> => {
          await db.transaction(async () => {
            await db.todos.insert({ completed: false, estimate: 0, projectId: 'p1', title: '幻' });
            throw new Error('changed its mind');
          });
        },
      };
      const engine = new AuthorityEngine({
        ...application,
        operations: { ...operations, 'test/regrets': regrets },
        sql: durableObjectSql(state.storage),
      });
      const { sessionId } = await engine.login('alice');
      const refused = await rejection(
        engine.operate(sessionId, {
          args: [],
          build: BUILD,
          module: 'test/regrets',
          name: 'createAndThrow',
          operationId: 'op-regret',
        }),
      );
      const [todos] = state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM records WHERE tbl = 'todos'")
        .toArray();
      return { refused, revision: engine.revision(), todos: todos?.n };
    });

    expect(kept.refused).toMatchObject({
      code: 'OPERATION_REJECTED',
      message: 'changed its mind',
      status: 422,
    });
    expect(kept).toMatchObject({ revision: 0, todos: 3 });
  });

  it('answers each refusal of a render as a failed result that keeps its status and code', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    await expect(stub.login('mallory')).resolves.toMatchObject({
      code: 'INVALID_USER',
      ok: false,
      status: 400,
    });
    await expect(
      stub.render(alice, { ...PROJECT, component: 'components/missing' }),
    ).resolves.toStrictEqual({
      code: 'UNKNOWN_COMPONENT',
      message: 'There is no such component.',
      ok: false,
      status: 404,
    });
    await expect(stub.render(alice, { ...PROJECT, build: 'b_other' })).resolves.toMatchObject({
      code: 'BUILD_MISMATCH',
      status: 409,
    });
    // A root that names no build: what the authority runs of it could be of any.
    await expect(
      stub.render(alice, { component: PROJECT.component, props: PROJECT.props } as RootRequest),
    ).resolves.toMatchObject({ code: 'INVALID_ROOT', status: 400 });
    // The todos have no public field, for a page without a session to show.
    await expect(stub.publicView('todos', 't1')).resolves.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('answers each refusal of a write as a failed result that keeps its status and code', async () => {
    const stub = authority();
    const { alice, bob } = await signedIn(stub);
    const title = bindingOf(valueOf(await stub.render(alice, PROJECT)), EDITOR, 'title');
    const sent = { binding: title, operationId: 'op-taken', updaterId: SET_TITLE, value: '一' };
    valueOf(await stub.update(alice, sent));

    // Another session's binding, and one tampered with.
    await expect(stub.update(bob, { ...sent, operationId: 'op-bob' })).resolves.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(
      stub.update(alice, { ...sent, binding: `${title}x`, operationId: 'op-forged' }),
    ).resolves.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(stub.update(alice, { ...sent, value: '二' })).resolves.toMatchObject({
      code: 'OPERATION_REUSED',
      status: 409,
    });
    // A `set` sent with no value, as a client that dropped it on the way would send it.
    await expect(
      stub.update(alice, { binding: title, operationId: 'op-unsent', updaterId: SET_TITLE }),
    ).resolves.toMatchObject({ code: 'INVALID_OPERATION', status: 400 });
    await expect(operate(stub, alice, { args: [], name: 'missing' })).resolves.toMatchObject({
      code: 'UNKNOWN_OPERATION',
      status: 404,
    });
    await expect(
      operate(stub, alice, { args: [json('p3')], name: 'completeProject' }),
    ).resolves.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('throws a storage fault the application’s code meets as a fault, not as the session’s refusal', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    // Asked inside the object, where what it throws is caught: thrown across its RPC, it would be
    // reported as the object's own uncaught exception besides.
    await inObject(stub, async (instance, state) => {
      // No record has been read yet, so the root's first read of one is the storage's.
      state.storage.sql.exec('ALTER TABLE records RENAME TO records_gone');

      // Read as a refusal, it would render the page as one the session may not see; a fault is
      // thrown, for the caller to answer as an outcome it does not know.
      await expect(instance.render(alice, PROJECT)).rejects.toThrow(StorageFaultError);
    });
  });

  it('refuses, as the Worker loads, a program of another protocol or build, a module that is none, and a database no `database()` declared', () => {
    const given = { database: db, operations, programs };
    const otherProtocol = [...programs, { ...counterProgram, protocolVersion: 1 }];
    const otherBuild = [...programs, { ...counterProgram, buildId: 'b_other', component: 'other' }];
    const noModule = { 'actions/todos': 'todos' } as unknown as typeof operations;

    expect(() => authorityObject({ ...given, programs: otherProtocol })).toThrow(
      'was compiled for protocol 1',
    );
    expect(() => authorityObject({ ...given, programs: otherBuild })).toThrow(
      'is of build b_other',
    );
    expect(() => authorityObject({ ...given, operations: noModule })).toThrow(
      'are not a module the authority can run',
    );
    expect(() => authorityObject({ ...given, database: {} as typeof db })).toThrow(
      'The authority is given the database `database()`',
    );
  });

  it('refuses a session that signed out, and its bindings with it', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const rendered = valueOf(await stub.render(alice, PROJECT));

    await expect(stub.logout(alice)).resolves.toStrictEqual({ ok: true, value: null });

    await expect(
      stub.update(alice, {
        binding: bindingOf(rendered, EDITOR, 'title'),
        operationId: 'after',
        updaterId: SET_TITLE,
        value: 'x',
      }),
    ).resolves.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    await expect(stub.render(alice, PROJECT)).resolves.toMatchObject({
      value: { status: 'unauthenticated', tree: null },
    });
    await expect(stub.logout(alice)).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it('shows a record’s public fields to anyone, and counts what it did', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    valueOf(await write(stub, alice, { captures: { by: 2 } }));

    const view = await stub.publicView('counters', 'main');
    const stats = await stub.stats();

    // What anyone may see, and nothing of what the authority's cache made of it.
    expect(view).toStrictEqual({
      ok: true,
      value: {
        id: 'main',
        resultVersion: expect.any(String),
        revision: 1,
        table: 'counters',
        values: { count: 2 },
      },
    });
    expect(stats).toMatchObject({
      buildId: BUILD,
      commits: 1,
      operations: 1,
      renders: 1,
      revision: 1,
      streams: 0,
      updaterRuns: 1,
    });
  });
});

describe('the object’s storage, as the authority before this one left it', () => {
  it('is brought up from schema 3 as the object starts again: every record, operation and change kept, and a seed deleted under it still deleted', async () => {
    const stub = authority();
    // The object's tables those of schema 3, with their rows, as the authority before this one
    // left them; and the object started again, which opens them.
    await inObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      const tables = sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'",
        )
        .toArray();
      for (const { name } of tables) {
        sql.exec(`DROP TABLE ${name}`);
      }
      for (const statement of SCHEMA_3_DATABASE) {
        sql.exec(statement);
      }
    });
    await evictDurableObject(stub);

    const alice = await signIn(stub, 'alice');
    const rendered = valueOf(await stub.render(alice, PROJECT));
    const kept = await inObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      return {
        schema: sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'").one()
          .value,
        tables: sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name IN ('artifacts', 'ended', 'seeded', 'views') ORDER BY name",
          )
          .toArray(),
      };
    });

    expect(kept).toStrictEqual({
      schema: '5',
      tables: [{ name: 'artifacts' }, { name: 'ended' }, { name: 'seeded' }, { name: 'views' }],
    });
    // P1 as it was left, by title: the to-do it made, t1 retitled, and the seed t2 not made again.
    expect(clientsIn(rendered.tree, 'components/todo-row').map(({ key }) => key)).toStrictEqual([
      SCHEMA_3_CREATED,
      't1',
    ]);
    expect(rendered.frame.fields['todos:t1:title']).toBe('一覧を直す');
    await expect(stub.stats()).resolves.toMatchObject({ revision: 3 });
  });
});

describe('the event stream', () => {
  it('opens with a comment at once, which a client reads as no event', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const rendered = valueOf(await stub.render(alice, PROJECT));

    // The page shows what the root renders: the stream has nothing to say but that it is open.
    const stream = valueOf(await stub.events(alice, rendered.frame.subscription));
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    const { value } = await reader.read();
    await reader.cancel();

    expect(value).toBe(': open\n\n');
  });

  it('says at once that the root renders something newer than the page shows', async () => {
    const stub = authority();
    const { alice, bob } = await signedIn(stub);
    const stale = valueOf(await stub.render(bob, PROJECT));
    valueOf(await retitle(stub, alice, '一覧を直す'));

    const events = await subscribe(stub, bob, stale.frame.subscription);
    const first = await events.next();

    expect(first).toStrictEqual({ data: { frame: { revision: 1 } }, event: 'frame' });
  });

  it('says nothing as it opens for a page that shows what the root renders, then each newer render a commit makes', async () => {
    const stub = authority();
    const { alice, bob } = await signedIn(stub);
    const rendered = valueOf(await stub.render(bob, PROJECT));
    const events = await subscribe(stub, bob, rendered.frame.subscription);

    valueOf(await retitle(stub, alice, '一覧を直す'));
    const next = await events.next();
    // The page renders its root again itself, once an event says there is something newer.
    const again = valueOf(await stub.render(bob, PROJECT));

    expect(next).toStrictEqual({ data: { frame: { revision: 1 } }, event: 'frame' });
    expect(again.frame).toMatchObject({ fields: { 'todos:t1:title': '一覧を直す' }, revision: 1 });
  });

  it('says nothing of a commit that changed nothing the root read', async () => {
    const stub = authority();
    const { alice, bob } = await signedIn(stub);
    const rendered = valueOf(await stub.render(bob, PROJECT));
    const events = await subscribe(stub, bob, rendered.frame.subscription);

    // The counter, and another project's todos: nothing the page of `p1` reads.
    valueOf(await write(stub, alice));
    valueOf(await operate(stub, alice, { args: [json('p2')], name: 'completeProject' }));
    valueOf(await retitle(stub, alice, '一覧を直す'));
    const next = await events.next();

    expect(next).toStrictEqual({ data: { frame: { revision: 3 } }, event: 'frame' });
  });

  it('says so when another session takes the reader’s editing away, which renders the todo read-only', async () => {
    const stub = authority();
    const { alice, bob } = await signedIn(stub);
    const rendered = valueOf(await stub.render(bob, PROJECT));
    const events = await subscribe(stub, bob, rendered.frame.subscription);

    valueOf(
      await write(stub, alice, {
        component: 'components/member-editor',
        key: 'canEdit',
        root: PROJECT,
        updaterId: SET_CAN_EDIT,
        value: false,
      }),
    );
    const next = await events.next();
    const after = valueOf(await stub.render(bob, PROJECT));

    expect(next).toStrictEqual({ data: { frame: { revision: 1 } }, event: 'frame' });
    expect(clientsIn(after.tree, EDITOR)).toHaveLength(0);
    expect(clientsIn(after.tree, 'components/todo-readonly')).toHaveLength(1);
  });

  it('renders the root again for a commit it depends on, and for no other', async () => {
    const seen = await runInDurableObject(authority(), async (_instance, state) => {
      const engine = new AuthorityEngine({ ...application, sql: durableObjectSql(state.storage) });
      const { sessionId: alice } = await engine.login('alice');
      const { sessionId: bob } = await engine.login('bob');
      const { subscription } = (await engine.render(bob, PROJECT)).frame;
      const stream = await new EventStreams(engine).open(bob, subscription);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      await reader.read();
      const renders = vi.spyOn(engine, 'watch');
      const next = reader.read();
      const complete = async (projectId: string): Promise<void> => {
        await engine.operate(alice, {
          args: [{ json: projectId }],
          build: BUILD,
          module: 'actions/todos',
          name: 'completeProject',
          operationId: `op-${projectId}`,
        });
      };

      await countWith(engine, alice);
      await complete('p2');
      await wait(50);
      const afterOthers = renders.mock.calls.length;
      await complete('p1');
      const { value } = await next;
      await reader.cancel();
      return { afterOthers, afterP1: renders.mock.calls.length, value };
    });

    expect(seen).toStrictEqual({
      afterOthers: 0,
      afterP1: 1,
      value: 'event: frame\ndata: {"frame":{"revision":3}}\n\n',
    });
  });

  it('sends `revoked` once the session signs out, and ends', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const rendered = valueOf(await stub.render(alice, PROJECT));
    const events = await subscribe(stub, alice, rendered.frame.subscription);

    valueOf(await stub.logout(alice));
    const ending = await events.next();

    expect(ending).toStrictEqual({
      data: { code: 'UNAUTHENTICATED', error: 'Sign in first.' },
      event: 'revoked',
    });
    await expect(events.next()).rejects.toThrow('The event stream ended.');
    await expect(stub.stats()).resolves.toMatchObject({ streams: 0 });
  });

  it('sends `revoked` once the session expires, with nothing committed, and ends', async () => {
    const stub = authority();
    const bob = await signIn(stub, 'bob');
    const rendered = valueOf(await stub.render(bob, PROJECT));
    // A day's session, shortened to half a second: long enough to open the stream within it.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE sessions SET expires = ? WHERE id = ?', Date.now() + 500, bob);
    });
    const events = await subscribe(stub, bob, rendered.frame.subscription);

    const ending = await events.next();

    expect(ending).toStrictEqual({
      data: { code: 'UNAUTHENTICATED', error: 'Sign in first.' },
      event: 'revoked',
    });
    await expect(events.next()).rejects.toThrow('The event stream ended.');
    await expect(stub.stats()).resolves.toMatchObject({ streams: 0 });
  });

  it('ends without `revoked` where the root fails to render, for the browser to open it again', async () => {
    const read = await runInDurableObject(authority(), async (_instance, state) => {
      let failing = false;
      const flaky = program('test/flaky', async (_props, $) => {
        await requireUser();
        const main = await db.counters.get('main');
        if (failing) {
          throw new Error('broken');
        }
        return $.h('p', null, main?.count ?? 0);
      });
      const engine = new AuthorityEngine({
        ...application,
        programs: [...programs, flaky],
        sql: durableObjectSql(state.storage),
      });
      const { sessionId } = await engine.login('alice');
      const { subscription } = (await engine.render(sessionId, rootOf('test/flaky'))).frame;
      const stream = await new EventStreams(engine).open(sessionId, subscription);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      await reader.read();
      failing = true;

      await countWith(engine, sessionId);
      return reader.read();
    });

    expect(read).toStrictEqual({ done: true, value: undefined });
  });

  it('refuses a stream to a session that may not follow the root, with no stream left open', async () => {
    const stub = authority();
    const { alice, bob } = await signedIn(stub);
    const { subscription } = valueOf(await stub.render(alice, PROJECT)).frame;

    await expect(stub.events(null, subscription)).resolves.toStrictEqual({
      code: 'UNAUTHENTICATED',
      message: 'Sign in first.',
      ok: false,
      status: 401,
    });
    // A subscription is the session's own: another's, or one tampered with, is none.
    await expect(stub.events(bob, subscription)).resolves.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(stub.events(alice, `${subscription}x`)).resolves.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(stub.stats()).resolves.toMatchObject({ streams: 0 });
  });

  it('lets go of a stream its reader cancels', async () => {
    const stub = authority();
    const { alice, bob } = await signedIn(stub);
    const rendered = valueOf(await stub.render(bob, PROJECT));
    const events = await subscribe(stub, bob, rendered.frame.subscription);

    await expect(stub.stats()).resolves.toMatchObject({ streams: 1 });

    await events.cancel();
    // The cancel crosses the RPC by the stream's next write at the latest, which a commit that
    // changes what the root shows makes.
    valueOf(await retitle(stub, alice, '一覧を直す'));

    await expect.poll(async () => (await stub.stats()).streams).toBe(0);
  });

  it('says it is alive while nothing is committed', async () => {
    const chunks = await runInDurableObject(authority(), async (_instance, state) => {
      const engine = new AuthorityEngine({ ...application, sql: durableObjectSql(state.storage) });
      const { sessionId } = await engine.login('alice');
      const { subscription } = (await engine.render(sessionId, PROJECT)).frame;
      const stream = await new EventStreams(engine, 10).open(sessionId, subscription);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      const read = [(await reader.read()).value, (await reader.read()).value];
      await reader.cancel();
      return read;
    });

    expect(chunks).toStrictEqual([': open\n\n', ': heartbeat\n\n']);
  });

  it('says it is alive on time while commits it renders the root again for change nothing it shows', async () => {
    const chunks = await runInDurableObject(authority(), async (_instance, state) => {
      const engine = new AuthorityEngine({ ...application, sql: durableObjectSql(state.storage) });
      const { sessionId } = await engine.login('alice');
      const done = { filter: 'done', projectId: 'p1' };
      const { subscription } = (await engine.render(sessionId, { ...PROJECT, props: done })).frame;
      const stream = await new EventStreams(engine, 50).open(sessionId, subscription);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      await reader.read();
      const binding = bindingOf(await engine.render(sessionId, PROJECT), EDITOR, 'title');
      // One of the project's todos retitled every ten milliseconds: each commit is one the page of
      // its done todos reads — its count of those not done — and none changes what it shows.
      const stop = new AbortController();
      const writes = (async (): Promise<void> => {
        while (!stop.signal.aborted) {
          await engine.update(sessionId, {
            binding,
            operationId: crypto.randomUUID(),
            updaterId: SET_TITLE,
            value: crypto.randomUUID(),
          });
          await wait(10);
        }
      })();
      const { value } = await reader.read();
      stop.abort();
      await writes;
      await reader.cancel();
      return value;
    });

    expect(chunks).toBe(': heartbeat\n\n');
  });

  it('follows what the application’s code read after it waited on a timer', async () => {
    const value = await runInDurableObject(authority(), async (_instance, state) => {
      // Its read made after a wait: the render's context has to reach it, for the authority to
      // answer the read and note it.
      const patient = program('test/patient', async (_props, $) => {
        await requireUser();
        await wait(20);
        const todo = await db.todos.get('t1');
        return $.h('p', null, todo?.completed === true ? '完了' : '未完了');
      });
      const engine = new AuthorityEngine({
        ...application,
        programs: [...programs, patient],
        sql: durableObjectSql(state.storage),
      });
      const { sessionId } = await engine.login('alice');
      const { subscription } = (await engine.render(sessionId, rootOf('test/patient'))).frame;
      const stream = await new EventStreams(engine).open(sessionId, subscription);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      await reader.read();

      await engine.operate(sessionId, {
        args: [{ json: 'p1' }],
        build: BUILD,
        module: 'actions/todos',
        name: 'completeProject',
        operationId: 'op-complete',
      });
      const read = await reader.read();
      await reader.cancel();
      return read.value;
    });

    expect(value).toBe('event: frame\ndata: {"frame":{"revision":1}}\n\n');
  });
});
