import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import {
  EVENTS_PATH,
  type Elements,
  operate,
  OperationError,
  publicView,
  renderRoot,
  type RootProps,
  updateField,
  type ViewAnswer,
  viewRoot,
} from '../src/next/index.ts';
import {
  type FieldReceipt,
  type OperationCall,
  type OperationReceipt,
  type RenderResult,
  type Result,
  SESSION_COOKIE,
  VIEW_LIMITS,
} from '../src/program.ts';
import { operationOutcome } from '../src/react/index.tsx';
import { LiveRoot } from '../src/react/live-root.tsx';
import type { ClientPartProps } from '../src/react/state.ts';
import { BUILD, frameAt, projectTree, refusal } from './support/page.ts';

/**
 * What a compile's files call on the application's server: `renderRoot`, which the root entry
 * returns, and the Server Functions' `viewRoot`, `updateField` and `operate` — with the request's
 * cookie, the authority and Next.js's `refresh` stood in for.
 */

const hoisted = vi.hoisted(() => {
  const session: { current: string | null } = { current: 'session-a' };
  return {
    client: {} as Record<string, ReturnType<typeof vi.fn>>,
    refresh: vi.fn<() => void>(),
    session,
  };
});

vi.mock(import('next/headers'), () => {
  return {
    cookies: () => {
      return Promise.resolve({
        get: (name: string) => {
          return name === SESSION_COOKIE && hoisted.session.current !== null
            ? { name, value: hoisted.session.current }
            : undefined;
        },
      }) as never;
    },
  };
});
vi.mock(import('next/cache'), () => ({ refresh: hoisted.refresh }));
vi.mock(import('next/navigation'), () => ({ useRouter: () => ({ refresh: vi.fn() }) as never }));
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => hoisted.client as unknown as AuthorityClient,
  };
});

type Update = (input: unknown) => Promise<Result<FieldReceipt>>;

function Row({ part }: ClientPartProps): ReactNode {
  const { id } = part.props as { readonly id: string };
  return <li>{id}</li>;
}

const ELEMENTS: Elements = {
  actions: {},
  build: BUILD,
  clients: { 'components/todo-editor': Row, 'components/todo-row': Row },
  modules: {},
};

const FRAME = frameAt(3, { 'todos:t1:title': 'Plan' });

const update: Update = () => Promise.reject(new Error('Not called here.'));
const viewAgain = (): Promise<Result<ViewAnswer>> => Promise.reject(new Error('Not called here.'));

function rendered(status: RenderResult['status']): Result<RenderResult> {
  return {
    ok: true,
    value: { frame: FRAME, status, tree: status === 'rendered' ? projectTree(['t1'], null) : null },
  };
}

function operated(result: OperationReceipt['result']): Result<OperationReceipt> {
  return {
    ok: true,
    value: { committedRevision: 4, deduplicated: false, operationId: 'op', result },
  };
}

/** The props `LiveRoot` was rendered with. */
function liveProps(node: ReactNode): Readonly<Record<string, unknown>> {
  if (!isValidElement(node) || node.type !== LiveRoot) {
    throw new Error('Not a LiveRoot.');
  }
  return node.props as Readonly<Record<string, unknown>>;
}

/**
 * An error as a page's error boundary is handed it in production: what React rebuilt from the RSC
 * payload, its message hidden, its digest kept.
 */
async function masked(running: Promise<unknown>): Promise<Error> {
  try {
    await running;
  } catch (error) {
    const { digest } = error as { readonly digest?: unknown };
    return Object.assign(new Error('An error occurred in the Server Components render.'), {
      digest,
    });
  }
  throw new Error('The operation was not refused.');
}

describe('the server runtime', () => {
  beforeEach(() => {
    hoisted.session.current = 'session-a';
    hoisted.refresh.mockReset();
    hoisted.client = {
      operate: vi.fn(),
      publicView: vi.fn(),
      render: vi.fn(() => Promise.resolve(rendered('rendered'))),
      update: vi.fn(),
      view: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('renderRoot', () => {
    it('renders what the authority rendered of the root inside a LiveRoot, with its frame', async () => {
      const root = await renderRoot({
        component: 'components/project',
        elements: ELEMENTS,
        props: { filter: 'all', projectId: 'p1', selectedId: undefined },
        update,
        view: viewAgain,
      });
      const props = liveProps(root);

      expect(hoisted.client['render']).toHaveBeenCalledExactlyOnceWith('session-a', {
        build: BUILD,
        component: 'components/project',
        props: { filter: 'all', projectId: 'p1' },
      });
      expect(props).toMatchObject({
        events: EVENTS_PATH,
        frame: FRAME,
        status: 'rendered',
        update,
        view: viewAgain,
      });
      expect(props['session']).toMatch(/^[\da-f]{24}$/u);
      expect(renderToStaticMarkup(props['children'] as ReactNode)).toBe(
        '<main><ul><li>t1</li></ul></main>',
      );
    });

    it('hands the browser the event stream where the site serves it: under the build’s base path, in its trailing-slash form', async () => {
      vi.stubEnv('__NEXT_ROUTER_BASEPATH', '/docs');
      vi.stubEnv('__NEXT_TRAILING_SLASH', 'true');
      const root = await renderRoot({
        component: 'components/project',
        elements: ELEMENTS,
        props: { projectId: 'p1' },
        update,
        view: viewAgain,
      });

      expect(liveProps(root)['events']).toBe(`/docs${EVENTS_PATH}/`);
    });

    it('names a session by a digest of its id, the same each time, and no session by nothing', async () => {
      const options = {
        component: 'components/project',
        elements: ELEMENTS,
        props: {},
        update,
        view: viewAgain,
      };
      const first = liveProps(await renderRoot(options))['session'];
      const again = liveProps(await renderRoot(options))['session'];
      hoisted.session.current = 'session-b';
      const other = liveProps(await renderRoot(options))['session'];
      hoisted.session.current = null;
      const none = liveProps(await renderRoot(options))['session'];

      expect(again).toBe(first);
      expect(other).not.toBe(first);
      expect(String(first)).not.toContain('session-a');
      expect(none).toBe('');
    });

    it.each(['forbidden', 'unauthenticated'] as const)(
      'renders nothing inside the LiveRoot of a root the session may not see (%s)',
      async (status) => {
        hoisted.client['render']?.mockResolvedValue(rendered(status));

        const props = liveProps(
          await renderRoot({
            component: 'components/project',
            elements: ELEMENTS,
            props: {},
            update,
            view: viewAgain,
          }),
        );

        expect(props).toMatchObject({ children: null, frame: FRAME, status });
      },
    );

    it('throws for an authority that did not render the root, for the error boundary', async () => {
      hoisted.client['render']?.mockResolvedValue(
        refusal(503, 'AUTHORITY_UNAVAILABLE', 'The authority could not be reached.'),
      );

      await expect(
        renderRoot({
          component: 'components/project',
          elements: ELEMENTS,
          props: {},
          update,
          view: viewAgain,
        }),
      ).rejects.toThrow(/components\/project \(503 AUTHORITY_UNAVAILABLE\)/u);
    });

    it('is rendered, where a parameter names the type of its props, without those TypeScript types as nodes', async () => {
      interface CardProps {
        readonly header: ReactNode;
        readonly icons: readonly ReactNode[];
        readonly label: string;
        readonly data: unknown;
      }
      type Mode =
        | { readonly mode: 'a'; readonly a: string; readonly header: ReactNode }
        | { readonly mode: 'b'; readonly b: number };
      const element = <b>header</b>;
      const props: RootProps<CardProps> = { data: { at: 1 }, label: 'card' };
      // @ts-expect-error -- `header` holds nodes, which a page renders a root without
      const header: RootProps<CardProps> = { ...props, header: element };
      // @ts-expect-error -- as does `icons`, a list of them
      const icons: RootProps<CardProps> = { ...props, icons: [element] };
      const modes: readonly RootProps<Mode>[] = [
        { a: 'x', mode: 'a' },
        { b: 1, mode: 'b' },
      ];
      // @ts-expect-error -- each member of a union apart
      const mixed: RootProps<Mode> = { a: 'x', mode: 'b' };

      await renderRoot({
        component: 'components/card',
        elements: ELEMENTS,
        props,
        update,
        view: viewAgain,
      });

      expect(hoisted.client['render']).toHaveBeenCalledExactlyOnceWith('session-a', {
        build: BUILD,
        component: 'components/card',
        props: { data: { at: 1 }, label: 'card' },
      });
      expect([header, icons, mixed, ...modes]).toHaveLength(5);
    });

    it('refuses props JSON would not carry as they are', async () => {
      await expect(
        renderRoot({
          component: 'components/project',
          elements: ELEMENTS,
          props: { since: new Date(0) },
          update,
          view: viewAgain,
        }),
      ).rejects.toThrow(TypeError);
      expect(hoisted.client['render']).not.toHaveBeenCalled();
    });
  });

  describe('viewRoot', () => {
    const SHOWN = { 'instance:list': { d0: { filter: 'active' } } };

    it('renders the root the subscription names again for the view, and nothing a caller sent beside them', async () => {
      const shown = frameAt(4, { 'todos:t1:title': 'Plan' }, { view: SHOWN });
      hoisted.client['view']?.mockResolvedValue({
        ok: true,
        value: { frame: shown, status: 'rendered', tree: projectTree(['t1'], null) },
      });

      const answer = await viewRoot(
        { extra: 'dropped', subscription: 'subscription:p1', view: SHOWN },
        ELEMENTS,
      );

      expect(hoisted.client['view']).toHaveBeenCalledExactlyOnceWith('session-a', {
        subscription: 'subscription:p1',
        view: SHOWN,
      });
      expect(answer).toMatchObject({ ok: true, value: { frame: shown, status: 'rendered' } });
      expect(renderToStaticMarkup(answer.ok ? answer.value.children : null)).toBe(
        '<main><ul><li>t1</li></ul></main>',
      );
      expect(hoisted.refresh).not.toHaveBeenCalled();
    });

    it('answers a root the session may no longer see with nothing to show', async () => {
      hoisted.client['view']?.mockResolvedValue(rendered('forbidden'));

      await expect(viewRoot({ subscription: 's', view: {} }, ELEMENTS)).resolves.toStrictEqual({
        ok: true,
        value: { children: null, frame: FRAME, status: 'forbidden' },
      });
    });

    it('answers what the authority refused as it refused it, and an authority that did not answer as such', async () => {
      hoisted.client['view']
        ?.mockResolvedValueOnce(refusal(403, 'FORBIDDEN', 'This subscription is not yours.'))
        .mockResolvedValueOnce(refusal(409, 'BUILD_MISMATCH', 'The application was updated.'))
        .mockResolvedValueOnce(
          refusal(503, 'AUTHORITY_UNAVAILABLE', 'The authority could not be reached.'),
        );
      const input = { subscription: 's', view: SHOWN };

      await expect(viewRoot(input, ELEMENTS)).resolves.toStrictEqual(
        refusal(403, 'FORBIDDEN', 'This subscription is not yours.'),
      );
      await expect(viewRoot(input, ELEMENTS)).resolves.toStrictEqual(
        refusal(409, 'BUILD_MISMATCH', 'The application was updated.'),
      );
      await expect(viewRoot(input, ELEMENTS)).resolves.toStrictEqual(
        refusal(503, 'AUTHORITY_UNAVAILABLE', 'The page could not be brought up to date yet.'),
      );
    });

    const crowded = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`instance:${String(index)}`, {}]),
    );
    const sited = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`d${String(index)}`, {}]),
    );

    it.each([
      ['nothing', null],
      ['no subscription', { view: {} }],
      ['an empty subscription', { subscription: '', view: {} }],
      [
        'a subscription longer than the authority signs',
        { subscription: 'x'.repeat(4097), view: {} },
      ],
      ['no view', { subscription: 's' }],
      ['a view that is a list', { subscription: 's', view: [] }],
      ['a part whose sites are not an object', { subscription: 's', view: { i: [] } }],
      ['inputs that are not an object', { subscription: 's', view: { i: { d0: 'all' } } }],
      [
        'inputs JSON would not carry',
        { subscription: 's', view: { i: { d0: { at: new Date(0) } } } },
      ],
      ['more than 64 parts', { subscription: 's', view: crowded }],
      ['more than 16 sites of a part', { subscription: 's', view: { i: sited } }],
      [
        'a view longer than the authority reads',
        { subscription: 's', view: { i: { d0: { filter: 'x'.repeat(VIEW_LIMITS.bytes) } } } },
      ],
      [
        'a view of fewer characters than that, but more bytes',
        {
          subscription: 's',
          view: { i: { d0: { filter: 'あ'.repeat(Math.ceil(VIEW_LIMITS.bytes / 3)) } } },
        },
      ],
    ])('refuses %s, as a view not valid', async (_what, input) => {
      await expect(viewRoot(input, ELEMENTS)).resolves.toMatchObject({
        code: 'INVALID_VIEW',
        ok: false,
        status: 400,
      });
      expect(hoisted.client['view']).not.toHaveBeenCalled();
    });
  });

  describe('updateField', () => {
    it('hands the authority a set’s value — `false` too — and nothing a caller sent beside it', async () => {
      hoisted.client['update']?.mockResolvedValue({ ok: true, value: { committedRevision: 2 } });

      await updateField({
        binding: 'b',
        extra: 'dropped',
        operationId: 'op-1',
        updaterId: 'u_set',
        value: false,
      });
      await updateField({
        binding: 'b',
        captures: { step: 5 },
        operationId: 'op-2',
        updaterId: 'u_add',
      });

      expect(hoisted.client['update']?.mock.calls).toStrictEqual([
        ['session-a', { binding: 'b', operationId: 'op-1', updaterId: 'u_set', value: false }],
        [
          'session-a',
          { binding: 'b', captures: { step: 5 }, operationId: 'op-2', updaterId: 'u_add' },
        ],
      ]);
    });

    it.each([
      ['nothing', null],
      ['no binding', { operationId: 'op', updaterId: 'u' }],
      [
        'a value and captures',
        { binding: 'b', captures: {}, operationId: 'op', updaterId: 'u', value: 1 },
      ],
      [
        'a value no field holds',
        { binding: 'b', operationId: 'op', updaterId: 'u', value: { x: 1 } },
      ],
      [
        'captures JSON would not carry',
        { binding: 'b', captures: { at: new Date(0) }, operationId: 'op', updaterId: 'u' },
      ],
    ])('refuses %s', async (_what, input) => {
      await expect(updateField(input)).resolves.toMatchObject({
        code: 'INVALID_OPERATION',
        ok: false,
        status: 400,
      });
      expect(hoisted.client['update']).not.toHaveBeenCalled();
    });

    it('says a write whose outcome is unknown is being confirmed, and keeps its status', async () => {
      hoisted.client['update']?.mockResolvedValue(
        refusal(503, 'AUTHORITY_UNAVAILABLE', 'The authority could not be reached.'),
      );

      await expect(
        updateField({ binding: 'b', operationId: 'op', updaterId: 'u', value: 'x' }),
      ).resolves.toStrictEqual({
        code: 'AUTHORITY_UNAVAILABLE',
        message: 'Whether the change was saved cannot be confirmed yet.',
        ok: false,
        status: 503,
      });
    });
  });

  describe('operate', () => {
    it('sends a form’s text fields — React’s own left out — and JSON as it is, under an id of its own', async () => {
      hoisted.client['operate']?.mockResolvedValue(operated(null));
      const form = new FormData();
      form.append('$ACTION_REF_1', '');
      form.append('title', '牛乳を買う');
      form.append('$ACTION_KEY', 'k0');

      await operate('actions/todos', 'createTodo', ['p1', form], BUILD);

      const [session, call] = hoisted.client['operate']?.mock.calls[0] as [string, OperationCall];

      expect(session).toBe('session-a');
      expect(call).toStrictEqual({
        args: [{ json: 'p1' }, { form: [['title', '牛乳を買う']] }],
        build: BUILD,
        module: 'actions/todos',
        name: 'createTodo',
        operationId: expect.stringMatching(/^[\da-f-]{36}$/u) as unknown,
      });
    });

    it('renders the route again once the operation ran, and answers what it returned', async () => {
      hoisted.client['operate']?.mockResolvedValue(operated({ id: 't3' }));

      await expect(operate('actions/todos', 'createTodo', ['p1'], BUILD)).resolves.toStrictEqual({
        id: 't3',
      });
      expect(hoisted.refresh).toHaveBeenCalledExactlyOnceWith();
    });

    it('sends a call whose outcome is unknown again under the same id, three times at most', async () => {
      vi.useFakeTimers();
      hoisted.client['operate']?.mockResolvedValue(
        refusal(503, 'AUTHORITY_UNAVAILABLE', 'The authority did not answer in time.'),
      );

      const running = operate('actions/todos', 'completeProject', ['p1'], BUILD);
      await Promise.all([expect(running).rejects.toThrow(OperationError), vi.runAllTimersAsync()]);
      const ids = (hoisted.client['operate']?.mock.calls as [string, OperationCall][]).map(
        ([, call]) => call.operationId,
      );

      await expect(running).rejects.toMatchObject({
        code: 'AUTHORITY_UNAVAILABLE',
        digest: 'REACTIVE_STATE_OPERATION;unknown;AUTHORITY_UNAVAILABLE',
        message: expect.stringMatching(
          /^Whether actions\/todos#completeProject ran is unknown/u,
        ) as unknown,
        outcome: 'unknown',
        status: 503,
      });
      // What a page's error boundary reads of it, the message hidden as production hides it.
      expect(operationOutcome(await masked(running))).toBe('unknown');
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(1);
      expect(hoisted.refresh).not.toHaveBeenCalled();
    });

    it('sends a call the authority answered with a fault of its own again, as one whose outcome is unknown', async () => {
      vi.useFakeTimers();
      hoisted.client['operate']
        ?.mockResolvedValueOnce(refusal(500, 'INTERNAL_ERROR', 'Internal error'))
        .mockResolvedValueOnce(operated(null));

      const outcome = operate('actions/todos', 'completeProject', ['p1'], BUILD);
      await vi.runAllTimersAsync();
      const ids = (hoisted.client['operate']?.mock.calls as [string, OperationCall][]).map(
        ([, call]) => call.operationId,
      );

      await expect(outcome).resolves.toBeNull();
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(1);
    });

    it('sends no more a call the authority answered as committed and then failed, whose outcome stays unknown', async () => {
      hoisted.client['operate']?.mockResolvedValue(
        refusal(
          500,
          'OPERATION_FAILED',
          'The operation committed at revision 3, and then threw: x',
        ),
      );

      await expect(
        operate('actions/todos', 'completeProject', ['p1'], BUILD),
      ).rejects.toMatchObject({ code: 'OPERATION_FAILED', outcome: 'unknown', status: 500 });
      expect(hoisted.client['operate']).toHaveBeenCalledTimes(1);
      expect(hoisted.refresh).not.toHaveBeenCalled();
    });

    it('says an outcome stays unknown once an attempt’s was, though a resend is refused', async () => {
      vi.useFakeTimers();
      hoisted.client['operate']
        ?.mockResolvedValueOnce(refusal(503, 'AUTHORITY_UNAVAILABLE', 'unreachable'))
        .mockResolvedValueOnce(refusal(401, 'UNAUTHENTICATED', 'Sign in first.'));

      const outcome = operate('actions/todos', 'deleteTodo', ['p1', 't1'], BUILD);
      await Promise.all([expect(outcome).rejects.toThrow(OperationError), vi.runAllTimersAsync()]);

      await expect(outcome).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        outcome: 'unknown',
        status: 401,
      });
    });

    it('takes the answer of a resend once the authority answers', async () => {
      vi.useFakeTimers();
      hoisted.client['operate']
        ?.mockResolvedValueOnce(refusal(503, 'AUTHORITY_UNAVAILABLE', 'unreachable'))
        .mockResolvedValueOnce(operated(null));

      const outcome = operate('actions/todos', 'deleteTodo', ['p1', 't1'], BUILD);
      await vi.runAllTimersAsync();

      await expect(outcome).resolves.toBeNull();
      expect(hoisted.client['operate']).toHaveBeenCalledTimes(2);
      expect(hoisted.refresh).toHaveBeenCalledExactlyOnceWith();
    });

    it('sends a call the authority refused no more, and says it was refused', async () => {
      hoisted.client['operate']?.mockResolvedValue(
        refusal(422, 'OPERATION_REJECTED', 'title must contain 1..200 characters'),
      );

      const refused = operate('actions/todos', 'createTodo', ['p1'], BUILD);

      expect(operationOutcome(await masked(refused))).toBe('refused');
      await expect(refused).rejects.toMatchObject({
        code: 'OPERATION_REJECTED',
        digest: 'REACTIVE_STATE_OPERATION;refused;OPERATION_REJECTED',
        message:
          'actions/todos#createTodo was refused (422 OPERATION_REJECTED): title must contain 1..200 characters',
        outcome: 'refused',
        status: 422,
      });
      expect(hoisted.client['operate']).toHaveBeenCalledTimes(1);
      expect(hoisted.refresh).not.toHaveBeenCalled();
    });

    it('refuses a file, more fields than a form may hold, and arguments JSON would not carry', async () => {
      const file = new FormData();
      file.append('attachment', new Blob(['x']), 'x.txt');
      const crowded = new FormData();
      for (let field = 0; field < 65; field += 1) {
        crowded.append(`f${String(field)}`, 'x');
      }

      await expect(operate('actions/todos', 'createTodo', [file], BUILD)).rejects.toThrow(
        TypeError,
      );
      await expect(operate('actions/todos', 'createTodo', [crowded], BUILD)).rejects.toThrow(
        RangeError,
      );
      await expect(
        operate('actions/todos', 'createTodo', [Symbol('no JSON')], BUILD),
      ).rejects.toThrow(TypeError);
      expect(hoisted.client['operate']).not.toHaveBeenCalled();
    });

    it('runs the operation all the same where nothing is rendered again', async () => {
      hoisted.client['operate']?.mockResolvedValue(operated(1));
      hoisted.refresh.mockImplementation(() => {
        throw new Error('refresh can only be called from within Server Actions.');
      });

      await expect(operate('actions/todos', 'createTodo', ['p1'], BUILD)).resolves.toBe(1);
    });
  });

  describe('publicView', () => {
    it('answers a record’s public fields, and throws for a refusal', async () => {
      const view = {
        id: 'main',
        resultVersion: 'v',
        revision: 2,
        table: 'counters',
        values: { count: 4 },
      };
      hoisted.client['publicView']
        ?.mockResolvedValueOnce({ ok: true, value: view })
        .mockResolvedValueOnce(refusal(404, 'NOT_FOUND', 'No such table.'));

      await expect(publicView('counters', 'main')).resolves.toStrictEqual(view);
      await expect(publicView('secrets', 'x')).rejects.toThrow(/404 NOT_FOUND/u);
    });
  });
});
