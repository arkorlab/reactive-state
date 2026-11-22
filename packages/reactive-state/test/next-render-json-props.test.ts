import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';

import { SCOPE } from '../src/authority/tree.ts';
import { type Elements, renderTree } from '../src/next/render.ts';
import { type Json, moduleRef, type Rendered } from '../src/program.ts';

/**
 * A prop's JSON and what is rendered, as the host tells them apart: by `kind` alone (`render.ts`),
 * which is sound of what the authority hands it — where a component is rendered, the authority
 * refuses a prop's JSON of a kind the host reads as rendered, wherever the prop holds it
 * (`tree.ts`), and hands on JSON of any other `kind` as it is. Both ends of that, pinned: every row
 * here passed before it was written down.
 */

/** The kinds the host reads a prop's object as something rendered by, or as an action. */
const HOST_KINDS = ['action', 'client', 'element', 'fragment', 'module'] as const;

/** Where a prop holds an object of a kind. */
const HELD = [
  { id: 'as-the-prop', of: (kind: string): Json => ({ kind, label: 'note' }) },
  { id: 'in-a-list', of: (kind: string): Json => [{ kind, label: 'note' }] },
  { id: 'within-an-object', of: (kind: string): Json => ({ items: [{ kind }] }) },
] as const;

const CARD = moduleRef('@/components/card', 'Card');

const ELEMENTS: Elements = { actions: {}, build: 'build', clients: {}, modules: {} };

describe.each(HOST_KINDS)(
  'a prop’s JSON of the kind `%s`, which the host reads as rendered',
  (kind) => {
    it.each(HELD)('is refused where it is rendered: $id', ({ of }) => {
      expect(() => SCOPE.h('section', { note: of(kind) })).toThrow('reads as something rendered');
      expect(() => SCOPE.h(CARD, { note: of(kind) })).toThrow('reads as something rendered');
    });
  },
);

describe('a prop’s JSON of a kind the host reads as nothing rendered', () => {
  it.each([
    { id: 'text', note: { kind: 'text', value: 'hi' } },
    { id: 'note', note: { kind: 'note', label: 'note' } },
    { id: 'a-list-of-them', note: [{ kind: 'text', value: 'hi' }, { kind: 'note' }] },
    { id: 'a-kind-that-is-no-text', note: { kind: ['element'], label: 'note' } },
  ])('reaches the element it is a prop of as it is: $id', ({ note }) => {
    const rendered = renderTree(SCOPE.h('section', { note }) as Rendered, ELEMENTS);

    expect(isValidElement(rendered) && rendered.props).toStrictEqual({ note });
  });
});
