import type { Node, TypeParameterDeclaration } from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import type { InferredCandidate } from './local-type-inferred-candidates.ts';

/** Readings, inferred groups and queued pairs of the written conditional matcher. */

export type Bindings = ReadonlyMap<TypeParameterDeclaration, TypeReading>;
export type Resolve = (reading: TypeReading) => TypeReading | undefined;
export type Compare = (checked: TypeReading, pattern: TypeReading) => boolean | undefined;

export interface Pair {
  readonly checked: TypeReading;
  readonly pattern: TypeReading;
}

export interface Inference {
  readonly owner: Node | undefined;
  readonly name: string;
  readonly declarations: Set<TypeParameterDeclaration>;
  readonly candidates: InferredCandidate[];
}

export type Parameters = Omit<Inference, 'candidates'>;
export interface MatchResult {
  readonly matches: boolean | undefined;
  readonly branches?: readonly Pair[];
}

export interface Matching {
  matches: boolean | undefined;
  readonly parameters: readonly Parameters[];
  readonly pending: Pair[];
  readonly groups: Inference[];
  readonly resolve: Resolve;
  readonly compare: Compare;
  readonly expandedObjects: Set<string>;
}
