import {
  isConditionalTypeNode,
  isInferTypeNode,
  isIntersectionTypeNode,
  isGetAccessorDeclaration,
  isMethodSignatureDeclaration,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isLiteralTypeNode,
  isSourceFile,
  isTypeLiteralNode,
  SyntaxKind,
  type Node,
  type TypeNode,
  type TypeElement,
  type TypeLiteralNode,
  type TypeParameterDeclaration,
} from 'typescript/ast';

import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { callableObjectShape } from './local-type-function-members.ts';
import type {
  Bindings,
  Inference,
  Matching,
  Parameters,
  Resolve,
} from './local-type-inference-types.ts';
import { inferredCandidates } from './local-type-inferred-candidates.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';
import { memberName, propertyMember } from './local-type-weak-objects.ts';

/** An already expanded object requirement in this one non-inference worklist branch. */
export function expandedObjectPair(
  checked: TypeReading,
  pattern: TypeReading,
  expanded: Set<string>,
): boolean {
  if (!isTypeLiteralNode(checked.type) || !isTypeLiteralNode(pattern.type)) return false;
  if (checked.bindings.size > 0 || pattern.bindings.size > 0) return false;
  const key = JSON.stringify([
    [
      typeReadingKey(checked),
      [...checked.aliases].toSorted((first, second) => first.localeCompare(second)),
    ],
    [
      typeReadingKey(pattern),
      [...pattern.aliases].toSorted((first, second) => first.localeCompare(second)),
    ],
  ]);
  if (expanded.has(key)) return true;
  expanded.add(key);
  return false;
}

/** Every declaration of an infer name, including alternatives that supply no selected candidate. */
export function inferenceParameters(root: Node): readonly Parameters[] {
  const groups: Parameters[] = [];
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isInferTypeNode(node)) {
      const parameter = node.typeParameter;
      const owner = inferenceOwner(parameter);
      let group = groups.find((each) => each.owner === owner && each.name === parameter.name.text);
      if (group === undefined) {
        group = { declarations: new Set(), name: parameter.name.text, owner };
        groups.push(group);
      }
      group.declarations.add(parameter);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return groups;
}

/** The enclosing conditional whose extends pattern declares an inferred parameter. */
export function inferenceOwner(parameter: TypeParameterDeclaration): Node | undefined {
  let child: Node = parameter;
  while (!isSourceFile(child)) {
    const parent = child.parent;
    if (isConditionalTypeNode(parent) && parent.extendsType === child) return parent;
    child = parent;
  }
  return undefined;
}

/** Each repeated infer name denotes every candidate collected in that conditional's pattern. */
export function alternativesOf(
  groups: readonly Inference[],
  resolve: Resolve,
): readonly Bindings[] {
  let alternatives: Bindings[] = [new Map()];
  for (const group of groups) {
    const next: Bindings[] = [];
    const candidates = inferredCandidates(group.candidates, resolve);
    for (const previous of alternatives) {
      for (const candidate of candidates) {
        const bindings = new Map(previous);
        for (const declaration of group.declarations) bindings.set(declaration, candidate);
        next.push(bindings);
      }
    }
    alternatives = next;
  }
  return alternatives;
}

/** Repeated closed primitive alternatives add no distinct non-inference obligation or branch. */
export function matchingUnionTypes(
  types: readonly TypeNode[],
  state: Matching,
): readonly TypeNode[] {
  if (state.parameters.length > 0 || state.groups.length > 0) return types;
  const seen = new Set<string>();
  return types.filter((type) => {
    const key = primitiveUnionKey(type);
    if (key === undefined) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keyword identities and exact original literal spellings carry no lexical type environment. */
function primitiveUnionKey(type: TypeNode): string | undefined {
  const kinds = new Set([
    SyntaxKind.BigIntKeyword,
    SyntaxKind.BooleanKeyword,
    SyntaxKind.NeverKeyword,
    SyntaxKind.NumberKeyword,
    SyntaxKind.StringKeyword,
    SyntaxKind.SymbolKeyword,
    SyntaxKind.UndefinedKeyword,
    SyntaxKind.VoidKeyword,
  ]);
  if (kinds.has(type.kind)) return `keyword:${type.kind}`;
  return isLiteralTypeNode(type) && type.pos >= 0 ? `literal:${type.getText()}` : undefined;
}

/** A source field, a known missing field, or a name an index or computed signature leaves unknown. */
export function sourceMember(
  source: TypeLiteralNode,
  name: string,
): TypeElement | null | undefined {
  let unknown = false;
  let selected: TypeElement | undefined;
  for (const member of source.members) {
    const key = memberName(member);
    if (
      key === name &&
      (selected === undefined ||
        (isMethodSignatureDeclaration(selected) && isMethodSignatureDeclaration(member)) ||
        (isSetAccessorDeclaration(selected) && isGetAccessorDeclaration(member)))
    ) {
      selected = member;
    }
    // An index, call or construct signature holds no property: only an unread property name may be it.
    if (key === undefined && propertyMember(member)) unknown = true;
  }
  return selected ?? (unknown ? undefined : null);
}

/** A property or accessor's declared data type, without treating a method as its return type. */
export function memberValue(member: TypeElement): TypeNode | undefined {
  if (isPropertySignatureDeclaration(member) || isGetAccessorDeclaration(member))
    return member.type;
  return isSetAccessorDeclaration(member) ? member.parameters[0]?.type : undefined;
}

/** Expanded object constituents retain their own actual environments; all other operands stay opaque. */
export function intersectionSources(
  checked: TypeReading,
  resolve: Resolve,
): {
  readonly sources: readonly (TypeReading & { readonly type: TypeLiteralNode })[];
  readonly callables: readonly TypeReading[];
  readonly unknown: boolean;
} {
  const sources: (TypeReading & { readonly type: TypeLiteralNode })[] = [];
  const callables: TypeReading[] = [];
  const pending = [checked];
  let unknown = false;
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const source = resolve(each);
    if (source?.type.kind === SyntaxKind.UnknownKeyword) continue;
    const interfaces =
      source === undefined
        ? undefined
        : interfaceShapeReadings(source, (at) => [resolve(at) ?? at]);
    if (interfaces !== undefined) {
      pending.push(...interfaces.sources);
      unknown ||= interfaces.unknown;
    } else if (source !== undefined && isIntersectionTypeNode(source.type)) {
      pending.push(...source.type.types.map((type) => ({ ...source, type })));
    } else if (source !== undefined && isTypeLiteralNode(source.type)) {
      sources.push({ ...source, type: source.type });
    } else if (source === undefined || callableObjectShape(source.type) === undefined) {
      unknown = true;
    } else callables.push(source);
  }
  return { sources, callables, unknown };
}
