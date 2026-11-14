import {
  type CallExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedQuietData } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Additional bind normalization retains opacity after a possible constructor or bind exposure. */

/** Selected constructor aliases do not excuse earlier own bind replacements or prototype exposures. */
export function unchangedNativeBind(
  target: Expression,
  call: CallExpression,
  names: ReadonlySet<string>,
): boolean {
  const selected = constructorReads(target);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && bindExposure(node, call, names, selected)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Whole constant constructor aliases retain only the exact initializer reads used by this bind. */
function constructorReads(target: Expression): ReadonlySet<Identifier> {
  let value = unwrapped(target);
  const selected = new Set<Identifier>();
  while (isIdentifier(value) && !selected.has(value)) {
    selected.add(value);
    const reading = frameBindingOf(value);
    if (reading === undefined || reading.keys.length > 0) break;
    const { binding } = reading;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      break;
    value = unwrapped(binding.initializer);
  }
  return selected;
}

/** Same-owner later reads are excluded unless repeated; captured earlier mutation remains possible. */
function bindExposure(
  name: Identifier,
  call: CallExpression,
  names: ReadonlySet<string>,
  selected: ReadonlySet<Identifier>,
): boolean {
  if (!readsBinding(name) || selected.has(name)) return false;
  if (name === frameBindingOf(name)?.binding.name) return false;
  const reader = executionOwner(call);
  const writer = executionOwner(name);
  if (
    reader === writer &&
    (name.pos >= call.pos || destructuredFirst(call, name)) &&
    !repeatedFrameRead(name, call, name, reader)
  )
    return false;
  if (reader !== writer && unreferencedLocalFunction(writer, reader)) return false;
  if (!framedPossibleBranch(name)) return false;
  if (globalPathOf(name)?.join('.') === 'Function') return true;
  return framedNativeConstructor(name, names) && !quietNativeCreation(name);
}

/** An ordinary native Error construction with literal data cannot replace a constructor's bind member. */
function quietNativeCreation(name: Identifier): boolean {
  const call = name.parent;
  return (
    (isCallExpression(call) || isNewExpression(call)) &&
    call.expression === name &&
    (call.arguments ?? []).every(framedQuietData)
  );
}
