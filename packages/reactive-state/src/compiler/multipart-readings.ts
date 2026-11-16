import {
  type BinaryExpression,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isConditionalExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isObjectBindingPattern,
  isParameterDeclaration,
  isSourceFile,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedAssignedSources, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { namesType } from './framed.ts';

/** Shared multipart `BodyReading` combinators, parameter value cuts, and `FormData` checks. */

export interface BodyReading {
  readonly bodies: readonly Expression[];
  readonly overwrites: boolean;
}

export interface AnalysisState {
  readonly cuts: { count: number };
  readonly formData: Map<Expression, boolean>;
  readonly readings: Map<Expression, Map<Node, BodyReading>>;
  readonly seen: ReadonlySet<Expression>;
}

export interface ParameterResolution {
  readonly ambiguous?: boolean;
  readonly cut?: BinaryExpression | undefined;
  readonly replaced: boolean;
  readonly values: readonly Expression[];
}

export const EMPTY_BODIES: BodyReading = { bodies: [], overwrites: false };

const FORM_DATA_NAMES: ReadonlySet<string> = new Set(['FormData']);

/** Fresh memoization tables and empty cycle trail for one multipart construction check. */
export function startAnalysis(): AnalysisState {
  return {
    cuts: { count: 0 },
    formData: new Map(),
    readings: new Map(),
    seen: new Set(),
  };
}

/** Deduplicates candidate body expressions by AST node identity. */
export function uniqueExpressions(items: readonly Expression[]): readonly Expression[] {
  return items.length <= 1 ? items : [...new Set(items)];
}

/** Combines an earlier body reading with a spread source that may or may not define `body`. */
export function mergeSpread(previous: BodyReading, spread: BodyReading): BodyReading {
  return {
    bodies: spread.overwrites
      ? uniqueExpressions(spread.bodies)
      : uniqueExpressions([...previous.bodies, ...spread.bodies]),
    overwrites: previous.overwrites || spread.overwrites,
  };
}

/** The alternatives an expression can select as its value, without interpreting its condition. */
export function selectedValues(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse];
  }
  if (isBinaryExpression(value)) {
    if (value.operatorToken.kind === SyntaxKind.CommaToken) {
      return [value.right];
    }
    if (
      [
        SyntaxKind.AmpersandAmpersandToken,
        SyntaxKind.BarBarToken,
        SyntaxKind.QuestionQuestionToken,
      ].includes(value.operatorToken.kind)
    ) {
      return [value.left, value.right];
    }
  }
  return undefined;
}

/** Values assigned to a parameter before `name`, noting whether a definite write replaced the initial binding. */
export function parameterValues(
  name: Identifier,
  parameter: ParameterDeclaration,
): ParameterResolution {
  const owner = executionOwner(name);
  const cut = lastDefiniteParameterWrite(name, parameter, owner);
  const sources = framedAssignedSources(name);
  const assigned = sources.filter((each) => each.keys.length === 0).map((each) => each.value);
  if (cut === undefined) {
    return { ambiguous: sources.length !== assigned.length, replaced: false, values: assigned };
  }
  const laterSources = sources.filter(
    (each) =>
      each.value !== cut.right &&
      (each.value.pos > cut.pos || executionOwner(each.value) !== owner),
  );
  const later = laterSources.filter((each) => each.keys.length === 0).map((each) => each.value);
  return {
    ambiguous: laterSources.length !== later.length,
    cut,
    replaced: true,
    values: [cut.right, ...later],
  };
}

/** Identifier site where `node` directly reads `parameter`, following whole `const` aliases. */
export function parameterCaptureOf(
  node: Expression,
  parameter: ParameterDeclaration,
): Identifier | undefined {
  let current: Expression | undefined = unwrapped(node);
  const seen = new Set<Node>();
  while (current !== undefined && isIdentifier(current) && !seen.has(current)) {
    seen.add(current);
    const declared = frameDeclarationOf(current);
    if (declared === parameter) {
      return isIdentifier(parameter.name) ? current : undefined;
    }
    current = constantAliasValue(declared);
  }
  return undefined;
}

/** Initializer unwrapped from a whole `const` variable declaration; undefined otherwise. */
function constantAliasValue(declared: Node | undefined): Expression | undefined {
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    !isVariableDeclarationList(declared.parent) ||
    !/^const\s/u.test(declared.parent.getText(declared.getSourceFile())) ||
    declared.initializer === undefined
  ) {
    return undefined;
  }
  return unwrapped(declared.initializer);
}

/** Whether a change may run before `point`: from another owner, earlier, or via an enclosing loop. */
export function reachesPoint(
  change: Node,
  name: Identifier,
  parameter: ParameterDeclaration,
  point: Node,
): boolean {
  if (!framedPossibleBranch(change)) {
    return false;
  }
  const owner = executionOwner(point);
  if (
    executionOwner(change) !== owner ||
    change.pos < point.end ||
    destructuredFirst(change, point)
  ) {
    return true;
  }
  return repeatedFrameRead(change, name, parameter, owner);
}

/** Whether `change` ran in the same execution owner strictly before `cut`. */
export function supersededBefore(change: Node, cut: Node, anchor: Node): boolean {
  return change.pos < cut.pos && executionOwner(change) === executionOwner(anchor);
}

/** Whether `change` is an earlier statement of an enclosing block in the same execution owner as `point`. */
export function definitelyBefore(change: Node, point: Node): boolean {
  if (executionOwner(change) !== executionOwner(point)) {
    return false;
  }
  const statement = change.parent;
  if (!isExpressionStatement(statement)) {
    return false;
  }
  const block = statement.parent;
  if (!isBlock(block) && !isSourceFile(block)) {
    return false;
  }
  for (let at: Node = point; !isSourceFile(at); at = at.parent) {
    if (at.parent === block) {
      return at.pos > statement.pos;
    }
  }
  return false;
}

/** Latest plain statement assignment to `name` in an enclosing block before `name`. */
function lastDefiniteParameterWrite(
  name: Identifier,
  parameter: ParameterDeclaration,
  owner: Node,
): BinaryExpression | undefined {
  let latest: BinaryExpression | undefined;
  for (let at: Node = name; at !== owner && !isSourceFile(at); at = at.parent) {
    const parent = at.parent;
    if (!isBlock(parent) && !isSourceFile(parent)) {
      continue;
    }
    for (const statement of parent.statements) {
      if (statement === at) {
        break;
      }
      const write = directParameterWrite(statement, name, parameter, owner);
      if (write !== undefined && (latest === undefined || write.pos > latest.pos)) {
        latest = write;
      }
    }
  }
  return latest;
}

/** Plain `param = rhs` expression statement rebinding `name` in the same execution owner. */
function directParameterWrite(
  statement: Node,
  name: Identifier,
  parameter: ParameterDeclaration,
  owner: Node,
): BinaryExpression | undefined {
  if (!isExpressionStatement(statement)) {
    return undefined;
  }
  const expression = unwrapped(statement.expression);
  if (
    isBinaryExpression(expression) &&
    expression.operatorToken.kind === SyntaxKind.EqualsToken &&
    isIdentifier(expression.left) &&
    expression.left.text === name.text &&
    frameDeclarationOf(expression.left) === parameter &&
    executionOwner(expression) === owner
  ) {
    return expression;
  }
  return undefined;
}

/** Whether a body is FormData the code constructs, assigns, or annotates, memoized across DAGs. */
export function isFormData(node: Expression, state: AnalysisState): boolean {
  const value = unwrapped(node);
  const cached = state.formData.get(value);
  if (cached !== undefined) {
    return cached;
  }
  if (state.seen.has(value)) {
    state.cuts.count += 1;
    return false;
  }
  const cutsBefore = state.cuts.count;
  const following: AnalysisState = { ...state, seen: new Set([...state.seen, value]) };
  const result = computeFormData(value, following);
  if (state.cuts.count === cutsBefore) {
    state.formData.set(value, result);
  }
  return result;
}

/** Evaluates whether one unwrapped body expression may hold `FormData` without consulting cache. */
function computeFormData(value: Expression, following: AnalysisState): boolean {
  if (isIdentifier(value)) {
    return identifierFormData(value, following);
  }
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    return alternatives.some((each) => isFormData(each, following));
  }
  return (
    isNewExpression(value) && globalPathOf(unwrapped(value.expression))?.join('.') === 'FormData'
  );
}

/** Whether a variable or parameter read may hold a `FormData` instance at `name`. */
function identifierFormData(name: Identifier, state: AnalysisState): boolean {
  const selected = frameBindingOf(name);
  if (selected === undefined) {
    return false;
  }
  if (isVariableDeclaration(selected.binding)) {
    return variableFormData(name, selected.binding, selected.keys, state);
  }
  return isParameterDeclaration(selected.binding)
    ? parameterFormData(name, selected.binding, selected.keys, state)
    : false;
}

/** Whether a held, destructured, or defaulted variable read may hold `FormData`. */
function variableFormData(
  name: Identifier,
  declaration: VariableDeclaration,
  keys: readonly string[],
  state: AnalysisState,
): boolean {
  const held = framedHeldValues(name, [], name);
  if (held === undefined) {
    return false;
  }
  const defaulted =
    held.initial !== undefined && bindingDefaultFormData(name, declaration.name, state);
  const entries = held.initial === undefined ? held.held : [held.initial, ...held.held];
  if (entries.length === 0) {
    return defaulted || (keys.length === 0 && namesType(declaration.type, FORM_DATA_NAMES));
  }
  return defaulted || entries.some((entry) => heldFormData(entry, state));
}

/** Whether a parameter read (including parameter or pattern defaults) may hold `FormData`. */
function parameterFormData(
  name: Identifier,
  parameter: ParameterDeclaration,
  keys: readonly string[],
  state: AnalysisState,
): boolean {
  const resolved = parameterValues(name, parameter);
  if (resolved.replaced) {
    return resolved.values.some((each) => isFormData(each, state));
  }
  const paramDefault =
    parameter.initializer !== undefined &&
    heldFormData({ keys, value: parameter.initializer }, state);
  const patternDefault = keys.length > 0 && bindingDefaultFormData(name, parameter.name, state);
  const assigned = framedAssignedSources(name).some((each) => heldFormData(each, state));
  const typed = keys.length === 0 && namesType(parameter.type, FORM_DATA_NAMES);
  return paramDefault || patternDefault || assigned || typed;
}

/** Checks any `BindingElement` default initializer matching `name` within a destructuring pattern. */
function bindingDefaultFormData(
  name: Identifier,
  root: BindingName,
  state: AnalysisState,
): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isBindingElement(node) &&
      isIdentifier(node.name) &&
      node.name.text === name.text &&
      node.initializer !== undefined &&
      isFormData(node.initializer, state)
    ) {
      return true;
    }
    if (isObjectBindingPattern(node) || isArrayBindingPattern(node) || isBindingElement(node)) {
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
  }
  return false;
}

/** Whether a held value or destructured member path may evaluate to `FormData`. */
function heldFormData(entry: Held, state: AnalysisState): boolean {
  if (entry.keys.length === 0) {
    return isFormData(entry.value, state);
  }
  const sources = framedObjectSources(entry.value, entry.keys) ?? [];
  return sources.some((each) => each.keys.length === 0 && isFormData(each.value, state));
}
