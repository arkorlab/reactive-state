import {
  type Expression,
  type GetAccessorDeclaration,
  isArrayTypeNode,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isIndexSignatureDeclaration,
  isLiteralTypeNode,
  isMethodSignatureDeclaration,
  isNamedTupleMember,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isOptionalTypeNode,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPrefixUnaryExpression,
  isPropertySignatureDeclaration,
  isRestTypeNode,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTemplateLiteralTypeNode,
  isTupleTypeNode,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type MethodSignatureDeclaration,
  type Node,
  type PropertySignatureDeclaration,
  type SetAccessorDeclaration,
  SyntaxKind,
  type TemplateLiteralTypeNode,
  type TupleTypeNode,
  type TypeElement,
  type TypeNode,
  type TypeLiteralNode,
  type VariableDeclaration,
} from 'typescript/ast';

import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { selectedMethodType } from './local-type-callable-members.ts';
import { indexSignatureDomains } from './local-type-index-domains.ts';

/** Property-preserving utility arguments and explicitly selected members of local type syntax. */

const PRESERVING = new Set(['NoInfer', 'NonNullable', 'Partial', 'Readonly', 'Required']);

/** The argument whose properties an unshadowed built-in utility preserves on its result. */
export function preservedUtilityType(
  name: string,
  args: readonly TypeNode[] | undefined,
): TypeNode | undefined {
  return PRESERVING.has(name) && args?.length === 1 ? args[0] : undefined;
}

type IndexKeys = readonly string[] | 'number';

/**
 * The types selected by literal keys from a written object or tuple, or numeric array elements.
 * Unknown indices and unselected fields say nothing of the whole value's type.
 */
export function indexedMemberTypes(
  objectType: TypeNode,
  indexType: TypeNode,
): readonly TypeNode[] | undefined {
  const keys = indexKeys(indexType);
  return keys === undefined ? undefined : selectedMemberTypes(objectType, keys);
}

/** Written members selected by already decoded literal property keys or all numeric positions. */
export function selectedMemberTypes(
  objectType: TypeNode,
  keys: IndexKeys,
): readonly TypeNode[] | undefined {
  const object = unwrappedType(objectType);
  if (isArrayTypeNode(object)) {
    return numericKeys(keys) ? [object.elementType] : undefined;
  }
  if (isTupleTypeNode(object)) {
    return tupleMembers(object, keys);
  }
  if (typeof keys === 'string' || !isTypeLiteralNode(object)) {
    return undefined;
  }
  return objectMembers(object, keys);
}

/** An explicitly named member, distinct from an index signature covering an inherited name. */
export function namedMemberTypes(
  objectType: TypeNode,
  key: string,
): readonly TypeNode[] | undefined {
  const object = unwrappedType(objectType);
  return isTypeLiteralNode(object) && object.members.some((member) => memberName(member) === key)
    ? objectMembers(object, [key])
    : undefined;
}

/** A getter's written read type, independently of a paired setter's accepted input type. */
export function getterMemberTypes(
  objectType: TypeNode,
  key: string,
): readonly TypeNode[] | undefined {
  const object = unwrappedType(objectType);
  if (!isTypeLiteralNode(object)) return undefined;
  const values: TypeNode[] = [];
  let found = false;
  for (const member of object.members) {
    if (!isGetAccessorDeclaration(member) || memberName(member) !== key) continue;
    found = true;
    if (member.type !== undefined) values.push(member.type);
  }
  return found ? values : undefined;
}

/**
 * The values of properties, accessors and methods whose computed names are not read exactly, such
 * as unique symbols or imported constants; `undefined` where every written name is read.
 */
export function unreadableMemberTypes(object: TypeLiteralNode): readonly TypeNode[] | undefined {
  let found = false;
  const values: TypeNode[] = [];
  for (const member of object.members) {
    if (!propertyLike(member) || memberName(member) !== undefined) continue;
    found = true;
    const value = isMethodSignatureDeclaration(member)
      ? selectedMethodType([member])
      : memberType(member);
    if (value !== undefined) values.push(value);
  }
  return found ? values : undefined;
}

/**
 * A written property takes precedence over the number or string signature covering its key; a key
 * no written name declares may still be one a computed name the reader cannot read declares, so
 * that member's value stays possible beside the signatures.
 */
function objectMembers(object: TypeLiteralNode, keys: readonly string[]): readonly TypeNode[] {
  const selected = new Set(keys);
  const declared = new Set<string>();
  const values: TypeNode[] = [];
  const methods = new Map<string, MethodSignatureDeclaration[]>();
  for (const member of object.members) {
    const name = memberName(member);
    if (name === undefined || !selected.has(name)) continue;
    declared.add(name);
    if (isMethodSignatureDeclaration(member)) {
      const signatures = methods.get(name) ?? [];
      signatures.push(member);
      methods.set(name, signatures);
      continue;
    }
    if (isSetAccessorDeclaration(member) && getterMemberTypes(object, name) !== undefined) continue;
    const value = memberType(member);
    if (value !== undefined) values.push(value);
  }
  values.push(...[...methods.values()].map((signatures) => selectedMethodType(signatures)));
  const unread = unreadableMemberTypes(object) ?? [];
  for (const key of keys) {
    if (!declared.has(key)) values.push(...signatureTypes(object, key), ...unread);
  }
  return values;
}

/** The written signatures that cover a literal property key, by how they do. */
interface CoveringSignatures {
  readonly specific: Set<TypeNode>;
  readonly possible: Set<TypeNode>;
  readonly strings: Set<TypeNode>;
}

/**
 * The written signatures covering a literal property key: those of a number domain, for a numeric
 * key, and of a template pattern the key matches, ahead of a `string` signature, which applies
 * only where no other does; and the values of patterns the reader cannot decide, which stay
 * possible beside them.
 */
function signatureTypes(object: TypeLiteralNode, key: string): readonly TypeNode[] {
  const { possible, specific, strings } = coveringSignatures(object, key);
  const values = new Set(specific.size > 0 ? specific : strings);
  for (const each of possible) values.add(each);
  return [...values];
}

/** Each written signature's value, by whether its domain covers the key, may, or is a string. */
function coveringSignatures(object: TypeLiteralNode, key: string): CoveringSignatures {
  const numeric = key !== '' && String(Number(key)) === key;
  const covering: CoveringSignatures = {
    possible: new Set(),
    specific: new Set(),
    strings: new Set(),
  };
  for (const member of object.members) {
    if (!isIndexSignatureDeclaration(member)) continue;
    const written = member.parameters[0]?.type;
    const domains = indexSignatureDomains(written);
    if (domains.has(SyntaxKind.StringKeyword)) covering.strings.add(member.type);
    if (numeric && domains.has(SyntaxKind.NumberKeyword)) covering.specific.add(member.type);
    const covers = domains.has(SyntaxKind.TemplateLiteralType)
      ? patternsCover(written, key)
      : false;
    if (covers === true) covering.specific.add(member.type);
    else if (covers === undefined) covering.possible.add(member.type);
  }
  return covering;
}

/** The key domains a signature's written type names without a pattern: `symbol` covers no text. */
const KEYWORD_DOMAINS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
]);

/**
 * Whether the template patterns a signature's key type writes, through unions and parentheses,
 * cover a key: `true` where one matches, `undefined` where one the reader does not match — a hole
 * of another type, or a pattern named through an alias — may, `false` otherwise.
 */
function patternsCover(type: TypeNode | undefined, key: string): boolean | undefined {
  let undecided = false;
  const pending = type === undefined ? [] : [type];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isParenthesizedTypeNode(at)) {
      pending.push(at.type);
    } else if (isUnionTypeNode(at)) {
      pending.push(...at.types);
    } else if (isTemplateLiteralTypeNode(at)) {
      const covers = patternCovers(at, key);
      if (covers === true) return true;
      undecided ||= covers === undefined;
    } else {
      undecided ||= !KEYWORD_DOMAINS.has(at.kind);
    }
  }
  return undecided ? undefined : false;
}

/**
 * Whether a pattern of `${string}` holes matches a key as TypeScript matches it: the text before
 * the first hole starts the key and the text after the last ends it, without overlap, and the
 * text between holes follows in order; of two adjacent holes the first takes a character. Holes
 * alone are the type `string`. `undefined` for a hole of another type.
 */
function patternCovers(pattern: TemplateLiteralTypeNode, key: string): boolean | undefined {
  const { head, templateSpans } = pattern;
  if (templateSpans.some((span) => span.type.kind !== SyntaxKind.StringKeyword)) return undefined;
  const texts = templateSpans.map((span) => span.literal.text);
  if (head.text === '' && texts.every((text) => text === '')) return true;
  const last = texts.pop() ?? '';
  const end = key.length - last.length;
  if (!key.startsWith(head.text) || !key.endsWith(last) || end < head.text.length) return false;
  let at = head.text.length;
  for (const text of texts) {
    const width = Math.max(text.length, 1);
    const found = text === '' ? at : key.indexOf(text, at);
    if (found === -1 || found + width > end) return false;
    at = found + width;
  }
  return true;
}

/** A parenthesized or readonly type's underlying syntax, without following aliases. */
function unwrappedType(type: TypeNode): TypeNode {
  let each = type;
  while (
    isParenthesizedTypeNode(each) ||
    (isTypeOperatorNode(each) && each.operator === SyntaxKind.ReadonlyKeyword)
  ) {
    each = each.type;
  }
  return each;
}

/** The literal keys a union names; `number` selects any numeric tuple or array element. */
function indexKeys(type: TypeNode): IndexKeys | undefined {
  const keys: string[] = [];
  const pending = [type];
  let numeric = false;
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const each = unwrappedType(at);
    if (isUnionTypeNode(each)) {
      pending.push(...each.types);
      continue;
    }
    if (each.kind === SyntaxKind.NumberKeyword) {
      numeric = true;
      continue;
    }
    const key = isLiteralTypeNode(each) ? literalKey(each.literal) : undefined;
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return numeric ? 'number' : keys;
}

/** A literal property key, decoded independently of quoting and numeric spelling. */
function literalKey(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (isNumericLiteral(node)) return String(Number(node.text));
  if (isPrefixUnaryExpression(node) && isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text);
    return String(node.operator === SyntaxKind.MinusToken ? -value : value);
  }
  return undefined;
}

/** The name a property or accessor declares, including literal and constant computed names. */
export function memberName(member: TypeElement): string | undefined {
  if (!propertyLike(member)) return undefined;
  const { name } = member;
  if (isComputedPropertyName(name)) return constantKey(name.expression);
  return isIdentifier(name) ? name.text : literalKey(name);
}

type NamedMember =
  | GetAccessorDeclaration
  | MethodSignatureDeclaration
  | PropertySignatureDeclaration
  | SetAccessorDeclaration;

/** Properties, accessors and methods are named; index, call and construct signatures are not. */
function propertyLike(member: TypeElement): member is NamedMember {
  return (
    isPropertySignatureDeclaration(member) ||
    isMethodSignatureDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  );
}

/**
 * A computed name's literal key, following `const` declarations TypeScript types by that literal:
 * a written literal type, or else an unannotated literal or constant initializer. Assertions and
 * other expressions keep their own types, so they stay unread.
 */
function constantKey(expression: Expression): string | undefined {
  const seen = new Set<VariableDeclaration>();
  let value: Expression | undefined = expression;
  while (value !== undefined) {
    while (isParenthesizedExpression(value)) value = value.expression;
    const key = literalKey(value);
    if (key !== undefined || !isIdentifier(value)) return key;
    const declared = frameDeclarationOf(value);
    if (declared === undefined || !constantDeclaration(declared) || seen.has(declared))
      return undefined;
    seen.add(declared);
    if (declared.type !== undefined)
      return isLiteralTypeNode(declared.type) ? literalKey(declared.type.literal) : undefined;
    value = declared.initializer;
  }
  return undefined;
}

/** A whole `const` binding, typed by its written literal type or else by its initializer. */
function constantDeclaration(declared: FrameDeclaration): declared is VariableDeclaration {
  return (
    isVariableDeclaration(declared) &&
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\b/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** A selected property's value type, without reading a method's return as the method itself. */
function memberType(member: TypeElement): TypeNode | undefined {
  if (isPropertySignatureDeclaration(member) || isGetAccessorDeclaration(member)) {
    return member.type;
  }
  return isSetAccessorDeclaration(member) ? member.parameters[0]?.type : undefined;
}

/** Whether every written key is a canonical non-negative array index. */
function numericKeys(keys: IndexKeys): boolean {
  return typeof keys === 'string' || keys.every((key) => tupleIndex(key) !== undefined);
}

/** Fixed tuple positions before an unresolved rest; finite literal rests retain their written offsets. */
function tupleMembers(tuple: TupleTypeNode, keys: IndexKeys): readonly TypeNode[] | undefined {
  const elements: TypeNode[] = [];
  const pending = tuple.elements.toReversed();
  let unresolved = false;
  for (let element = pending.pop(); element !== undefined; element = pending.pop()) {
    const nested = writtenRestType(element);
    if (nested === undefined) {
      elements.push(tupleElementType(element));
      continue;
    }
    if (isTupleTypeNode(nested)) {
      pending.push(...nested.elements.toReversed());
      continue;
    }
    unresolved = true;
    if (typeof keys !== 'string') break;
    if (isArrayTypeNode(nested)) elements.push(nested.elementType);
  }
  if (typeof keys === 'string') return unresolved && elements.length === 0 ? undefined : elements;
  return literalTupleMembers(elements, keys, unresolved);
}

/** A written fixed or optional tuple element retains its original underlying type. */
function tupleElementType(element: TypeNode): TypeNode {
  return isNamedTupleMember(element) || isOptionalTypeNode(element) ? element.type : element;
}

/** A written tuple rest's underlying syntax, preserving the original type nodes and environment. */
function writtenRestType(element: TypeNode): TypeNode | undefined {
  return isRestTypeNode(element) ||
    (isNamedTupleMember(element) && element.dotDotDotToken !== undefined)
    ? unwrappedType(element.type)
    : undefined;
}

/** Known positions stay selected; an entirely unresolved numeric selection remains opaque. */
function literalTupleMembers(
  elements: readonly TypeNode[],
  keys: readonly string[],
  unresolved: boolean,
): readonly TypeNode[] | undefined {
  const selected = keys.flatMap((key) => {
    const index = tupleIndex(key);
    const element = index === undefined ? undefined : elements[index];
    return element === undefined ? [] : [element];
  });
  return unresolved && selected.length === 0 && keys.length > 0 && numericKeys(keys)
    ? undefined
    : selected;
}

/** A canonical non-negative integer key, excluding arbitrary strings such as `01` or `length`. */
function tupleIndex(key: string): number | undefined {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key ? index : undefined;
}
