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
  readonly reading: TypeReading;
  readonly element: TypeNode;
  readonly parents: readonly TypeReading[];
}
interface Selection {
  readonly pending: Member[];
  position: number;
}
interface TupleReadings {
  readonly index: number | undefined;
  readonly selectRest: RestSelection;
  readonly operands: Operands;
  readonly result: TypeReading[];
  readonly paths: Selection[];
}

/** Fixed prefixes and trailing rests keep literal offsets; numeric selections retain every rest. */
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
    paths: [{ pending: tupleMembers({ ...at, type: tuple }, []), position: 0 }],
  };
  for (let path = state.paths.pop(); path !== undefined; path = state.paths.pop()) {
    for (let member = path.pending.pop(); member !== undefined; member = path.pending.pop()) {
      if (selectTupleMember(member, path, state)) break;
    }
  }
  return state.result;
}

/**
 * How many places a written tuple's members may stand at, the most any alternative has: each member
 * stands at one, a rest of written tuples at as many as its tuple has, and a rest of unknown length
 * at one, from which it supplies its elements. Undefined where the type is no tuple.
 */
export function writtenTuplePlaces(
  at: TypeReading,
  operands: Operands,
  parents: readonly TypeReading[] = [],
): number | undefined {
  if (isExpressionWithTypeArguments(at.type)) return undefined;
  const tuple = unwrappedType(at.type);
  if (!isTupleTypeNode(tuple)) return undefined;
  const lineage = [...parents, { ...at, type: tuple }];
  let places = 0;
  for (const element of tuple.elements) {
    const rest = writtenRestType(element);
    const expanded =
      rest === undefined ? undefined : finiteRestReadings({ ...at, type: rest }, operands, lineage);
    places +=
      expanded === undefined
        ? 1
        : Math.max(...expanded.map((each) => writtenTuplePlaces(each, operands, lineage) ?? 1));
  }
  return places;
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
      pending: [...path.pending, ...tupleMembers(each, parents)],
      position: path.position,
    });
  }
  return true;
}

/** A fixed position retains its original member and environment before advancing the offset. */
function selectFixedMember(member: Member, path: Selection, state: TupleReadings): boolean {
  if (state.index === undefined || state.index === path.position)
    state.result.push({ ...member.reading, type: tupleElementType(member.element) });
  if (state.index === path.position) return true;
  path.position += 1;
  return false;
}

/** Unknown rest lengths keep the original numeric or trailing-rest selection boundary. */
function selectOpaqueRest(reading: TypeReading, path: Selection, state: TupleReadings): boolean {
  if (state.index === undefined) {
    state.result.push(...state.selectRest(reading, undefined));
    return false;
  }
  if (path.pending.length === 0 && state.index >= path.position)
    state.result.push(...state.selectRest(reading, state.index - path.position));
  return true;
}

/** Only entirely written tuple alternatives determine the offset of a following member. */
function finiteRestReadings(
  reading: TypeReading,
  operands: Operands,
  parents: readonly TypeReading[],
): readonly TypeReading[] | undefined {
  const readings = operands(reading).map((each) => {
    return isExpressionWithTypeArguments(each.type)
      ? each
      : { ...each, type: unwrappedType(each.type) };
  });
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
function tupleMembers(reading: TypeReading, parents: readonly TypeReading[]): Member[] {
  const { type } = reading;
  if (!isTupleTypeNode(type)) return [];
  const lineage = [...parents, reading];
  return type.elements.toReversed().map((element) => ({ element, reading, parents: lineage }));
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
