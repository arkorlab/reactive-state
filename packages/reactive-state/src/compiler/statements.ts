import {
  type ArrayBindingPattern,
  type ArrowFunction,
  type BindingName,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Identifier,
  isArrayBindingPattern,
  isArrowFunction,
  isBindingElement,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isObjectBindingPattern,
  isOmittedExpression,
  isParenthesizedExpression,
  isVariableStatement,
  type SourceFile,
  type Statement,
  type VariableDeclaration,
  type VariableStatement,
} from 'typescript/ast';

import type { Fail } from './errors.ts';
import { INTRINSIC } from './imports.ts';

/**
 * The statements that declare state, in a component or in a custom hook: `useReactiveState` itself,
 * and a custom hook's call, each declared on its own with `const`. Any other form of either is
 * refused where it stands rather than read past.
 */

/** `const [value, setValue] = useReactiveState(input)`, or `const [value] = …`. */
export interface StateDeclaration {
  readonly kind: 'state';
  readonly statement: VariableStatement;
  readonly call: CallExpression;
  readonly input: Expression;
  readonly value: Identifier;
  readonly setter: Identifier | undefined;
}

/** How a custom hook's call names what the hook returns. */
type HookBinding =
  /** `const value = useHook(…)`: what the hook returns, whole. */
  | { readonly kind: 'whole'; readonly name: Identifier }
  /** `const [a, b] = useHook(…)`, `const { a, b: c } = useHook(…)`: each name by its item. */
  | {
      readonly kind: 'items';
      readonly names: ReadonlyMap<string, Identifier>;
      /** Whether the items are named by property, `{ a, b }`, or by place, `[a, b]`. */
      readonly object: boolean;
    };

/** `const [estimate, increase] = useEstimate(ref.estimate, step)`. */
export interface HookCallStatement {
  readonly kind: 'hook';
  readonly statement: VariableStatement;
  readonly call: CallExpression;
  /** The hook, as the caller names it. */
  readonly callee: Identifier;
  readonly binding: HookBinding;
}

export type StateStatement = HookCallStatement | StateDeclaration;

/** What a statement is read with: its file, and whether a name calls a custom hook. */
export interface Reading {
  readonly sourceFile: SourceFile;
  /** Whether `name`, read where a statement calls it, is a custom hook that declares state. */
  readonly isHook: (name: Identifier) => boolean;
}

const STATE_ALONE =
  'State is declared on its own, with `const`: `const [value, setValue] = useReactiveState(initial)`, or `const [value] = …` where the state is read alone.';

/**
 * The state `statement` declares, or `null` where it declares none. A statement that declares one in
 * any other form is refused.
 */
export function stateStatementOf(
  statement: Statement | undefined,
  reading: Reading,
  fail: Fail,
): StateStatement | null {
  if (statement === undefined || !isVariableStatement(statement)) {
    return null;
  }
  const [declaration, ...others] = statement.declarationList.declarations;
  const call = declaration?.initializer;
  if (
    declaration === undefined ||
    call === undefined ||
    !isCallExpression(call) ||
    !isIdentifier(call.expression)
  ) {
    return null;
  }
  const callee = call.expression;
  const intrinsic = callee.text === INTRINSIC;
  if (!intrinsic && !reading.isHook(callee)) {
    return null;
  }
  if (others.length > 0 || !isConstant(statement, reading.sourceFile)) {
    return fail(intrinsic ? STATE_ALONE : hookAlone(callee.text), statement);
  }
  if (!intrinsic) {
    return {
      binding: hookBindingOf(declaration.name, callee.text, fail),
      call,
      callee,
      kind: 'hook',
      statement,
    };
  }
  const [input, ...more] = call.arguments;
  const names = isArrayBindingPattern(declaration.name) ? pairOf(declaration.name) : null;
  if (names === null || input === undefined || more.length > 0) {
    return fail(STATE_ALONE, statement);
  }
  return { ...names, call, input, kind: 'state', statement };
}

function hookAlone(name: string): string {
  return `\`${name}\` is called on its own, with \`const\`, as state is declared: \`const [value, update] = ${name}(…)\`.`;
}

/** Whether a statement declares with `const`. */
export function isConstant(statement: VariableStatement, sourceFile: SourceFile): boolean {
  return /^const\s/u.test(statement.declarationList.getText(sourceFile));
}

function pairOf(
  pattern: ArrayBindingPattern,
): { value: Identifier; setter: Identifier | undefined } | null {
  const names = pattern.elements.map((element) => {
    return isBindingElement(element) &&
      element.name !== undefined &&
      isIdentifier(element.name) &&
      element.initializer === undefined &&
      element.dotDotDotToken === undefined
      ? element.name
      : undefined;
  });
  const [value, setter, ...more] = names;
  if (value === undefined || more.length > 0 || (setter === undefined && names.length > 1)) {
    return null;
  }
  return { setter, value };
}

/** How a custom hook's call names what it returns: whole, or each item by its index or its name. */
function hookBindingOf(name: BindingName, hook: string, fail: Fail): HookBinding {
  if (isIdentifier(name)) {
    return { kind: 'whole', name };
  }
  const names = new Map<string, Identifier>();
  const refuse = (): never => {
    return fail(
      `What \`${hook}\` returns is named by plain names, each its own: \`const [a, b] = ${hook}(…)\` or \`const { a, b } = ${hook}(…)\`.`,
      name,
    );
  };
  for (const [index, element] of name.elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (
      !isBindingElement(element) ||
      element.name === undefined ||
      !isIdentifier(element.name) ||
      element.initializer !== undefined ||
      element.dotDotDotToken !== undefined
    ) {
      return refuse();
    }
    let item = String(index);
    if (isObjectBindingPattern(name)) {
      const property = element.propertyName ?? element.name;
      if (!isIdentifier(property)) {
        return refuse();
      }
      item = property.text;
    }
    names.set(item, element.name);
  }
  return { kind: 'items', names, object: isObjectBindingPattern(name) };
}

const AFTER_STATE =
  'After the state come `const` declarations, which the browser computes, and one `return` — nothing else: an authorization written there would run in the browser alone, where it authorizes nothing, so it is refused rather than moved.';

/**
 * A statement after the state: a `const` the browser computes — a value derived from the state, a
 * handler — and nothing else. Whatever else is written there would run in the browser alone.
 */
export function constantOf(statement: Statement, reading: Reading, fail: Fail): VariableStatement {
  if (stateStatementOf(statement, reading, fail) !== null) {
    return fail(
      'State is declared in one run, after the code the authority runs and before anything the browser computes from it.',
      statement,
    );
  }
  if (!isVariableStatement(statement) || !isConstant(statement, reading.sourceFile)) {
    return fail(AFTER_STATE, statement);
  }
  return statement;
}

/** The function a constant holds, written there: `const increase = () => …`. */
export function functionOf(
  declaration: VariableDeclaration,
): ArrowFunction | FunctionExpression | undefined {
  let initializer = declaration.initializer;
  while (initializer !== undefined && isParenthesizedExpression(initializer)) {
    initializer = initializer.expression;
  }
  return initializer !== undefined &&
    (isArrowFunction(initializer) || isFunctionExpression(initializer))
    ? initializer
    : undefined;
}
