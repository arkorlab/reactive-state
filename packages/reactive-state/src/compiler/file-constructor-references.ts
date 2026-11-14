import {
  type Identifier,
  isExportDeclaration,
  isExportSpecifier,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isModuleDeclaration,
  isQualifiedName,
  isSourceFile,
  type Node,
  NodeFlags,
  type VariableDeclaration,
} from 'typescript/ast';

import { isTypeOnly, readsBinding } from './scope.ts';

/** Runtime references to a local File constructor, excluding erased declarations and public labels. */

type BindingOf = (name: Identifier) => VariableDeclaration | null | undefined;

/**
 * Whether a name reads a runtime constructor binding rather than an import or export label, the
 * name a namespace declares, or a part of an `import … =` alias — its own name, and each label of
 * the qualified name it aliases — which name a namespace or a member of one, never a variable.
 */
export function fileConstructorReference(reference: Identifier): boolean {
  if (!readsBinding(reference)) return false;
  const { parent } = reference;
  if (isExportSpecifier(parent) && (parent.propertyName ?? parent.name) !== reference) return false;
  if (isModuleDeclaration(parent) && parent.name === reference) return false;
  if (inAlias(reference)) return false;
  for (let at: Node = reference; ; at = at.parent) {
    if (ignoredTree(at)) return false;
    if (isSourceFile(at)) return true;
  }
}

/** Whether a name is the alias's own, or one of the labels of the qualified name it aliases. */
function inAlias(reference: Identifier): boolean {
  let at: Node = reference;
  while (isQualifiedName(at.parent)) at = at.parent;
  return isImportEqualsDeclaration(at.parent);
}

/** A constant constructor's runtime reads, resolved to that exact lexical declaration. */
export function constructorReferences(
  declaration: VariableDeclaration,
  bindingOf: BindingOf,
): readonly Identifier[] {
  const reads: Identifier[] = [];
  const pending: Node[] = [declaration.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (ignoredTree(at)) continue;
    if (
      isIdentifier(at) &&
      at !== declaration.name &&
      fileConstructorReference(at) &&
      bindingOf(at) === declaration
    ) {
      reads.push(at);
    }
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return reads;
}

/** Declarations and external names whose subtrees read no local runtime constructor binding. */
function ignoredTree(node: Node): boolean {
  return (
    isAmbient(node) ||
    isTypeOnly(node) ||
    isImportDeclaration(node) ||
    (isExportDeclaration(node) && (node.isTypeOnly || node.moduleSpecifier !== undefined)) ||
    (isExportSpecifier(node) && node.isTypeOnly)
  );
}

/** Whether a declaration is erased by `declare`. */
function isAmbient(node: Node): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript exposes ambient declarations through this flag.
  return (node.flags & NodeFlags.Ambient) !== 0;
}
