import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import {
  type ComponentProgram,
  componentRef,
  type Json,
  PROTOCOL_VERSION,
  type RenderResult,
  type RenderScope,
} from '../src/program.ts';
import { clientOf, textOf } from './support/frames.ts';
import { application, BUILD } from './support/program.ts';

/** Invalid initial lists made by requested parent inputs belong to that parent's refusal. */

const PARENT = 'test/nested-list-parent';
const CHILD = 'test/nested-list-child';
const BRIDGE = 'test/nested-list-bridge';
const TOO_MANY = 17;
const RULES = ['length', 'duplicates', 'item'] as const;

interface Opened {
  readonly engine: Engine;
  readonly session: string;
}

function program(
  component: string,
  evaluate: (props: Readonly<Record<string, Json>>, scope: RenderScope) => unknown,
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

const child = program(CHILD, (props, $) => {
  type Rule = (typeof RULES)[number];

  const count = props['count'] as number;
  const rule = props['rule'] as Rule;
  return $.client({
    props: {},
    sites: {
      d0: {
        each: ({ count: size }) => {
          return Array.from({ length: size }, (_, index) => {
            return {
              item: rule === 'item' && size > 1 ? ((() => index) as unknown as Json) : index,
              key: rule === 'duplicates' ? 'same' : index,
              render: () => $.h('p', null, `row:${String(index)}`),
            };
          });
        },
        inputs: ['count'],
      },
    },
    slots: {},
    states: { count },
  });
});

const bridge = program(BRIDGE, (props, $) => $.h(componentRef(CHILD), props));
const parent = program(PARENT, (props, $) => {
  const site = props['site'] as 'd0' | 'd1';
  const nested = (count: number) =>
    $.h(componentRef(props['bridge'] === true ? BRIDGE : CHILD), { count, rule: props['rule'] });
  const rendering =
    site === 'd0'
      ? { render: ({ count }: { count: number }) => nested(count) }
      : {
          each: ({ count }: { count: number }) => {
            const item = { item: count, key: 'child', render: () => nested(count) };
            return [item];
          },
        };
  return $.client({
    props: {},
    sites: { [site]: { ...rendering, inputs: ['count'] } },
    slots: {},
    states: { count: props['initial'] as number },
  });
});

async function open(): Promise<Opened> {
  const engine = new Engine({
    ...application,
    programs: [...application.programs, parent, bridge, child],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  const session = await engine.login('alice');
  return { engine, session: session.sessionId };
}

async function firstOf(
  engine: Engine,
  session: string,
  props: Readonly<Record<string, Json>> = {},
): Promise<RenderResult> {
  return engine.render(session, {
    build: BUILD,
    component: PARENT,
    props: { bridge: false, initial: 1, rule: 'length', site: 'd0', ...props },
  });
}

async function viewOf(
  { engine, session }: Opened,
  first: RenderResult,
  site: string,
  count: number,
): Promise<RenderResult> {
  const { instance = '' } = clientOf(first.tree, PARENT).part;
  return engine.view(session, {
    subscription: first.frame.subscription,
    view: { [instance]: { [site]: { count } } },
  });
}

describe('initial lists beneath a requested parent site', () => {
  it.each((['d0', 'd1'] as const).flatMap((site) => RULES.map((rule) => ({ rule, site }))))(
    'refuses the parent $site when its previously unseen child violates $rule',
    async ({ rule, site }) => {
      const { engine, session } = await open();
      const first = await firstOf(engine, session, { rule, site });
      const count = rule === 'length' ? TOO_MANY : 2;

      const answered = await viewOf({ engine, session }, first, site, count);

      expect(clientOf(answered.tree, PARENT).part.sites?.[site]).toStrictEqual({
        inputs: { count },
        refused: { code: 'INVALID_VIEW', message: expect.any(String) as unknown },
      });
    },
  );

  it.each([false, true])(
    'refuses requested invalid children previously omitted at first, through a bridge: %s',
    async (throughBridge) => {
      const { engine, session } = await open();
      const first = await firstOf(engine, session, { bridge: throughBridge, initial: TOO_MANY });

      const answered = await viewOf({ engine, session }, first, 'd0', TOO_MANY);

      expect(clientOf(first.tree, CHILD).part.sites ?? {}).toStrictEqual({});
      expect(clientOf(answered.tree, PARENT).part.sites?.['d0']?.refused?.code).toBe(
        'INVALID_VIEW',
      );
    },
  );

  it.each([false, true])(
    'honors explicit child inputs before refusing an unchanged requested parent, through a bridge: %s',
    async (throughBridge) => {
      const { engine, session } = await open();
      const first = await firstOf(engine, session, { bridge: throughBridge, initial: TOO_MANY });
      const parentId = clientOf(first.tree, PARENT).part.instance ?? '';
      const childId = clientOf(first.tree, CHILD).part.instance ?? '';

      const answered = await engine.view(session, {
        subscription: first.frame.subscription,
        view: {
          [parentId]: { d0: { count: TOO_MANY } },
          [childId]: { d0: { count: 1 } },
        },
      });

      expect(textOf(answered.tree)).toBe('row:0');
      expect(clientOf(answered.tree, PARENT).part.sites?.['d0']?.refused).toBeUndefined();
      expect(clientOf(answered.tree, CHILD).part.sites?.['d0']?.items).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'assigns explicitly requested invalid child inputs to the child, through a bridge: %s',
    async (throughBridge) => {
      const { engine, session } = await open();
      const first = await firstOf(engine, session, { bridge: throughBridge, initial: TOO_MANY });
      const parentId = clientOf(first.tree, PARENT).part.instance ?? '';
      const childId = clientOf(first.tree, CHILD).part.instance ?? '';

      const answered = await engine.view(session, {
        subscription: first.frame.subscription,
        view: {
          [parentId]: { d0: { count: TOO_MANY } },
          [childId]: { d0: { count: TOO_MANY } },
        },
      });

      expect(clientOf(answered.tree, PARENT).part.sites?.['d0']?.refused).toBeUndefined();
      expect(clientOf(answered.tree, CHILD).part.sites?.['d0']?.refused).toStrictEqual({
        code: 'INVALID_VIEW',
        message: `The list d0 holds ${String(TOO_MANY)} entries, more than the 16 a site renders.`,
      });
    },
  );

  it('honors an explicit child entry that hides its invalid initial list', async () => {
    const { engine, session } = await open();
    const first = await firstOf(engine, session, { initial: TOO_MANY });
    const parentId = clientOf(first.tree, PARENT).part.instance ?? '';
    const childId = clientOf(first.tree, CHILD).part.instance ?? '';

    const answered = await engine.view(session, {
      subscription: first.frame.subscription,
      view: { [parentId]: { d0: { count: TOO_MANY } }, [childId]: {} },
    });

    expect(clientOf(answered.tree, PARENT).part.sites?.['d0']?.refused).toBeUndefined();
    expect(clientOf(answered.tree, CHILD).part.sites ?? {}).toStrictEqual({});
  });

  it.each(RULES)(
    'keeps a genuine authority-initial invalid $rule list silently absent',
    async (rule) => {
      const { engine, session } = await open();
      const initial = rule === 'length' ? TOO_MANY : 2;

      const first = await firstOf(engine, session, { initial, rule });

      expect(clientOf(first.tree, CHILD).part.sites ?? {}).toStrictEqual({});
      expect(clientOf(first.tree, PARENT).part.sites?.['d0']?.refused).toBeUndefined();
    },
  );

  it.each(['d0', 'd1'])('renders a valid nested list of the requested parent %s', async (site) => {
    const { engine, session } = await open();
    const first = await firstOf(engine, session, { site });

    const answered = await viewOf({ engine, session }, first, site, 2);

    expect(textOf(answered.tree)).toBe('row:0row:1');
    expect(clientOf(answered.tree, CHILD).part.sites?.['d0']?.items).toHaveLength(2);
  });

  it('keeps a valid empty nested list absent without refusing its requested parent', async () => {
    const { engine, session } = await open();
    const first = await firstOf(engine, session);

    const answered = await viewOf({ engine, session }, first, 'd0', 0);

    expect(clientOf(answered.tree, CHILD).part.sites ?? {}).toStrictEqual({});
    expect(clientOf(answered.tree, PARENT).part.sites?.['d0']?.refused).toBeUndefined();
  });
});
