import {
  type Expression,
  isArrayLiteralExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayRestBinding } from './framed-array-rest.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { soleTarget } from './framed-mutator-calls.ts';
import { framedWrittenTargets } from './framed-written-targets.ts';
import { bindingIdentifiers, isBlockScoped } from './scope.ts';

/**
 * The declaration whose array value a name or a chain of lexical aliases denotes; none where a name
 * of the chain is written as a whole elsewhere, and may hold another array than it was given.
 */
export function arrayIdentity(value: Expression): FrameBinding | undefined {
  const followed = followedIdentity(value);
  return followed.written ? undefined : followed.root;
}

/** Whether a file writes the binding as a whole, so that it may hold another array than it was given. */
export function writtenAsWhole(binding: FrameBinding): boolean {
  return writtenWhole(binding.getSourceFile()).has(binding);
}

/**
 * Whether a mutation that may reach any of the expressions may write the array `root`: or, as
 * `sure`, whether it reaches that array and nothing else.
 */
export function reachesArray(
  targets: readonly Expression[],
  root: FrameBinding,
  sure: boolean,
): boolean {
  if (!sure) return targets.some((target) => mayBeArray(target, root));
  const [only] = targets;
  return targets.length === 1 && only !== undefined && arrayIdentity(only) === root;
}

/**
 * Whether a write to a member of `value` may write the array `root`: a name of its chain that is
 * written as a whole elsewhere may hold any array, and so may its member be one of the array's.
 */
export function mayBeArray(value: Expression, root: FrameBinding): boolean {
  const followed = followedIdentity(value);
  return followed.written || followed.root === root;
}

interface FollowedIdentity {
  readonly root: FrameBinding | undefined;
  /** Whether a name of the chain is written as a whole. */
  readonly written: boolean;
}

/** The chain of lexical aliases a value follows to an array's declaration, and what it passes. */
function followedIdentity(value: Expression): FollowedIdentity {
  let each = unwrapped(value);
  const rest = arrayRestBinding(each);
  if (rest !== undefined) return { root: rest, written: false };
  const seen = new Set<FrameBinding>();
  let root: FrameBinding | undefined;
  let written = false;
  while (isIdentifier(each)) {
    const selected = frameBindingOf(each);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return { root: undefined, written };
    root = selected.binding;
    written ||= writtenWhole(root.getSourceFile()).has(root);
    seen.add(root);
    if (root.initializer === undefined) return { root, written };
    each = soleTarget(unwrapped(root.initializer));
  }
  return { root: isArrayLiteralExpression(each) ? root : undefined, written };
}

const WRITTEN_WHOLE = new WeakMap<SourceFile, ReadonlySet<FrameBinding>>();

/**
 * The bindings a file writes as a whole — by an assignment, a destructuring target, a loop head or
 * a `var` that declares a name again — found in one walk of the file.
 */
function writtenWhole(file: SourceFile): ReadonlySet<FrameBinding> {
  const known = WRITTEN_WHOLE.get(file);
  if (known !== undefined) return known;
  const found = new Set<FrameBinding>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const target of framedWrittenTargets(node)) {
      const name = unwrapped(target);
      const selected = isIdentifier(name) ? frameBindingOf(name) : undefined;
      if (selected?.keys.length === 0) found.add(selected.binding);
    }
    if (isVariableDeclaration(node)) for (const binding of redeclared(node)) found.add(binding);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  WRITTEN_WHOLE.set(file, found);
  return found;
}

/**
 * The bindings a declaration writes as a whole where an earlier declaration binds the same name, as
 * a `var` may: one with a value, an initializer or a for-in or for-of head, assigns it (`var a;`
 * alone does not), and a block-scoped declaration only ever binds its own.
 */
function redeclared(declaration: VariableDeclaration): readonly FrameBinding[] {
  const { parent } = declaration;
  if (!isVariableDeclarationList(parent) || isBlockScoped(parent)) return [];
  const head = isForInStatement(parent.parent) || isForOfStatement(parent.parent);
  if (!head && declaration.initializer === undefined) return [];
  const bound: FrameBinding[] = [];
  for (const name of bindingIdentifiers(declaration.name)) {
    const selected = frameBindingOf(name);
    if (selected?.keys.length === 0 && selected.binding !== declaration)
      bound.push(selected.binding);
  }
  return bound;
}
