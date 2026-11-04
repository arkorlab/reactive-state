import {
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isVariableStatement,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { definitionsThrow } from '../src/compiler/throw-definitions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('the written constraints of a property definition', () => {
  it.each([
    [
      'const descriptor = { value: 2 };',
      "Object.defineProperty(Object.freeze({ x: 1 }), 'x', descriptor, descriptor.value = 1);",
      'Object.defineProperty',
    ],
    [
      'const descriptor = { x: { value: 2 } };',
      'Object.defineProperties(Object.freeze({ x: 1 }), descriptor, descriptor.x.value = 1);',
      'Object.defineProperties',
    ],
  ])(
    'defers ignored arguments that change a descriptor before the native call: %s',
    (declaration, call, path) => {
      expect(throwsOf(`${declaration}\n${call}`, path)).toBe(false);
    },
  );
});

/** Whether the parsed native call is refused with the fixture's descriptor constant followed. */
function throwsOf(source: string, path: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'definitions.ts', source);
  const [first, last] = parsed.sourceFile.statements;
  const variable =
    first !== undefined && isVariableStatement(first)
      ? first.declarationList.declarations[0]
      : undefined;
  const invoked = last !== undefined && isExpressionStatement(last) ? last.expression : undefined;
  if (invoked === undefined || variable?.initializer === undefined || !isCallExpression(invoked)) {
    throw new Error('The fixture declares its descriptor and calls the definition operation.');
  }
  return definitionsThrow(path, invoked.arguments, (name) => {
    return isIdentifier(variable.name) && name.text === variable.name.text
      ? variable.initializer
      : undefined;
  });
}
