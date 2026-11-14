import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isReturnStatement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { arrayWritesUnfollowed } from '../src/compiler/framed-array-elements.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The array a parameter holds is the one it is called with, and the literal of its default only where
 * none is given: the writes made to it in the function are not every write to it. A read of it is
 * refused as the read of an array the compile does not follow, whatever the function does with it;
 * the same body on a constant that holds the literal is followed.
 */
const PARAMETERS = 'error: Error, source: any, consume: (list: any[]) => void, opaque: () => any';

const BODIES = [
  { id: 'handed-to-a-call', body: 'consume(values);', constant: true },
  {
    id: 'aliased-and-handed-to-a-call',
    body: 'const alias = values; consume(alias);',
    constant: true,
  },
  { id: 'assigned-from-a-call', body: 'Object.assign(values, opaque());', constant: true },
  { id: 'pushed-through-apply', body: 'values.push.apply(values, source);', constant: true },
  { id: 'written-by-an-opaque-pattern', body: '[values[0]] = opaque();', constant: false },
  { id: 'untouched-pin', body: '', constant: false },
  { id: 'element-written-pin', body: "values[0] = 'other';", constant: false },
  { id: 'pushed-to-pin', body: 'values.push(error);', constant: false },
  { id: 'read-pin', body: 'void values.length;', constant: false },
  { id: 'method-overridden-pin', body: "values.join = () => 'fixed';", constant: false },
] as const;

describe('the writes to an array a constant holds and to the default of a parameter', () => {
  it.each(BODIES)('$id on a constant', ({ body, constant }) => {
    const source = `function frames(${PARAMETERS}) { const values: any[] = ['safe']; ${body} return values; }`;

    expect(unfollowed(source)).toBe(constant);
  });

  it.each(BODIES)('$id on the default of a parameter', ({ body }) => {
    const source = `function frames(${PARAMETERS}) { function read(values: any[] = ['safe']) { ${body} return values; } return read(); }`;

    expect(unfollowed(source)).toBe(true);
  });

  it.each(BODIES)('$id on the default of a parameter of an arrow', ({ body }) => {
    const source = `function frames(${PARAMETERS}) { const read = (values: any[] = ['safe']) => { ${body} return values; }; return read(); }`;

    expect(unfollowed(source)).toBe(true);
  });
});

const CONVERSIONS = [
  {
    id: 'default-replaced-by-the-argument',
    source: `function frames(${PARAMETERS}) { function read(values: any[] = ['safe']) { return String(values); } return read([error]); }`,
    converts: true,
  },
  {
    id: 'default-handed-to-a-call',
    source: `function frames(${PARAMETERS}) { function read(values: any[] = ['safe']) { consume(values); return String(values); } return read(); }`,
    converts: true,
  },
  {
    id: 'constant-handed-to-a-call',
    source: `function frames(${PARAMETERS}) { const values: any[] = ['safe']; consume(values); return String(values); }`,
    converts: true,
  },
  {
    id: 'constant-not-handed-pin',
    source: `function frames(${PARAMETERS}) { const values: any[] = ['safe']; return String(values); }`,
    converts: false,
  },
  {
    id: 'constant-with-an-error-pin',
    source: `function frames(${PARAMETERS}) { const values: any[] = [error]; return String(values); }`,
    converts: true,
  },
  {
    id: 'array-the-function-makes-pin',
    source: `function frames(${PARAMETERS}) { function read() { const values: any[] = ['safe']; return String(values); } return read(); }`,
    converts: false,
  },
] as const;

describe('text conversion of an array a parameter holds a default for', () => {
  it.each(CONVERSIONS)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the compile does not follow every write to the array the function returns. */
function unfollowed(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'parameter-roots.ts', source);
  const read = returned(parsed.sourceFile);
  return arrayWritesUnfollowed(read, read);
}

function returned(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isReturnStatement(node) &&
      node.expression !== undefined &&
      isIdentifier(node.expression) &&
      node.expression.text === 'values'
    )
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no returned name');
}

/** Whether a conversion of an array to text finds the `error`. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'parameter-roots.ts', source);
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
