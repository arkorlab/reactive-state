import {
  type Expression,
  type Identifier,
  isCatchClause,
  isIdentifier,
  isParameterDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedPossibleBranch, reachedLoopRead } from './framed-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Native Error string conversion needs an unchanged input, independently of its message origin. */

/** Exact reads qualified by one closed native consumer, separately from other binding exposure. */
export interface FramedNativeErrorReads {
  readonly consumer: Expression;
  readonly unconverted: ReadonlySet<Identifier>;
  readonly consumed: ReadonlySet<Identifier>;
}

interface ErrorInput {
  readonly consumer: Expression;
  readonly bindings: ReadonlySet<FrameBinding>;
  readonly selected: ReadonlySet<Identifier>;
  readonly reads: FramedNativeErrorReads | undefined;
}

/**
 * Prior possible Error uses retain opacity for own toString, primitive conversion and unknown exposure.
 * A reader whose proof an exposure drops passes `reached` false, to count only a loop body's uses.
 */
export function framedNativeErrorInput(
  source: Expression,
  consumer: Expression,
  reads?: FramedNativeErrorReads,
  reached = true,
): boolean {
  const input = errorInput(source, consumer, reads?.consumer === consumer ? reads : undefined);
  if (input === undefined) return false;
  const pending: Node[] = [source.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && exposedErrorInput(node, input, reached)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Whole const aliases retain their original parameter or catch binding and selected source reads. */
function errorInput(
  source: Expression,
  consumer: Expression,
  reads: FramedNativeErrorReads | undefined,
): ErrorInput | undefined {
  let value = unwrapped(source);
  const bindings = new Set<FrameBinding>();
  const selected = new Set<Identifier>();
  while (isIdentifier(value)) {
    selected.add(value);
    const reading = frameBindingOf(value);
    if (reading === undefined || reading.keys.length > 0 || bindings.has(reading.binding))
      return undefined;
    const { binding } = reading;
    bindings.add(binding);
    if (
      (isParameterDeclaration(binding) && binding.initializer === undefined) ||
      (isVariableDeclaration(binding) && isCatchClause(binding.parent))
    )
      return { bindings, selected, consumer, reads };
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    value = unwrapped(binding.initializer);
  }
  return undefined;
}

/** Selected holder/getter reads remain lexical sources; all other prior possible uses can change conversion. */
function exposedErrorInput(name: Identifier, input: ErrorInput, reached: boolean): boolean {
  if (!readsBinding(name) || input.selected.has(name)) return false;
  if (input.reads?.unconverted.has(name) === true || input.reads?.consumed.has(name) === true)
    return false;
  const reading = frameBindingOf(name);
  if (
    reading === undefined ||
    name === reading.binding.name ||
    !input.bindings.has(reading.binding)
  )
    return false;
  const reader = executionOwner(input.consumer);
  const owner = executionOwner(name);
  if (owner === reader) {
    if (
      (name.pos >= input.consumer.pos || destructuredFirst(input.consumer, name)) &&
      !reachedLoopRead(reached)(name, input.consumer, reading.binding, reader)
    )
      return false;
  } else if (unreferencedLocalFunction(owner, reader)) return false;
  if (!framedPossibleBranch(name)) return false;
  const { parent } = useOf(name);
  return (
    !isVariableDeclaration(parent) ||
    parent.initializer === undefined ||
    unwrapped(parent.initializer) !== name ||
    !input.bindings.has(parent)
  );
}
