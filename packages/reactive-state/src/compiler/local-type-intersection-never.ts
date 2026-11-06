import {
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isUnionTypeNode,
  SyntaxKind,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { inferredCandidates, type InferredCandidate } from './local-type-inferred-candidates.ts';
import { literalKind } from './local-type-utility-readings.ts';

/** Finite primitive intersections keep their empty result; other intersections retain uncertainty. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
interface Work {
  readonly reading: TypeReading;
  readonly ancestors: ReadonlySet<TypeReading['type']>;
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

interface Domain {
  readonly candidates: readonly InferredCandidate[];
  readonly uncertain: boolean;
  readonly empty: boolean;
}

/** Explicit never wins; unknown is neutral; an any or opaque operand cannot prove nonemptiness. */
export function intersectionNeverTruth(at: TypeReading, resolve: Resolve): boolean | undefined {
  const domain = intersectionParts(at, resolve);
  if (domain.empty) return true;
  if (domain.candidates.length === 0) return domain.uncertain ? undefined : false;
  const results = inferredCandidates(domain.candidates, resolve);
  const first = results[0];
  if (first === undefined || results.length !== 1) return undefined;
  const empty = primitiveNeverTruth(first, resolve);
  if (empty === true) return true;
  return empty === false && !domain.uncertain ? false : undefined;
}

/** A repeated source within its own intersection ancestry contributes no closed-type proof. */
function intersectionParts(at: TypeReading, resolve: Resolve): Domain {
  const pending: Work[] = [{ reading: at, ancestors: new Set() }];
  const candidates: InferredCandidate[] = [];
  let uncertain = false;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const reading = resolve(next.reading);
    if (reading === undefined || next.ancestors.has(reading.type)) {
      uncertain = true;
      continue;
    }
    const { type } = reading;
    if (isIntersectionTypeNode(type)) {
      const ancestors = new Set([...next.ancestors, type]);
      pending.push(
        ...type.types.map((member) => ({ reading: { ...reading, type: member }, ancestors })),
      );
      continue;
    }
    if (type.kind === SyntaxKind.UnknownKeyword) continue;
    const empty = primitiveNeverTruth(reading, resolve);
    if (empty === true) return { candidates, uncertain, empty: true };
    if (empty === undefined) uncertain = true;
    else candidates.push({ reading, contravariant: true });
  }
  return { candidates, uncertain, empty: false };
}

/** Complete written primitive unions are the existing combiner's domain; cyclic shapes are opaque. */
function primitiveNeverTruth(at: TypeReading, resolve: Resolve): boolean | undefined {
  const pending: Work[] = [{ reading: at, ancestors: new Set() }];
  let nonempty = false;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const reading = resolve(next.reading);
    if (reading === undefined || next.ancestors.has(reading.type)) return undefined;
    const { type } = reading;
    if (isUnionTypeNode(type)) {
      const ancestors = new Set([...next.ancestors, type]);
      pending.push(
        ...type.types.map((member) => ({ reading: { ...reading, type: member }, ancestors })),
      );
      continue;
    }
    if (type.kind === SyntaxKind.NeverKeyword) continue;
    const kind = isLiteralTypeNode(type) ? literalKind(type) : type.kind;
    if (!PRIMITIVES.has(kind)) return undefined;
    nonempty = true;
  }
  return !nonempty;
}
