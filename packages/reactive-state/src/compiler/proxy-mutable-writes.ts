import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { literalName } from './bounded.ts';
import { declarationOf } from './framed.ts';
import { peelPlatform, platformPathsOf } from './platform-uses.ts';
import { isTypeOnly } from './scope.ts';

/** A value written into the container a `let` or `var` binding holds. */
export type WrittenMember =
  /** Stored at the member `name` of the container itself; `name` is undefined where computed. */
  | { readonly kind: 'member'; readonly name: string | undefined; readonly value: Expression }
  /** Stored deeper, in a member of a member, where any read of the container may reach it. */
  | { readonly kind: 'deep'; readonly value: Expression }
  /** Copied in whole, its members becoming the container's (`Object.assign(box, value)`). */
  | { readonly kind: 'merged'; readonly value: Expression };

/** Array methods whose arguments become elements of the receiver, from the argument at the number. */
const INSERTING_METHODS: ReadonlyMap<string, number> = new Map([
  ['fill', 0],
  ['push', 0],
  ['splice', 2],
  ['unshift', 0],
]);

/** Assignments that store their right side in their target. */
const STORING_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** What the file writes into the binding of one declaration. */
export interface MutableWrites {
  /** The right sides of the assignments to the binding itself. */
  readonly assigned: readonly Expression[];
  /** The values stored into the container it holds. */
  readonly members: readonly WrittenMember[];
}

/** No write at all. */
const NONE: MutableWrites = { assigned: [], members: [] };

/** The writes of each declaration of a file, which one walk over the file finds for all of them. */
const INDEXES = new WeakMap<SourceFile, ReadonlyMap<VariableDeclaration, Written>>();

/** The writes of a declaration as the walk collects them. */
interface Written {
  readonly assigned: Expression[];
  readonly members: WrittenMember[];
}

/**
 * What the file writes into the binding `declaration` declares and into the container it holds: the
 * assignments to it, member assignments, array methods and `Object.assign`, wherever the file puts
 * them and whichever object the binding then held (coarse, which only refuses more). The file is
 * walked once for every declaration, each write resolved to what declares the name where it stands
 * (`declarationOf`), so a same-named binding of another function is none of this one's; a write
 * through another name for the container is not followed.
 */
export function writesInto(declaration: VariableDeclaration): MutableWrites {
  const sourceFile = declaration.getSourceFile();
  let index = INDEXES.get(sourceFile);
  if (index === undefined) {
    index = indexWrites(sourceFile);
    INDEXES.set(sourceFile, index);
  }
  return index.get(declaration) ?? NONE;
}

/** Walks `sourceFile` once, filing each write under the declaration of the name it writes into. */
function indexWrites(sourceFile: SourceFile): ReadonlyMap<VariableDeclaration, Written> {
  const index = new Map<VariableDeclaration, Written>();
  const entry = (root: Identifier): Written | undefined => {
    const declared = declarationOf(root);
    if (
      declared === undefined ||
      !isVariableDeclaration(declared) ||
      !isIdentifier(declared.name)
    ) {
      return undefined;
    }
    let found = index.get(declared);
    if (found === undefined) {
      found = { assigned: [], members: [] };
      index.set(declared, found);
    }
    return found;
  };
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (isBinaryExpression(node) && STORING_ASSIGNMENTS.has(node.operatorToken.kind)) {
      fileAssignment(node.left, node.right, entry);
    } else if (isCallExpression(node)) {
      fileCall(node, entry);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);

  return index;
}

/** Files `left = right`: an assignment to the binding itself, or a store into its container. */
function fileAssignment(
  left: Expression,
  right: Expression,
  entry: (root: Identifier) => Written | undefined,
): void {
  const chain = memberChain(left);
  const written = chain === undefined ? undefined : entry(chain.root);
  if (chain === undefined || written === undefined) {
    return;
  }
  if (chain.names.length === 0) {
    written.assigned.push(right);
  } else {
    written.members.push(chain.names.length === 1 ? member(chain.names[0], right) : deep(right));
  }
}

/** Files what a call stores into a container: array insertions and the sources of `Object.assign`. */
function fileCall(call: CallExpression, entry: (root: Identifier) => Written | undefined): void {
  const callee = peelPlatform(call.expression);
  if (isPropertyAccessExpression(callee) && INSERTING_METHODS.has(callee.name.text)) {
    const from = INSERTING_METHODS.get(callee.name.text) ?? 0;
    fileValues(callee.expression, call.arguments.slice(from), entry, (value) =>
      member(undefined, value),
    );
  } else if (platformPathsOf(call.expression).includes('Object.assign')) {
    const [target, ...sources] = call.arguments;
    if (target !== undefined) {
      fileValues(target, sources, entry, (value) => ({ kind: 'merged', value }));
    }
  }
}

/** Files each of `values` as stored by a call into the container `target` names, as `direct` says there. */
function fileValues(
  target: Expression,
  values: readonly Expression[],
  entry: (root: Identifier) => Written | undefined,
  direct: (value: Expression) => WrittenMember,
): void {
  const chain = isSpreadElement(target) ? undefined : memberChain(target);
  const written = chain === undefined ? undefined : entry(chain.root);
  if (chain === undefined || written === undefined) {
    return;
  }
  for (const each of values) {
    const value = isSpreadElement(each) ? each.expression : each;
    written.members.push(chain.names.length === 0 ? direct(value) : deep(value));
  }
}

/** A value stored at one member of the container. */
function member(name: string | undefined, value: Expression): WrittenMember {
  return { kind: 'member', name, value };
}

/** A value stored deeper in the container. */
function deep(value: Expression): WrittenMember {
  return { kind: 'deep', value };
}

/**
 * The binding `expr` names and the members it reads from it, outermost from the binding first, where
 * `expr` is a name or member reads of one; undefined where it is anything else. A member's name is
 * undefined where computed.
 */
function memberChain(
  expr: Expression,
): { readonly names: readonly (string | undefined)[]; readonly root: Identifier } | undefined {
  const names: (string | undefined)[] = [];
  let current = peelPlatform(expr);
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    names.unshift(isPropertyAccessExpression(current) ? current.name.text : literalName(current));
    current = peelPlatform(current.expression);
  }
  return isIdentifier(current) ? { names, root: current } : undefined;
}
