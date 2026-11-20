import { isVariableStatement } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import type { TopLevel } from '../src/compiler/analyze.ts';
import { bindingIdentifiers } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { heldWriters } from '../src/compiler/writer-values.ts';

describe('the writers held by a value', () => {
  it.each([
    ['const actions = { a: actions.a.b };', []],
    ['const actions = { a: ready ? actions.a.b : { reset: setDraft } };', ['setDraft']],
    ['const [, alias] = [0, actions.a.b]; const actions = { a: alias };', []],
    [
      'const [, alias] = [0, ready ? actions.a.b : { reset: setDraft }]; const actions = { a: alias };',
      ['setDraft'],
    ],
    ['const { ...aliases } = { a: actions.a.b }; const actions = aliases;', []],
    [
      'const { ...aliases } = { a: ready ? actions.a.b : { reset: setDraft } }; const actions = aliases;',
      ['setDraft'],
    ],
    ['const [, ...[alias]] = [0, actions.a.b]; const actions = { a: alias };', []],
    ['const [alias = actions.a.b] = []; const actions = { a: alias };', []],
    [
      'const [alias = ready ? actions.a.b : { reset: setDraft }] = []; const actions = { a: alias };',
      ['setDraft'],
    ],
    [
      'const [, ...[alias]] = [0, ...source]; const source = [actions.a.b]; const actions = { a: alias };',
      [],
    ],
  ] as const)(
    'finishes following a member cycle and retains a separate writer: %s',
    (declaration, expected) => {
      expect(writersOf(declaration)).toStrictEqual(expected);
    },
  );
});

/** What a selected member holds while reading the source, without running its initializers. */
function writersOf(declaration: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'writers.ts', `${declaration}\nconst read = actions.a.reset;`);
  const names = new Map<string, TopLevel>();
  for (const statement of parsed.sourceFile.statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const each of statement.declarationList.declarations) {
      for (const name of bindingIdentifiers(each.name)) {
        names.set(name.text, { declaration: each, kind: 'constant' });
      }
    }
  }
  const read = names.get('read');
  const value = read?.kind === 'constant' ? read.declaration.initializer : undefined;
  if (value === undefined) {
    throw new Error('The fixture declares the member read.');
  }
  return heldWriters(value, names).map((writer) => writer.getText());
}
