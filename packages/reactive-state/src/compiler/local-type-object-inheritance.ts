import {
  factory,
  isFunctionTypeNode,
  isLiteralTypeNode,
  isMethodSignatureDeclaration,
  isPropertySignatureDeclaration,
  SyntaxKind,
  type FunctionTypeNode,
  type TypeElement,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { writtenSignaturePatternMatch } from './local-type-function-patterns.ts';
import { memberName, optionalMember } from './local-type-weak-objects.ts';

/** Missing written Object members remain possible without inventing inherited inference candidates. */

type Resolve = (at: TypeReading) => TypeReading | undefined;
type Compare = (source: TypeReading, target: TypeReading) => boolean | undefined;
interface Matching {
  readonly resolve: Resolve;
  readonly compare: Compare;
}

const OBJECT_MEMBERS = new Set([
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** Whether an unwritten name can denote one of the native Object type's inherited members. */
function inheritedObjectMemberName(name: string): boolean {
  return OBJECT_MEMBERS.has(name);
}

const STRING_RESULT = factory.createFunctionTypeNode(
  undefined,
  [],
  factory.createKeywordTypeNode(SyntaxKind.StringKeyword),
);
const PRIMITIVES = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NeverKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.VoidKeyword,
]);

/** Ordinary missing fields retain optionality; inherited native names are not proven absent. */
export function absentMember(
  member: TypeElement,
  pattern: TypeReading,
  tools: Matching,
): boolean | undefined {
  const name = memberName(member);
  if (name === undefined) return undefined;
  if (!inheritedObjectMemberName(name)) return optionalMember(member);
  let signature: FunctionTypeNode | undefined;
  if (isPropertySignatureDeclaration(member)) {
    const value = tools.resolve({ ...pattern, type: member.type });
    if (value !== undefined && (isLiteralTypeNode(value.type) || PRIMITIVES.has(value.type.kind)))
      return false;
    if (value !== undefined && isFunctionTypeNode(value.type)) signature = value.type;
  }
  if (name !== 'toString' && name !== 'toLocaleString') return undefined;
  const expected = isMethodSignatureDeclaration(member) ? member : signature;
  if (expected === undefined) return undefined;
  const actual = { ...pattern, type: STRING_RESULT };
  const result = writtenSignaturePatternMatch(
    { reading: actual, signature: STRING_RESULT },
    { reading: pattern, signature: expected },
    tools.resolve,
    tools.compare,
  );
  if (result.matches === false) return false;
  return result.pairs.some((pair) => tools.compare(pair.checked, pair.pattern) === false)
    ? false
    : undefined;
}
