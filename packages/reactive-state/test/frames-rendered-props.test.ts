import { describe, expect, it } from 'vitest';

import type { Rendered, RenderedElement, RenderedProps } from '../src/program.ts';
import { clientsIn, textOf } from './support/frames.ts';

/** A `<section>` of `props`, holding `children`, as the authority renders one. */
function section(props: RenderedProps, children: readonly Rendered[]): RenderedElement {
  return { children, key: null, kind: 'element', props, type: 'section' };
}

describe('what the suites read of the props of a tree', () => {
  it('reads JSON of a `kind` no node is as the JSON it is', () => {
    const tree = section({ note: { kind: 'note', text: 'kept' } }, ['shown']);

    expect(textOf(tree)).toBe('shown');
    expect(clientsIn(tree)).toStrictEqual([]);
  });
});
