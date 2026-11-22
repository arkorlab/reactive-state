import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { FieldReceipt, Result } from '../src/program.ts';
import { MAX_JSON_LENGTH } from '../src/runtime/json.ts';
import type { Predictor } from '../src/runtime/operations.ts';
import { PageStore, type Send, type WriteTarget } from '../src/runtime/store.ts';
import { deferred, frameAt } from './support/page.ts';

/**
 * What an update captured, past the JSON one request carries: the store refuses the write as it
 * refuses one made offline or one too many — nothing thrown into the event handler that made it,
 * the page told, nothing sent — where what JSON does not carry at all is still thrown for, as a
 * mistake of the page's code.
 */

const ESTIMATE = 'todos:t1:estimate';
const SESSION = 'session:alice';
const FIRST = frameAt(1, { [ESTIMATE]: 2 });

/** A registered update of the estimate, as the compiler predicts one: adding one. */
const plusOne: Predictor = (value) => Number(value) + 1;

/** A store attached to the first frame, and the transport its operations are handed to. */
function attached(): { readonly store: PageStore; readonly send: ReturnType<typeof vi.fn<Send>> } {
  const store = new PageStore({ retryDelay: 1 });
  onTestFinished(() => {
    store.dispose();
  });
  store.attach('root', FIRST, SESSION);
  // Never answered: an operation that is sent stays pending.
  const send = vi.fn<Send>(async () => deferred<Result<FieldReceipt>>().promise);
  return { send, store };
}

/** Where an operation goes: `t1`'s estimate through its binding. */
function target(send: Send): WriteTarget {
  return {
    binding: 'binding:estimate:t1',
    field: ESTIMATE,
    send,
    session: SESSION,
    updaterId: 'u_add',
  };
}

describe('what an update captured, past what one request carries', () => {
  it('is refused without a throw, the page told and nothing sent', () => {
    const { send, store } = attached();
    // `{"text":"…"}`: one character more of JSON than a request carries.
    const captures = { text: 'x'.repeat(MAX_JSON_LENGTH - 10) };

    const id = store.apply({ ...target(send), captures, predict: plusOne });

    expect(JSON.stringify(captures)).toHaveLength(MAX_JSON_LENGTH + 1);
    expect(id).toBeUndefined();
    expect(store.getStatus()).toMatchObject({
      error: 'The update captured too much.',
      pending: 0,
    });
    expect(store.pendingOf(ESTIMATE)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('is refused so of a few objects that hold each other many times over', () => {
    const { send, store } = attached();
    let captures: Record<string, unknown> = {};
    for (let level = 0; level < 30; level += 1) {
      captures = { a: captures, b: captures };
    }

    const id = store.apply({ ...target(send), captures: captures as never, predict: plusOne });

    expect(id).toBeUndefined();
    expect(store.getStatus()).toMatchObject({
      error: 'The update captured too much.',
      pending: 0,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('is made as before of as much JSON as a request carries, and no status shown', () => {
    const { send, store } = attached();
    const captures = { text: 'x'.repeat(MAX_JSON_LENGTH - 11) };

    const id = store.apply({ ...target(send), captures, predict: plusOne });

    expect(JSON.stringify(captures)).toHaveLength(MAX_JSON_LENGTH);
    expect(id).toStrictEqual(expect.any(String));
    expect(store.getStatus()).toMatchObject({ error: null, pending: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is thrown for as before where JSON does not carry it at all, large or not', () => {
    const { send, store } = attached();
    const dated = { at: new Date(0) } as never;
    const large = { at: new Date(0), text: 'x'.repeat(MAX_JSON_LENGTH) } as never;

    expect(() => store.apply({ ...target(send), captures: dated, predict: plusOne })).toThrow(
      'What the update captured.at is an instance of Date, which JSON does not carry as it is.',
    );
    expect(() => store.apply({ ...target(send), captures: large, predict: plusOne })).toThrow(
      TypeError,
    );
    expect(store.getStatus()).toMatchObject({ error: null, pending: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
