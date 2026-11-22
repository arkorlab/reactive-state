import {
  type Expression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { writtenArrayKey } from '../src/compiler/framed-array-functions.ts';
import { framedHeldFields, framedHeldMember } from '../src/compiler/framed-held-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A constant alias of a variable that is assigned again holds the object the variable held where the
 * alias was made, not the variable's initializer: a read through the alias meets what was assigned
 * to the variable before it, and what code writes into the object through either name.
 */
const CASES = [
  {
    id: 'reassigned-before-alias',
    source: `function frames(error: Error) { let box = { x: 0 }; box = { x: error }; const alias = box; return alias.x; }`,
    selects: true,
  },
  {
    id: 'var-reassigned-before-alias',
    source: `function frames(error: Error) { var box = { x: 0 }; box = { x: error }; const alias = box; return alias.x; }`,
    selects: true,
  },
  {
    id: 'alias-of-alias',
    source: `function frames(error: Error) { let box = { x: 0 }; box = { x: error }; const first = box; const alias = first; return alias.x; }`,
    selects: true,
  },
  {
    id: 'asserted-alias',
    source: `function frames(error: Error) { let box = { x: 0 }; box = { x: error }; const alias = box as { x: unknown }; return alias.x; }`,
    selects: true,
  },
  {
    id: 'reassigned-in-a-branch',
    source: `function frames(error: Error, ok: boolean) { let box = { x: 0 }; if (ok) box = { x: error }; const alias = box; return alias.x; }`,
    selects: true,
  },
  {
    id: 'reassigned-in-a-function-called-first',
    source: `function frames(error: Error) { let box = { x: 0 }; const replace = () => { box = { x: error }; }; replace(); const alias = box; return alias.x; }`,
    selects: true,
  },
  {
    id: 'reassigned-and-written',
    source: `function frames(error: Error) { let box = { x: 0 }; box = { x: 1 }; const alias = box; alias.x = error; return alias.x; }`,
    selects: true,
  },
  {
    id: 'initial-error-kept',
    source: `function frames(error: Error) { let box = { x: error }; const alias = box; return alias.x; }`,
    selects: true,
  },
  {
    id: 'initial-error-reassigned-after-alias',
    source: `function frames(error: Error) { let box = { x: error }; const alias = box; box = { x: 0 }; return alias.x; }`,
    selects: true,
  },
  {
    id: 'reassigned-after-alias',
    source: `function frames(error: Error) { let box = { x: 0 }; const alias = box; box = { x: error }; return alias.x; }`,
    selects: false,
  },
  {
    id: 'written-through-alias-read-through-variable',
    source: `function frames(error: Error) { let box = { x: 0 }; const alias = box; alias.x = error; return box.x; }`,
    selects: true,
  },
  {
    id: 'written-through-variable-read-through-alias',
    source: `function frames(error: Error) { let box = { x: 0 }; const alias = box; box.x = error; return alias.x; }`,
    selects: true,
  },
  {
    id: 'reassigned-to-plain-values',
    source: `function frames(error: Error) { let box = { x: 0 }; box = { x: 1 }; const alias = box; return alias.x; }`,
    selects: false,
  },
  {
    id: 'constant-holder',
    source: `function frames(error: Error) { const box = { x: error }; const alias = box; return alias.x; }`,
    selects: true,
  },
  {
    id: 'constant-holder-replaced',
    source: `function frames(error: Error) { const box = { x: error }; box.x = 0; const alias = box; return alias.x; }`,
    selects: false,
  },
] as const;

describe('what a constant alias of a reassigned variable holds', () => {
  it.each(CASES)('$id', ({ source, selects }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'held-alias-captures.ts', source);

    expect(readSelectsError(parsed.sourceFile)).toBe(selects);
  });
});

const FIELDS = [
  {
    id: 'fields-of-a-reassigned-literal',
    source: `function frames(error: Error) { let box = { a: 0 }; box = { b: error }; const alias = box; return alias; }`,
    names: ['b'],
  },
  {
    id: 'fields-through-two-aliases',
    source: `function frames(error: Error) { let box = { a: 0 }; box = { b: error }; const first = box; const alias = first; return alias; }`,
    names: ['b'],
  },
  {
    id: 'fields-reassigned-after-alias',
    source: `function frames(error: Error) { let box = { a: 0 }; const alias = box; box = { b: error }; return alias; }`,
    names: [],
  },
] as const;

describe('which fields a constant alias of a reassigned variable may have', () => {
  it.each(FIELDS)('$id', ({ source, names }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'held-alias-fields.ts', source);

    const read = lastReturned(parsed.sourceFile);
    const alias = isIdentifier(read) ? read : undefined;
    const fields = alias === undefined ? undefined : framedHeldFields(alias, alias);

    expect(new Set(fields?.names)).toStrictEqual(new Set(names));
  });
});

/** The expression the last `return` of the source gives back. */
function lastReturned(root: Node): Expression {
  const pending = [root];
  let read: Expression | undefined;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined) read = node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  if (read === undefined) throw new Error('the source has no return');
  return read;
}

/** Whether the member the last `return` reads may be the `error` parameter, as the walks follow it. */
function readSelectsError(root: Node): boolean {
  return framedHeldMember(lastReturned(root), [], isErrorAt);
}

/** The `error` parameter, selected from a literal by its keys or from a variable that holds it. */
function isErrorAt(value: Expression, keys: readonly string[]): boolean {
  const each = unwrapped(value);
  const [key, ...rest] = keys;
  if (key === undefined) return isIdentifier(each) && each.text === 'error';
  if (isIdentifier(each)) return framedHeldMember(each, keys, isErrorAt);
  if (!isObjectLiteralExpression(each)) return false;
  return each.properties.some((property) => {
    return (
      isPropertyAssignment(property) &&
      writtenArrayKey(property.name) === key &&
      isErrorAt(property.initializer, rest)
    );
  });
}
