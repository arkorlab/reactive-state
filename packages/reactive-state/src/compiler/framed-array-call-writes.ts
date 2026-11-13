import { type Expression, isCallExpression, isObjectLiteralExpression } from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayIdentity, mayBeArray } from './framed-array-identity.ts';
import {
  type ArrayMethodOverride,
  assignMethods,
  defineMethod,
  descriptorMethods,
  forgetMethods,
  type OwnMethods,
} from './framed-array-own-methods.ts';
import type { FrameBinding } from './framed-bindings.ts';
import {
  invokedTarget,
  type MutatorInvocation,
  mutatorInvocation,
} from './framed-mutator-calls.ts';

/**
 * What a write that may be of another array leaves of a method: its value unproven, and an attribute
 * only where the method had it before and the write gives it, as it stands whether or not the write
 * was of this array. A method nothing wrote before has both, as a plain assignment makes them.
 */
function possibleOverride(
  written: ArrayMethodOverride,
  before: ArrayMethodOverride | undefined,
): ArrayMethodOverride {
  const writable = written.writable === true && (before === undefined || before.writable === true);
  const configurable =
    written.configurable === true && (before === undefined || before.configurable === true);
  return {
    own: false,
    ...(writable && { writable: true as const }),
    ...(configurable && { configurable: true as const }),
  };
}

/**
 * Native object mutators replace own methods in source order, retaining unknown writes as unknown.
 * Through a name that may hold another array, or a mutator that fails silently where it fails
 * (`Reflect.defineProperty` on a frozen array), they only leave the methods they write unproven, with
 * the attributes a definition gives them that hold either way, read against the methods as they
 * stood, since a definition that leaves an attribute unsaid keeps it.
 */
export function callMethodWrites(node: Expression, root: FrameBinding, own: OwnMethods): void {
  if (!isCallExpression(node)) return;
  const invoked = mutatorInvocation(node);
  const target = invoked === undefined ? undefined : invokedTarget(invoked);
  if (invoked === undefined || target === undefined || !mayBeArray(target, root)) return;
  if (arrayIdentity(target) === root && invoked.silent !== true) {
    mutatorWrites(invoked, own);
    return;
  }
  const possible: OwnMethods = new Map(own);
  mutatorWrites(invoked, possible);
  for (const [key, written] of possible)
    if (written !== own.get(key)) own.set(key, possibleOverride(written, own.get(key)));
}

/** The methods one native object mutator writes, as it names them, after its target. */
function mutatorWrites(invoked: MutatorInvocation, own: OwnMethods): void {
  const [, ...rest] = invoked.args;
  switch (invoked.path) {
    case 'Object.assign': {
      for (const source of rest) assignMethods(source, own);
      break;
    }
    case 'Object.defineProperty': {
      defineMethod(invoked.args, own);
      break;
    }
    case 'Object.defineProperties': {
      const descriptors = rest[0];
      const value = descriptors === undefined ? undefined : unwrapped(descriptors);
      if (value !== undefined && isObjectLiteralExpression(value)) descriptorMethods(value, own);
      else forgetMethods(own);
      break;
    }
    default: {
      break;
    }
  }
}
