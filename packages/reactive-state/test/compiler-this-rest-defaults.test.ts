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
 * When a rest binding sits inside an outer pattern step whose default is proven chosen on an
 * unchanged object-literal receiver (`const { missing: { ...copy } = { items: [] } } = this`),
 * nested members originating from fresh literals in that default do not alias `this` — whereas
 * live receiver members (`{ items: this.live }`) or unchosen defaults still retain `this`.
 */
const CASES = [
  {
    id: 'undefined-property-object-rest-default-nested-push',
    source:
      'const counter = { missing: undefined, bump() { const { missing: { ...copy } = { items: [] as number[] } } = this; copy.items.push(1); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'absent-property-object-rest-default-nested-increment',
    source:
      'const counter: { missing?: { state: { n: number } }; bump(): void } = { bump() { const { missing: { ...copy } = { state: { n: 0 } } } = this; copy.state.n++; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'object-rest-after-sibling-key-in-fresh-default',
    source:
      'const counter = { missing: undefined, bump() { const { missing: { skip, ...copy } = { skip: 0, items: [] as number[] } } = this; void skip; copy.items.push(1); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'destructured-member-of-object-rest-fresh-default',
    source:
      'const counter = { missing: undefined, bump() { const { missing: { ...copy } = { items: [] as number[] } } = this; const { items } = copy; items.push(1); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'array-rest-with-offset-in-fresh-default',
    source:
      'const counter = { missing: undefined, bump() { const { missing: [, ...copy] = [0, [] as number[]] } = this; copy[0]!.push(1); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'nested-pattern-inside-array-rest-with-offset-fresh-default',
    source:
      'const counter = { missing: undefined, bump() { const { missing: [, ...[first]] = [0, { n: 0 }] } = this; first!.n++; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'destructured-live-receiver-member-inside-chosen-default-still-writes',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const { missing = { items: this.live } } = this; const { items } = missing; items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'present-property-object-rest-default-not-chosen-pin',
    source:
      'const counter = { missing: { items: [1] }, bump() { const { missing: { ...copy } = { items: [] as number[] } } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'object-rest-chosen-default-live-member-pin',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const { missing: { ...copy } = { items: this.live } } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'array-rest-offset-chosen-default-live-member-pin',
    source:
      'const counter = { live: [1], missing: undefined, bump() { const { missing: [, ...copy] = [[], this.live] as [number[], number[]] } = this; copy[0]!.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'module-held-default-in-object-rest-pin',
    source:
      'const shared = { items: [1] }; const counter = { missing: undefined, bump() { const { missing: { ...copy } = shared } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
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

describe('fresh defaults around rest bindings on receiver destructuring', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'this-rest-defaults.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
