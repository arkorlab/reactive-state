import type { ColumnRef, Fact, Occurrence, Scope, StatementRead } from './scopes.ts';
import { holdsKind } from './values.ts';
import type { Term } from './where.ts';

/**
 * The columns of each source of a statement that hold one of its parameters on every row that
 * counts: a term of a condition of the source's own scope, or an equality with a column that does.
 * `b.k = a.f and a.f = ?` says `b.k` holds the parameter.
 *
 * An equality hands a parameter on between columns compared alike alone. `INTEGER` 5 equals `TEXT`
 * `'05'`, whose key's text is not the parameter's, and `NOCASE` finds two texts equal that are not.
 * It hands one to a column of the scope it stands in, from that scope or one around it, and a
 * `LEFT JOIN`'s `ON` to its right table alone.
 */

/** How a column compares, of which two alike hand a parameter on; none of what compares otherwise. */
export type Comparison = (of: ColumnRef) => string | undefined;

/** How a column of the declared `type` compares, of a table of no collation of its own. */
export function comparisonOf(type: string | undefined, collated: boolean): string | undefined {
  if (type === undefined || collated) return undefined;
  return (['integer', 'text'] as const).find((kind) => holdsKind(kind, type));
}

/** Two columns an equality holds of on every row of `to`'s source that counts. */
export interface Edge {
  readonly from: ColumnRef;
  readonly to: ColumnRef;
}

/** Whether `a` and `b` compare alike. */
function alike(comparison: Comparison, a: ColumnRef, b: ColumnRef): boolean {
  const of = comparison(a);
  return of !== undefined && of === comparison(b);
}

/** Whether an equality in `scope`, of the `ON` of the `LEFT JOIN` of `on`, holds of `to`'s rows. */
function holdsOf(to: ColumnRef, scope: Scope, on: Occurrence | undefined): boolean {
  return to.occurrence.scope === scope && (on === undefined || on === to.occurrence);
}

/** A column that holds a parameter, and of which parameters. */
interface Bound {
  readonly of: ColumnRef;
  readonly params: readonly number[];
}

/** The closure of a statement's terms. */
class Closure {
  readonly #bound = new Map<string, Bound>();
  readonly #comparison: Comparison;
  readonly #places: ReadonlyMap<Occurrence, number>;

  constructor(read: StatementRead, comparison: Comparison) {
    this.#comparison = comparison;
    this.#places = new Map(read.occurrences.map((occurrence, at) => [occurrence, at]));
  }

  /** A column's name among those of the statement. */
  #key({ column, occurrence }: ColumnRef): string {
    return `${String(this.#places.get(occurrence))}.${column}`;
  }

  /** Notes that `of` holds `params`: whether that is new. */
  #add(of: ColumnRef, params: readonly number[]): boolean {
    const key = this.#key(of);
    if (this.#bound.has(key)) return false;
    this.#bound.set(key, { of, params });
    return true;
  }

  /** Of a term in `scope`: it says something of its column where the column's own scope is this. */
  #term(fact: Extract<Fact, { kind: 'params' }>, scope: Scope): boolean {
    const { of, on, params } = fact;
    const holds = of.occurrence.scope === scope && (on === undefined || on === of.occurrence);
    return holds && this.#add(of, params);
  }

  /** Of an equality in `scope`, what `from` holds handed on to `to`. */
  #handed(to: ColumnRef, from: ColumnRef, scope: Scope, on: Occurrence | undefined): boolean {
    const known = this.#bound.get(this.#key(from));
    return known !== undefined && holdsOf(to, scope, on) && this.#add(to, known.params);
  }

  /** Of a `LEFT JOIN`'s `ON`: `b.k = a.f and a.f = ?` holds of `b`, though not of `a`. */
  #sameOn(to: ColumnRef, from: ColumnRef, scope: Scope, on: Occurrence): boolean {
    if (to.occurrence !== on) return false;
    const fromKey = this.#key(from);
    const own = scope.facts.find(
      (each) => each.kind === 'params' && each.on === on && this.#key(each.of) === fromKey,
    );
    return own?.kind === 'params' && this.#add(to, own.params);
  }

  /** One pass of `scope`'s facts: whether anything new was found. */
  #pass(scope: Scope): boolean {
    let found = false;
    for (const fact of scope.facts) {
      if (fact.kind === 'params') {
        found = this.#term(fact, scope) || found;
      } else if (alike(this.#comparison, fact.a, fact.b)) {
        for (const [to, from] of [
          [fact.a, fact.b],
          [fact.b, fact.a],
        ] as const) {
          found = this.#handed(to, from, scope, fact.on) || found;
          if (fact.on !== undefined) found = this.#sameOn(to, from, scope, fact.on) || found;
        }
      }
    }
    return found;
  }

  /** Each column of `read`'s that holds a parameter. */
  of(read: StatementRead): readonly Bound[] {
    let found = true;
    while (found) {
      found = false;
      for (const scope of read.scopes) {
        found = this.#pass(scope) || found;
      }
    }
    return [...this.#bound.values()];
  }
}

/** Each equality of `read` between columns compared alike, of each side it holds of. */
export function edgesOf(read: StatementRead, comparison: Comparison): readonly Edge[] {
  const edges: Edge[] = [];
  for (const scope of read.scopes) {
    for (const fact of scope.facts) {
      if (fact.kind === 'equal' && alike(comparison, fact.a, fact.b)) {
        const { a, b, on } = fact;
        if (holdsOf(a, scope, on)) edges.push({ from: b, to: a });
        if (holdsOf(b, scope, on)) edges.push({ from: a, to: b });
      }
    }
  }
  return edges;
}

/** The terms of each source of `read`, of its own conditions and what equalities hand it. */
export function termsOf(
  read: StatementRead,
  comparison: Comparison,
): ReadonlyMap<Occurrence, readonly Term[]> {
  const terms = new Map<Occurrence, Term[]>();
  const bound = new Closure(read, comparison).of(read);
  for (const { of, params } of bound) {
    const own = terms.get(of.occurrence) ?? [];
    terms.set(of.occurrence, own);
    own.push({ column: of.column, params });
  }
  return terms;
}
