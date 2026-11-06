import { describe, expect, it } from 'vitest';

import type { Rendered, RenderedClient, RenderedElement, RenderedProps } from '../src/program.ts';
import { clientsIn, textOf } from './support/frames.ts';

/** A `<section>` of `props`, holding `children`, as the authority renders one. */
function section(props: RenderedProps, children: readonly Rendered[]): RenderedElement {
  return { children, key: null, kind: 'element', props, type: 'section' };
}

/** A client part of nothing. */
const NOTE: RenderedClient = {
  component: 'components/note',
  key: null,
  kind: 'client',
  part: { props: {}, slots: {}, states: {} },
};

describe('what the suites read of the props of a tree', () => {
  it('reads JSON of a `kind` no node is as the JSON it is', () => {
    const tree = section({ note: { kind: 'note', text: 'kept' } }, ['shown']);

    expect(textOf(tree)).toBe('shown');
    expect(clientsIn(tree)).toStrictEqual([]);
  });

  it('reads the nodes of a list a prop holds, those of a list in it included, and no list of JSON', () => {
    const tree = section({ fallback: [[NOTE], 'Loading'], tags: ['a', 'b'] }, ['shown']);

    expect(clientsIn(tree)).toStrictEqual([NOTE]);
    expect(textOf(tree)).toBe('shownLoading');
  });
});
