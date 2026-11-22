import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import {
  type Elements,
  operate,
  renderRoot,
  updateField,
  type ViewAnswer,
  viewRoot,
} from '../src/next/index.ts';
import {
  type FieldReceipt,
  type OperationCall,
  type Result,
  SESSION_COOKIE,
} from '../src/program.ts';
import { BUILD, frameAt } from './support/page.ts';

/**
 * What a compile's Server Functions and a root's entry do with a value of a few objects that hold
 * each other many times over, which a Server Function's decoder hands them of a small request as
 * the caller built it: refused once it is counted past what a request carries — before it is
 * copied, before the request's session is read, and before the authority is asked — and a small
 * value that holds an object in several places answered as it was. The request's cookie, the
 * authority and Next.js's `refresh` are stood in for.
 */

const hoisted = vi.hoisted(() => {
  return {
    client: {} as Record<string, ReturnType<typeof vi.fn>>,
    /** How many times the request's session was read. */
    sessions: { read: 0 },
  };
});

vi.mock(import('next/headers'), () => {
  return {
    cookies: () => {
      hoisted.sessions.read += 1;
      return Promise.resolve({
        get: (name: string) => (name === SESSION_COOKIE ? { name, value: 'session-a' } : undefined),
      }) as never;
    },
  };
});
vi.mock(import('next/cache'), () => ({ refresh: vi.fn<() => void>() }));
vi.mock(import('next/navigation'), () => ({ useRouter: () => ({ refresh: vi.fn() }) as never }));
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => hoisted.client as unknown as AuthorityClient,
  };
});

const ELEMENTS: Elements = { actions: {}, build: BUILD, clients: {}, modules: {} };
const FRAME = frameAt(3, {});
const PAST = /is past the 1048576 characters of JSON one request carries\.$/u;

const update = (): Promise<Result<FieldReceipt>> => Promise.reject(new Error('Not called here.'));
const viewAgain = (): Promise<Result<ViewAnswer>> => Promise.reject(new Error('Not called here.'));

/**
 * `levels` objects that each hold the next twice, above `leaf`: `levels + 1` objects, and `2 **
 * levels` places `leaf` stands at in the JSON a copy writes.
 */
function doubled(levels: number, leaf: unknown = {}): unknown {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) {
    value = { a: value, b: value };
  }
  return value;
}

/** An empty object that counts each time a copy reads it, and is a plain object otherwise. */
function countedLeaf(): { readonly leaf: unknown; readonly reads: () => number } {
  let reads = 0;
  const leaf = new Proxy(
    {},
    {
      getPrototypeOf: (target) => {
        reads += 1;
        return Reflect.getPrototypeOf(target);
      },
    },
  );
  return { leaf, reads: () => reads };
}

/** A form of one field, of as many bytes as one form may hold (16 KiB). */
function fullForm(): FormData {
  const form = new FormData();
  form.append('f', 'x'.repeat(16_383));
  return form;
}

describe('a value of objects that hold each other many times over', () => {
  beforeEach(() => {
    hoisted.sessions.read = 0;
    hoisted.client = {
      operate: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: { committedRevision: 4, deduplicated: false, operationId: 'op', result: null },
        }),
      ),
      render: vi.fn(() =>
        Promise.resolve({ ok: true, value: { frame: FRAME, status: 'forbidden', tree: null } }),
      ),
      update: vi.fn(() => Promise.resolve({ ok: true, value: { committedRevision: 2 } })),
      view: vi.fn(() =>
        Promise.resolve({ ok: true, value: { frame: FRAME, status: 'forbidden', tree: null } }),
      ),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sent as what an update captured', () => {
    it('is refused past what a request carries, the session unread and the authority unasked', async () => {
      // Nineteen objects: 2 ** 18 places of the last, five million characters of JSON.
      await expect(
        updateField({ binding: 'b', captures: doubled(18), operationId: 'op', updaterId: 'u' }),
      ).resolves.toMatchObject({ code: 'INVALID_OPERATION', ok: false, status: 400 });
      expect(hoisted.client['update']).not.toHaveBeenCalled();
      expect(hoisted.sessions.read).toBe(0);
    });

    it('is refused at once of the thirty objects of a small request, a thousand million places', async () => {
      await expect(
        updateField({ binding: 'b', captures: doubled(30), operationId: 'op', updaterId: 'u' }),
      ).resolves.toMatchObject({ code: 'INVALID_OPERATION', ok: false, status: 400 });
      expect(hoisted.client['update']).not.toHaveBeenCalled();
      expect(hoisted.sessions.read).toBe(0);
    });

    it('is sent as it was where it is small: each place the object stands at, a copy of it', async () => {
      const step = { by: 5 };

      await updateField({
        binding: 'b',
        captures: { first: step, list: [step, step] },
        operationId: 'op',
        updaterId: 'u',
      });

      expect(hoisted.client['update']).toHaveBeenCalledExactlyOnceWith('session-a', {
        binding: 'b',
        captures: { first: { by: 5 }, list: [{ by: 5 }, { by: 5 }] },
        operationId: 'op',
        updaterId: 'u',
      });
    });
  });

  describe('sent as the inputs of a view', () => {
    it('is refused before it is copied: its shared object read no more often than the bound has room for', async () => {
      const { leaf, reads } = countedLeaf();
      const view = { 'instance:list': { d0: { filter: doubled(18, leaf) } } };

      await expect(viewRoot({ subscription: 's', view }, ELEMENTS)).resolves.toMatchObject({
        code: 'INVALID_VIEW',
        ok: false,
        status: 400,
      });
      // Half a million places in the value; the bound has room for a hundred thousand objects.
      expect(reads()).toBeLessThan(104_858);
      expect(hoisted.client['view']).not.toHaveBeenCalled();
      expect(hoisted.sessions.read).toBe(0);
    });

    it('is refused at once of the thirty objects of a small request, a thousand million places', async () => {
      const view = { 'instance:list': { d0: { filter: doubled(30) } } };

      await expect(viewRoot({ subscription: 's', view }, ELEMENTS)).resolves.toMatchObject({
        code: 'INVALID_VIEW',
        ok: false,
        status: 400,
      });
      expect(hoisted.client['view']).not.toHaveBeenCalled();
      expect(hoisted.sessions.read).toBe(0);
    });

    it('is sent as it was where it is small: two sites of the same inputs, each a copy of them', async () => {
      const inputs = { filter: 'active' };

      await viewRoot(
        { subscription: 's', view: { 'instance:list': { d0: inputs, d1: inputs } } },
        ELEMENTS,
      );

      expect(hoisted.client['view']).toHaveBeenCalledExactlyOnceWith('session-a', {
        subscription: 's',
        view: { 'instance:list': { d0: { filter: 'active' }, d1: { filter: 'active' } } },
      });
    });
  });

  describe('sent as the arguments of a server operation', () => {
    it('is refused past what a request carries, the session unread and the authority unasked', async () => {
      await expect(operate('actions/todos', 'createTodo', [doubled(18)], BUILD)).rejects.toThrow(
        /^Argument 1(?:\.[ab])+ is past the 1048576 characters of JSON one request carries\.$/u,
      );
      await expect(operate('actions/todos', 'createTodo', [doubled(30)], BUILD)).rejects.toThrow(
        TypeError,
      );
      expect(hoisted.client['operate']).not.toHaveBeenCalled();
      expect(hoisted.sessions.read).toBe(0);
    });

    it('is counted with the call’s other arguments: a dozen that each fit alone are refused together', async () => {
      // Fourteen objects, 2 ** 13 places of the last: a hundred thousand characters of JSON.
      const each = doubled(13);
      await operate('actions/todos', 'createTodo', [each], BUILD);

      expect(hoisted.client['operate']).toHaveBeenCalledTimes(1);

      const dozen = Array.from({ length: 12 }, () => each);

      await expect(operate('actions/todos', 'createTodo', dozen, BUILD)).rejects.toThrow(
        /^Argument 11(?:\.[ab])+ is past the 1048576 characters of JSON one request carries\.$/u,
      );
      expect(hoisted.client['operate']).toHaveBeenCalledTimes(1);
      expect(hoisted.sessions.read).toBe(1);
    });

    it('is counted with the call’s forms: sixty-four forms of 16 KiB each are refused together', async () => {
      const forms = Array.from({ length: 64 }, () => fullForm());
      await operate('actions/todos', 'createTodo', forms.slice(0, 63), BUILD);

      expect(hoisted.client['operate']).toHaveBeenCalledTimes(1);

      await expect(operate('actions/todos', 'createTodo', forms, BUILD)).rejects.toThrow(
        'Argument 64 is past the 1048576 characters of JSON one request carries.',
      );
      expect(hoisted.client['operate']).toHaveBeenCalledTimes(1);
      expect(hoisted.sessions.read).toBe(1);
    });

    it('is sent as it was where it is small: each place the object stands at, a copy of it', async () => {
      const shared = { id: 't1' };
      const form = new FormData();
      form.append('title', 'Plan');

      await operate('actions/todos', 'createTodo', [shared, [shared, shared], form], BUILD);

      const [, call] = hoisted.client['operate']?.mock.calls[0] as [string, OperationCall];

      expect(call.args).toStrictEqual([
        { json: { id: 't1' } },
        { json: [{ id: 't1' }, { id: 't1' }] },
        { form: [['title', 'Plan']] },
      ]);
    });
  });

  describe('handed to a root as its props', () => {
    it('is refused past what a request carries, the session unread and the authority unasked', async () => {
      const props = { items: Array.from({ length: 600_000 }, () => 0) };

      await expect(
        renderRoot({
          component: 'components/project',
          elements: ELEMENTS,
          props,
          update,
          view: viewAgain,
        }),
      ).rejects.toThrow(PAST);
      expect(hoisted.client['render']).not.toHaveBeenCalled();
      expect(hoisted.sessions.read).toBe(0);
    });

    it('is rendered as it was where it is small: each place the object stands at, a copy of it', async () => {
      const owner = { id: 'u1' };

      await renderRoot({
        component: 'components/project',
        elements: ELEMENTS,
        props: { owner, reviewers: [owner, owner] },
        update,
        view: viewAgain,
      });

      expect(hoisted.client['render']).toHaveBeenCalledExactlyOnceWith('session-a', {
        build: BUILD,
        component: 'components/project',
        props: { owner: { id: 'u1' }, reviewers: [{ id: 'u1' }, { id: 'u1' }] },
      });
    });
  });
});
