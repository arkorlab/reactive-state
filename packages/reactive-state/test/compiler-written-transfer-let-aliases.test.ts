import {
  type CallExpression,
  isCallExpression,
  isFunctionDeclaration,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rootOf } from '../src/compiler/kept.ts';
import { keptWrite } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenArgumentBy } from '../src/compiler/written.ts';

interface TransferAliasCase {
  /** The roots `writtenArgumentBy` reports for the call, sorted. */
  readonly argumentRoots: readonly string[];
  readonly body: string;
  readonly id: string;
  /** The module-held name `keptWrite` finds the call to write, which a shared module may not. */
  readonly keptRoot: string | undefined;
}

/**
 * A transfer list or an options object held by a `let` or `var` variable of a function keeps the
 * module-owned buffers its initializer and every value assigned to it name: the call detaches them,
 * so the first call of the function answers otherwise than the second, which throws.
 */
const TRANSFER_ALIAS_CASES: readonly TransferAliasCase[] = [
  {
    id: 'let-list-initializer',
    body: 'let list = [sharedBuffer]; structuredClone(null, { transfer: list });',
    argumentRoots: ['list', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'var-list-initializer',
    body: 'var list = [sharedBuffer]; structuredClone(null, { transfer: list });',
    argumentRoots: ['list', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-list-assigned-after-empty-initializer',
    body: 'let list: ArrayBuffer[] = []; list = [sharedBuffer]; structuredClone(null, { transfer: list });',
    argumentRoots: ['list', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-list-assigned-in-a-branch',
    body: 'let list: ArrayBuffer[] = [new ArrayBuffer(1)]; if (flag) { list = [sharedBuffer]; } structuredClone(null, { transfer: list });',
    argumentRoots: ['list', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-list-declared-without-initializer',
    body: 'let list: ArrayBuffer[]; list = [sharedBuffer]; structuredClone(null, { transfer: list });',
    argumentRoots: ['list', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-list-of-a-let-list',
    body: 'let inner = [sharedBuffer]; let list = inner; structuredClone(null, { transfer: list });',
    argumentRoots: ['inner', 'list', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-list-spread-into-a-literal',
    body: 'let more = [sharedBuffer]; structuredClone(null, { transfer: [...more] });',
    argumentRoots: ['more', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-entry-of-a-literal',
    body: 'let entry = sharedBuffer; structuredClone(null, { transfer: [entry] });',
    argumentRoots: ['entry', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-list-shorthand-transfer',
    body: 'let transfer = [sharedBuffer]; structuredClone(null, { transfer });',
    argumentRoots: ['sharedBuffer', 'transfer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-options-initializer',
    body: 'let options: StructuredSerializeOptions = { transfer: [sharedBuffer] }; structuredClone(null, options);',
    argumentRoots: ['options', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-options-assigned-after-empty-initializer',
    body: 'let options: StructuredSerializeOptions = {}; options = { transfer: [sharedBuffer] }; structuredClone(null, options);',
    argumentRoots: ['options', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-options-holding-a-let-list',
    body: 'let list = [sharedBuffer]; let options = { transfer: list }; structuredClone(null, options);',
    argumentRoots: ['list', 'options', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-options-in-a-branch',
    body: 'let options: StructuredSerializeOptions = {}; if (flag) { options = { transfer: [sharedBuffer] }; } structuredClone(null, options);',
    argumentRoots: ['options', 'sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'const-list-pin',
    body: 'const list = [sharedBuffer]; structuredClone(null, { transfer: list });',
    argumentRoots: ['sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'const-options-pin',
    body: 'const options: StructuredSerializeOptions = { transfer: [sharedBuffer] }; structuredClone(null, options);',
    argumentRoots: ['sharedBuffer'],
    keptRoot: 'sharedBuffer',
  },
  {
    id: 'let-list-of-fresh-buffers-pin',
    body: 'let list = [new ArrayBuffer(8)]; structuredClone(null, { transfer: list });',
    argumentRoots: ['list'],
    keptRoot: undefined,
  },
  {
    id: 'let-empty-list-pin',
    body: 'let list: ArrayBuffer[] = []; structuredClone(null, { transfer: list });',
    argumentRoots: ['list'],
    keptRoot: undefined,
  },
  {
    id: 'let-list-assigned-a-parameter',
    body: 'let list: ArrayBuffer[] = []; list = items; structuredClone(null, { transfer: list });',
    argumentRoots: ['items', 'list'],
    keptRoot: undefined,
  },
  {
    id: 'let-options-without-transfer-pin',
    body: 'let options: StructuredSerializeOptions = {}; structuredClone(null, options);',
    argumentRoots: ['options'],
    keptRoot: undefined,
  },
  {
    id: 'let-list-cloned-not-transferred-pin',
    body: 'let list = [sharedBuffer]; structuredClone({ list }, {});',
    argumentRoots: [],
    keptRoot: undefined,
  },
];

describe('transfer targets held by a let or var list and options', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(TRANSFER_ALIAS_CASES)('$id', ({ argumentRoots, body, keptRoot }) => {
    const source = [
      'const sharedBuffer = new ArrayBuffer(8);',
      'export function run(flag: boolean, items: ArrayBuffer[]): number {',
      `  void flag; void items; ${body}`,
      '  return 0;',
      '}',
    ].join('\n');
    using parsed = parseModule(api, 'written-transfer-let-aliases.ts', source);
    const call = lastCallIn(parsed.sourceFile, 'run');

    expect(call === undefined ? undefined : rootNames(writtenArgumentBy(call))).toStrictEqual(
      argumentRoots,
    );
    expect(call === undefined ? undefined : keptWrite(call)?.text).toBe(keptRoot);
  });
});

/** The sorted root binding names reported for `nodes`. */
function rootNames(nodes: readonly Node[]): readonly string[] {
  const names: string[] = [];
  for (const node of nodes) {
    const root = rootOf(node);
    if (root !== undefined) {
      names.push(root.text);
    }
  }
  return names.toSorted((left, right) => left.localeCompare(right));
}

/** The final call expression inside the named function declaration in `file`. */
function lastCallIn(file: SourceFile, fnName: string): CallExpression | undefined {
  const fn = file.statements.find(
    (statement) => isFunctionDeclaration(statement) && statement.name?.text === fnName,
  );
  if (fn === undefined) {
    return undefined;
  }
  let found: CallExpression | undefined;
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return found;
}
