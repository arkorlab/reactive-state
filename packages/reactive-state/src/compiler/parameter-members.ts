import {
  type Expression,
  isIdentifier,
  isSourceFile,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { memberPath } from './exported-values.ts';
import { metadataInitializer } from './input-callees.ts';
import type { JsonReading } from './json-reading.ts';
import { readsOf } from './local-module-reads.ts';
import { writesOf } from './local-writes.ts';
import { type Check, heldNonJson, memberHeld } from './member-reads.ts';
import { parameterValue, readsReplacement } from './parameter-values.ts';
import { bindingIdentifiers } from './scope.ts';

/** A returned member of a proven replacement, before any further write makes its value unknown. */
export function replacedMember(
  node: Expression,
  fn: Answering,
  reading: JsonReading,
  check: Check,
): boolean | undefined {
  const { keys, root } = memberPath(node);
  if (keys.length === 0 || !isIdentifier(root)) {
    return undefined;
  }
  const declared = parametersOf(fn)
    .flatMap((parameter) => bindingIdentifiers(parameter.name))
    .find((parameter) => parameter.text === root.text);
  if (declared === undefined || !readsOf(declared, fn)(root)) {
    return undefined;
  }
  const replacement = parameterValue(fn, declared, root);
  if (replacement === undefined) {
    return undefined;
  }
  const found = writesOf(declared, replacement.value, {
    owner: fn,
    calls: { functionOf: (callee) => reading.scope?.functionOf(callee, reading) },
    visiting: new Set(),
    reads: readsReplacement(fn, replacement),
  });
  if (found.changes || found.values.length > 0) {
    return undefined;
  }
  const value = unchangedReplacement(replacement.value, reading);
  if (value === undefined) {
    return undefined;
  }
  const at: JsonReading = {
    ...reading,
    follow: (name) => (name === root ? value : reading.follow?.(name)),
    isChanged: (name, context) => name !== root && reading.isChanged?.(name, context) === true,
  };
  const held = memberHeld(node, at);
  // Accessors and unknown computed values retain the existing runtime boundary.
  return held.some((each) => each.kind === 'computed') ? undefined : heldNonJson(held, at, check);
}

/** An unmodified constant replacement, excluding the reference that hands it to the parameter. */
function unchangedReplacement(
  expression: Expression,
  reading: JsonReading,
): Expression | undefined {
  const handoff = unwrapped(expression);
  const seen = new Set<Expression>();
  let value = handoff;
  while (isIdentifier(value)) {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const held = metadataInitializer(value);
    const declaration = held?.parent;
    if (held === undefined || declaration === undefined || !isVariableDeclaration(declaration)) {
      break;
    }
    if (!isIdentifier(declaration.name)) {
      return undefined;
    }
    let owner: Node = declaration;
    while (!isSourceFile(owner) && !isAnswering(owner)) {
      owner = owner.parent;
    }
    const found = writesOf(declaration.name, held, {
      owner,
      calls: { functionOf: (callee) => reading.scope?.functionOf(callee, reading) },
      visiting: new Set(),
      reads: (name) => name !== handoff,
    });
    if (found.changes || found.values.length > 0) {
      return undefined;
    }
    value = unwrapped(held);
  }
  return value;
}
