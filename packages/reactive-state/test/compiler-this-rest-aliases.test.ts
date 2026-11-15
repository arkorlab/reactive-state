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
 * A rest pattern (`const { ...copy } = this` or `const [...copy] = this.items`) allocates a fresh
 * shallow container whose own top-level slots may be written without changing `this`, whereas its
 * retained object and array members still alias `this` and report a receiver write when mutated.
 */
const CASES = [
  {
    id: 'object-rest-nested-property-write',
    source:
      'const counter = { state: { n: 0 }, bump() { const { ...copy } = this; copy.state.n++; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'object-rest-nested-method-mutation',
    source:
      'const counter = { items: [1], bump() { const { ...copy } = this; copy.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'object-rest-destructured-member-write',
    source:
      'const counter = { state: { n: 0 }, bump() { const { ...copy } = this; const { state } = copy; state.n++; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'object-rest-aliased-nested-write',
    source:
      'const counter = { state: { n: 0 }, bump() { const { ...copy } = this; const alias = copy; alias.state.n++; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'array-rest-element-nested-write',
    source:
      'const counter = { items: [{ n: 0 }], bump() { const [...copy] = this.items; copy[0]!.n++; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'array-rest-nested-pattern-write',
    source:
      'const counter = { items: [{ n: 0 }], bump() { const [...[first]] = this.items; first!.n++; } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'object-rest-top-level-property-write-fresh-pin',
    source:
      'const counter = { n: 0, bump() { const { ...copy } = this; return ++copy.n; } }; export function run() { return counter.bump(); }',
    writes: false,
  },
  {
    id: 'object-rest-assign-container-fresh-pin',
    source:
      'const counter = { n: 0, bump() { const { ...copy } = this; Object.assign(copy, { n: 1 }); return copy.n; } }; export function run() { return counter.bump(); }',
    writes: false,
  },
  {
    id: 'array-rest-push-container-fresh-pin',
    source:
      'const counter = { items: [1], bump() { const [...copy] = this.items; copy.push(2); return copy.length; } }; export function run() { return counter.bump(); }',
    writes: false,
  },
  {
    id: 'nested-object-rest-own-field-fresh-pin',
    source:
      'const counter = { state: { n: 0 }, bump() { const { state: { ...copy } } = this; return ++copy.n; } }; export function run() { return counter.bump(); }',
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

describe('writes through retained nested members of receiver rest copies', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'this-rest-aliases.ts', source);
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
