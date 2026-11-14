import {
  isExpressionWithTypeArguments,
  isNamedTupleMember,
  isOptionalTypeNode,
  isParenthesizedTypeNode,
  isRestTypeNode,
  isTupleTypeNode,
  isTypeOperatorNode,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';

/** Written tuple member selections retain each rest's original lexical argument environment. */

type RestSelection = (reading: TypeReading, index: number | undefined) => readonly TypeReading[];
type Operands = (reading: TypeReading) => readonly TypeReading[];

interface Member {
  /** One written member of one expansion: what a path has left to read is a list of these. */
  readonly identity: number;
  readonly reading: TypeReading;
  readonly element: TypeNode;
  readonly parents: readonly TypeReading[];
}
interface Selection {
  readonly pending: Member[];
  position: number;
  /** Past a rest of unknown length, `position` is only the least offset a member can stand at. */
  least: boolean;
}
interface TupleReadings {
  readonly index: number | undefined;
  readonly selectRest: RestSelection;
  readonly operands: Operands;
  readonly result: TypeReading[];
  readonly paths: Selection[];
  /** The states of paths read so far, and how many members have been made. */
  readonly reached: Set<string>;
  readonly made: { members: number };
}

/**
 * Fixed prefixes and the first rest of unknown length keep literal offsets; a member past such a rest
 * may stand at any offset from its least one; numeric selections retain every rest.
 */
export function writtenTupleReadings(
  at: TypeReading,
  index: number | undefined,
  selectRest: RestSelection,
  operands: Operands,
): readonly TypeReading[] | undefined {
  if (isExpressionWithTypeArguments(at.type)) return undefined;
  const tuple = unwrappedType(at.type);
  if (!isTupleTypeNode(tuple)) return undefined;
  const state: TupleReadings = {
    index,
    selectRest,
    operands,
    result: [],
    paths: [],
    reached: new Set(),
    made: { members: 0 },
  };
  state.paths.push({
    least: false,
    pending: tupleMembers({ ...at, type: tuple }, [], state.made),
    position: 0,
  });
  for (let path = state.paths.pop(); path !== undefined; path = state.paths.pop()) {
    for (let member = path.pending.pop(); member !== undefined; member = path.pending.pop()) {
      if (repeatedState(member, path, state) || selectTupleMember(member, path, state)) break;
    }
  }
  return state.result;
}

interface PlaceReads {
  /** The rests a count of places may still read the alternatives of. */
  left: number;
}

/**
 * The rests whose alternatives one count of a tuple's places reads. Shared aliases are met by every
 * path that reaches them, and each alternative of a rest may reach the same one, so what a count
 * costs grows with the ways to reach an alias, not with the aliases: twenty levels of
 * `[...(T | [...T])]` are a million reads of one place. A selection reads each state once, as
 * `repeatedState` has it; a count carries no state, and its reads are what it is bounded by.
 */
const PLACE_READS = 4096;

/**
 * How many places a written tuple's members may stand at, the most any alternative has: each member
 * stands at one, and a rest at the most any alternative of it has. A written tuple has as many as
 * its own places; an array, a cycle or any operand the reader cannot expand has one, from which a
 * rest of unknown length supplies its elements. A count reads the alternatives of at most
 * `PLACE_READS` rests, and a rest it has none left for counts as one, as a cycle does. Undefined
 * where the type is no tuple.
 */
export function writtenTuplePlaces(at: TypeReading, operands: Operands): number | undefined {
  return countedPlaces(at, operands, [], { left: PLACE_READS });
}

/** A tuple's places, its lineage the written tuples above it, which no rest may return to. */
function countedPlaces(
  at: TypeReading,
  operands: Operands,
  parents: readonly TypeReading[],
  reads: PlaceReads,
): number | undefined {
  if (isExpressionWithTypeArguments(at.type)) return undefined;
  const tuple = unwrappedType(at.type);
  if (!isTupleTypeNode(tuple)) return undefined;
  const lineage = [...parents, { ...at, type: tuple }];
  let places = 0;
  for (const element of tuple.elements) {
    const rest = writtenRestType(element);
    places += rest === undefined ? 1 : restPlaces({ ...at, type: rest }, operands, lineage, reads);
  }
  return places;
}

/**
 * The most places any alternative of a rest has, each counted on its own, so that a rest of an array
 * beside a written tuple has the places of the tuple and not the one of the array. A written tuple
 * that is not one above it has the places it is counted at; any other alternative has one.
 */
function restPlaces(
  rest: TypeReading,
  operands: Operands,
  lineage: readonly TypeReading[],
  reads: PlaceReads,
): number {
  if (reads.left <= 0) return 1;
  reads.left -= 1;
  const alternatives = restOperands(rest, operands);
  if (alternatives.length === 0) return 1;
  let most = 0;
  for (const each of alternatives) {
    const cycle = lineage.some((parent) => sameReading(parent, each));
    const places = cycle ? undefined : countedPlaces(each, operands, lineage, reads);
    most = Math.max(most, places ?? 1);
  }
  return most;
}

/**
 * What a path has left to read, and where, decides everything it will select. Alternatives of one
 * rest meet again once their own members are read; the path that comes second selects what the
 * first has, so it ends, and the work is the states there are, not the paths that lead to them.
 */
function repeatedState(member: Member, path: Selection, state: TupleReadings): boolean {
  const left = [...path.pending, member].map(({ identity }) => identity);
  const key = `${path.position}:${path.least ? 1 : 0}:${left.join(',')}`;
  if (state.reached.has(key)) return true;
  state.reached.add(key);
  return false;
}

/** One member either supplies a result, adds finite alternatives or retains the opaque rest rule. */
function selectTupleMember(member: Member, path: Selection, state: TupleReadings): boolean {
  const { reading, element, parents } = member;
  const rest = writtenRestType(element);
  if (rest === undefined) return selectFixedMember(member, path, state);
  const restReading = { ...reading, type: rest };
  const expanded = finiteRestReadings(restReading, state.operands, parents);
  if (expanded === undefined) return selectOpaqueRest(restReading, path, state);
  for (const each of expanded) {
    state.paths.push({
      least: path.least,
      pending: [...path.pending, ...tupleMembers(each, parents, state.made)],
      position: path.position,
    });
  }
  return true;
}

/**
 * A fixed position retains its original member and environment before advancing the offset. Past a
 * rest of unknown length, each member up to the index may be the one a shorter rest brings there.
 */
function selectFixedMember(member: Member, path: Selection, state: TupleReadings): boolean {
  const { index } = state;
  if (index !== undefined && index < path.position) return true;
  if (index === undefined || index === path.position || path.least)
    state.result.push({ ...member.reading, type: tupleElementType(member.element) });
  if (index === path.position && !path.least) return true;
  if (index !== undefined) path.position += 1;
  return false;
}

/**
 * A rest of unknown length holds the index at the offset the fixed positions before it leave, or at
 * any offset once an earlier rest left them unknown; the members after it may hold the index too.
 */
function selectOpaqueRest(reading: TypeReading, path: Selection, state: TupleReadings): boolean {
  const { index } = state;
  if (index === undefined) {
    state.result.push(...state.selectRest(reading, undefined));
    return false;
  }
  if (index < path.position) return true;
  const offset = path.least ? undefined : index - path.position;
  state.result.push(...state.selectRest(reading, offset));
  path.least = true;
  return path.pending.length === 0;
}

/** The operands of a rest as written: only the parentheses and `readonly` of each are taken off. */
function restOperands(reading: TypeReading, operands: Operands): readonly TypeReading[] {
  return operands(reading).map((each) => {
    return isExpressionWithTypeArguments(each.type)
      ? each
      : { ...each, type: unwrappedType(each.type) };
  });
}

/** Only entirely written tuple alternatives determine the offset of a following member. */
function finiteRestReadings(
  reading: TypeReading,
  operands: Operands,
  parents: readonly TypeReading[],
): readonly TypeReading[] | undefined {
  const readings = restOperands(reading, operands);
  if (
    readings.length === 0 ||
    readings.some(
      (each) => !isTupleTypeNode(each.type) || parents.some((parent) => sameReading(parent, each)),
    )
  )
    return undefined;
  return readings;
}

/** Expanded positions retain the selected alias's actual arguments and their original scopes. */
function tupleMembers(
  reading: TypeReading,
  parents: readonly TypeReading[],
  made: { members: number },
): Member[] {
  const { type } = reading;
  if (!isTupleTypeNode(type)) return [];
  const lineage = [...parents, reading];
  return type.elements.toReversed().map((element) => {
    made.members += 1;
    return { element, identity: made.members, parents: lineage, reading };
  });
}

/** An unchanged recursive operand cannot shift the same pending suffix forever. */
function sameReading(left: TypeReading, right: TypeReading): boolean {
  if (left.type !== right.type || left.bindings.size !== right.bindings.size) return false;
  for (const [parameter, value] of left.bindings) {
    if (right.bindings.get(parameter) !== value) return false;
  }
  return true;
}

/** Parenthesized and readonly syntax preserves the original type nodes. */
function unwrappedType(type: TypeNode): TypeNode {
  let each = type;
  while (
    isParenthesizedTypeNode(each) ||
    (isTypeOperatorNode(each) && each.operator === SyntaxKind.ReadonlyKeyword)
  )
    each = each.type;
  return each;
}

/** A written tuple rest retains its original type before existing operand resolution. */
function writtenRestType(element: TypeNode): TypeNode | undefined {
  return isRestTypeNode(element) ||
    (isNamedTupleMember(element) && element.dotDotDotToken !== undefined)
    ? unwrappedType(element.type)
    : undefined;
}

/** A fixed or optional member retains the type written at that original position. */
function tupleElementType(element: TypeNode): TypeNode {
  return isNamedTupleMember(element) || isOptionalTypeNode(element) ? element.type : element;
}
