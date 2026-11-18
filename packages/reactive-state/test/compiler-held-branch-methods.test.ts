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
 * A held value returned by a factory or chosen across branches may come from any return statement
 * or branch expression, and `methodsOf` keeps every candidate method body for each key so
 * `writesThis` reports a write when any branch's method writes through `this`.
 */
const CASES = [
  {
    id: 'factory-early-return-writes-later-noop',
    source:
      'function make(flag: boolean) { if (flag) return { n: 0, bump() { this.n++; } }; return { bump() {} }; } const counter = make(true); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'factory-early-class-instance-writes-later-noop',
    source:
      'class Active { n = 0; bump() { this.n++; } } class Idle { bump() {} } function make(flag: boolean) { if (flag) return new Active(); return new Idle(); } const counter = make(true); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'factory-conditional-return-writes',
    source:
      'function make(flag: boolean) { return flag ? { n: 0, bump() { this.n++; } } : { bump() {} }; } const counter = make(true); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'factory-logical-return-writes',
    source:
      'function make(fallback?: { bump(): void }) { return ({ n: 0, bump() { this.n++; } } as { bump(): void } | undefined) ?? (fallback ?? { bump() {} }); } const counter = make(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'held-conditional-initializer-writes',
    source:
      'declare const flag: boolean; const counter = flag ? { n: 0, bump() { this.n++; } } : { bump() {} }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'factory-returned-local-constant-writes',
    source:
      'function make() { const built = { n: 0, bump() { this.n++; } }; return built; } const counter = make(); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'factory-later-return-writes-pin',
    source:
      'function make(flag: boolean) { if (flag) return { bump() {} }; return { n: 0, bump() { this.n++; } }; } const counter = make(false); export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'factory-both-branches-pure-pin',
    source:
      'function make(flag: boolean) { if (flag) return { n: 1, bump() { return this.n; } }; return { n: 2, bump() { return this.n; } }; } const counter = make(true); export function run() { return counter.bump(); }',
    writes: false,
  },
  {
    id: 'subclass-override-replaces-base-write-pin',
    source:
      'class Base { n = 0; bump() { this.n++; } } class Child extends Base { bump() {} } const counter = new Child(); export function run() { counter.bump(); }',
    writes: false,
  },
] as const;

/** The method call inside `run` in `root`. */
function runCall(root: Node): CallExpression {
  for (const statement of isFunctionBodyStatements(root)) {
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

/** The top-level statements of `export function run()`. */
function isFunctionBodyStatements(root: Node): readonly Node[] {
  const statements: Node[] = [];
  root.forEachChild((node) => {
    if (isFunctionDeclaration(node) && node.name?.text === 'run' && node.body !== undefined) {
      statements.push(...node.body.statements);
    }
  });
  return statements;
}

describe('held method candidates across factory return paths and branches', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'held-branch-methods.ts', source);
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
