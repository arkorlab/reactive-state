import {
  isClassDeclaration,
  isClassExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isTypeReferenceNode,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { typeBindingKey, typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { inferredCandidates } from './local-type-inferred-candidates.ts';
import { qualifiedLocalTypeBinding } from './local-type-namespaces.ts';
import { literalKind, STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** The native unknown-receiver guard retains any/unknown intersections before callable erasure. */

type Operands = (reading: TypeReading) => readonly TypeReading[];
type DomainKind = 'any' | 'known' | 'never' | 'unknown';
interface Domain {
  readonly kind: DomainKind;
  readonly primitive?: TypeReading | undefined;
  readonly nonNullable?: boolean;
  readonly objectOnly?: boolean;
  readonly closed?: boolean;
  readonly record?: string | undefined;
}
interface Work {
  readonly readings: readonly TypeReading[];
  readonly results: Domain[];
  readonly intersection: boolean;
}
const PRIMITIVES = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
]);
const NON_NULLABLE = new Set([
  SyntaxKind.ArrayType,
  SyntaxKind.ConstructorType,
  SyntaxKind.FunctionType,
  SyntaxKind.MappedType,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.TupleType,
  SyntaxKind.TypeLiteral,
]);

/** Union alternatives and nested intersections retain their original actual argument readings. */
export function receiverAcceptsUnknown(at: TypeReading, operands: Operands): boolean {
  const pending: Work[] = [{ readings: [at], results: [], intersection: false }];
  let result: Domain = { kind: 'known' };
  for (let work = pending.at(-1); work !== undefined; work = pending.at(-1)) {
    const next = work.readings[work.results.length];
    if (next !== undefined) {
      const prepared = receiverWork(next, operands);
      if ('kind' in prepared) work.results.push(prepared);
      else pending.push(prepared);
      continue;
    }
    result = work.intersection ? intersectionDomain(work.results) : unionDomain(work.results);
    pending.pop();
    pending.at(-1)?.results.push(result);
  }
  return result.kind === 'any' || result.kind === 'unknown';
}

/** Only written intersections need joint reduction; the existing resolver supplies union arms. */
function receiverWork(at: TypeReading, operands: Operands): Work | Domain {
  const readings = operands(at);
  if (readings.length === 0) return { kind: 'known' };
  const [reading] = readings;
  if (reading === undefined || readings.length !== 1)
    return { readings, results: [], intersection: false };
  const { type } = reading;
  if (isIntersectionTypeNode(type))
    return {
      readings: type.types.map((member) => ({ ...reading, type: member })),
      results: [],
      intersection: true,
    };
  if (type.kind === SyntaxKind.AnyKeyword) return { kind: 'any', closed: true };
  if (type.kind === SyntaxKind.UnknownKeyword) return { kind: 'unknown', closed: true };
  if (type.kind === SyntaxKind.NeverKeyword) return { kind: 'never' };
  const kind = isLiteralTypeNode(type) ? literalKind(type) : type.kind;
  const nonNullable = NON_NULLABLE.has(kind) || nonNullableReference(reading);
  return {
    kind: 'known',
    primitive: PRIMITIVES.has(kind) ? reading : undefined,
    nonNullable,
    objectOnly: kind === SyntaxKind.ObjectKeyword,
    closed: PRIMITIVES.has(kind) || nonNullable,
    record: receiverRecord(reading),
  };
}

/** Only closed record declarations identify whether a source union retains distinct object types. */
function receiverRecord(at: TypeReading): string | undefined {
  const { type } = at;
  if (type.kind === SyntaxKind.TypeLiteral && at.bindings.size === 0)
    return `literal:${typeReadingKey(at)}`;
  if (!isTypeReferenceNode(type) || (type.typeArguments?.length ?? 0) > 0) return undefined;
  const name = type.typeName;
  const binding = isIdentifier(name) ? localTypeBinding(name) : qualifiedLocalTypeBinding(name);
  if (binding !== undefined && binding !== null) return recordDeclaration(at, binding);
  if (binding === null) return undefined;
  const builtin = isIdentifier(name) ? name.text : qualifiedBuiltinName(name);
  return builtin !== undefined && STANDARD_ERRORS.has(builtin) ? `native:${builtin}` : undefined;
}

/** Nongeneric local record declarations have one identity outside supplied argument environments. */
function recordDeclaration(at: TypeReading, declaration: Node): string | undefined {
  if (at.bindings.size > 0) return undefined;
  if (
    !isClassDeclaration(declaration) &&
    !isClassExpression(declaration) &&
    !isInterfaceDeclaration(declaration)
  )
    return undefined;
  return (declaration.typeParameters?.length ?? 0) === 0
    ? `declaration:${typeBindingKey(declaration, at.bindings)}`
    : undefined;
}

/** Written classes/interfaces and the existing native Error/array types are non-nullable records. */
function nonNullableReference(at: TypeReading): boolean {
  const { type } = at;
  if (!isTypeReferenceNode(type)) return false;
  const name = type.typeName;
  const binding = isIdentifier(name) ? localTypeBinding(name) : qualifiedLocalTypeBinding(name);
  if (binding !== undefined && binding !== null)
    return (
      isClassDeclaration(binding) || isClassExpression(binding) || isInterfaceDeclaration(binding)
    );
  if (binding === null) return false;
  const builtin = isIdentifier(name) ? name.text : qualifiedBuiltinName(name);
  return (
    builtin !== undefined &&
    (STANDARD_ERRORS.has(builtin) || builtin === 'Array' || builtin === 'ReadonlyArray')
  );
}

/** An any or unknown union arm keeps the native whole-receiver preservation guard. */
function unionDomain(domains: readonly Domain[]): Domain {
  if (domains.some((domain) => domain.kind === 'any')) return { kind: 'any', closed: true };
  if (domains.some((domain) => domain.kind === 'unknown')) return { kind: 'unknown', closed: true };
  const selected = domains.filter((domain) => domain.kind !== 'never');
  if (selected.length === 0) return { kind: 'never' };
  const records = new Set(selected.map((domain) => domain.record));
  const distinctRecords = !records.has(undefined) && records.size > 1;
  return {
    kind: 'known',
    primitive: primitiveDomain(selected, false),
    nonNullable: !distinctRecords && selected.every((domain) => domain.nonNullable === true),
    objectOnly: selected.every((domain) => domain.objectOnly === true),
    closed: selected.every((domain) => domain.closed === true),
    record: records.size === 1 ? selected[0]?.record : undefined,
  };
}

/** Explicit or finite primitive never dominates any; unknown alone remains the neutral operand. */
function intersectionDomain(domains: readonly Domain[]): Domain {
  if (domains.some((domain) => domain.kind === 'never')) return { kind: 'never' };
  const primitive = primitiveDomain(
    domains.filter((domain) => domain.primitive !== undefined),
    true,
  );
  if (emptyIntersection(domains, primitive)) return { kind: 'never' };
  const closed = domains.every((domain) => domain.closed === true);
  let kind: DomainKind = 'known';
  if (closed && domains.some((domain) => domain.kind === 'any')) kind = 'any';
  else if (domains.every((domain) => domain.kind === 'unknown')) kind = 'unknown';
  return {
    kind,
    primitive,
    nonNullable: domains.some((domain) => domain.nonNullable === true),
    objectOnly: domains.some((domain) => domain.objectOnly === true),
    closed,
  };
}

/** Syntax-known primitive disjointness and nullish/non-nullable intersections retain native never. */
function emptyIntersection(
  domains: readonly Domain[],
  primitive: TypeReading | undefined,
): boolean {
  if (primitive === undefined) return false;
  const { type } = primitive;
  if (type.kind === SyntaxKind.NeverKeyword) return true;
  if (domains.some((domain) => domain.objectOnly === true)) return true;
  const kind = isLiteralTypeNode(type) ? literalKind(type) : type.kind;
  return (
    (kind === SyntaxKind.NullKeyword || kind === SyntaxKind.UndefinedKeyword) &&
    domains.some((domain) => domain.nonNullable === true)
  );
}

/** The existing finite primitive candidate combiner supplies union and intersection identities. */
function primitiveDomain(
  domains: readonly Domain[],
  intersection: boolean,
): TypeReading | undefined {
  if (domains.length === 0 || domains.some((domain) => domain.primitive === undefined))
    return undefined;
  const readings = domains.flatMap((domain) => {
    return domain.primitive === undefined
      ? []
      : [{ reading: domain.primitive, contravariant: intersection }];
  });
  return inferredCandidates(readings, (reading) => reading)[0];
}
