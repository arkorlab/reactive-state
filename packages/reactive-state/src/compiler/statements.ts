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
  isExpressionWithTypeArguments,
  isFunctionExpression,
  isIdentifier,
  isObjectBindingPattern,
  isOmittedExpression,
  isParenthesizedExpression,
  isTypeAssertion,
  isVariableStatement,
  type Node,
  NodeFlags,
  type SourceFile,
  type Statement,
  type VariableDeclaration,
  type VariableStatement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { Fail } from './errors.ts';
import { INTRINSIC } from './imports.ts';
import { forEachSynchronousCall } from './statement-calls.ts';

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

interface CalledState {
  readonly call: CallExpression;
  readonly callee: Identifier;
  readonly intrinsic: boolean;
}

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
  const direct =
    declaration !== undefined && others.length === 0 && isConstant(statement)
      ? directStateCall(declaration.initializer, reading)
      : undefined;
  const nested = nestedStateCall(statement.declarationList, reading, direct?.call);
  if (nested !== undefined) {
    return fail(nested.intrinsic ? STATE_ALONE : hookAlone(nested.callee.text), statement);
  }
  return direct === undefined || declaration === undefined
    ? null
    : declaredStateOf(statement, declaration, direct, fail);
}

/** The state or custom-hook call an initializer writes directly: `useReactiveState(…)` or `useHook(…)`. */
function directStateCall(
  initializer: Expression | undefined,
  reading: Reading,
): CalledState | undefined {
  if (
    initializer === undefined ||
    !isCallExpression(initializer) ||
    initializer.questionDotToken !== undefined
  ) {
    return undefined;
  }
  const { expression } = initializer;
  if (!isIdentifier(expression)) {
    return undefined;
  }
  const intrinsic = expression.text === INTRINSIC;
  return intrinsic || reading.isHook(expression)
    ? { call: initializer, callee: expression, intrinsic }
    : undefined;
}

/** Any synchronous state or custom-hook call within `root`, other than `allowed` itself. */
function nestedStateCall(
  root: Node,
  reading: Reading,
  allowed: CallExpression | undefined,
): CalledState | undefined {
  let found: CalledState | undefined;
  forEachSynchronousCall(root, (call) => {
    if (call === allowed) {
      return false;
    }
    found = calledState(call, reading);
    return found !== undefined;
  });
  return found;
}

/** The state or custom-hook call `call` makes, unwrapping parentheses or assertions on its callee. */
function calledState(call: CallExpression, reading: Reading): CalledState | undefined {
  let callee = unwrapped(call.expression);
  while (isExpressionWithTypeArguments(callee) || isTypeAssertion(callee)) {
    callee = unwrapped(callee.expression);
  }
  if (!isIdentifier(callee)) {
    return undefined;
  }
  const intrinsic = callee.text === INTRINSIC;
  return intrinsic || reading.isHook(callee) ? { call, callee, intrinsic } : undefined;
}

/** The validated `StateStatement` of a single `const` declarator whose initializer is `direct`. */
function declaredStateOf(
  statement: VariableStatement,
  declaration: VariableDeclaration,
  direct: CalledState,
  fail: Fail,
): StateStatement {
  const { call, callee, intrinsic } = direct;
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
export function isConstant(
  statement: VariableStatement,
  sourceFile?: SourceFile | undefined,
): boolean;
export function isConstant(statement: VariableStatement): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript says `const` in these flags (`AwaitUsing` sets `Const | Using`).
  return (statement.declarationList.flags & NodeFlags.BlockScoped) === NodeFlags.Const;
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
