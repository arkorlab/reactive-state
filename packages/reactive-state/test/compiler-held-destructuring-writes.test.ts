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
 * A held method that assigns a member of `this` through a destructuring pattern, `({ n: this.n } =
 * source)`, `[this.a, this.b] = [this.b, this.a]`, or the target of a `for…of`, writes through `this`
 * as a plain assignment does; a pattern of local names writes nothing.
 */
const CASES = [
  {
    id: 'object-pattern-member-target',
    source:
      'const counter = { n: 0, bump() { ({ n: this.n } = { n: 1 }); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'array-pattern-member-target',
    source:
      'const counter = { n: 0, bump() { [this.n] = [1]; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'array-swap-of-members',
    source:
      'const counter = { a: 1, b: 2, swap() { [this.a, this.b] = [this.b, this.a]; } }; export function run() { counter.swap(); }',
    writes: true,
  },
  {
    id: 'object-pattern-default-member-target',
    source:
      'const counter = { n: 0, bump() { ({ n: this.n = 5 } = {} as { n?: number }); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'array-rest-member-target',
    source:
      'const counter = { rest: [] as number[], bump() { [, ...this.rest] = [1, 2, 3]; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'nested-pattern-member-target',
    source:
      'const counter = { n: 0, bump() { ({ a: [this.n] } = { a: [1] }); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'for-of-pattern-member-target',
    source:
      'const counter = { n: 0, bump() { for ([this.n] of [[1]]) { break; } } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'pattern-member-target-through-receiver-alias',
    source:
      'const counter = { n: 0, bump() { const self = this; [self.n] = [1]; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'pattern-member-target-in-called-sibling-method',
    source:
      'const counter = { n: 0, bump() { this.store(); }, store() { ({ n: this.n } = { n: 1 }); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'plain-member-assignment-pin',
    source:
      'const counter = { n: 0, bump() { this.n = 1; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'object-pattern-of-local-names-stays-false-pin',
    source:
      'const counter = { n: 0, bump() { let local = 0; ({ n: local } = { n: this.n }); return local; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'array-pattern-of-local-names-stays-false-pin',
    source:
      'const counter = { a: 1, b: 2, swap() { let x = this.a; let y = this.b; [x, y] = [y, x]; return x; } }; export function run() { counter.swap(); }',
    writes: false,
  },
  {
    id: 'shorthand-pattern-of-local-names-stays-false-pin',
    source:
      'const counter = { n: 0, bump() { let n = 0; ({ n } = this); return n; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'pattern-declaration-reading-this-stays-false-pin',
    source:
      'const counter = { n: 0, bump() { const { n } = this; const [first] = [this.n]; return n + first; } }; export function run() { counter.bump(); }',
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

describe('held methods that assign through destructuring patterns', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-destructuring-writes.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
