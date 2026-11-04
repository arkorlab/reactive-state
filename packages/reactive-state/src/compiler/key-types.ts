import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrayTypeNode,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isLiteralTypeNode,
  isNonNullExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSpreadElement,
  isTypeAliasDeclaration,
  isTypeOperatorNode,
  isTypeReferenceNode,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
  type TypeOperatorNode,
  type TypeReferenceNode,
  type VariableDeclaration,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import { unwrapped } from './bounded.ts';
import { callTypes } from './call-types.ts';
import type { Fail } from './errors.ts';
import { literalKey } from './exported-values.ts';
import type { HookDefinition } from './hooks.ts';
import { nonJsonPart } from './json-types.ts';
import { isConstCast, type Kind, kindsOf } from './kinds.ts';
import type { Modules } from './modules.ts';
import type { StateDeclaration } from './statements.ts';
import { memberOf, memberTypes, type WrittenType } from './type-members.ts';
import {
  declarationOf,
  isLanguageType,
  type TypeReading,
  typeReading,
  type TypeSite,
} from './type-names.ts';

/**
 * What a list's key holds, as the code types what it reads: the items of the array the list maps —
 * a state's, a hook's, a prop's, a constant's, as they are or through what keeps their elements,
 * `filter`, `slice`, `toSorted`, a copy — or as the callback types its parameter, and the members of
 * them the key reads. The authority refuses each item of a key but text or a finite number, so a
 * key its type says may be left out, `null`, or of neither — `{ panelId?: string }` — is refused,
 * as the list would never show; one the code computes otherwise is the code's (`slots.ts`).
 */

/** Where a name is read: its names, where its types are written, and how they are read. */
interface Scope {
  readonly names: ReadonlyMap<string, TopLevel>;
  readonly at: TypeSite;
  readonly reading: TypeReading;
  readonly modules: Modules;
  /** The component's props' type; none of a hook's. */
  readonly propsType: TypeNode | undefined;
  /** The names whose types are told otherwise: a list's item. */
  readonly typed: ReadonlyMap<string, KeyType>;
}

/** A type read where it is declared, including a called function's own generic parameters. */
interface KeyType extends WrittenType {
  readonly reading?: TypeReading;
  readonly alternatives?: readonly KeyType[];
}

/** What a component's list is read in: the component, its file, the modules, and what refuses. */
interface KeyContext {
  readonly component: {
    readonly names: ReadonlyMap<string, TopLevel>;
    readonly propsType: TypeNode | undefined;
    readonly sourceFile: SourceFile;
  };
  readonly file: string;
  readonly modules: Modules;
  readonly fail: Fail;
}

/** A list's array, its item and its key, as `sites.ts` reads them. */
interface Listed {
  readonly array: Expression;
  readonly item: Identifier;
  readonly key: Expression;
}

/** The methods that answer an array of elements of the one they are called on. */
const KEEPING: ReadonlySet<string> = new Set([
  'filter',
  'reverse',
  'slice',
  'sort',
  'toReversed',
  'toSorted',
]);

/** The language's arrays: of elements of their argument's values. */
const LANGUAGE_ARRAYS: ReadonlySet<string> = new Set(['Array', 'ReadonlyArray']);

/** The kinds of JSON no key is of, whatever it falls back to. */
const NO_KEYS: readonly Kind[] = ['array', 'boolean', 'object'];

/** How many names and aliases a type is followed through. */
const MAX_FOLLOWED = 16;

/**
 * Of what a key falls back from where it answers nothing: `??`'s left, of `null` and `undefined`;
 * `||`'s, of whatever is false; none.
 */
type Covered = 'falsy' | 'none' | 'nullish';

/**
 * Refuses the key of `list` where the types of what it reads say it may hold what is neither text
 * nor a finite number — `undefined` of a member that may be left out, `null`, `true`, an object —
 * in either answer of `?:`, `&&`, `||`, `??`; the fallback of `??` and `||` answers in their left's
 * place: `panel.panelId ?? panel.todoId`.
 */
export function checkKeyType(list: Listed, context: KeyContext): void {
  const { component, file, modules } = context;
  const scope: Scope = {
    at: { file, sourceFile: component.sourceFile },
    modules,
    names: component.names,
    propsType: component.propsType,
    reading: typeReading(modules),
    typed: new Map(),
  };
  const item = itemType(list, scope);
  const found =
    item === undefined
      ? undefined
      : keyProblem(list.key, { ...scope, typed: new Map([[list.item.text, item]]) }, 'none');
  if (found !== undefined) {
    context.fail(
      `The key of a list's item reads \`${found.getText()}\` here, which its type says may be left out, \`null\`, or neither text nor a number — the authority refuses each item of a key but text or a finite number, so the list would never show. Key the item by what it always holds, an id of its own, or give the key what it falls back to: \`panel.panelId ?? panel.todoId\`.`,
      found,
    );
  }
}

/** The type of `list`'s items: as the callback types its parameter, or of the array it maps. */
function itemType(list: Listed, scope: Scope): KeyType | undefined {
  const { parent } = list.item;
  if (isParameterDeclaration(parent) && parent.type !== undefined) {
    return { at: scope.at, optional: false, type: parent.type };
  }
  const array = declaredType(list.array, scope, 0);
  return array === undefined ? undefined : elementOf(array, array.reading ?? scope.reading, 0);
}

/**
 * What of `key` may hold what no key is, as its types say, as `checkKeyType` reads it: `covered`,
 * what it falls back from where it stands; `onlyFalsy`, the values a conjunction can short with.
 */
function keyProblem(
  key: Expression,
  scope: Scope,
  covered: Covered,
  onlyFalsy = false,
): Node | undefined {
  if (onlyFalsy && covered === 'falsy') {
    return undefined;
  }
  let value = key;
  let falling = covered;
  for (;;) {
    if (isParenthesizedExpression(value) || isSatisfiesExpression(value)) {
      value = value.expression;
    } else if (isNonNullExpression(value)) {
      // `panel.panelId!`: what the code says holds a value.
      falling = falling === 'none' ? 'nullish' : falling;
      value = value.expression;
    } else {
      break;
    }
  }
  if (isConditionalExpression(value)) {
    return (
      keyProblem(value.whenTrue, scope, falling, onlyFalsy) ??
      keyProblem(value.whenFalse, scope, falling, onlyFalsy)
    );
  }
  return isBinaryExpression(value)
    ? operandsProblem(value, scope, falling, onlyFalsy)
    : readProblem(value, scope, falling, onlyFalsy);
}

/** What of the operands of `value` may hold what no key is, where it answers one of them. */
function operandsProblem(
  value: BinaryExpression,
  scope: Scope,
  covered: Covered,
  onlyFalsy: boolean,
): Node | undefined {
  const { left, operatorToken, right } = value;
  const { kind } = operatorToken;
  if (kind === SyntaxKind.QuestionQuestionToken) {
    const fallsBack = covered === 'falsy' ? 'falsy' : 'nullish';
    return (
      keyProblem(left, scope, fallsBack, onlyFalsy) ?? keyProblem(right, scope, covered, onlyFalsy)
    );
  }
  if (kind === SyntaxKind.BarBarToken) {
    return (
      (onlyFalsy ? undefined : keyProblem(left, scope, 'falsy')) ??
      keyProblem(right, scope, covered, onlyFalsy)
    );
  }
  return kind === SyntaxKind.AmpersandAmpersandToken
    ? (keyProblem(left, scope, covered, true) ?? keyProblem(right, scope, covered, onlyFalsy))
    : undefined;
}

/** `value`, where it reads what its type says may be no key — of `null` or `undefined` but where it falls back. */
function readProblem(
  value: Expression,
  scope: Scope,
  covered: Covered,
  onlyFalsy: boolean,
): Node | undefined {
  if (isCallExpression(value)) {
    return callTypes(value.expression, scope).some((type) =>
      typeProblem(type, scope, covered, onlyFalsy),
    )
      ? value
      : undefined;
  }
  const isRead =
    isIdentifier(value) ||
    isPropertyAccessExpression(value) ||
    isElementAccessExpression(value) ||
    isAsExpression(value);
  const written = isRead ? declaredType(value, scope, 0) : undefined;
  return typeProblem(written, scope, covered, onlyFalsy) ? value : undefined;
}

/** Whether a declared type admits a non-key answer where the expression does not fall back. */
function typeProblem(
  written: KeyType | undefined,
  scope: Scope,
  covered: Covered,
  onlyFalsy: boolean,
): boolean {
  return written?.alternatives === undefined
    ? individualProblem(written, scope, covered, onlyFalsy)
    : written.alternatives.some((each) => individualProblem(each, scope, covered, onlyFalsy));
}

/** One union alternative is checked in its own declaration context, with the same fallback. */
function individualProblem(
  written: KeyType | undefined,
  scope: Scope,
  covered: Covered,
  onlyFalsy: boolean,
): boolean {
  if (written?.type === undefined) {
    return false;
  }
  const reading = written.reading ?? scope.reading;
  const kinds = kindsOf(written.type, written.at, reading);
  if (onlyFalsy && kinds !== undefined) {
    const trueOnly =
      isLiteralTypeNode(written.type) && written.type.literal.kind === SyntaxKind.TrueKeyword;
    const nullish = written.optional || kinds.has('undefined') || kinds.has('null');
    return (kinds.has('boolean') && !trueOnly) || (nullish && covered === 'none');
  }
  if (
    written.reading !== undefined &&
    nonJsonPart(written.type, written.at, reading) !== undefined
  ) {
    return true;
  }
  if (kinds === undefined) {
    return false;
  }
  const nullish = written.optional || kinds.has('undefined') || kinds.has('null');
  return NO_KEYS.some((kind) => kinds.has(kind)) || (nullish && covered === 'none');
}

/**
 * The type `node` is written of, where the code types it: through what answers what it is given as
 * it is — parentheses, `as const`, a method that keeps an array's elements (`KEEPING`), a copy,
 * `[...items]` — a cast's, a name's (`nameType`), or a member's of it; none of anything else.
 */
function declaredType(node: Expression, scope: Scope, depth: number): KeyType | undefined {
  let value = node;
  let asserted = false;
  for (let step = depth; step <= MAX_FOLLOWED; step += 1) {
    asserted ||= isNonNullExpression(value);
    const kept = keptOf(value);
    if (kept === undefined) {
      let written = readType(value, scope, step + 1);
      if (written !== undefined && scope.reading.parameters !== undefined) {
        written = { ...written, reading: written.reading ?? scope.reading };
      }
      return asserted && written !== undefined
        ? {
            ...written,
            optional: false,
            ...(written.alternatives !== undefined && {
              alternatives: written.alternatives.map((each) => ({ ...each, optional: false })),
            }),
          }
        : written;
    }
    value = kept;
  }
  return undefined;
}

/** A cast's, name's, member's or call's declared type after wrappers have been followed. */
function readType(value: Expression, scope: Scope, depth: number): KeyType | undefined {
  if (isAsExpression(value)) {
    return { at: scope.at, optional: false, type: value.type };
  }
  if (isIdentifier(value)) {
    return nameType(value.text, scope, depth);
  }
  if (isCallExpression(value)) {
    const types = callTypes(value.expression, scope);
    return types.length === 1 ? types[0] : undefined;
  }
  return isPropertyAccessExpression(value) || isElementAccessExpression(value)
    ? memberType(value, scope, depth)
    : undefined;
}

/**
 * What `node` answers as it is, or the elements of: within parentheses or a cast to itself, an
 * array a method that keeps its elements is called on, what a copy spreads; none of another.
 */
function keptOf(node: Expression): Expression | undefined {
  if (isParenthesizedExpression(node) || isSatisfiesExpression(node) || isNonNullExpression(node)) {
    return node.expression;
  }
  if (isAsExpression(node)) {
    return isConstCast(node.type) ? node.expression : undefined;
  }
  if (
    isCallExpression(node) &&
    isPropertyAccessExpression(node.expression) &&
    KEEPING.has(node.expression.name.text)
  ) {
    return node.expression.expression;
  }
  // `[...items]`: a copy of `items`.
  const elements = isArrayLiteralExpression(node) ? node.elements : [];
  const [only] = elements;
  return only !== undefined && elements.length === 1 && isSpreadElement(only)
    ? only.expression
    : undefined;
}

/** The type of the member `node` reads, as its target's type writes it; of one that may be left out, so. */
function memberType(node: Expression, scope: Scope, depth: number): KeyType | undefined {
  let key: string | undefined;
  let target: Expression | undefined;
  if (isPropertyAccessExpression(node)) {
    key = node.name.text;
    target = node.expression;
  } else if (isElementAccessExpression(node)) {
    key = literalKey(unwrapped(node.argumentExpression));
    target = node.expression;
  }
  const of = target === undefined ? undefined : declaredType(target, scope, depth);
  if (key === undefined || of === undefined) {
    return undefined;
  }
  const members: KeyType[] = [];
  const alternatives = of.alternatives ?? [of];
  for (const each of alternatives) {
    if (each.type === undefined) {
      continue;
    }
    const selected = memberTypes(each.type, key, each.at, each.reading ?? scope.reading);
    for (const member of selected) {
      members.push({
        ...member,
        optional: member.optional || each.optional,
        ...(each.reading !== undefined && { reading: each.reading }),
      });
    }
  }
  return members.length > 1
    ? { alternatives: members, at: of.at, optional: false, type: undefined }
    : members[0];
}

/**
 * The type the name `name` is written of where `scope` reads it: a state's type argument, or what
 * it starts from; a constant's annotation, or its value's; a prop's, a parameter's; a hook's item's,
 * in the hook; none of another.
 */
function nameType(name: string, scope: Scope, depth: number): KeyType | undefined {
  const typed = scope.typed.get(name);
  if (typed !== undefined) {
    return typed;
  }
  const entry = scope.names.get(name);
  if (entry?.kind === 'state') {
    return stateType(entry.state, scope, depth);
  }
  if (entry?.kind === 'constant') {
    return constantType(entry.declaration, scope, depth);
  }
  if (entry?.kind === 'prop') {
    return scope.propsType === undefined
      ? undefined
      : memberOf(scope.propsType, entry.prop.name, scope.at, scope.reading);
  }
  if (entry?.kind === 'param') {
    return parameterType(entry.parameter, scope);
  }
  const item =
    entry?.kind === 'hooked' && entry.item !== 'whole'
      ? entry.call.hook.items.get(entry.item)
      : undefined;
  return item === undefined || entry?.kind !== 'hooked'
    ? undefined
    : declaredType(item.node as Expression, hookScope(entry.call.hook, scope.modules), depth);
}

/** The type a state is written of: its type argument, or what it starts from. */
function stateType(state: StateDeclaration, scope: Scope, depth: number): KeyType | undefined {
  const [argument] = state.call.typeArguments ?? [];
  return argument === undefined
    ? declaredType(state.input, scope, depth)
    : { at: scope.at, optional: false, type: argument };
}

/** The type a constant is written of: its annotation, or its value's. */
function constantType(
  declaration: VariableDeclaration,
  scope: Scope,
  depth: number,
): KeyType | undefined {
  if (declaration.type !== undefined) {
    return { at: scope.at, optional: false, type: declaration.type };
  }
  return declaration.initializer === undefined || !isIdentifier(declaration.name)
    ? undefined
    : declaredType(declaration.initializer, scope, depth);
}

/** The type a parameter is written of; of one that may be left out, so. */
function parameterType(parameter: ParameterDeclaration, scope: Scope): KeyType | undefined {
  return parameter.type === undefined
    ? undefined
    : {
        at: scope.at,
        optional: parameter.questionToken !== undefined,
        type: parameter.type,
      };
}

/** The scope of a hook's code: its names, its file, its type parameters. */
function hookScope(hook: HookDefinition, modules: Modules): Scope {
  const at = { file: hook.module.file, sourceFile: hook.module.sourceFile };
  const { typeParameters } = hook.declaration;
  return {
    at,
    modules,
    names: hook.names,
    propsType: undefined,
    reading: typeReading(
      modules,
      typeParameters === undefined ? undefined : { declarations: typeParameters, file: at.file },
    ),
    typed: new Map(),
  };
}

/**
 * The type of the elements of an array of the type `written`: `T` of `T[]`, `readonly T[]`,
 * `Array<T>`, `ReadonlyArray<T>`, and of an alias of one; none of another.
 */
function elementOf(written: KeyType, reading: TypeReading, depth: number): KeyType | undefined {
  let node = written.type;
  // `(T)[]` is of `T`, `readonly T[]` of `T[]`.
  while (node !== undefined && (isParenthesizedTypeNode(node) || isReadonlyOperator(node))) {
    node = node.type;
  }
  if (node === undefined || depth > MAX_FOLLOWED) {
    return undefined;
  }
  if (isArrayTypeNode(node)) {
    return { ...written, optional: false, type: node.elementType };
  }
  return isTypeReferenceNode(node)
    ? referencedElement(node, written.at, reading, depth)
    : undefined;
}

/** Whether `node` is `readonly` of an array's type. */
function isReadonlyOperator(node: TypeNode): node is TypeOperatorNode {
  return isTypeOperatorNode(node) && node.operator === SyntaxKind.ReadonlyKeyword;
}

/** The type of the elements of the array type `node` names: the language's, of its argument; an alias's. */
function referencedElement(
  node: TypeReferenceNode,
  at: TypeSite,
  reading: TypeReading,
  depth: number,
): KeyType | undefined {
  const { typeName } = node;
  if (isLanguageType(typeName, at)) {
    const [first] = node.typeArguments ?? [];
    return first !== undefined && isIdentifier(typeName) && LANGUAGE_ARRAYS.has(typeName.text)
      ? { at, optional: false, type: first, ...(reading.parameters !== undefined && { reading }) }
      : undefined;
  }
  const declared = declarationOf(typeName, at, reading);
  const alias = declared?.declaration;
  return declared !== undefined &&
    alias !== undefined &&
    isTypeAliasDeclaration(alias) &&
    alias.typeParameters === undefined
    ? elementOf({ at: declared.at, optional: false, type: alias.type }, reading, depth + 1)
    : undefined;
}
