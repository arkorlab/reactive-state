import {
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isIndexSignatureDeclaration,
  isMethodSignatureDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTypeLiteralNode,
  type Node,
  SyntaxKind,
  type TypeElement,
  type TypeLiteralNode,
  type TypeNode,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { getterMemberTypes } from './local-type-members.ts';
import { normalizedAnyOperand } from './local-type-never-any.ts';

/** Written index signatures and the source values their string or number domains select. */

interface Pair {
  readonly checked: TypeReading;
  readonly pattern: TypeReading;
}

interface Match {
  readonly matches: boolean | undefined;
  readonly pairs: readonly Pair[];
}

type Domain = SyntaxKind.StringKeyword | SyntaxKind.NumberKeyword;

interface InterfaceIndexRelations {
  readonly resolve: (at: TypeReading) => TypeReading | undefined;
  readonly compare: (source: TypeReading, target: TypeReading) => boolean | undefined;
}

interface Signatures {
  readonly strings: TypeNode[];
  readonly numbers: TypeNode[];
  unknown: boolean;
}

/** Selected source values retain their own argument environments, apart from the target pattern. */
export function indexPatternMatch(
  checked: TypeReading,
  pattern: TypeReading,
  member: TypeElement,
): Match | undefined {
  if (!isIndexSignatureDeclaration(member)) return undefined;
  const domain = member.parameters[0]?.type?.kind;
  if (
    !isTypeLiteralNode(checked.type) ||
    (domain !== SyntaxKind.StringKeyword && domain !== SyntaxKind.NumberKeyword)
  ) {
    return { matches: undefined, pairs: [] };
  }
  const signatures = sourceSignatures(checked.type);
  const selected = coveringSignatures(signatures, domain);
  if (selected.length > 0) {
    return {
      matches: signatures.unknown ? undefined : true,
      pairs: pairsOf(selected, member.type, checked, pattern),
    };
  }
  const fields = sourceFields(checked.type, domain);
  const values = [...fields.values];
  if (domain === SyntaxKind.StringKeyword) values.push(...signatures.numbers);
  return {
    matches: fields.unknown || signatures.unknown ? undefined : true,
    pairs: pairsOf(values, member.type, checked, pattern),
  };
}

/** Interfaces require covering signatures except for the native written-any string-index rule. */
export function interfaceIndexPatternMatch(
  { sources, unknown }: { readonly sources: readonly TypeReading[]; readonly unknown: boolean },
  pattern: TypeReading,
  member: TypeElement,
  relations: InterfaceIndexRelations,
): Match | undefined {
  if (!isIndexSignatureDeclaration(member)) return undefined;
  const domain = member.parameters[0]?.type?.kind;
  if (domain !== SyntaxKind.StringKeyword && domain !== SyntaxKind.NumberKeyword)
    return { matches: undefined, pairs: [] };
  if (anyIndexRequirement(pattern, member.type, relations)) return { matches: true, pairs: [] };
  const signatures = interfaceSignatures(sources);
  const values =
    domain === SyntaxKind.NumberKeyword && signatures.numbers.length > 0
      ? signatures.numbers
      : signatures.strings;
  const uncertain = unknown || signatures.unknown;
  let matches: boolean | undefined = values.length > 0;
  if (uncertain) matches = undefined;
  return {
    matches,
    pairs: values.map((checked) => {
      return {
        checked: { ...checked, aliases: new Set<string>() },
        pattern: { ...pattern, type: member.type },
      };
    }),
  };
}

/** A written-any target is permissive only beside an explicit string index in this target. */
function anyIndexRequirement(
  pattern: TypeReading,
  type: TypeNode,
  relations: InterfaceIndexRelations,
): boolean {
  if (
    !isTypeLiteralNode(pattern.type) ||
    !pattern.type.members.some((member) => {
      return (
        isIndexSignatureDeclaration(member) &&
        member.parameters[0]?.type?.kind === SyntaxKind.StringKeyword
      );
    })
  ) {
    return false;
  }
  const reading = normalizedAnyOperand(
    relations.resolve({ ...pattern, type }),
    relations.resolve,
    relations.compare,
  );
  return reading?.type.kind === SyntaxKind.AnyKeyword && reading.type.pos >= 0;
}

/** The nearest written domain keeps its own declaration's actual argument environment. */
function interfaceSignatures(sources: readonly TypeReading[]): {
  readonly strings: readonly TypeReading[];
  readonly numbers: readonly TypeReading[];
  readonly unknown: boolean;
} {
  let strings: readonly TypeReading[] = [];
  let numbers: readonly TypeReading[] = [];
  let unknown = false;
  for (const reading of sources) {
    if (!isTypeLiteralNode(reading.type)) {
      unknown = true;
      continue;
    }
    const signatures = sourceSignatures(reading.type);
    unknown ||= signatures.unknown;
    if (strings.length === 0) strings = signatures.strings.map((type) => ({ ...reading, type }));
    if (numbers.length === 0) numbers = signatures.numbers.map((type) => ({ ...reading, type }));
  }
  return { numbers, strings, unknown };
}

/** A number signature overrides a string signature for a numeric target, as it does for key reads. */
function coveringSignatures(source: Signatures, domain: Domain): readonly TypeNode[] {
  if (domain === SyntaxKind.NumberKeyword && source.numbers.length > 0) return source.numbers;
  return source.strings;
}

/** Explicit index domains; symbols do not contribute a string or numeric candidate. */
function sourceSignatures(source: TypeLiteralNode): Signatures {
  const result: Signatures = { numbers: [], strings: [], unknown: false };
  for (const member of source.members) {
    if (!isIndexSignatureDeclaration(member)) continue;
    const domain = member.parameters[0]?.type?.kind;
    if (domain === SyntaxKind.StringKeyword) result.strings.push(member.type);
    else if (domain === SyntaxKind.NumberKeyword) result.numbers.push(member.type);
    else if (domain !== SyntaxKind.SymbolKeyword) result.unknown = true;
  }
  return result;
}

/** Named properties contribute only where no covering signature already states the value type. */
function sourceFields(
  source: TypeLiteralNode,
  domain: Domain,
): { readonly values: readonly TypeNode[]; readonly unknown: boolean } {
  const values: TypeNode[] = [];
  let unknown = false;
  for (const member of source.members) {
    if (isIndexSignatureDeclaration(member)) continue;
    const name = memberName(member);
    if (name === undefined) {
      unknown = true;
      continue;
    }
    if (domain === SyntaxKind.NumberKeyword && !numericName(name)) continue;
    if (isSetAccessorDeclaration(member) && getterMemberTypes(source, name) !== undefined) continue;
    const value = memberValue(member);
    if (value === undefined) unknown = true;
    else values.push(value);
  }
  return { unknown, values };
}

/** Each value and target keep their original declarations and actual generic arguments. */
function pairsOf(
  values: readonly TypeNode[],
  target: TypeNode,
  checked: TypeReading,
  pattern: TypeReading,
): readonly Pair[] {
  return values.map((type) => {
    return {
      checked: { ...checked, type },
      pattern: { ...pattern, type: target },
    };
  });
}

/** A declared data value, without interpreting a method's returned value as the method itself. */
function memberValue(member: TypeElement): TypeNode | undefined {
  if (isPropertySignatureDeclaration(member) || isGetAccessorDeclaration(member))
    return member.type;
  return isSetAccessorDeclaration(member) ? member.parameters[0]?.type : undefined;
}

/** A written property or method key, with literal computed keys decoded like ordinary keys. */
function memberName(member: TypeElement): string | undefined {
  if (
    !isPropertySignatureDeclaration(member) &&
    !isMethodSignatureDeclaration(member) &&
    !isGetAccessorDeclaration(member) &&
    !isSetAccessorDeclaration(member)
  ) {
    return undefined;
  }
  const { name } = member;
  if (isComputedPropertyName(name)) return literalName(name.expression);
  return isIdentifier(name) ? name.text : literalName(name);
}

/** A literal key independent of its quoting or numeric spelling. */
function literalName(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (isNumericLiteral(node)) return String(Number(node.text));
  if (isPrefixUnaryExpression(node) && isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text);
    return String(node.operator === SyntaxKind.MinusToken ? -value : value);
  }
  return undefined;
}

/** A canonical numeric property name, excluding arbitrary spellings such as `01` or `1e2`. */
function numericName(name: string): boolean {
  return name !== '' && String(Number(name)) === name;
}
