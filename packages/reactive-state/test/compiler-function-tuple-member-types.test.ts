import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * A tuple type supplies functions through its labeled rest member (`...callbacks: (() => void)[]`),
 * its optional members (`(() => void)?`) and its rest member in a destructured parameter, each as
 * the unlabeled forms do.
 */
const CASES = [
  {
    id: 'labeled-rest-slot-after-head',
    reason: NAME_REASON,
    source:
      'export function out(items: [head: number, ...callbacks: (() => void)[]]) { return items[1]!.name; }',
  },
  {
    id: 'labeled-rest-dynamic-index',
    reason: NAME_REASON,
    source:
      'export function out(items: [head: number, ...callbacks: (() => void)[]], index: number) { return items[index]!.name; }',
  },
  {
    id: 'labeled-rest-after-two-fixed-members',
    reason: NAME_REASON,
    source:
      'export function out(items: [first: number, second: number, ...callbacks: (() => void)[]]) { return items[2]!.name; }',
  },
  {
    id: 'labeled-rest-generic-array',
    reason: NAME_REASON,
    source:
      'export function out(items: [head: number, ...callbacks: Array<() => void>]) { return items[1]!.name; }',
  },
  {
    id: 'labeled-rest-readonly-array',
    reason: NAME_REASON,
    source:
      'export function out(items: [head: number, ...callbacks: readonly (() => void)[]]) { return items[1]!.name; }',
  },
  {
    id: 'labeled-rest-through-const-pattern',
    reason: NAME_REASON,
    source:
      'export function out(items: [head: number, ...callbacks: (() => void)[]]) { const [first, callback] = items; return callback.name; }',
  },
  {
    id: 'optional-unlabeled-member',
    reason: NAME_REASON,
    source: 'export function out(items: [number, (() => void)?]) { return items[1]!.name; }',
  },
  {
    id: 'optional-unlabeled-member-dynamic-index',
    reason: TOSTRING_REASON,
    source:
      'export function out(items: [number, (() => void)?], index: number) { return items[index]!.toString(); }',
  },
  {
    id: 'parameter-pattern-unlabeled-rest',
    reason: NAME_REASON,
    source:
      'export function out([head, callback]: [number, ...(() => void)[]]) { return callback.name; }',
  },
  {
    id: 'parameter-pattern-labeled-rest',
    reason: NAME_REASON,
    source:
      'export function out([head, callback]: [head: number, ...callbacks: (() => void)[]]) { return callback.name; }',
  },
  {
    id: 'parameter-pattern-second-slot-of-rest',
    reason: NAME_REASON,
    source:
      'export function out([head, first, second]: [number, ...(() => void)[]]) { return second.name; }',
  },
  {
    id: 'parameter-pattern-optional-member',
    reason: NAME_REASON,
    source:
      'export function out([head, callback]: [number, (() => void)?]) { return callback!.name; }',
  },
  {
    id: 'unlabeled-rest-through-const-pattern-pin',
    reason: NAME_REASON,
    source:
      'export function out(items: [number, ...(() => void)[]]) { const [first, callback] = items; return callback.name; }',
  },
  {
    id: 'labeled-fixed-function-member-pin',
    reason: NAME_REASON,
    source:
      'export function out(items: [head: number, callback: () => void]) { return items[1]!.name; }',
  },
  {
    id: 'labeled-head-before-function-rest-stays-accepted-pin',
    reason: undefined,
    source:
      'export function out(items: [label: string, ...callbacks: (() => void)[]]) { return items[0]!.toString(); }',
  },
  {
    id: 'labeled-rest-of-strings-stays-accepted-pin',
    reason: undefined,
    source:
      'export function out(items: [head: number, ...names: string[]]) { return items[1]!.toString(); }',
  },
  {
    id: 'parameter-pattern-rest-of-strings-stays-accepted-pin',
    reason: undefined,
    source: 'export function out([head, name]: [number, ...string[]]) { return name.toString(); }',
  },
  {
    id: 'parameter-pattern-head-before-function-rest-stays-accepted-pin',
    reason: undefined,
    source:
      'export function out([label, callback]: [string, ...(() => void)[]]) { return label.toString(); }',
  },
  {
    id: 'optional-string-member-stays-accepted-pin',
    reason: undefined,
    source: 'export function out(items: [number, string?]) { return items[1]!.toString(); }',
  },
] as const;

/** The first `functionRead` diagnostic encountered in `root`. */
function firstFunctionRead(root: Node): string | undefined {
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) {
      return;
    }
    found = functionRead(node);
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  visit(root);
  return found;
}

describe('function types supplied by tuple members', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-tuple-member-types.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
