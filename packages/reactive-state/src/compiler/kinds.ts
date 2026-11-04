import {
  type EnumDeclaration,
  type Expression,
  type IndexedAccessTypeNode,
  isAsExpression,
  isEnumDeclaration,
  isIdentifier,
  isIndexedAccessTypeNode,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPrefixUnaryExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  type Node,
  SyntaxKind,
  type TypeNode,
  type TypeParameterDeclaration,
  type TypeReferenceNode,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import type { Fail } from './errors.ts';
import { type NonJsonPart, nonJsonPart } from './json-types.ts';
import type { Modules } from './modules.ts';
import { membersKind, shapesKind } from './object-kinds.ts';
import { LANGUAGE_OBJECTS, membersOf } from './object-members.ts';
import { isOneKindLiteral, propPath } from './state-starts.ts';
import type { StateDeclaration } from './statements.ts';
import {
  interfaceMembersKind,
  isInterface,
  memberOf,
  within,
  type WrittenType,
} from './type-members.ts';
import {
  declarationOf,
  isLanguageType,
  typeParameterOf,
  type TypeReading,
  typeReading,
  type TypeSite,
} from './type-names.ts';

/**
 * The kinds of JSON a state a dynamic site reads holds values of, as its code writes its type. A
 * site's view is held to the kind of the state's first value, which the authority evaluates anew as
 * the page renders, while React keeps the value the state holds (`authority/sites.ts`): a state a
 * site reads is of one kind, `null` aside, and never of `undefined`, which no JSON holds — nor of
 * what no JSON holds inside its values (`json-types.ts`). A type is read of its text, the aliases,
 * interfaces and enums it names followed (`type-names.ts`), and one of a kind the text cannot tell
 * is refused.
 */

/** A kind of JSON, or `undefined`, which no JSON holds. */
export type Kind = 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string' | 'undefined';

/** What a component's state is read with: its file, its names and its props' type, the modules. */
interface StateContext {
  readonly at: TypeSite;
  readonly component: {
    readonly names: ReadonlyMap<string, TopLevel>;
    readonly propsType: TypeNode | undefined;
  };
  readonly modules: Modules;
}

/** The kinds of the types written of a keyword, or as a node of their own: `string`, `[a, b]`. */
const WRITTEN_KINDS: Partial<Record<SyntaxKind, Kind>> = {
  [SyntaxKind.ArrayType]: 'array',
  [SyntaxKind.BooleanKeyword]: 'boolean',
  [SyntaxKind.NumberKeyword]: 'number',
  [SyntaxKind.StringKeyword]: 'string',
  [SyntaxKind.TemplateLiteralType]: 'string',
  [SyntaxKind.TupleType]: 'array',
  [SyntaxKind.UndefinedKeyword]: 'undefined',
  [SyntaxKind.VoidKeyword]: 'undefined',
};

/**
 * The language's arrays, of names no file declares: of the array's kind. Its types of objects are
 * told by the members they make (`object-members.ts`), and `String`, `Number` and `Boolean` are
 * refused, which an object of their class, `new Number(1)`, satisfies as well as their values do.
 */
const LANGUAGE_ARRAYS: ReadonlySet<string> = new Set(['Array', 'ReadonlyArray']);

/**
 * Refuses a state of a component's a dynamic site reads that is of more than one kind of JSON, of
 * `undefined`, of a type whose kind the compile cannot tell, or of one that admits what no JSON
 * holds inside its values — as its type argument types it, or the prop it starts from as it is, or
 * a member of one, as the props' type does.
 */
export function checkStateKinds(state: StateDeclaration, context: StateContext, fail: Fail): void {
  const reading = typeReading(context.modules);
  const [argument] = state.call.typeArguments ?? [];
  const written = stateType(state, context, reading);
  checkWritten(state.value.text, written, { at: argument ?? state.input, fail, reading });
}

/**
 * Refuses a parameter of a hook's that declares a local state as it is — `useReactiveState(initial)`
 * — typed of more than one kind of JSON, of `undefined`, or of a type whose kind the compile cannot
 * tell, as `checkStateKinds` refuses a component's: of a type parameter of the hook's, the kinds
 * its constraint is of (`T extends string`).
 */
export function checkParameterKinds(
  name: string,
  type: TypeNode,
  context: {
    readonly at: TypeSite;
    readonly modules: Modules;
    readonly parameters: readonly TypeParameterDeclaration[];
  },
  fail: Fail,
): void {
  const { at, modules, parameters } = context;
  const reading = typeReading(modules, { declarations: parameters, file: at.file });
  checkWritten(name, { at, optional: false, type }, { at: type, fail, reading });
}

/** Refuses the state `name`, of `written`, where it holds what a site's view may not, at `at`. */
function checkWritten(
  name: string,
  written: WrittenType | undefined,
  checking: { readonly at: Node; readonly fail: Fail; readonly reading: TypeReading },
): void {
  if (written === undefined) {
    return;
  }
  const { at, fail, reading } = checking;
  const { type } = written;
  const kinds = type === undefined ? undefined : kindsOf(type, written.at, reading);
  if (type === undefined || kinds === undefined) {
    return fail(written.unreadStart === true ? unreadStart(name) : untold(name), at);
  }
  if (written.optional || kinds.has('undefined')) {
    return fail(mayBeUndefined(name), at);
  }
  const json = [...kinds].filter((kind) => kind !== 'null');
  if (json.length > 1) {
    return fail(manyKinds(name, json), at);
  }
  const inside = nonJsonPart(type, written.at, reading);
  if (inside !== undefined) {
    fail(admitsNonJson(name, inside), at);
  }
}

/**
 * The type a state of a component's is written of: its type argument; or, where it starts from a
 * prop as it is, or a member of one — `initialFilter`, `options.filter`, `options['filter']` — the
 * prop's, as the props' type writes it, of no type where that cannot be read; none where it starts
 * of a literal of one kind of JSON, which TypeScript types of what it is; and of no type where it
 * starts of anything else, which the compile cannot type (`unreadStart`).
 */
function stateType(
  state: StateDeclaration,
  context: StateContext,
  reading: TypeReading,
): WrittenType | undefined {
  const { at, component } = context;
  const [argument] = state.call.typeArguments ?? [];
  if (argument !== undefined) {
    return { at, optional: false, type: argument };
  }
  // `initial as Selection`: of the type it is cast to.
  const input = typedAsItIs(state.input);
  if (isAsExpression(input)) {
    return { at, optional: false, type: input.type };
  }
  const path = propPath(input);
  const entry = path === undefined ? undefined : component.names.get(path.root);
  if (path === undefined || entry?.kind !== 'prop') {
    return isOneKindLiteral(input)
      ? undefined
      : { at, optional: false, type: undefined, unreadStart: true };
  }
  const unread: WrittenType = { at, optional: false, type: undefined };
  if (!path.told) {
    return { ...unread, unreadStart: true };
  }
  const { members } = path;
  let written =
    component.propsType === undefined
      ? undefined
      : memberOf(component.propsType, entry.prop.name, at, reading);
  for (const member of members) {
    if (written?.type === undefined) {
      return unread;
    }
    const inner = memberOf(written.type, member, written.at, reading);
    written =
      inner === undefined ? undefined : { ...inner, optional: inner.optional || written.optional };
  }
  return written ?? unread;
}

/**
 * `input` past what keeps the type of what it is of — parentheses, `as const`, `satisfies` — so
 * that `'all' as const` is a literal, `options satisfies Options` a prop.
 */
function typedAsItIs(input: Expression): Expression {
  let node = input;
  while (
    isParenthesizedExpression(node) ||
    isSatisfiesExpression(node) ||
    (isAsExpression(node) && isConstCast(node.type))
  ) {
    node = node.expression;
  }
  return node;
}

/** Whether `type` is the `const` of `as const`, which casts a literal to itself. */
export function isConstCast(type: TypeNode): boolean {
  return isTypeReferenceNode(type) && isIdentifier(type.typeName) && type.typeName.text === 'const';
}

/**
 * The kinds of JSON `type`'s values are of where it is written — `undefined` among them — none
 * where its text cannot tell: a package's type, a class, an alias of parameters, `keyof T`,
 * `unknown`, a mapped or a conditional type.
 */
export function kindsOf(
  type: TypeNode,
  at: TypeSite,
  reading: TypeReading,
): ReadonlySet<Kind> | undefined {
  let node = type;
  while (isParenthesizedTypeNode(node)) {
    node = node.type;
  }
  if (isUnionTypeNode(node)) {
    return unionKinds(node.types, at, reading);
  }
  if (isIntersectionTypeNode(node)) {
    return intersectionKinds(node.types, at, reading);
  }
  if (isLiteralTypeNode(node)) {
    return single(literalKind(node.literal));
  }
  // `readonly string[]` is an array; `keyof T`, `unique symbol` tell nothing of a kind.
  if (isTypeOperatorNode(node)) {
    return node.operator === SyntaxKind.ReadonlyKeyword
      ? kindsOf(node.type, at, reading)
      : undefined;
  }
  if (isIndexedAccessTypeNode(node)) {
    return indexedKinds(node, at, reading);
  }
  // `{}`, `{ length: number }` hold text as well as objects, `{ (): string }` a function.
  if (isTypeLiteralNode(node)) {
    return membersKind(node.members) === 'object' ? single('object') : undefined;
  }
  return isTypeReferenceNode(node)
    ? referenceKinds(node, at, reading)
    : single(WRITTEN_KINDS[node.kind]);
}

/**
 * The kinds of `T['key']`: of the member `key` of `T`, as `memberOf` reads it — `undefined` too, of
 * one that may be left out; none of an index but a key's text.
 */
function indexedKinds(
  node: IndexedAccessTypeNode,
  at: TypeSite,
  reading: TypeReading,
): ReadonlySet<Kind> | undefined {
  const index = node.indexType;
  const key =
    isLiteralTypeNode(index) &&
    (isStringLiteral(index.literal) || isNoSubstitutionTemplateLiteral(index.literal))
      ? index.literal.text
      : undefined;
  const member = key === undefined ? undefined : memberOf(node.objectType, key, at, reading);
  const kinds = member?.type === undefined ? undefined : kindsOf(member.type, member.at, reading);
  return kinds === undefined || member?.optional !== true
    ? kinds
    : new Set<Kind>([...kinds, 'undefined']);
}

function single(kind: Kind | undefined): ReadonlySet<Kind> | undefined {
  return kind === undefined ? undefined : new Set([kind]);
}

/** The kinds of a union's members, each told; none where one's cannot be. */
function unionKinds(
  members: readonly TypeNode[],
  at: TypeSite,
  reading: TypeReading,
): ReadonlySet<Kind> | undefined {
  const kinds = new Set<Kind>();
  for (const member of members) {
    const each = kindsOf(member, at, reading);
    if (each === undefined) {
      return undefined;
    }
    for (const kind of each) {
      kinds.add(kind);
    }
  }
  return kinds;
}

/**
 * The kinds of an intersection's values: those every one of what it intersects holds, but of an
 * object's type alone, which a brand is — `string & { readonly brand: 'Id' }` is text — and an
 * object's where it intersects objects alone; none where the compile cannot tell one of them.
 */
function intersectionKinds(
  members: readonly TypeNode[],
  at: TypeSite,
  reading: TypeReading,
): ReadonlySet<Kind> | undefined {
  let kinds: ReadonlySet<Kind> | undefined;
  for (const member of members) {
    const each = kindsOf(member, at, reading);
    if (each === undefined) {
      return undefined;
    }
    if (each.size !== 1 || !each.has('object')) {
      kinds = kinds === undefined ? each : heldByBoth(kinds, each);
    }
  }
  return kinds ?? new Set<Kind>(['object']);
}

/** The kinds `a` and `b` both hold. */
function heldByBoth(a: ReadonlySet<Kind>, b: ReadonlySet<Kind>): ReadonlySet<Kind> {
  const both = new Set<Kind>();
  for (const kind of a) {
    if (b.has(kind)) {
      both.add(kind);
    }
  }
  return both;
}

/** The kind of JSON of a literal type's value: none of one no JSON holds, `1n`. */
function literalKind(value: Node): Kind | undefined {
  if (value.kind === SyntaxKind.NullKeyword) {
    return 'null';
  }
  if (value.kind === SyntaxKind.TrueKeyword || value.kind === SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
    return 'string';
  }
  // `-1`, a negative number, is the minus of a numeric literal.
  const number = isPrefixUnaryExpression(value) ? value.operand : value;
  return isNumericLiteral(number) ? 'number' : undefined;
}

/**
 * The kinds of the type `reference` names: an alias's, followed; an interface's, an object; an
 * enum's, of its members' values; the language's own, `Array<T>`, `Readonly<T>`; none of a class,
 * of a package's type, or of an alias of parameters, which the compile does not give arguments.
 */
function referenceKinds(
  reference: TypeReferenceNode,
  at: TypeSite,
  reading: TypeReading,
): ReadonlySet<Kind> | undefined {
  // `T`, of `T extends string`: of the kinds its constraint is of; of none, unconstrained.
  const parameter = typeParameterOf(reference.typeName, at, reading);
  if (parameter !== undefined) {
    const { constraint } = parameter;
    return constraint === undefined
      ? undefined
      : within(parameter, reading, () => kindsOf(constraint, at, reading));
  }
  if (isLanguageType(reference.typeName, at)) {
    return languageKinds(reference, at, reading);
  }
  const declared = declarationOf(reference.typeName, at, reading);
  if (declared === undefined) {
    return undefined;
  }
  const { declaration } = declared;
  if (isEnumDeclaration(declaration)) {
    return enumKinds(declaration);
  }
  if (isInterface(declaration)) {
    return interfaceMembersKind(declaration, declared.at, reading) === 'object'
      ? single('object')
      : undefined;
  }
  if (!isTypeAliasDeclaration(declaration)) {
    return undefined;
  }
  return declaration.typeParameters === undefined
    ? within(declaration, reading, () => kindsOf(declaration.type, declared.at, reading))
    : undefined;
}

/**
 * The kinds of a type of the language's own: `Array<T>`; `Partial<T>`, `Pick<T, K>`, `Record<K, V>`
 * and the like, an object's where the members they make tell one (`membersOf`); and `Readonly<T>`,
 * `NonNullable<T>` of `T`.
 */
function languageKinds(
  reference: TypeReferenceNode,
  at: TypeSite,
  reading: TypeReading,
): ReadonlySet<Kind> | undefined {
  const name = isIdentifier(reference.typeName) ? reference.typeName.text : '';
  if (LANGUAGE_ARRAYS.has(name)) {
    return single('array');
  }
  if (LANGUAGE_OBJECTS.has(name)) {
    const members = membersOf(reference, at, reading);
    return members !== undefined && shapesKind(members.map(({ shape }) => shape)) === 'object'
      ? single('object')
      : undefined;
  }
  const [argument] = reference.typeArguments ?? [];
  if (argument === undefined || (name !== 'Readonly' && name !== 'NonNullable')) {
    return undefined;
  }
  const kinds = kindsOf(argument, at, reading);
  return kinds === undefined || name === 'Readonly'
    ? kinds
    : new Set([...kinds].filter((each) => each !== 'null' && each !== 'undefined'));
}

/** The kinds of an enum's values: numbers, of members of no value or of a number; text, of text. */
function enumKinds(declaration: EnumDeclaration): ReadonlySet<Kind> | undefined {
  const kinds = new Set<Kind>();
  for (const { initializer } of declaration.members) {
    const kind = initializer === undefined ? 'number' : literalKind(initializer);
    if (kind === undefined) {
      return undefined;
    }
    kinds.add(kind);
  }
  return kinds;
}

/** Why a state a site reads of values of `kinds` of JSON is refused. */
function manyKinds(name: string, kinds: readonly string[]): string {
  return `\`${name}\` declares a state of values of more than one kind of JSON — ${kinds.join(', ')} — while a site's view is held to the kind of the state's first value, which the authority evaluates again as the page renders anew, though React keeps the value the state holds: type it of one kind, \`null\` aside.`;
}

/** Why a state a site reads that may hold `undefined` is refused. */
function mayBeUndefined(name: string): string {
  return `\`${name}\` declares a state a site reads that may hold \`undefined\` — of its type, or of a prop that may be left out — which no JSON holds, while the page sends what a site's states hold as JSON, and the authority starts them of JSON: type it of \`null\` instead, \`string | null\`, and start it of \`null\`.`;
}

/** Why a state a site reads whose type admits what no JSON holds inside its values is refused. */
function admitsNonJson(name: string, { admits, part }: NonJsonPart): string {
  return `\`${name}\` declares a state a site reads of a type that admits what no JSON holds inside its values — \`${part}\`, ${admits} — which a handler TypeScript lets write it would write, while the page sends what a site's states hold as JSON, all through: type each member, element and index of it of JSON — text, a number, a boolean, \`null\`, an array or an object of these, an object of a member of a name of its own — and leave a function out of it.`;
}

/** Why a state a site reads that starts of what the compile cannot type is refused. */
function unreadStart(name: string): string {
  return `\`${name}\` declares a state a site reads that starts of what the compile cannot read the type of — \`initial ?? 'all'\`, \`options[key]\`, a constant, a call — while a site's view is held to one kind of JSON: give it a type argument of one, \`useReactiveState<string>(…)\`, or start it of a prop, a member of one, or a literal.`;
}

/** Why a state a site reads of a type whose kind of JSON the compile cannot tell is refused. */
function untold(name: string): string {
  return `\`${name}\` declares a state a site reads of a type whose kind of JSON the compile cannot tell — a package's, a class, an alias of parameters, a mapped or a conditional type — while a site's view is held to one kind: type it of what the compile reads, a literal, \`string\`, \`number\`, \`boolean\`, an object or an array type, or an alias, an interface or an enum of the application's of one — \`useReactiveState<string>(initial)\`.`;
}
