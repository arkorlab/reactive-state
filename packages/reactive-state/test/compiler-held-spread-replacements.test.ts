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
 * A property of an object literal that a later property of the same name replaces no longer holds
 * the method it had: a method, an arrow, a function by name, a shorthand, a value that is none and
 * an accessor each replace what the object spread before them, and a spread of an object that holds
 * such a property replaces it as well.
 */
const CASES = [
  {
    id: 'arrow-replaces-the-spread-writer',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, bump: () => 0 }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'spread-of-an-arrow-replaces-the-spread-writer',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, ...{ bump: () => 0 } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'spread-of-a-constant-with-an-arrow-replaces-the-spread-writer',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const stubs = { bump: () => 0 }; const counter = { ...base, ...stubs }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'function-by-name-replaces-the-spread-writer',
    source:
      'function noop() { return 0; } const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, bump: noop }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'stubbed-service-method-replaces-the-spread-writer',
    source:
      'const service = { saved: 0, save() { this.saved++; } }; const stub = { ...service, save: () => undefined }; export function run() { stub.save(); }',
    writes: false,
  },
  {
    id: 'shorthand-replaces-the-spread-writer',
    source:
      'const bump = () => 0; const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, bump }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'value-that-is-no-function-replaces-the-spread-writer',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, bump: 0 as unknown as () => void }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'accessor-replaces-the-spread-writer',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, get bump() { return () => 0; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'own-arrow-replaces-an-own-method-of-the-same-name',
    source:
      'const counter = { n: 0, bump() { this.n++; }, bump: () => 0 }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'spread-after-the-replacement-restores-the-writer-pin',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, bump: () => 0, ...base }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'replacement-of-another-key-keeps-the-writer-pin',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, other: () => 0 }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'method-replaces-the-spread-writer-pin',
    source:
      'const base = { n: 0, bump() { this.n++; } }; const counter = { ...base, bump() { return 0; } }; export function run() { counter.bump(); }',
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

describe('held objects whose later properties replace the methods they spread', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-spread-replacements.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
