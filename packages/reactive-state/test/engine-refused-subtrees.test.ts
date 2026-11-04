import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import {
  type ComponentProgram,
  componentRef,
  PROTOCOL_VERSION,
  type View,
} from '../src/program.ts';
import { clientOf, clientsIn } from './support/frames.ts';
import { application, BUILD } from './support/program.ts';

/** Refusing a subtree discards its client instances from the frame and signed baseline. */
const PARENT = 'test/refused-subtree-parent';
const CHILD = 'test/refused-subtree-child';
const TOO_MANY = 17;
const child: ComponentProgram = {
  buildId: BUILD,
  component: CHILD,
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
  evaluate: (props, $) => {
    return $.client({
      props: {},
      slots: {},
      states: { count: props['count'] as number },
      sites: {
        d0: {
          inputs: ['count'],
          each: ({ count }) => {
            return Array.from({ length: count }, (_, key) => {
              return {
                item: key,
                key,
                render: () => $.h('p', null, String(key)),
              };
            });
          },
        },
      },
    });
  },
};
const parent: ComponentProgram = {
  buildId: BUILD,
  component: PARENT,
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
  evaluate: (props, $) => {
    return $.client({
      props: {},
      slots: {},
      states: { ids: ['a'] },
      sites: {
        d0: {
          inputs: ['ids'],
          each: ({ ids }) => {
            return (ids as readonly string[]).map((id) => {
              return {
                item: id,
                key: id,
                render: () => {
                  return $.h(componentRef(CHILD), {
                    count: id === 'bad' && props['fails'] === true ? TOO_MANY : 1,
                  });
                },
              };
            });
          },
        },
      },
    });
  },
};

const WRAPPER = 'test/refused-subtree-wrapper';
const wrapper: ComponentProgram = {
  buildId: BUILD,
  component: WRAPPER,
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
  evaluate: (props, $) =>
    $.h('section', null, $.h(componentRef(CHILD), { count: 1 }), $.h(componentRef(PARENT), props)),
};

/** The signed payload is decoded only to inspect the visible subscription baseline. */
function named(subscription: string): View {
  const encoded = subscription.split('.', 1)[0] ?? '';
  return (JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { readonly view: View }).view;
}

async function open(fails: boolean, wrapped = false) {
  const engine = new Engine({
    ...application,
    programs: [...application.programs, parent, child, wrapper],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  const { sessionId } = await engine.login('alice');
  const first = await engine.render(sessionId, {
    build: BUILD,
    component: wrapped ? WRAPPER : PARENT,
    props: { fails },
  });
  return { engine, first, sessionId };
}

describe('refused subtree subscription baselines', () => {
  it.each([false, true])(
    'drops earlier nested instances, including named child inputs: %s',
    async (requestedChild) => {
      const { engine, first, sessionId } = await open(true);
      const root = clientOf(first.tree, PARENT).part.instance ?? '';
      const nested = clientOf(first.tree, CHILD).part.instance ?? '';
      const view: View = {
        [root]: { d0: { ids: ['a', 'bad'] } },
        ...(requestedChild && { [nested]: { d0: { count: 2 } } }),
      };
      const refused = await engine.view(sessionId, {
        subscription: first.frame.subscription,
        view,
      });

      expect(clientOf(refused.tree, PARENT).part.sites?.['d0']?.refused?.code).toBe('INVALID_VIEW');
      expect(refused.frame.view).toStrictEqual({ [root]: view[root] });
      expect(named(refused.frame.subscription)).toStrictEqual({ [root]: view[root] });
    },
  );

  it('keeps nested instances and named inputs when the complete list succeeds', async () => {
    const { engine, first, sessionId } = await open(false);
    const root = clientOf(first.tree, PARENT).part.instance ?? '';
    const nested = clientOf(first.tree, CHILD).part.instance ?? '';
    const requested = { [root]: { d0: { ids: ['a', 'bad'] } }, [nested]: { d0: { count: 2 } } };
    const shown = await engine.view(sessionId, {
      subscription: first.frame.subscription,
      view: requested,
    });

    expect(clientOf(shown.tree, PARENT).part.sites?.['d0']?.refused).toBeUndefined();
    expect(Object.keys(shown.frame.view)).toHaveLength(3);
    expect(named(shown.frame.subscription)).toStrictEqual(requested);
  });

  it('keeps an earlier sibling outside the refused site', async () => {
    const { engine, first, sessionId } = await open(true, true);
    const root = clientOf(first.tree, PARENT).part.instance ?? '';
    const sibling = clientsIn(first.tree, CHILD)[0]?.part.instance ?? '';
    const view = { [root]: { d0: { ids: ['a', 'bad'] } } };
    const refused = await engine.view(sessionId, { subscription: first.frame.subscription, view });

    expect(refused.frame.view).toStrictEqual({
      [sibling]: first.frame.view[sibling],
      [root]: view[root],
    });
    expect(named(refused.frame.subscription)).toStrictEqual(view);
  });
});
