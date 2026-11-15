import {
  type CallExpression,
  type Identifier,
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
 * A local `const` default referenced in receiver destructuring proves freshness only when that
 * local binding (and any nested local it embeds) has no member writes, mutating calls, escapes or
 * cross-loop reuse that could attach a live receiver reference after initialization.
 */
const CASES = [
  {
    id: 'mutated-member-on-local-default-around-object-rest',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const fresh = { items: [] as number[] }; fresh.items = this.live; const { missing: { ...copy } = fresh } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'mutated-member-on-local-default-non-rest-binding',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const fresh = { items: [] as number[] }; fresh.items = this.live; const { missing = fresh } = this; missing.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'nested-member-write-on-local-default-around-rest',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const fresh = { nested: { items: [] as number[] } }; fresh.nested.items = this.live; const { missing: { ...copy } = fresh } = this; copy.nested.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'array-fill-on-nested-local-default-around-rest',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const fresh = { items: [[] as number[]] }; fresh.items.fill(this.live); const { missing: { ...copy } = fresh } = this; copy.items[0]!.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'object-assign-on-local-default-around-rest',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const fresh = { items: [] as number[] }; Object.assign(fresh, { items: this.live }); const { missing: { ...copy } = fresh } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'escaped-local-default-to-helper-before-rest-destructuring',
    source:
      'function attach(target: { items: number[] }, live: number[]) { target.items = live; } const counter = { live: [1], missing: undefined, bump() { const fresh = { items: [] as number[] }; attach(fresh, this.live); const { missing: { ...copy } = fresh } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'mutated-inner-local-referenced-inside-default-literal',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const items = [[] as number[]]; items[0] = this.live; const { missing: { ...copy } = { items } } = this; copy.items[0]!.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'local-default-reused-across-loop-iterations',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const fresh = { items: [[] as number[]] }; for (const step of [0, 1]) { const { missing = fresh } = this; if (step === 0) { missing.items[0] = this.live; } else { missing.items[0]!.push(2); } } } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'unchanged-local-const-default-around-object-rest-pin',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const fresh = { items: [] as number[] }; const { missing: { ...copy } = fresh } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'unchanged-local-const-default-non-rest-pin',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const fresh = { items: [] as number[] }; const { missing = fresh } = this; missing.items.push(2); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'unchanged-nested-local-const-inside-fresh-default-pin',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const items = [] as number[]; const fresh = { items }; const { missing: { ...copy } = fresh } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'reassigned-let-local-default-around-rest-pin',
    source:
      'const counter = { live: [1], missing: undefined, bump() { let fresh = { items: [] as number[] }; fresh = { items: this.live }; const { missing: { ...copy } = fresh } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
] as const;

/** Extracts the invoked receiver identifier, method name, and call node inside `run()`. */
function runTarget(root: Node): {
  readonly call: CallExpression;
  readonly method: string;
  readonly receiver: Identifier;
} {
  const call = runCall(root);
  const method = methodOf(call);
  const callee = unwrapped(call.expression);
  const receiver =
    isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
      ? unwrapped(callee.expression)
      : undefined;
  if (method === undefined || receiver === undefined || !isIdentifier(receiver)) {
    throw new Error('Expected a receiver identifier call.');
  }
  return { call, method, receiver };
}

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

describe('mutations and escapes of local defaults in receiver destructuring', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'this-mutated-defaults.ts', source);
    const { call, method, receiver } = runTarget(parsed.sourceFile);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
