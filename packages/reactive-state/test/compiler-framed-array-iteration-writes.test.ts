import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A write that holds a read among its operands makes its change after the read where it evaluates that
 * part first: the operands of a call, the key and the right of an assignment, the iterable of a loop.
 * Where the read lies in a part it evaluates after (the body of a loop, a default of a later element of a
 * pattern, the left of a pattern), the write has been made, and is an element the read joins.
 */
const CASES = [
  {
    id: 'for-of-body-reads-the-iteration-write',
    source: `function frames(error: Error) { const a: unknown[] = []; for (a[0] of [error]) { String(a); } return a; }`,
    converts: true,
  },
  {
    id: 'for-of-body-reads-after-two-iterations',
    source: `function frames(error: Error) { const a: unknown[] = []; for (a[0] of [error, error]) { String(a); } return a; }`,
    converts: true,
  },
  {
    id: 'for-of-body-reads-through-a-block',
    source: `function frames(error: Error) { const a: unknown[] = []; for (a[0] of [error]) { const text = String(a); void text; } return a; }`,
    converts: true,
  },
  {
    id: 'for-of-pattern-target-body-reads',
    source: `function frames(error: Error) { const a: unknown[] = []; for ([a[0]] of [[error]]) { String(a); } return a; }`,
    converts: true,
  },
  {
    id: 'for-of-object-pattern-target-body-reads',
    source: `function frames(error: Error) { const a: unknown[] = []; for ({ x: a[0] } of [{ x: error }]) { String(a); } return a; }`,
    converts: true,
  },
  {
    id: 'for-of-body-reads-the-write-after-it',
    source: `function frames(error: Error) { const a: unknown[] = []; for (a[0] of [error]) { } String(a); return a; }`,
    converts: true,
  },
  {
    id: 'for-of-iterable-reads-before-any-write',
    source: `function frames(error: Error) { const a: unknown[] = []; for (a[0] of [(String(a), error)]) { } return a; }`,
    converts: false,
  },
  {
    id: 'pattern-default-of-a-later-element-reads-after-the-first',
    source: `function frames(error: Error) { const a: unknown[] = []; [a[0], a[1] = String(a) as unknown] = [error, undefined]; return a; }`,
    converts: true,
  },
  {
    id: 'pattern-right-reads-before-the-writes',
    source: `function frames(error: Error) { const a: unknown[] = []; [a[0]] = [(String(a), error)]; return a; }`,
    converts: false,
  },
  {
    id: 'object-pattern-default-reads-after-the-first',
    source: `function frames(error: Error) { const a: unknown[] = []; ({ x: a[0], y: a[1] = String(a) as unknown } = { x: error, y: undefined }); return a; }`,
    converts: true,
  },
  {
    id: 'assignment-right-reads-before-the-write',
    source: `function frames(error: Error) { const a: unknown[] = []; a[1] = (String(a), error); return a; }`,
    converts: false,
  },
  {
    id: 'assignment-key-reads-before-the-write',
    source: `function frames(error: Error) { const a: unknown[] = []; a[String(a) as unknown as number] = error; return a; }`,
    converts: false,
  },
  {
    id: 'logical-assignment-right-reads-before-the-write',
    source: `function frames(error: Error) { const a: unknown[] = []; a[0] ||= (String(a), error); return a; }`,
    converts: false,
  },
  {
    id: 'push-arguments-read-before-the-write',
    source: `function frames(error: Error) { const a: unknown[] = []; a.push(String(a), error); return a; }`,
    converts: false,
  },
  {
    id: 'push-receiver-reads-before-the-write',
    source: `function frames(error: Error) { const a: unknown[] = []; (String(a), a).push(error); return a; }`,
    converts: false,
  },
  {
    id: 'assign-source-reads-before-the-write',
    source: `function frames(error: Error) { const a: unknown[] = []; Object.assign(a, { 1: String(a), 2: error }); return a; }`,
    converts: false,
  },
  {
    id: 'read-in-a-later-statement-pin',
    source: `function frames(error: Error) { const a: unknown[] = []; a.push(error); String(a); return a; }`,
    converts: true,
  },
] as const;

describe('a read in the part of a write that runs after it', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'iteration-writes.ts', source);
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
