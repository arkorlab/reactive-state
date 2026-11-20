import {
  type Expression,
  isFunctionDeclaration,
  isIdentifier,
  isVariableStatement,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, localsOf } from '../../src/compiler/answers.ts';
import { unwrapped } from '../../src/compiler/bounded.ts';
import {
  followedOf,
  isFunctionValue,
  isMadeNonJson,
  isNonJsonName,
  type JsonReading,
  reached,
} from '../../src/compiler/json-reading.ts';
import { toldChanges } from '../../src/compiler/local-writes.ts';
import { constantNumber } from '../../src/compiler/numbers.ts';

/**
 * What a suite of the writes into a constant needs: the answer `toldChanges` gives of `const target
 * = …` in a function `build`, read with a check that refuses the numbers, functions, classes and
 * names that no JSON holds, as the checks of what an initializer holds do.
 */

/** Whether `node` is a value no JSON holds: a number that is not finite, a function, a class's. */
function isSimpleNonJson(node: Expression, reading: JsonReading): boolean {
  const follow = followedOf(reading);
  const numeric = isIdentifier(unwrapped(node)) ? undefined : constantNumber(node, follow);
  if (numeric !== undefined) {
    return !Number.isFinite(numeric);
  }
  const { at, value } = reached(node, reading);
  const held = constantNumber(value, follow);
  if (held !== undefined) {
    return !Number.isFinite(held);
  }
  if (isIdentifier(value)) {
    return isNonJsonName(value, at);
  }
  return isFunctionValue(value) || isMadeNonJson(value);
}

/** The `const target` of the first function in `file`, and that function. */
function findTarget(file: SourceFile): {
  readonly fn: Answering;
  readonly target: VariableDeclaration;
} {
  const fn = file.statements.find((statement) => isFunctionDeclaration(statement));
  if (fn?.body === undefined) {
    throw new Error('expected function build');
  }
  for (const statement of fn.body.statements) {
    if (isVariableStatement(statement)) {
      const found = statement.declarationList.declarations.find(
        (each) => isIdentifier(each.name) && each.name.text === 'target',
      );
      if (found !== undefined) {
        return { fn, target: found };
      }
    }
  }
  throw new Error('expected target declaration');
}

/** The top-level function declarations of `file`, by name. */
function fileFunctions(file: SourceFile): ReadonlyMap<string, Answering> {
  const functions = new Map<string, Answering>();
  for (const statement of file.statements) {
    if (isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.set(statement.name.text, statement);
    }
  }
  return functions;
}

/** Whether the code of `file` changes the `const target` its first function declares. */
export function targetChanged(file: SourceFile): boolean {
  const { fn, target } = findTarget(file);
  if (target.initializer === undefined) {
    throw new Error('expected target initializer');
  }
  const locals = localsOf(fn);
  const functions = fileFunctions(file);
  const base: JsonReading = {
    follow: (name) => locals.constants.get(name.text),
  };
  const { changes } = toldChanges(
    base,
    () => ({ functionOf: (callee) => functions.get(isIdentifier(callee) ? callee.text : '') }),
    isSimpleNonJson,
  );
  return changes(target.initializer);
}
