import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Aliased, generic, union, template-literal, member-selected, and asserted primitive string
 * receiver types invoke `String.prototype` methods just like explicit `string` annotations do,
 * while array receivers, custom structural `{ concat(...) }` receivers, and cyclic aliases remain
 * unflagged.
 */

const CASES = [
  {
    framed: true,
    id: 'simple-string-alias-concat-error',
    source: `type Label = string; function text(label: Label, error: Error) { return label.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'simple-string-alias-concat-error-array',
    source: `type Label = string; function text(label: Label, error: Error) { return label.concat([error] as unknown as string); }`,
  },
  {
    framed: true,
    id: 'generic-string-alias-concat-error',
    source: `type Value<T> = T; function text(label: Value<string>, error: Error) { return label.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'defaulted-generic-string-alias',
    source: `type Label<T = string> = T; function text(label: Label, error: Error) { return label.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'string-literal-union-alias',
    source: `type Filter = 'all' | 'active' | 'done'; function text(filter: Filter, error: Error) { return filter.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'optional-string-alias-concat',
    source: `type Label = string; function text(label: Label | undefined, error: Error) { return label?.concat(error as unknown as string) ?? ''; }`,
  },
  {
    framed: true,
    id: 'template-literal-type-alias',
    source: `type Key = \`item:\${string}\`; function text(key: Key, error: Error) { return key.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'intrinsic-uppercase-string-alias',
    source: `type Code = Uppercase<string>; function text(code: Code, error: Error) { return code.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'object-member-aliased-string-receiver',
    source: `type Label = string; interface Box { readonly label: Label } function text(box: Box, error: Error) { return box.label.concat(error as unknown as string); }`,
  },
  {
    framed: true,
    id: 'type-asserted-aliased-string-receiver',
    source: `type Label = string; function text(raw: unknown, error: Error) { return (raw as Label).concat(error as unknown as string); }`,
  },
  {
    framed: false,
    id: 'aliased-string-array-concat-retains-value',
    source: `type Label = string; function count(items: Label[], error: Error) { return items.concat(error as unknown as Label).length; }`,
  },
  {
    framed: false,
    id: 'structural-custom-concat-alias',
    source: `type Holder = { concat(value: unknown): string }; function text(holder: Holder, error: Error) { return holder.concat(error); }`,
  },
  {
    framed: false,
    id: 'union-with-non-string-receiver-remains-unproven',
    source: `type Receiver = string | string[]; function count(receiver: Receiver, error: Error) { return receiver.concat(error as never).length; }`,
  },
  {
    framed: false,
    id: 'recursive-type-alias-terminates',
    source: `type Loop = Loop; function text(loop: Loop, error: Error) { return (loop as { concat(v: unknown): string }).concat(error); }`,
  },
] as const;

describe('aliased string receiver text conversions', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'aliased-string-receivers.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
