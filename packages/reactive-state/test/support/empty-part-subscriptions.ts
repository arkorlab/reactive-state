import type { AuthorityEngine } from '../../src/authority/engine.ts';
import type { Application, CommitEvent } from '../../src/authority/model.ts';
import {
  type ComponentProgram,
  componentRef,
  PROTOCOL_VERSION,
  type RenderResult,
} from '../../src/program.ts';
import { db } from './app/db.ts';
import { clientOf, clientsIn, textOf } from './frames.ts';
import { application, BUILD } from './program.ts';

const PARENT = 'test/empty-part-parent';
const CHILD = 'test/empty-part-child';
const BRIDGE = 'test/empty-part-bridge';
const INVALID_LENGTH = 17;

/** A nested list whose first value may be invalid while an explicit view hides it. */
const child: ComponentProgram = {
  buildId: BUILD,
  component: CHILD,
  protocolVersion: PROTOCOL_VERSION,
  evaluate: (props, $) => {
    return $.client({
      props: {},
      sites: {
        d0: {
          each: ({ count }) => {
            return Array.from({ length: count }, (_, index) => {
              return {
                item: index,
                key: index,
                render: () => $.h('span', null, `row:${String(index)}`),
              };
            });
          },
          inputs: ['count'],
        },
      },
      slots: { sibling: $.h('span', null, 'child sibling') },
      states: { count: props['count'] as number },
    });
  },
  updaters: {},
  writable: [],
};

const bridge: ComponentProgram = {
  ...child,
  component: BRIDGE,
  evaluate: (props, $) => $.h(componentRef(CHILD), props),
};
const parent: ComponentProgram = {
  ...child,
  component: PARENT,
  evaluate: async (props, $) => {
    const todo = await db.todos.get('t1');
    return $.client({
      props: {},
      sites: {
        d0: {
          inputs: ['count'],
          render: ({ count }) =>
            $.h(componentRef(props['bridge'] === true ? BRIDGE : CHILD), { count }),
        },
      },
      slots: { live: $.h('p', null, todo?.title ?? 'Missing todo') },
      states: { count: props['initial'] as number },
    });
  },
};

/** A real commit must rerender the same signed view rather than restore the child's first list. */
export const emptyPartApplication: Application = {
  ...application,
  programs: [...application.programs, parent, bridge, child],
  operations: {
    'test/empty-part': {
      retitle: async () => {
        await db.transaction(async () => {
          await db.todos.update('t1', { title: 'Changed subscription title' });
        });
      },
    },
  },
};

interface Case {
  readonly name: string;
  readonly bridge: boolean;
  readonly mode: 'empty' | 'valid' | 'implicit' | 'initial';
  readonly parentRefused: string | undefined;
  readonly childSites: readonly string[];
}

export const emptyPartCases: readonly Case[] = [
  {
    name: 'explicit empty child',
    bridge: false,
    mode: 'empty',
    parentRefused: undefined,
    childSites: [],
  },
  {
    name: 'explicit empty child through bridge',
    bridge: true,
    mode: 'empty',
    parentRefused: undefined,
    childSites: [],
  },
  {
    name: 'explicit valid child',
    bridge: false,
    mode: 'valid',
    parentRefused: undefined,
    childSites: ['d0'],
  },
  {
    name: 'explicit valid child through bridge',
    bridge: true,
    mode: 'valid',
    parentRefused: undefined,
    childSites: ['d0'],
  },
  {
    name: 'implicit invalid child',
    bridge: false,
    mode: 'implicit',
    parentRefused: 'INVALID_VIEW',
    childSites: [],
  },
  {
    name: 'implicit invalid child through bridge',
    bridge: true,
    mode: 'implicit',
    parentRefused: 'INVALID_VIEW',
    childSites: [],
  },
  {
    name: 'unrequested invalid first child',
    bridge: false,
    mode: 'initial',
    parentRefused: undefined,
    childSites: [],
  },
];

function summary(result: RenderResult) {
  return {
    childSites: Object.keys(clientsIn(result.tree, CHILD)[0]?.part.sites ?? {}),
    parentRefused: clientOf(result.tree, PARENT).part.sites?.['d0']?.refused?.code,
    text: textOf(result.tree),
  };
}

/** Initial, signed and event-driven renders over an actual engine and one database commit. */
export async function emptyPartRoundtrip(
  engine: AuthorityEngine,
  selection: Case,
): Promise<{
  readonly shown: ReturnType<typeof summary>;
  readonly after: ReturnType<typeof summary>;
  readonly stableBeforeCommit: boolean;
  readonly dependsOnCommit: boolean;
}> {
  const { sessionId } = await engine.login('alice');
  const first = await engine.render(sessionId, {
    build: BUILD,
    component: PARENT,
    props: { bridge: selection.bridge, initial: selection.mode === 'initial' ? INVALID_LENGTH : 1 },
  });
  const parentId = clientOf(first.tree, PARENT).part.instance ?? '';
  const childId = clientOf(first.tree, CHILD).part.instance ?? '';
  const requested: Record<string, Record<string, { count: number }>> = {};
  if (selection.mode !== 'initial') {
    requested[parentId] = { d0: { count: INVALID_LENGTH } };
  }
  if (selection.mode === 'empty') {
    requested[childId] = {};
  } else if (selection.mode === 'valid') {
    requested[childId] = { d0: { count: 1 } };
  }
  const shown = await engine.view(sessionId, {
    subscription: first.frame.subscription,
    view: requested,
  });
  const watched = await engine.watch(sessionId, shown.frame.subscription);
  const commits: CommitEvent[] = [];
  engine.onCommit((event) => {
    commits.push(event);
  });
  await engine.operate(sessionId, {
    args: [],
    build: BUILD,
    module: 'test/empty-part',
    name: 'retitle',
    operationId: 'op-retitle',
  });
  const committed = commits.at(-1);
  const after = await engine.view(sessionId, { subscription: shown.frame.subscription, view: {} });
  return {
    after: summary(after),
    dependsOnCommit: committed !== undefined && watched.dependsOn(committed),
    shown: summary(shown),
    stableBeforeCommit: watched.digest === watched.issued,
  };
}
