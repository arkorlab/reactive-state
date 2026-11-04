import { type Expression, isIdentifier, isVariableStatement } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { globalCalleePath } from '../src/compiler/throw-callees.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('the global a callee aliases', () => {
  it.each([
    'const left = right; const right = left; const callee = left;',
    'const box = box.member; const callee = box.run;',
    'const left = right.member; const right = left.other; const callee = left.run;',
  ])('finishes following a cycle without inventing a global: %s', (source) => {
    expect(pathOf(source)).toBeUndefined();
  });
});

/** What a selected callee reads while following source, without running cyclic initializers. */
function pathOf(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'callees.ts', source);
  const declarations = new Map<string, Expression>();
  for (const statement of parsed.sourceFile.statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const each of statement.declarationList.declarations) {
      if (isIdentifier(each.name) && each.initializer !== undefined) {
        declarations.set(each.name.text, each.initializer);
      }
    }
  }
  const callee = declarations.get('callee');
  if (callee === undefined) {
    throw new Error('The fixture declares the callee.');
  }
  return globalCalleePath(callee, (name) => declarations.get(name.text));
}
