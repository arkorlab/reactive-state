import {
  type Expression,
  type Identifier,
  isIdentifier,
  isSourceFile,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { metadataInitializer } from './input-callees.ts';
import type { JsonReading } from './json-reading.ts';
import { writesOf } from './local-writes.ts';
import { parameterValue, readsReplacement } from './parameter-values.ts';
import { bindingIdentifiers } from './scope.ts';

/** Primitive parameters retain their value when passed to calls that may change objects. */
const PRIMITIVES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
]);

/** Whether a returned parameter acquires a value no JSON holds in the function's own code. */
export function changedParameters(
  fn: Answering,
  reading: JsonReading,
  check: (value: Expression, reading: JsonReading) => boolean,
): (name: Identifier) => boolean {
  const known = new Map<Identifier, boolean>();
  const parameters = parametersOf(fn)
    .filter((parameter) => parameter.type === undefined || !PRIMITIVES.has(parameter.type.kind))
    .flatMap((parameter) => bindingIdentifiers(parameter.name));
  return (name) => {
    const declared = parameters.find((parameter) => parameter.text === name.text);
    if (declared === undefined) {
      return false;
    }
    const was = known.get(name);
    if (was !== undefined) {
      return was;
    }
    // Reading the whole parameter while checking what is put in it closes an object cycle.
    known.set(name, true);
    const replacement = parameterValue(fn, declared, name);
    const walk = {
      owner: fn,
      calls: { functionOf: (callee) => reading.scope?.functionOf(callee, reading) },
      visiting: new Set(),
      reads: replacement === undefined ? undefined : readsReplacement(fn, replacement),
    } satisfies Parameters<typeof writesOf>[2];
    const found = writesOf(declared, replacement?.value, walk);
    const changed =
      found.changes ||
      found.values.some((put) => check(put.value, { ...reading, entry: put.entry })) ||
      (replacement !== undefined && replacementNonJson(replacement.value, { reading, check }));
    known.set(name, changed);
    return changed;
  };
}

/** A replacement's own JSON value, following constants without treating its handoff as a mutation. */
function replacementNonJson(
  expression: Expression,
  {
    reading,
    check,
  }: {
    readonly reading: JsonReading;
    readonly check: (value: Expression, at: JsonReading) => boolean;
  },
): boolean {
  const seen = new Set<Expression>();
  const handoff = unwrapped(expression);
  let value = handoff;
  while (isIdentifier(value)) {
    if (seen.has(value)) {
      return true;
    }
    seen.add(value);
    const held = metadataInitializer(value);
    const declaration = held?.parent;
    if (held === undefined || declaration === undefined || !isVariableDeclaration(declaration)) {
      break;
    }
    if (!isIdentifier(declaration.name)) {
      break;
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
    if (
      found.changes ||
      found.values.some((put) => check(put.value, { ...reading, entry: put.entry }))
    ) {
      return true;
    }
    value = unwrapped(held);
  }
  return check(value, reading);
}
