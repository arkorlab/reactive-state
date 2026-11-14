import {
  type CallExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { defaultArrayComparison } from '../src/compiler/framed-array-sorting.ts';
import { writtenArrayWords } from '../src/compiler/framed-array-word-origins.ts';
import { iteratorPrefixQuiet } from '../src/compiler/framed-iterator-guards.ts';
import { knownUsesOnly } from '../src/compiler/framed-known-mentions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Of the nodes TypeScript counts among the types, `ExpressionWithTypeArguments` is read for what it
 * does where it is the expression a class extends or an instantiation expression, and is a type alone
 * in an `implements` clause or an interface's `extends`: there it names a type, which a value of the
 * same name (`interface values {}` beside `const values = [1, 2]`) is no use of. The parser keeps a
 * name as a type reference, and what is no name (`make()`) as an expression with type arguments.
 */
const PRELUDE =
  'declare const hooks: any; declare const Base: any; declare function make<T = unknown>(...rest: unknown[]): any;';

const MENTIONS = [
  {
    id: 'implements-a-type-named-as-the-constant',
    clause: 'class C implements values {}',
    known: true,
  },
  {
    id: 'implements-with-type-arguments',
    clause: 'class C implements values<string> {}',
    known: true,
  },
  {
    id: 'implements-a-class-expression',
    clause: 'const C = class implements values {}; void C;',
    known: true,
  },
  { id: 'interface-extends-the-type', clause: 'interface J extends values {}', known: true },
  {
    id: 'interface-extends-with-type-arguments',
    clause: 'interface J extends values<string> {}',
    known: true,
  },
  { id: 'implements-no-name-of-a-type', clause: 'class C implements make(values) {}', known: true },
  {
    id: 'interface-extends-no-name-of-a-type',
    clause: 'interface J extends make(values) {}',
    known: true,
  },
  {
    id: 'extends-a-name-with-the-type-as-an-argument',
    clause: 'class C extends Base<values> {}',
    known: true,
  },
  { id: 'extends-the-constant', clause: 'class C extends values {}', known: false },
  {
    id: 'extends-the-constant-with-type-arguments',
    clause: 'class C extends values<string> {}',
    known: false,
  },
  {
    id: 'extends-a-call-that-is-handed-the-constant',
    clause: 'class C extends make(values) {}',
    known: false,
  },
  {
    id: 'extends-an-instantiated-call-that-is-handed-the-constant',
    clause: 'class C extends make<string>(values) {}',
    known: false,
  },
] as const;

describe('a constant a heritage clause names', () => {
  it.each(MENTIONS)('$id', ({ clause, known }) => {
    const source = `${PRELUDE} interface values {} const values = [1, 2]; ${clause} void values.length;`;

    expect(usesKnown(source)).toBe(known);
  });
});

const SORTS = [
  {
    id: 'implements-a-type-named-as-the-alias',
    clause: 'class C implements same {}',
    defaults: false,
  },
  {
    id: 'implements-no-name-of-a-type',
    clause: 'class C implements make(same) {}',
    defaults: false,
  },
  { id: 'interface-extends-the-type', clause: 'interface J extends same {}', defaults: false },
  { id: 'extends-the-alias', clause: 'class C extends same {}', defaults: true },
  {
    id: 'extends-a-call-that-is-handed-the-alias',
    clause: 'class C extends make(same) {}',
    defaults: true,
  },
  {
    id: 'extends-a-name-with-type-arguments-pin',
    clause: 'class C extends Base<string> {}',
    defaults: false,
  },
] as const;

describe('a small array a heritage clause names before it is sorted', () => {
  it.each(SORTS)('$id', ({ clause, defaults }) => {
    const source = `${PRELUDE} interface same {} const single = [1]; const same = single; ${clause} same.sort();`;

    expect(sortsByDefault(source)).toBe(defaults);
  });
});

const WORDS = [
  {
    id: 'implements-a-type-named-as-the-literal',
    clause: 'class C implements words {}',
    written: true,
  },
  {
    id: 'implements-no-name-of-a-type',
    clause: 'class C implements make(words) {}',
    written: true,
  },
  { id: 'interface-extends-the-type', clause: 'interface J extends words {}', written: true },
  { id: 'extends-the-literal', clause: 'class C extends words {}', written: false },
  {
    id: 'extends-a-call-that-is-handed-the-literal',
    clause: 'class C extends make(words) {}',
    written: false,
  },
  {
    id: 'extends-a-name-with-type-arguments-pin',
    clause: 'class C extends Base<string> {}',
    written: true,
  },
] as const;

describe('a literal of words a heritage clause names before it is read', () => {
  it.each(WORDS)('$id', ({ clause, written }) => {
    const source = `${PRELUDE} interface words {} const words = ['a', 'b']; ${clause} void words[0];`;

    expect(wordsWritten(source)).toBe(written);
  });
});

const WINDOWS = [
  { id: 'implements-a-name', clause: 'class C implements Shape {}', quiet: true },
  {
    id: 'implements-with-type-arguments',
    clause: 'class C implements Shape<string> {}',
    quiet: true,
  },
  { id: 'implements-no-name-of-a-type', clause: 'class C implements make() {}', quiet: true },
  {
    id: 'implements-a-member-of-no-type',
    clause: 'class C implements hooks.base() {}',
    quiet: true,
  },
  {
    id: 'interface-extends-no-name-of-a-type',
    clause: 'interface J extends make() {}',
    quiet: true,
  },
  { id: 'extends-a-name-pin', clause: 'class C extends Base {}', quiet: true },
  {
    id: 'extends-a-name-with-type-arguments-pin',
    clause: 'class C extends Base<string> {}',
    quiet: true,
  },
  { id: 'extends-a-call', clause: 'class C extends make() {}', quiet: false },
  { id: 'extends-an-instantiated-call', clause: 'class C extends make<string>() {}', quiet: false },
  {
    id: 'extends-a-call-beside-an-implements-clause',
    clause: 'class C extends make() implements Shape {}',
    quiet: false,
  },
] as const;

describe('a heritage clause between a source and its iterator', () => {
  it.each(WINDOWS)('$id', ({ clause, quiet }) => {
    const source = `${PRELUDE} interface Shape<T = unknown> {} function frames() { const set = new Set([1, 2]); ${clause} return set[Symbol.iterator](); }`;

    expect(windowQuiet(source)).toBe(quiet);
  });
});

function inModule<T>(source: string, read: (file: SourceFile) => T): T {
  using api = openTypeScript();
  using parsed = parseModule(api, 'heritage.ts', source);
  return read(parsed.sourceFile);
}

function usesKnown(source: string): boolean {
  return inModule(source, (file) => {
    return knownUsesOnly(
      find(
        file,
        (node): node is VariableDeclaration =>
          isVariableDeclaration(node) && node.name.getText() === 'values',
      ),
      'array',
    );
  });
}

function sortsByDefault(source: string): boolean {
  return inModule(source, (file) => {
    const call = find(
      file,
      (node): node is CallExpression => isCallExpression(node) && node.getText() === 'same.sort()',
    );
    return defaultArrayComparison(lastNamed(file, 'same'), call, []);
  });
}

function wordsWritten(source: string): boolean {
  return inModule(source, (file) =>
    writtenArrayWords(lastNamed(file, 'words'), { created: () => false, custom: () => false }),
  );
}

function windowQuiet(source: string): boolean {
  return inModule(source, (file) => {
    const created = find(file, (node): node is Expression => isNewExpression(node));
    const acquisition = find(
      file,
      (node): node is CallExpression =>
        isCallExpression(node) && node.getText().includes('Symbol.iterator'),
    );
    return iteratorPrefixQuiet(created, acquisition);
  });
}

function lastNamed(file: SourceFile, name: string): Identifier {
  const found: Identifier[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node) && node.text === name) found.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const last = found.toSorted((one, other) => other.pos - one.pos)[0];
  if (last === undefined) throw new Error(`no ${name}`);
  return last;
}

function find<T extends Node>(root: Node, matches: (node: Node) => node is T): T {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (matches(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no such node');
}
