import {
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isInferTypeNode,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTypeLiteralNode,
  isUnionTypeNode,
  type TypeElement,
  type TypeLiteralNode,
  type TypeNode,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { referencePatternPairs } from './local-type-reference-patterns.ts';
import { sequencePatternMatch, sequenceReading } from './local-type-sequence-patterns.ts';

/** Inferred parameter candidates selected only by explicitly corresponding written paths. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
interface Pair {
  readonly checked: TypeReading;
  readonly pattern: TypeReading;
}

/** Selected infer operands, without asserting structural contravariant assignability. */
export function functionParameterCaptures(
  checked: TypeReading,
  pattern: TypeReading,
  resolve: Resolve,
): readonly Pair[] {
  const result: Pair[] = [];
  const pending = [{ checked, pattern }];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const actual = resolve(pair.checked);
    const target = resolve(pair.pattern);
    if (actual === undefined || target === undefined) continue;
    if (isInferTypeNode(target.type)) {
      result.push({ checked: actual, pattern: target });
      continue;
    }
    if (isUnionTypeNode(actual.type)) {
      pending.push(
        ...actual.type.types.map((type) => ({ checked: { ...actual, type }, pattern: target })),
      );
      continue;
    }
    const source = sequenceReading(actual).reading;
    const parameter = sequenceReading(target).reading;
    const references = referencePatternPairs(source, parameter);
    const sequence = sequencePatternMatch(source, parameter, resolve);
    pending.push(...(references ?? sequence?.pairs ?? memberPairs(source, parameter)));
  }
  return result;
}

/** Only matching named written members select a candidate; unrelated fields remain unread. */
function memberPairs(checked: TypeReading, pattern: TypeReading): readonly Pair[] {
  if (!isTypeLiteralNode(checked.type) || !isTypeLiteralNode(pattern.type)) return [];
  const pairs: Pair[] = [];
  for (const member of pattern.type.members) {
    const name = memberName(member);
    const value = memberValue(member);
    if (name === undefined || value === undefined) continue;
    const source = sourceValue(checked.type, name);
    if (source !== undefined) {
      pairs.push({ checked: { ...checked, type: source }, pattern: { ...pattern, type: value } });
    }
  }
  return pairs;
}

/** The source data member at a literal name, rather than a method's returned value. */
function sourceValue(type: TypeLiteralNode, name: string): TypeNode | undefined {
  for (const member of type.members) {
    if (memberName(member) === name) return memberValue(member);
  }
  return undefined;
}

/** A written property or accessor's value. */
function memberValue(member: TypeElement): TypeNode | undefined {
  if (isPropertySignatureDeclaration(member) || isGetAccessorDeclaration(member))
    return member.type;
  return isSetAccessorDeclaration(member) ? member.parameters[0]?.type : undefined;
}

/** A literal property name, including literal computed names. */
function memberName(member: TypeElement): string | undefined {
  if (
    !isPropertySignatureDeclaration(member) &&
    !isGetAccessorDeclaration(member) &&
    !isSetAccessorDeclaration(member)
  )
    return undefined;
  const { name } = member;
  const key = isComputedPropertyName(name) ? name.expression : name;
  if (isIdentifier(key) && !isComputedPropertyName(name)) return key.text;
  if (isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key)) return key.text;
  return isNumericLiteral(key) ? String(Number(key.text)) : undefined;
}
