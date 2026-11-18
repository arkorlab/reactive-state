import {
  type CallExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  type Identifier,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { methodsOf, writesThis } from '../src/compiler/held-methods.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { methodOf, writtenBy } from '../src/compiler/written.ts';

/**
 * An object that spreads another object literal holds the methods it spreads, as its own, with
 * `this` bound to the new object: `{ ...base }` of a `base` whose `bump` counts `this.n` writes
 * through `this` when `bump` is called on it. A later property of the same name replaces an earlier one.
 */
const UNSEEN_SPREAD =
  'declare const base: { bump(): void }; const counter = { ...base, read() { return 1; } }; export function run() { return counter.read(); }';

const CASES = [
  {
    id: 'spread-of-literal-with-writer',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'spread-then-own-method',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, reset() { return 0; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'spread-after-own-method-replaces-it',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { bump() { return 0; }, ...base }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'spread-through-constant-alias',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const alias = base; const counter = { ...alias }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'spread-of-spread',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const middle = { ...base }; const counter = { ...middle }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'spread-of-inline-literal',
    source:
      'const counter = { ...{ n: 0, bump() { this.n++; } } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'spread-writer-called-by-own-method',
    source:
      'const base = { n: 0, step() { this.n++; } }; const counter = { ...base, bump() { this.step(); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'spread-of-function-valued-property',
    source:
      'const base = { n: 0, bump: function () { this.n++; } }; const counter = { ...base }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'own-method-after-spread-replaces-the-writer-pin',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, bump() { return 0; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'spread-of-pure-literal-stays-false-pin',
    source:
      'const base = { n: 0, read() { return this.n; } }; const counter = { ...base }; export function run() { return counter.read(); }',
    writes: false,
  },
  {
    id: 'spread-of-unseen-value-stays-false-known-limit-pin',
    source: UNSEEN_SPREAD,
    writes: false,
  },
] as const;

/** The method call inside `run` in `root`. */
function runCall(root: Node): CallExpression {
  const statements: Node[] = [];
  root.forEachChild((node) => {
    if (isFunctionDeclaration(node) && node.name?.text === 'run' && node.body !== undefined) {
      statements.push(...node.body.statements);
    }
  });
  for (const statement of statements) {
    let found: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (found !== undefined) {
        return;
      }
      if (isCallExpression(node) && methodOf(node) !== undefined) {
        found = node;
        return;
      }
      node.forEachChild(visit);
    };
    visit(statement);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error('Expected a method call in run().');
}

function receiverCallTarget(call: CallExpression): {
  readonly method: string;
  readonly receiver: Identifier;
} {
  const method = methodOf(call);
  const callee = unwrapped(call.expression);
  const receiver =
    isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
      ? unwrapped(callee.expression)
      : undefined;
  if (method === undefined || receiver === undefined || !isIdentifier(receiver)) {
    throw new Error('Expected a receiver identifier call.');
  }
  return { method, receiver };
}

describe('held objects that spread the methods of another object', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-spread-methods.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });

  it('holds no method of a spread of a value the code does not show', () => {
    using parsed = parseModule(api, 'held-spread-methods.ts', UNSEEN_SPREAD);
    const { receiver } = receiverCallTarget(runCall(parsed.sourceFile));

    expect(methodsOf(receiver).has('bump')).toBe(false);
    expect(methodsOf(receiver).has('read')).toBe(true);
  });
});
