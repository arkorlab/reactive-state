import {
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrowFunction,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isSpreadElement,
  isVariableStatement,
} from 'typescript/ast';

import type { Component } from './analyze.ts';
import { type Answering, answeringOf, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import {
  exportedMember,
  isImportBinding,
  type MemberValue,
  memberPath,
  moduleFunction,
} from './exported-values.ts';
import { metadataCallee } from './input-callees.ts';
import { type CallScope, capturesNothing, type JsonReading, reached } from './json-reading.ts';
import type { Modules } from './modules.ts';
import { ownCallTarget } from './own-call-targets.ts';
import type { SideState } from './reads.ts';
import { isConstant } from './statements.ts';

/**
 * What a name of a component's holds, as its code writes it (`json-values.ts`): a constant's value,
 * of its browser part's or its server part's, whether its server part declares a function of it,
 * what a module it imports declares of one, and the function a call of one calls.
 */

/** What the component reads its names of: its own, and the application's modules. */
type ComponentReading = Pick<SideState, 'component' | 'modules'>;

/**
 * Whether the server part of `component` declares `name` a function: `function name() {}`, or a
 * constant of an arrow, a function or a class.
 */
export function isServerFunction(component: Component, name: string): boolean {
  return component.server.some((statement) => {
    if (isFunctionDeclaration(statement)) {
      return statement.name?.text === name;
    }
    return (
      isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => {
        return (
          isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer !== undefined &&
          isFunctionWritten(unwrapped(declaration.initializer))
        );
      })
    );
  });
}

/**
 * What the constant `name` of `component` holds, as its code writes it: a constant of its browser
 * part's, or one its server part declares with `const` — none of another name, which may hold
 * anything.
 */
export function constantOf(component: Component, name: Identifier): Expression | undefined {
  const declared = component.names.get(name.text);
  if (declared?.kind === 'constant') {
    return isIdentifier(declared.declaration.name) ? declared.declaration.initializer : undefined;
  }
  return declared?.kind === 'server' ? serverConstant(component, name.text) : undefined;
}

/** What the server part's constant `name` holds, declared with `const`; none of another. */
function serverConstant(component: Component, name: string): Expression | undefined {
  const declarations = component.server.flatMap((statement) => {
    return isVariableStatement(statement) && isConstant(statement, component.sourceFile)
      ? statement.declarationList.declarations
      : [];
  });
  const declaration = declarations.find(
    (each) => isIdentifier(each.name) && each.name.text === name,
  );
  return declaration?.initializer;
}

/** Whether `node` is a function the code writes — an arrow, a function, a class. */
function isFunctionWritten(node: Expression): boolean {
  return isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node);
}

/** The function the server part declares as `name`, of its code: `function name() {}`. */
function serverFunctionOf(component: Component, name: string): FunctionDeclaration | undefined {
  return component.server.find((statement): statement is FunctionDeclaration => {
    return (
      isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.body !== undefined
    );
  });
}

/**
 * What a module the component imports declares of what `node` reads: a name it imports, as it is;
 * a member of a module's namespace, `panels.fill`; and an entry of what either holds, of the object
 * or the array its module writes — `payload.when` of `export const payload = { when: … }`
 * (`exportedMember`); none of another.
 */
export function importedOf(state: ComponentReading, node: Expression): MemberValue | undefined {
  const { keys, root } = memberPath(node);
  const entry = isIdentifier(root) ? state.component.names.get(root.text) : undefined;
  if (entry?.kind !== 'import' || entry.binding.typeOnly) {
    return undefined;
  }
  const { binding } = entry;
  const file = binding.module.target.file;
  if (file === undefined) {
    return undefined;
  }
  if (binding.form !== 'namespace') {
    return exportedMember(state.modules, file, binding.exported, keys);
  }
  // `panels.fill`: the member the module exports as `fill`; `panels` alone, an object of them.
  const [exported, ...rest] = keys;
  return exported === undefined ? undefined : exportedMember(state.modules, file, exported, rest);
}

/** Whether `node` reads what the component imports: a name it imports, or a member of one. */
function isImportRooted(state: ComponentReading, node: Expression): boolean {
  const { root } = memberPath(node);
  return isIdentifier(root) && state.component.names.get(root.text)?.kind === 'import';
}

/**
 * The function a call of `callee` calls, of code the compile reads, through the component's
 * constants (`reading`): a shared module's (`importedOf`), one the code writes there or a constant
 * holds, `(() => …)()`, or one the server part declares; none of another.
 */
function functionOf(
  state: ComponentReading,
  callee: Expression,
  reading: JsonReading,
): Answering | undefined {
  const { at, value } = reached(callee, reading);
  const imported = answeringOf(importedOf(state, value));
  if (imported !== undefined) {
    return imported;
  }
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return value;
  }
  const own = ownCallTarget(value, at);
  return own ?? (isIdentifier(value) ? serverFunctionOf(state.component, value.text) : undefined);
}

/**
 * Whether the pattern `node`, which `split` divides text by, may hold a group that captures nothing
 * (`capturesNothing`), read through the constants where it stands and what a shared module declares
 * (`scope`); what a spread hands, anything.
 */
export function patternCapturesNothing(
  scope: CallScope,
  node: Expression,
  reading: JsonReading,
): boolean {
  if (isSpreadElement(node)) {
    return true;
  }
  const { value } = reached(node, reading);
  return capturesNothing(scope.importedOf?.(value) ?? value);
}

/** How a call of the component's code reads what it calls: of its names (`functionOf`). */
export function componentScope(state: ComponentReading): CallScope {
  return {
    functionOf: (callee, reading) => functionOf(state, callee, reading),
    importedOf: (node) => importedOf(state, node),
    isImport: (node) => isImportRooted(state, node),
  };
}

/**
 * How a call of a shared module's function's code reads what it calls, of its module's names: a
 * function written there or a constant holds, or one the module declares, or imports of another
 * module — of an import it reads nothing of, a package's, it tells nothing.
 */
export function moduleScope(modules: Modules): CallScope {
  return {
    functionOf: (callee, reading) => {
      const { value } = reached(callee, reading);
      if (isArrowFunction(value) || isFunctionExpression(value)) {
        return value;
      }
      const own = metadataCallee(value);
      if (own !== undefined && isAnswering(own)) {
        return own;
      }
      return isIdentifier(value) ? moduleFunction(modules, value) : undefined;
    },
    isImport: (node) => {
      const { root } = memberPath(node);
      return isIdentifier(root) && isImportBinding(root);
    },
  };
}
