import {
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isTypeNode,
  isVariableDeclarationList,
  type Node,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { classify, isArray, type Subject, type Use } from './framed-known-uses.ts';
import { readsBinding } from './scope.ts';

/**
 * Whether every mention of the constant, and of each constant that only names it, is a use the
 * compile knows for the subject, among those `relevant` keeps. A name that is written as a whole
 * elsewhere is not followed.
 */
export function knownUsesOnly(
  declaration: VariableDeclaration,
  subject: Subject,
  relevant: (name: Identifier) => boolean = () => true,
): boolean {
  const found = scan(declaration, subject, relevant);
  if (found === 'carries') return scan(declaration, 'carrier', relevant) === 'known';
  return found === 'known';
}

/** What the mentions of a name come to: all known, or known with the array stored in itself, or not. */
function scan(
  declaration: VariableDeclaration,
  subject: Subject,
  relevant: (name: Identifier) => boolean,
): 'carries' | 'known' | 'unknown' {
  const kinds = new Map<VariableDeclaration, Subject>([[declaration, subject]]);
  const pending: VariableDeclaration[] = [declaration];
  let carries = false;
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const base = kinds.get(at) ?? subject;
    const kind = base === 'held' && holdsList(at) ? 'list' : base;
    const uses = usesOf(at, kind, relevant);
    if (uses === undefined) return 'unknown';
    carries ||= uses.some((use) => use.carries === true);
    for (const { alias, ...use } of uses) {
      if (alias === undefined || kinds.has(alias)) continue;
      kinds.set(alias, aliasKind(use, kind));
      pending.push(alias);
    }
  }
  return carries && subject === 'array' ? 'carries' : 'known';
}

/** The uses the mentions of a name make, none where one is not known, or a name that holds no array is no constant. */
function usesOf(
  declaration: VariableDeclaration,
  kind: Subject,
  relevant: (name: Identifier) => boolean,
): readonly Use[] | undefined {
  if (!isArray(kind) && !constant(declaration)) return undefined;
  const seen = mentions(declaration).filter((name) => relevant(name));
  const uses = seen.map((name) => classify(name, kind));
  return uses.every((use) => use.known) ? uses : undefined;
}

/** What a name that a mention is kept in stands for: a literal that holds it, the array itself, or the same. */
function aliasKind(use: Use, kind: Subject): Subject {
  if (use.contained === true) return 'box';
  return use.echo === true && isArray(kind) ? 'echo' : kind;
}

/** Whether a constant starts as a written list. */
function holdsList(declaration: VariableDeclaration): boolean {
  const { initializer } = declaration;
  return initializer !== undefined && isArrayLiteralExpression(unwrapped(initializer));
}

/** Whether a declaration is a constant, which no later write gives another value. */
function constant(declaration: VariableDeclaration): boolean {
  const list = declaration.parent;
  return isVariableDeclarationList(list) && /^const\b/u.test(list.getText(list.getSourceFile()));
}

/** The identifiers that read the binding, apart from the name that declares it. */
function mentions(declaration: VariableDeclaration): Identifier[] {
  const found: Identifier[] = [];
  const pending: Node[] = [declaration.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && node !== declaration.name && readsBinding(node)) {
      const selected = frameBindingOf(node);
      if (selected?.binding === declaration && selected.keys.length === 0) found.push(node);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}
