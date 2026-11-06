import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { onTestFinished } from 'vitest';

import type { AuthorityEngine } from '../../src/authority/engine.ts';
import type { AuthorityClient } from '../../src/client/contract.ts';
import type { AuthorityObject, AuthorityStats } from '../../src/cloudflare/index.ts';
import type {
  FieldReceipt,
  Json,
  OperationArgument,
  OperationReceipt,
  RenderResult,
  Result,
  RootRequest,
  Value,
} from '../../src/program.ts';
import { type EventReader, readEvents } from '../support/event-stream.ts';
import { clientOf } from '../support/frames.ts';
import { BUILD, INCREMENT, SET_TITLE } from '../support/program.ts';

/**
 * The object's stub, its RPC methods typed as the contract types them, in place of workerd's own
 * types for them: those type each answer again as what an RPC can carry, and a rendered tree — a
 * type made of itself — is deeper than the checker follows.
 */
export type AuthorityStub = AuthorityClient & {
  readonly stats: () => Promise<AuthorityStats>;
} & DurableObjectStub;

/** The counter `main`, which anyone signed in may count, and which the public page shows. */
export const COUNTER: RootRequest = {
  build: BUILD,
  component: 'components/counter',
  props: { id: 'main' },
};
/** The counter `other`, which no public page shows. */
export const OTHER: RootRequest = { ...COUNTER, props: { id: 'other' } };
/**
 * The page of the project `p1`, with `t1` of its todos selected: Alice owns the project, and Bob is
 * a member who may edit it.
 */
export const PROJECT: RootRequest = {
  build: BUILD,
  component: 'components/project',
  props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
};
/** The editor of the item the project's page selects, which it renders for whoever may edit it. */
export const EDITOR = 'components/todo-editor';

/**
 * An object of its own, as an application's server reaches it: by a name no other test's object
 * has, since storage outlives a test within its file. The alarm it arms is deleted when the test
 * finishes, so that none fires on its own while another test runs.
 */
export function authority(): AuthorityStub {
  // Every RPC method of the object is one of the contract's (`AuthorityClient`), or `stats`.
  const stub = env.AUTHORITY.getByName(
    `authority-${crypto.randomUUID()}`,
  ) as unknown as AuthorityStub;
  onTestFinished(async () => {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
  return stub;
}

/**
 * Runs `callback` inside the object `stub` names, with the object itself, as `runInDurableObject`
 * does: through the stub's type that names the object's class, which `AuthorityStub` leaves out.
 */
export async function inObject<R>(
  stub: AuthorityStub,
  callback: (instance: AuthorityObject, state: DurableObjectState) => Promise<R> | R,
): Promise<R> {
  return runInDurableObject(stub as unknown as DurableObjectStub<AuthorityObject>, callback);
}

/** A result's value; a refusal fails the test with what the authority said. */
export function valueOf<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`${String(result.status)} ${result.code}: ${result.message}`);
  }
  return result.value;
}

/** A session of `user`'s. */
export async function signIn(stub: AuthorityStub, user: string): Promise<string> {
  return valueOf(await stub.login(user)).sessionId;
}

/** Alice's session, the owner of every project but `p3`, and Bob's, a member who may edit them. */
export async function signedIn(
  stub: AuthorityStub,
): Promise<{ readonly alice: string; readonly bob: string }> {
  return { alice: await signIn(stub, 'alice'), bob: await signIn(stub, 'bob') };
}

/** The binding `component` writes its state `key` with, in a rendered root that renders it once. */
export function bindingOf(rendered: RenderResult, component: string, key: string): string {
  const state = clientOf(rendered.tree, component).part.states[key];
  const binding = state !== undefined && 'field' in state ? state.binding : undefined;
  if (binding === undefined) {
    throw new Error(`${component} has no binding for ${key}.`);
  }
  return binding;
}

/** What `write` writes: the counter `main` counted up by one, unless told otherwise. */
interface WriteInput {
  /** The root rendered for the binding, and the component in it whose state `key` is written. */
  readonly root?: RootRequest;
  readonly component?: string;
  readonly key?: string;
  readonly operationId?: string;
  readonly updaterId?: string;
  /** What a `set` writes; none for an update the authority computes. */
  readonly value?: Value;
  readonly captures?: Readonly<Record<string, Json>>;
}

/** One write as a page makes it: the root rendered for the session, then a write under its binding. */
export async function write(
  stub: AuthorityStub,
  session: string,
  input: WriteInput = {},
): Promise<Result<FieldReceipt>> {
  const { component = COUNTER.component, key = 'count', root = COUNTER } = input;
  const rendered = valueOf(await stub.render(session, root));
  return stub.update(session, {
    binding: bindingOf(rendered, component, key),
    operationId: input.operationId ?? crypto.randomUUID(),
    updaterId: input.updaterId ?? INCREMENT,
    ...(input.value !== undefined && { value: input.value }),
    ...(input.captures !== undefined && { captures: input.captures }),
  });
}

/** `t1`'s title, written through the project page's editor, as its text input writes it. */
export async function retitle(
  stub: AuthorityStub,
  session: string,
  title: string,
): Promise<Result<FieldReceipt>> {
  return write(stub, session, {
    component: EDITOR,
    key: 'title',
    root: PROJECT,
    updaterId: SET_TITLE,
    value: title,
  });
}

/** A server operation of the test application's `actions/todos`, as its server sends one. */
export async function operate(
  stub: AuthorityStub,
  session: string,
  call: {
    readonly name: string;
    readonly args: readonly OperationArgument[];
    readonly operationId?: string;
  },
): Promise<Result<OperationReceipt>> {
  return stub.operate(session, {
    args: call.args,
    build: BUILD,
    module: 'actions/todos',
    name: call.name,
    operationId: call.operationId ?? crypto.randomUUID(),
  });
}

/** A form's entries, as a server operation is sent them. */
export function form(entries: Readonly<Record<string, string>>): OperationArgument {
  return { form: Object.entries(entries) };
}

/** A value, as a server operation is sent it. */
export function json(value: Json): OperationArgument {
  return { json: value };
}

/**
 * The counter `root` — `main` unless given — counted up by one by `engine` itself, as the object's
 * own calls count it: rendered, then written under the binding the render issued.
 */
export async function countWith(
  engine: AuthorityEngine,
  session: string,
  root: RootRequest = COUNTER,
): Promise<FieldReceipt> {
  const rendered = await engine.render(session, root);
  return engine.update(session, {
    binding: bindingOf(rendered, root.component, 'count'),
    operationId: crypto.randomUUID(),
    updaterId: INCREMENT,
  });
}

/**
 * The session's event stream for a rendered root, by its frame's subscription — cancelled when the
 * test finishes if it is not before.
 */
export async function subscribe(
  stub: AuthorityStub,
  session: string,
  subscription: string,
): Promise<EventReader> {
  const stream = valueOf(await stub.events(session, subscription));
  const events = readEvents(new Response(stream));
  onTestFinished(async () => {
    await events.cancel();
  });
  return events;
}

/** What the object keeps about its delivery: its alarm, the site's cursor, and its own entries. */
export interface DeliveryState {
  readonly alarm: number | null;
  readonly cursor: number;
  readonly meta: Readonly<Record<string, string>>;
}

export async function deliveryState(stub: AuthorityStub): Promise<DeliveryState> {
  return runInDurableObject(stub, async (_instance, state) => {
    const { sql } = state.storage;
    // The engine's own entries are left out: its revision, its schema, and its binding secret.
    const meta = sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM meta WHERE key NOT IN ('binding_secret', 'revision', 'schema')",
      )
      .toArray();
    const [cursor] = sql
      .exec<{ revision: number }>("SELECT revision FROM deliveries WHERE consumer = 'site'")
      .toArray();
    return {
      alarm: await state.storage.getAlarm(),
      cursor: cursor?.revision ?? 0,
      meta: Object.fromEntries(meta.map((row) => [row.key, row.value])),
    };
  });
}

/** Takes the floor a failure's backoff set away, as if its time had come. */
export async function expireBackoff(stub: AuthorityStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'delivery_retry_at'");
  });
}
