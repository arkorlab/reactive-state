import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Written-error factory proofs preserve enclosing unquiet parameter guards across nested factory
 * calls and traverse unsupplied parameter defaults and binding patterns on referenced local
 * helpers and destructured bindings, while keeping quiet outer calls and supplied non-undefined
 * quiet arguments unflagged.
 */

const CASES = [
  {
    framed: true,
    id: 'nested-factory-function-captures-outer-param',
    source: `function make(value: unknown) { function build() { return new Error(String(value)); } return build(); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'nested-arrow-factory-captures-outer-alias',
    source: `function make(value: unknown) { const alias = value; const build = () => new TypeError(String(alias)); return build(); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
  {
    framed: true,
    id: 'multi-level-nested-factories-capture-outer-param',
    source: `function make(value: unknown) { const middle = () => { function inner() { return new RangeError(String(value)); } return inner(); }; return middle(); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'nested-arrow-factory-captures-outer-arguments',
    source: `function make(_value: unknown) { const build = () => new Error(String(arguments[0])); return build(); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
  {
    framed: true,
    id: 'nested-factory-with-quiet-arg-captures-outer',
    source: `function make(value: unknown) { function build(prefix: string) { return new Error(prefix + String(value)); } return build('tag:'); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'branch-memoization-keeps-outer-unquiet-guard',
    source: `function make(value: unknown) { function build() { return new Error(String(value)); } return build(); } function text(flag: boolean, externalError: Error) { const local: Error = flag ? make('safe') : make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'helper-identifier-default-omitted-arg',
    source: `function make(value: unknown) { function format(input = value) { return String(input); } return new Error(format()); } function text(external: Error) { const local: Error = make([external]); return String(local); }`,
  },
  {
    framed: true,
    id: 'helper-identifier-default-undefined-arg',
    source: `function make(value: unknown) { function format(input: unknown = value) { return String(input); } return new Error(format(undefined)); } function text(external: Error) { const local: Error = make([external]); return local.message; }`,
  },
  {
    framed: true,
    id: 'helper-object-destructured-default-omitted-arg',
    source: `function make(value: unknown) { function format({ input = value }: { input?: unknown } = {}) { return String(input); } return new Error(format()); } function text(external: Error) { const local: Error = make([external]); return String(local); }`,
  },
  {
    framed: true,
    id: 'helper-computed-parameter-key-reads-outer-param',
    source: `function make(value: unknown) { function format({ [String(value)]: label = 'ok' }: Record<string, string> = {}) { return label; } return new Error(format()); } function text(external: Error) { const local: Error = make([external]); return local.message; }`,
  },
  {
    framed: true,
    id: 'nested-factory-default-captures-outer-param',
    source: `function make(value: unknown) { function build(input = value) { return new Error(String(input)); } return build(); } function text(external: Error) { const local: Error = make([external]); return String(local); }`,
  },
  {
    framed: true,
    id: 'destructured-const-default-reads-outer-param',
    source: `function make(value: unknown) { const { input = value }: { input?: unknown } = {}; return new Error(String((input as { item: unknown }).item)); } function text(external: Error) { const local: Error = make({ item: external }); return String(local); }`,
  },
  {
    framed: false,
    id: 'nested-factory-with-quiet-outer-arg-preserved',
    source: `function make(label: string) { function build() { return new Error(label); } return build(); } function text() { const local: Error = make('fixed'); return String(local); }`,
  },
  {
    framed: false,
    id: 'nested-factory-ignoring-unquiet-outer-preserved',
    source: `function make(_value: unknown) { function build() { return new Error('fixed'); } return build(); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
  {
    framed: false,
    id: 'helper-default-overridden-by-supplied-quiet-arg',
    source: `function make(value: unknown) { function format(input: unknown = value) { return String(input); } return new Error(format('fixed')); } function text(external: Error) { const local: Error = make([external]); return String(local); }`,
  },
  {
    framed: false,
    id: 'nested-factory-default-overridden-by-quiet-arg',
    source: `function make(value: unknown) { function build(input: unknown = value) { return new Error(String(input)); } return build('fixed'); } function text(external: Error) { const local: Error = make([external]); return local.message; }`,
  },
] as const;

describe('nested factory parameter guards and helper parameter defaults', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'nested-factory-parameters.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
