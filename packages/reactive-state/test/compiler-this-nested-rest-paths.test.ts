import {
  type CallExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
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
 * Stepping backward through a nested rest or destructuring alias (`const { outer: { ...copy } } =
 * missing`, `const { outer: [, ...copy] } = missing`, `const [, ...[second]] = missing`) must
 * prepend and shift every ancestor binding step onto `state.path` from innermost to outermost so
 * upstream default checks inspect the actual selected member rather than a top-level homonym.
 */
const CASES = [
  {
    id: 'nested-object-rest-on-defaulted-alias-retaining-live-receiver-member',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const { missing = { outer: { items: this.live }, items: [] as number[] } } = this; const { outer: { ...copy } } = missing; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'nested-array-rest-with-offset-on-defaulted-alias-retaining-live-member',
    source:
      "const counter = { live: [1], missing: undefined, bump() { const { missing = { outer: [[] as number[], this.live], '1': [] as number[] } } = this; const { outer: [, ...copy] } = missing; copy[0]!.push(2); } }; export function run() { counter.bump(); }",
    writes: true,
  },
  {
    id: 'nested-object-rest-with-intermediate-default-retaining-live-member',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const { missing = { items: [] as number[] } as { outer?: { items: number[] }; items: number[] } } = this; const { outer: { ...copy } = { items: this.live } } = missing; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'nested-object-rest-with-computed-outer-key-retaining-live-member',
    source:
      "const counter = { live: [1], missing: undefined, bump(key: 'outer') { const { missing = { outer: { items: this.live }, items: [] as number[] } } = this; const { [key]: { ...copy } } = missing; copy.items.push(2); } }; export function run() { counter.bump('outer'); }",
    writes: true,
  },
  {
    id: 'nested-object-rest-on-defaulted-alias-with-fresh-nested-member',
    source:
      'const counter = { missing: undefined, bump() { const { missing = { outer: { items: [] as number[] } } } = this; const { outer: { ...copy } } = missing; copy.items.push(1); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'nested-array-rest-with-offset-on-defaulted-alias-with-fresh-slot',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const { missing = { outer: [this.live, [] as number[]] as [number[], number[]] } } = this; const { outer: [, ...copy] } = missing; copy[0]!.push(1); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'nested-pattern-inside-array-rest-on-defaulted-alias-with-fresh-slot',
    source:
      'const counter = { live: { n: 0 }, missing: undefined, bump() { const { missing = [this.live, { n: 0 }] as [{ n: number }, { n: number }] } = this; const [, ...[second]] = missing; second.n++; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'direct-write-to-nested-rest-container-stays-local-pin',
    source:
      'const counter = { outer: { n: 0 }, bump() { const { outer: { ...copy } } = this; copy.n++; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'retained-member-write-through-nested-rest-on-live-receiver-pin',
    source:
      'const counter = { outer: { items: [1] }, bump() { const { outer: { ...copy } } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'nested-pattern-inside-array-rest-on-defaulted-alias-live-slot-pin',
    source:
      'const counter = { live: { n: 0 }, missing: undefined, bump() { const { missing = [{ n: 0 }, this.live] as [{ n: number }, { n: number }] } = this; const [, ...[second]] = missing; second.n++; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'excluded-sibling-key-on-nested-object-rest-stays-unproven-pin',
    source:
      'const counter = { missing: undefined, bump() { const { missing = { outer: { skip: [] as number[], items: [] as number[] } } } = this; const { outer: { skip, ...copy } } = missing; void skip; (copy as { skip?: number[] }).skip?.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
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
      if (isCallExpression(node) && found === undefined) {
        found = node;
      }
      node.forEachChild(visit);
    };
    visit(statement);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error('Expected call in run()');
}

describe('ancestor binding path tracking across nested rest and destructuring aliases', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'this-nested-rest-paths.ts', source);
    const call = runCall(parsed.sourceFile);
    const method = methodOf(call);
    const callee = unwrapped(call.expression);
    const receiver =
      isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
        ? unwrapped(callee.expression)
        : undefined;
    if (method === undefined || receiver === undefined || !isIdentifier(receiver)) {
      throw new Error('Expected a receiver identifier call.');
    }

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
