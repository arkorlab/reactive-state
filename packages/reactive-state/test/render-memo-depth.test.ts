import { describe, expect, it, onTestFinished } from 'vitest';

import { Database } from '../src/authority/database.ts';
import { Call } from '../src/authority/evaluation.ts';
import { Memo } from '../src/authority/memo.ts';
import { nodeSql } from '../src/authority/node-sql.ts';
import { type Renderer, renderRoot } from '../src/authority/render.ts';
import { Tables } from '../src/authority/tables.ts';
import {
  type ComponentProgram,
  componentRef,
  type Json,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../src/program.ts';
import { forbidden } from '../src/server/index.ts';

const BUILD = 'build-1';

/** A program of the build, of no state: `evaluate`. */
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

const CHAIN = componentRef('test/chain');
const UNDER = componentRef('test/under');
const REFUSING = componentRef('test/refusing');

const PROGRAMS = [
  // Itself again, of one less, until none is left: it renders `left` deeper than it stands.
  program('test/chain', (props, $) => {
    const left = Number(props['left']);
    return left === 0 ? 'end' : $.h(CHAIN, { left: left - 1 });
  }),
  // Itself again, of one less, until none is above: then the chain of `left`, one deeper.
  program('test/under', (props, $) => {
    const above = Number(props['above']);
    const left = Number(props['left']);
    return above === 0 ? $.h(CHAIN, { left }) : $.h(UNDER, { above: above - 1, left });
  }),
  // The chain of 63, beside the root, and then beneath one more component.
  program('test/twice', (_props, $) =>
    $.h('div', null, $.h(CHAIN, { left: 63 }), $.h(UNDER, { above: 0, left: 63 })),
  ),
  // A part that renders the chain of `left` in its slot, and then refuses the session (403).
  program('test/refusing', (props, $) => {
    return $.client({
      props: {},
      sites: { d0: { guard: () => forbidden(), inputs: [], render: () => null } },
      slots: { below: $.h(CHAIN, { left: Number(props['left']) }) },
      states: {},
    });
  }),
  // That part, beneath one more component.
  program('test/over-refusing', (props, $) => $.h(REFUSING, { left: Number(props['left']) })),
];

/** A render of one call of Alice's, with `memo`: a database of no table it reads nothing of. */
function rendererOf(memo: Memo): Renderer {
  const definition = { seed: [], tables: new Map() };
  const sql = nodeSql(':memory:');
  const call = new Call('A render', 5000);
  onTestFinished(() => {
    call.close();
    sql.close();
  });
  return {
    buildId: BUILD,
    counts: { evaluations: 0, memoHits: 0, renderQueries: 0, siteRenders: 0 },
    definition,
    evaluatedBy: new Map(),
    instances: 0,
    memo,
    programs: new Map(PROGRAMS.map((each) => [each.component, each])),
    scope: {
      call,
      tables: new Tables(new Database(sql), definition),
      user: () => ({ id: 'alice' }),
    },
    userId: 'alice',
  };
}

/** The root `component` of `props`, rendered with `memo`: the renderer, which counts the render. */
async function render(
  memo: Memo,
  component: string,
  props: Readonly<Record<string, Json>>,
): Promise<Renderer> {
  const renderer = rendererOf(memo);
  await renderRoot(renderer, { component, props });
  return renderer;
}

/** A render's components may render components 64 deep, the root 0 deep: no deeper from the memo. */
describe('the depth of a rendering the memo keeps', () => {
  it('refuses one a later render takes deeper than a render may render', async () => {
    const memo = new Memo();
    // The root, and 64 beneath it: as deep as a render may render.
    await render(memo, 'test/chain', { left: 64 });

    // Beneath one more component, it renders 65 deep: evaluated there, it is refused.
    await expect(render(new Memo(), 'test/under', { above: 0, left: 64 })).rejects.toThrow(
      'more than 64 deep',
    );
    await expect(render(memo, 'test/under', { above: 0, left: 64 })).rejects.toThrow(
      'more than 64 deep',
    );
  });

  it('refuses one the same render takes again deeper than a render may render', async () => {
    // The chain of 63 beside the root renders 64 deep; the same one beneath one more, 65.
    await expect(render(new Memo(), 'test/twice', {})).rejects.toThrow('more than 64 deep');
  });

  it('refuses one that refused the session after its components rendered as deep as they may', async () => {
    const memo = new Memo();
    await render(memo, 'test/refusing', { left: 63 });

    // Evaluated beneath one more, its slot renders 65 deep before it refuses.
    await expect(render(memo, 'test/over-refusing', { left: 63 })).rejects.toThrow(
      'more than 64 deep',
    );
  });

  // A pin: this passes before the change, which must not refuse a rendering that fits.
  it('takes one that renders as deep as a render may render where it stands', async () => {
    const memo = new Memo();
    await render(memo, 'test/chain', { left: 62 });

    // Beneath two more components, it renders 64 deep.
    const renderer = await render(memo, 'test/under', { above: 1, left: 62 });

    expect(renderer.counts.memoHits).toBe(1);
  });
});
