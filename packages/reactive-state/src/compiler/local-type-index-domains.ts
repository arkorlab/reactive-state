import {
  isIdentifier,
  isParenthesizedTypeNode,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
  type TypeReferenceNode,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';

/** Written index domains retain lexical aliases, while active alias cycles stay unsupported. */

interface DomainWalk {
  readonly type: TypeNode;
  readonly completed?: boolean;
}

export function indexSignatureDomains(type: TypeNode | undefined): ReadonlySet<SyntaxKind> {
  const domains = new Set<SyntaxKind>();
  const pending: DomainWalk[] = type === undefined ? [] : [{ type }];
  const active = new Set<TypeNode>();
  const completed = new Set<TypeNode>();
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    const at = step.type;
    if (step.completed === true) {
      active.delete(at);
      completed.add(at);
      continue;
    }
    if (active.has(at)) {
      domains.add(SyntaxKind.TypeReference);
      continue;
    }
    if (completed.has(at)) continue;
    const children = domainChildren(at);
    if (children === undefined) {
      domains.add(at.kind);
      completed.add(at);
      continue;
    }
    active.add(at);
    pending.push({ type: at, completed: true }, ...children.map((child) => ({ type: child })));
  }
  return domains;
}

/** Written unions, parentheses and whole non-generic aliases contribute their original children. */
function domainChildren(type: TypeNode): readonly TypeNode[] | undefined {
  if (isParenthesizedTypeNode(type)) return [type.type];
  if (isUnionTypeNode(type)) return type.types;
  if (!isTypeReferenceNode(type)) return undefined;
  const alias = domainAlias(type);
  return alias === undefined ? undefined : [alias];
}

/** A whole non-generic type alias keeps its original lexical declaration, without substitution. */
function domainAlias(type: TypeReferenceNode): TypeNode | undefined {
  const alias = isIdentifier(type.typeName) ? localTypeBinding(type.typeName) : undefined;
  return alias !== undefined &&
    alias !== null &&
    isTypeAliasDeclaration(alias) &&
    (alias.typeParameters?.length ?? 0) === 0 &&
    (type.typeArguments?.length ?? 0) === 0
    ? alias.type
    : undefined;
}
