import {
  type EnumDeclaration,
  type EnumMember,
  type Expression,
  type IndexedAccessTypeNode,
  isArrayTypeNode,
  isComputedPropertyName,
  isConstructorTypeNode,
  isEnumDeclaration,
  isFunctionTypeNode,
  isIdentifier,
  isIndexedAccessTypeNode,
  isIndexSignatureDeclaration,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isMethodSignatureDeclaration,
  isNamedTupleMember,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isOptionalTypeNode,
  isParenthesizedTypeNode,
  isPrefixUnaryExpression,
  isPropertySignatureDeclaration,
  isRestTypeNode,
  isStringLiteral,
  isTupleTypeNode,
  isTypeAliasDeclaration,
  isTypePredicateNode,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  type Node,
  SyntaxKind,
  type TypeNode,
  type TypeOperatorNode,
  type TypeReferenceNode,
} from 'typescript/ast';

import { firstLine } from './bounded.ts';
import { constantNumber } from './numbers.ts';
import { shapesKind } from './object-kinds.ts';
import { LANGUAGE_OBJECTS, membersOf, type ObjectMember } from './object-members.ts';
import { memberOf, within } from './type-members.ts';
import {
  type Declared,
  declarationOf,
  isLanguageType,
  typeParameterOf,
  type TypeReading,
  type TypeSite,
} from './type-names.ts';

/**
 * What a state's type admits inside its values that no JSON holds, as `kinds.ts` reads the kind of
 * the values themselves: the page sends what a site's states hold as JSON, every member, element
 * and index's value of them too — so none of them may be a function, a method, a symbol, a `bigint`,
 * an object of a class, `unknown`, an object's type a function satisfies (`{}`, `{ name: string }`)
 * or `undefined` among an array's elements, which a handler TypeScript lets write it would write,
 * and the page then fail to send. A type the compile cannot read there is refused, as at the top.
 */

/** What of a type no JSON holds: the part, as its code writes it, and what it admits. */
export interface NonJsonPart {
  readonly part: string;
  readonly admits: string;
}

/**
 * The aliases, interfaces, type parameters and indexed accesses a walk has met, by what they are
 * read as: an object's entry, which JSON leaves `undefined` out of, or an array's element, which it
 * does not.
 */
interface Reads {
  readonly elements: Set<Node>;
  readonly entries: Set<Node>;
}

/** Where a type is read, and the declarations walked under way and walked to the end. */
interface Walk {
  readonly at: TypeSite;
  readonly reading: TypeReading;
  /** What is walked under way, each walked once: a type of itself is not walked again. */
  readonly walking: Reads;
  /** What was walked to the end and admits nothing no JSON holds, which no later read walks again. */
  readonly completed: Reads;
}

const FUNCTION = 'a function';
const METHOD = 'a method, a function';
const SATISFIED = 'which a function satisfies as well';
const SYMBOL = 'a symbol';
const SYMBOL_KEY = 'an entry of a name that may be a symbol, which JSON holds none of';
const BIGINT = 'an integer of `bigint`';
const ANY = 'which holds any value';
const ELEMENT = "among an array's elements, which JSON holds no `undefined` among";
const LANGUAGE =
  "a type of the language's own, which an object of its class satisfies, `new Date()`, `new Number(1)`, or one the compile cannot read";
const NON_FINITE = 'a number no JSON holds, which is not finite';
const UNTOLD = 'a type the compile cannot read';

/** The keywords of the types of JSON's values, and of none: `never`. */
const JSON_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NeverKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.TemplateLiteralType,
]);

/** The types of an index's key that no symbol is of: text, a number, a template literal. */
const PLAIN_KEYS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.TemplateLiteralType,
]);

/** The literals of JSON's values, as a literal type writes them, a number past its sign. */
const JSON_LITERALS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/** What the keywords of types no JSON holds admit. */
const ADMITTED: ReadonlyMap<SyntaxKind, string> = new Map([
  [SyntaxKind.AnyKeyword, ANY],
  [SyntaxKind.BigIntKeyword, BIGINT],
  [SyntaxKind.ObjectKeyword, SATISFIED],
  [SyntaxKind.SymbolKeyword, SYMBOL],
  [SyntaxKind.UnknownKeyword, ANY],
]);

/** The language's arrays, of elements of their argument's values: `Array<T>`. */
const LANGUAGE_ARRAYS: ReadonlySet<string> = new Set(['Array', 'ReadonlyArray']);

/**
 * What the values of `type`, a state's, admit inside them that no JSON holds, as the code writes
 * it; none where they are JSON all through. The state itself holding `undefined` is `kinds.ts`'s.
 */
export function nonJsonPart(
  type: TypeNode,
  at: TypeSite,
  reading: TypeReading,
): NonJsonPart | undefined {
  return partOf(type, { at, completed: reads(), reading, walking: reads() }, true);
}

/**
 * What of `type` no JSON holds: `entry` where it is an object's entry's value — of which JSON leaves
 * one of `undefined` out, as the page sends it — rather than an array's element, which it does not.
 */
function partOf(type: TypeNode, walk: Walk, entry: boolean): NonJsonPart | undefined {
  // `(T)` is of `T`; `T[]`, of `T` among an array's elements.
  let node = type;
  let isEntry = entry;
  while (isParenthesizedTypeNode(node) || isArrayTypeNode(node)) {
    isEntry &&= !isArrayTypeNode(node);
    node = isArrayTypeNode(node) ? node.elementType : node.type;
  }
  if (isUnionTypeNode(node) || isIntersectionTypeNode(node)) {
    return firstOf(node.types, (each) => partOf(each, walk, isEntry));
  }
  if (isTupleTypeNode(node)) {
    return firstOf(node.elements, (element) => elementPart(element, walk));
  }
  if (isTypeLiteralNode(node)) {
    return objectPart(node, membersOf(node, walk.at, walk.reading), walk);
  }
  if (isTypeReferenceNode(node)) {
    return referencePart(node, walk, isEntry);
  }
  return isTypeOperatorNode(node) || isIndexedAccessTypeNode(node)
    ? derivedPart(node, walk, isEntry)
    : leafPart(node, isEntry);
}

/**
 * What a type of a keyword, a literal or a function admits that no JSON holds: `1n` and `-1n`,
 * `symbol`, `unknown`, a function's type, and `undefined` but as an entry's value.
 */
function leafPart(node: TypeNode, entry: boolean): NonJsonPart | undefined {
  if (isLiteralTypeNode(node)) {
    // `-1` is the minus of a numeric literal, `-1n` of an integer's of `bigint`.
    const { literal } = node;
    const value = isPrefixUnaryExpression(literal) ? literal.operand : literal;
    if (value.kind === SyntaxKind.BigIntLiteral) {
      return admitting(node, BIGINT);
    }
    return JSON_LITERALS.has(value.kind) ? undefined : admitting(node, UNTOLD);
  }
  // `item is Open`, a boolean; `asserts item is Open`, nothing, as `void` is.
  const isNothing = isTypePredicateNode(node) && node.assertsModifier !== undefined;
  if (!isNothing && isTypePredicateNode(node)) {
    return undefined;
  }
  if (
    isNothing ||
    node.kind === SyntaxKind.UndefinedKeyword ||
    node.kind === SyntaxKind.VoidKeyword
  ) {
    return entry ? undefined : admitting(node, ELEMENT);
  }
  if (isFunctionTypeNode(node) || isConstructorTypeNode(node)) {
    return admitting(node, FUNCTION);
  }
  return JSON_KEYWORDS.has(node.kind)
    ? undefined
    : admitting(node, ADMITTED.get(node.kind) ?? UNTOLD);
}

/**
 * What a type of another admits: `readonly T[]`, as its array; `T['key']`, as the member `key` of
 * `T` — `undefined` too, of one that may be left out, and read once where its own type names it
 * again; `unique symbol`, a symbol; and `keyof T`, of symbols too, what the compile cannot read.
 */
function derivedPart(
  node: IndexedAccessTypeNode | TypeOperatorNode,
  walk: Walk,
  entry: boolean,
): NonJsonPart | undefined {
  if (isTypeOperatorNode(node)) {
    if (node.operator === SyntaxKind.ReadonlyKeyword) {
      return partOf(node.type, walk, entry);
    }
    return admitting(node, node.operator === SyntaxKind.UniqueKeyword ? SYMBOL : UNTOLD);
  }
  const index = node.indexType;
  const key =
    isLiteralTypeNode(index) &&
    (isStringLiteral(index.literal) || isNoSubstitutionTemplateLiteral(index.literal))
      ? index.literal.text
      : undefined;
  const member =
    key === undefined ? undefined : memberOf(node.objectType, key, walk.at, walk.reading);
  const written = member?.type;
  if (member === undefined || written === undefined) {
    return admitting(node, UNTOLD);
  }
  // `S['x']` of `{ x: { y: S['x'] } }`: read once, as a type of itself is.
  return !entry && member.optional
    ? admitting(node, ELEMENT)
    : walked(node, walk, entry, () => partOf(written, { ...walk, at: member.at }, entry));
}

/** What a tuple's element admits: one that may be left out, `undefined` in its place too. */
function elementPart(element: TypeNode, walk: Walk): NonJsonPart | undefined {
  if (
    isOptionalTypeNode(element) ||
    (isNamedTupleMember(element) && element.questionToken !== undefined)
  ) {
    return admitting(element, ELEMENT);
  }
  // `...string[]`, `...rest: string[]`: of the array's elements.
  return partOf(
    isRestTypeNode(element) || isNamedTupleMember(element) ? element.type : element,
    walk,
    false,
  );
}

/**
 * What an object's type — a type literal, an interface with what it extends, what the language's
 * own make (`membersOf`) — admits that no JSON holds: a function's values, where its members do not
 * keep one from it (`shapesKind`) — `{}`, `{ name: string }`, `{ (): string }` — and what each
 * member admits; none the compile reads the members of, what it cannot read.
 */
function objectPart(
  node: Node,
  members: readonly ObjectMember[] | undefined,
  walk: Walk,
): NonJsonPart | undefined {
  if (members === undefined) {
    return admitting(node, UNTOLD);
  }
  const kind = shapesKind(members.map(({ shape }) => shape));
  if (kind !== 'object') {
    return admitting(node, kind === 'called' ? FUNCTION : SATISFIED);
  }
  return firstOf(members, (member) => memberPart(member, walk));
}

/**
 * What a member of an object's type admits: a method; a property's value, an index's — `V`, of
 * those `Record<K, V>` makes; and an entry a symbol may name.
 */
function memberPart({ at, member, value }: ObjectMember, walk: Walk): NonJsonPart | undefined {
  const there = { ...walk, at };
  if (member === undefined) {
    return value === undefined ? undefined : partOf(value, there, true);
  }
  if (isPropertySignatureDeclaration(member)) {
    // A name the code computes, `[KEY]`, may be a symbol's; a property typed of nothing is of any value.
    const { name } = member;
    if (isComputedPropertyName(name) && !isLiteralName(name.expression)) {
      return admitting(member, SYMBOL_KEY);
    }
    return value === undefined ? admitting(member, ANY) : partOf(value, there, true);
  }
  if (isIndexSignatureDeclaration(member)) {
    const [key] = member.parameters;
    return key?.type !== undefined && mayBeSymbol(key.type, at, walk.reading)
      ? admitting(member, SYMBOL_KEY)
      : partOf(member.type, there, true);
  }
  return admitting(member, isMethodSignatureDeclaration(member) ? METHOD : UNTOLD);
}

/** Whether a computed name is written as text or a number: `['id']`, `[0]`. */
function isLiteralName(name: Node): boolean {
  return isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name) || isNumericLiteral(name);
}

/**
 * Whether an index's key type may take a symbol: any but `string`, `number`, a template literal
 * type, or a union of those, read through parentheses and through a name the module reads as an
 * alias without type parameters, of the file or of an import — `type Key = symbol` is one, `type
 * UserId = string` is not. What it cannot read to one of those, a type parameter or a package's
 * type among it, may be a symbol.
 */
function mayBeSymbol(type: TypeNode, at: TypeSite, reading: TypeReading): boolean {
  let node = type;
  while (isParenthesizedTypeNode(node)) {
    node = node.type;
  }
  if (isUnionTypeNode(node)) {
    return node.types.some((each) => mayBeSymbol(each, at, reading));
  }
  if (!isTypeReferenceNode(node)) {
    return !PLAIN_KEYS.has(node.kind);
  }
  const declared =
    typeParameterOf(node.typeName, at, reading) === undefined
      ? declarationOf(node.typeName, at, reading)
      : undefined;
  const alias = declared?.declaration;
  if (declared === undefined || alias === undefined || !isTypeAliasDeclaration(alias)) {
    return true;
  }
  // An alias that names itself adds no symbol to what it names beside.
  return (
    alias.typeParameters !== undefined ||
    (within(alias, reading, () => mayBeSymbol(alias.type, declared.at, reading)) ?? false)
  );
}

/**
 * What the type `reference` names admits: a type parameter's constraint's, but of one each call
 * gives, nothing; the language's own, of their arguments (`languagePart`); an alias's, followed; an
 * interface's, its members' with those of what it extends; an enum's, what its members are of
 * (`enumPart`); and what it cannot read.
 */
function referencePart(
  reference: TypeReferenceNode,
  walk: Walk,
  entry: boolean,
): NonJsonPart | undefined {
  const { at, reading } = walk;
  const parameter = typeParameterOf(reference.typeName, at, reading);
  if (parameter !== undefined) {
    const { constraint } = parameter;
    if (reading.parameters?.given === true) {
      return undefined;
    }
    return constraint === undefined
      ? admitting(reference, ANY)
      : walked(parameter, walk, entry, () => partOf(constraint, walk, entry));
  }
  if (isLanguageType(reference.typeName, at)) {
    return languagePart(reference, walk, entry);
  }
  const declared = declarationOf(reference.typeName, at, reading);
  return declared === undefined
    ? admitting(reference, UNTOLD)
    : declaredPart(reference, declared, walk, entry);
}

function declaredPart(
  reference: TypeReferenceNode,
  { at, declaration }: Declared,
  walk: Walk,
  entry: boolean,
): NonJsonPart | undefined {
  if (isEnumDeclaration(declaration)) {
    return enumPart(declaration);
  }
  if (isTypeAliasDeclaration(declaration)) {
    return declaration.typeParameters === undefined
      ? walked(declaration, walk, entry, () => partOf(declaration.type, { ...walk, at }, entry))
      : admitting(reference, UNTOLD);
  }
  // An object's members are read as entries, whatever the object is read as.
  return walked(declaration, walk, true, () =>
    objectPart(reference, membersOf(reference, walk.at, walk.reading), walk),
  );
}

/**
 * What a type of the language's own admits: `Partial<T>`, `Pick<T, K>`, `Record<K, V>` and the
 * like, what the members they make do (`membersOf`); `Array<T>`, what `T` does as an array's
 * element; `Readonly<T>`, what `T` does, and `NonNullable<T>` but `undefined`; any other — `Date`,
 * `Map<K, V>`, and `String`, `Number`, `Boolean`, which an object of their class satisfies as well
 * as their values do — itself.
 */
function languagePart(
  reference: TypeReferenceNode,
  walk: Walk,
  entry: boolean,
): NonJsonPart | undefined {
  const name = isIdentifier(reference.typeName) ? reference.typeName.text : '';
  if (LANGUAGE_OBJECTS.has(name)) {
    // `Partial<Tree>` of `{ children: Partial<Tree>[] }`: read once, as a type of itself is.
    return walked(reference, walk, true, () =>
      objectPart(reference, membersOf(reference, walk.at, walk.reading), walk),
    );
  }
  const [first] = reference.typeArguments ?? [];
  if (first === undefined) {
    return admitting(reference, LANGUAGE);
  }
  if (LANGUAGE_ARRAYS.has(name)) {
    return partOf(first, walk, false);
  }
  return name === 'Readonly' || name === 'NonNullable'
    ? partOf(first, walk, entry || name === 'NonNullable')
    : admitting(reference, LANGUAGE);
}

/**
 * What an enum's members admit that no JSON holds: a number that is not finite (`1e400`), and a
 * value the compile does not read — another member's, a call's — as a member of none, text or a
 * number, written, admits nothing.
 */
function enumPart(declaration: EnumDeclaration): NonJsonPart | undefined {
  return firstOf(declaration.members, (member) => {
    const { initializer } = member;
    return initializer === undefined ||
      isStringLiteral(initializer) ||
      isNoSubstitutionTemplateLiteral(initializer)
      ? undefined
      : numberPart(member, initializer);
  });
}

/** What an enum's member of a number admits: one that is not finite, or one the compile cannot read. */
function numberPart(member: EnumMember, initializer: Expression): NonJsonPart | undefined {
  // `-1`, a negative number, is the minus of a numeric literal.
  const number = isPrefixUnaryExpression(initializer) ? initializer.operand : initializer;
  const value = isNumericLiteral(number) ? constantNumber(initializer) : undefined;
  if (value === undefined) {
    return admitting(member, UNTOLD);
  }
  return Number.isFinite(value) ? undefined : admitting(member, NON_FINITE);
}

/** No declaration walked, under way or to the end. */
function reads(): Reads {
  return { elements: new Set(), entries: new Set() };
}

/**
 * What `read` answers of `declaration`, read as an entry or an element (`entry`), walked under way
 * while it does: nothing more where it is already, as a type of itself (`{ children: Tree[] }`)
 * admits nothing it has not already, and nothing where it was walked to the end before, whatever
 * reached it then. A part found ends the whole walk, so what is kept is that a declaration, read
 * as it is read, holds none: reading it again, as a sibling member of the type does, would answer
 * the same. A read that a declaration under way cut short is kept too: whoever began that one reads
 * it to the end before the walk answers. What a declaration answers depends on it and on `entry`
 * alone — the site its names are read at is its file's, and what the reading holds is the walk's —
 * so an alias, a type parameter and an indexed access are kept by both; an object's members are
 * read as entries whatever it is read as, so an interface and what the language makes of an object
 * are kept by `true`.
 */
function walked(
  declaration: Node,
  walk: Walk,
  entry: boolean,
  read: () => NonJsonPart | undefined,
): NonJsonPart | undefined {
  const key = entry ? 'entries' : 'elements';
  const under = walk.walking[key];
  const completed = walk.completed[key];
  if (under.has(declaration) || completed.has(declaration)) {
    return undefined;
  }
  under.add(declaration);
  try {
    const found = read();
    if (found === undefined) {
      completed.add(declaration);
    }
    return found;
  } finally {
    under.delete(declaration);
  }
}

/** The first of what `find` answers of `items`. */
function firstOf<T>(
  items: Iterable<T>,
  find: (item: T) => NonJsonPart | undefined,
): NonJsonPart | undefined {
  for (const item of items) {
    const found = find(item);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function admitting(node: Node, admits: string): NonJsonPart {
  return { admits, part: firstLine(node) };
}
