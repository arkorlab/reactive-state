import {
  type Expression,
  type Identifier,
  isArrayTypeNode,
  isComputedPropertyName,
  isIdentifier,
  isIndexSignatureDeclaration,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isStringLiteral,
  isTupleTypeNode,
  isTypeLiteralNode,
  type TypeLiteralNode,
  isTypeReferenceNode,
  isTypeOperatorNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { frameDeclarationOf } from './framed-bindings.ts';
import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';
import { homomorphicSourceReading } from './local-type-mapped-members.ts';
import { memberName } from './local-type-members.ts';
import { propertyMember } from './local-type-weak-objects.ts';

/** Native Omit filters type-key identities before a surviving numeric runtime property is selected. */
type KeyKind = SyntaxKind.StringKeyword | SyntaxKind.NumberKeyword;
interface KeyIdentity {
  readonly kind: KeyKind;
  readonly broad: boolean;
}
type Operands = (reading: TypeReading) => readonly TypeReading[];

const ACTIVE = new Set<string>();

/** Only a complete set of original numeric-name keys can prove that Omit removed this property. */
export function omittedNumericKey(
  object: TypeReading,
  key: string,
  excluded: readonly TypeReading[],
  operands: Operands,
): boolean {
  const origins = keyOrigins(object, key, operands);
  return (
    origins !== undefined &&
    origins.length > 0 &&
    origins.every((origin) => included(key, origin, excluded))
  );
}

/** Each resolved original operand retains its own bindings while a repeated projection stays unknown. */
function keyOrigins(
  at: TypeReading,
  key: string,
  operands: Operands,
): readonly KeyIdentity[] | undefined {
  const identity = JSON.stringify([typeReadingKey(at), key]);
  if (ACTIVE.has(identity)) return undefined;
  ACTIVE.add(identity);
  try {
    const origins: KeyIdentity[] = [];
    const sources = operands(at);
    if (sources.length === 0) return undefined;
    for (const source of sources) {
      const keys = sourceKeys(source, key, operands);
      if (keys === undefined) return undefined;
      origins.push(...keys);
    }
    return origins;
  } finally {
    ACTIVE.delete(identity);
  }
}

/** Finite written bodies, inherited interfaces and existing native projections keep their key domains. */
function sourceKeys(
  at: TypeReading,
  key: string,
  operands: Operands,
): readonly KeyIdentity[] | undefined {
  const { type } = at;
  const transparent = preservingKeySource(at);
  if (transparent !== undefined) return keyOrigins(transparent, key, operands);
  if (isArrayTypeNode(type)) return [{ kind: SyntaxKind.NumberKeyword, broad: true }];
  if (isTupleTypeNode(type))
    return [
      { kind: SyntaxKind.NumberKeyword, broad: true },
      { kind: SyntaxKind.StringKeyword, broad: false },
    ];
  if (isTypeLiteralNode(type)) return shapeKeys([at], key, operands);
  const interfaces = interfaceShapeReadings(at, operands);
  if (interfaces !== undefined)
    return interfaces.unknown ? undefined : shapeKeys(interfaces.sources, key, operands);
  const name = nativeName(at);
  if (name === 'Array' || name === 'ReadonlyArray')
    return [{ kind: SyntaxKind.NumberKeyword, broad: true }];
  if (!isTypeReferenceNode(type) || type.typeArguments?.length !== 2) return undefined;
  const [object, keys] = type.typeArguments;
  if (object === undefined || keys === undefined) return undefined;
  if (name === 'Record') return argumentKeys({ ...at, type: object }, key, operands);
  if (name === 'Pick') return argumentKeys({ ...at, type: keys }, key, operands);
  if (name !== 'Omit') return undefined;
  const originals = keyOrigins({ ...at, type: object }, key, operands);
  const excluded = operands({ ...at, type: keys });
  return originals?.filter((origin) => !included(key, origin, excluded));
}

/** Existing member selection transparency preserves both identity maps and readonly array syntax. */
function preservingKeySource(at: TypeReading): TypeReading | undefined {
  const mapped = homomorphicSourceReading(at);
  if (mapped !== undefined) return mapped;
  const { type } = at;
  return isTypeOperatorNode(type) && type.operator === SyntaxKind.ReadonlyKeyword
    ? { ...at, type: type.type }
    : undefined;
}

/** An index domain subsumes literal keys of its own primitive kind, including inherited indices. */
function shapeKeys(
  sources: readonly TypeReading[],
  key: string,
  operands: Operands,
): readonly KeyIdentity[] | undefined {
  const finite: KeyIdentity[] = [];
  const domains = new Set<KeyKind>();
  for (const source of sources) {
    if (!isTypeLiteralNode(source.type)) return undefined;
    const named = finiteShapeKeys(source.type, key);
    const indexed = shapeDomains(source, operands);
    if (named === undefined || indexed === undefined) return undefined;
    finite.push(...named);
    for (const kind of indexed) domains.add(kind);
  }
  return [
    ...finite.filter(({ kind }) => !domains.has(kind)),
    ...[...domains].map((kind) => ({ kind, broad: true })),
  ];
}

/** A numeric-name member retains the primitive identity of its written declaration. */
function finiteShapeKeys(type: TypeLiteralNode, key: string): readonly KeyIdentity[] | undefined {
  const result: KeyIdentity[] = [];
  for (const member of type.members) {
    if (!propertyMember(member)) continue;
    const name = memberName(member);
    if (name === undefined) return undefined;
    if (name !== key) continue;
    let kind: KeyKind | undefined;
    if (isComputedPropertyName(member.name)) kind = computedKind(member.name.expression);
    else kind = isNumericLiteral(member.name) ? SyntaxKind.NumberKeyword : SyntaxKind.StringKeyword;
    if (kind === undefined) return undefined;
    result.push({ kind, broad: false });
  }
  return result;
}

/** A written string index includes numeric keys, while a numeric index keeps its own broad domain. */
function shapeDomains(source: TypeReading, operands: Operands): ReadonlySet<KeyKind> | undefined {
  if (!isTypeLiteralNode(source.type)) return undefined;
  const domains = new Set<KeyKind>();
  for (const member of source.type.members) {
    if (!isIndexSignatureDeclaration(member)) continue;
    const type = member.parameters[0]?.type;
    if (type === undefined) return undefined;
    const indexed = resolvedIndexDomains({ ...source, type }, operands);
    if (indexed === undefined) return undefined;
    for (const kind of indexed) domains.add(kind);
  }
  return domains;
}

/** Broad index aliases use their original argument environment; unproved domains cannot erase a key. */
function resolvedIndexDomains(
  at: TypeReading,
  operands: Operands,
): ReadonlySet<KeyKind> | undefined {
  const domains = new Set<KeyKind>();
  const sources = operands(at);
  if (sources.length === 0) return undefined;
  for (const { type } of sources) {
    if (type.kind === SyntaxKind.StringKeyword) {
      domains.add(SyntaxKind.StringKeyword);
      domains.add(SyntaxKind.NumberKeyword);
    } else if (type.kind === SyntaxKind.NumberKeyword) {
      domains.add(SyntaxKind.NumberKeyword);
    } else if (type.kind !== SyntaxKind.SymbolKeyword) {
      return undefined;
    }
  }
  return domains;
}

/** Record and Pick introduce their written key argument rather than the source property's spelling. */
function argumentKeys(
  at: TypeReading,
  key: string,
  operands: Operands,
): readonly KeyIdentity[] | undefined {
  const result: KeyIdentity[] = [];
  const keys = operands(at);
  for (const { type } of keys) {
    if (type.kind === SyntaxKind.NeverKeyword) continue;
    if (type.kind === SyntaxKind.StringKeyword || type.kind === SyntaxKind.NumberKeyword)
      result.push({ kind: type.kind, broad: true });
    else if (isLiteralTypeNode(type)) {
      const literal = literalKey(type.literal);
      if (literal === undefined) return undefined;
      if (literal.key === key) result.push({ kind: literal.kind, broad: false });
    } else return undefined;
  }
  return result;
}

/** Excluding one literal cannot remove a broad index domain, and a string never excludes a number. */
function included(key: string, origin: KeyIdentity, excluded: readonly TypeReading[]): boolean {
  for (const { type } of excluded) {
    if (type.kind === origin.kind) return true;
    if (origin.broad || !isLiteralTypeNode(type)) continue;
    const literal = literalKey(type.literal);
    if (literal?.kind === origin.kind && literal.key === key) return true;
  }
  return false;
}

/** Native utilities respect both lexical and qualified namespace shadows. */
function nativeName({ type }: TypeReading): string | undefined {
  if (!isTypeReferenceNode(type)) return undefined;
  if (isIdentifier(type.typeName))
    return localTypeBinding(type.typeName) === undefined ? type.typeName.text : undefined;
  return qualifiedBuiltinName(type.typeName);
}

/** A literal's runtime name and its original numeric or string type identity. */
function literalKey(node: Node): { readonly key: string; readonly kind: KeyKind } | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    return { key: node.text, kind: SyntaxKind.StringKeyword };
  if (isNumericLiteral(node))
    return { key: String(Number(node.text)), kind: SyntaxKind.NumberKeyword };
  if (isPrefixUnaryExpression(node) && isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text);
    return {
      key: String(node.operator === SyntaxKind.MinusToken ? -value : value),
      kind: SyntaxKind.NumberKeyword,
    };
  }
  return undefined;
}

/** Closed computed const names use the literal kind TypeScript records before runtime coercion. */
function computedKind(expression: Expression): KeyKind | undefined {
  const seen = new Set<VariableDeclaration>();
  let value: Expression | undefined = expression;
  while (value !== undefined) {
    while (isParenthesizedExpression(value)) value = value.expression;
    const literal = literalKey(value);
    if (literal !== undefined) return literal.kind;
    if (!isIdentifier(value)) return undefined;
    const declaration = constantDeclaration(value);
    if (declaration === undefined || seen.has(declaration)) return undefined;
    seen.add(declaration);
    if (declaration.type !== undefined)
      return isLiteralTypeNode(declaration.type)
        ? literalKey(declaration.type.literal)?.kind
        : undefined;
    value = declaration.initializer;
  }
  return undefined;
}

/** A whole const name follows the same literal annotation/initializer boundary as memberName. */
function constantDeclaration(identifier: Identifier): VariableDeclaration | undefined {
  const declaration = frameDeclarationOf(identifier);
  return declaration !== undefined &&
    isVariableDeclaration(declaration) &&
    isIdentifier(declaration.name) &&
    isVariableDeclarationList(declaration.parent) &&
    /^const\b/u.test(declaration.parent.getText(declaration.getSourceFile()))
    ? declaration
    : undefined;
}
