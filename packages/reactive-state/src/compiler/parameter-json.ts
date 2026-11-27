import {
  type Expression,
  type Identifier,
  isIdentifier,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isSourceFile,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { writtenAsWhole } from './framed-array-identity.ts';
import { metadataInitializer } from './input-callees.ts';
import type { JsonReading } from './json-reading.ts';
import { readsOf } from './local-module-reads.ts';
import { writesOf } from './local-writes.ts';
import { holdsStill } from './parameter-held.ts';
import { parameterValue, readsReplacement } from './parameter-values.ts';
import { bindingIdentifiers } from './scope.ts';

/** Primitive parameters retain their value when passed to calls that may change objects. */
const PRIMITIVES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
]);

/**
 * Whether a returned parameter acquires a value no JSON holds in the function's own code. A member
 * the code writes is an entry of the object the parameter holds where the compile reads that object:
 * what the function replaces the parameter with, or what the call writes in its place (`written`,
 * `writtenObject`), and no call locks it before the write nor the function keeps it where its reads
 * are not followed (`holdsStill`). Of any other value the call hands, or an object so kept or locked,
 * a write changes what the compile does not read.
 */
export function changedParameters(
  fn: Answering,
  reading: JsonReading,
  check: (value: Expression, reading: JsonReading) => boolean,
  written?: (index: number) => Expression | undefined,
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
    const held = replacement?.value ?? writtenObject(fn, declared, written);
    const walk = {
      owner: fn,
      calls: { functionOf: (callee) => reading.scope?.functionOf(callee, reading) },
      visiting: new Set(),
      reads: replacement === undefined ? undefined : readsReplacement(fn, replacement),
    } satisfies Parameters<typeof writesOf>[2];
    const isHeld = held !== undefined && holdsStill(fn, declared, walk);
    const found = writesOf(declared, held, { ...walk, holds: isHeld ? declared : undefined });
    const changed =
      found.changes ||
      found.values.some((put) => check(put.value, { ...reading, entry: put.entry })) ||
      (replacement !== undefined && replacementNonJson(replacement.value, { reading, check }));
    known.set(name, changed);
    return changed;
  };
}

/**
 * The object the call writes where the parameter `declared` stands, which the parameter holds at
 * each read of it: an object written out there (`make({ id: 'safe' })`), made for this call and held
 * by nothing else, of a parameter that is a plain name, no rest, which nothing in the file assigns as
 * a whole and the function names in no other way (`namedOtherwise`). A name, a call, an array, and
 * what a spread or `apply` hands, are none: the function may be writing into a value another name
 * holds, into a frozen one, or into an array, which a named member makes no JSON of. Each call is
 * read with what it writes itself, so another call of the same function that hands a constant is
 * refused on its own.
 */
function writtenObject(
  fn: Answering,
  declared: Identifier,
  written: ((index: number) => Expression | undefined) | undefined,
): Expression | undefined {
  const index = parametersOf(fn).findIndex(
    (parameter) => parameter.name === declared && parameter.dotDotDotToken === undefined,
  );
  const given = index === -1 ? undefined : written?.(index);
  const value = given === undefined ? undefined : unwrapped(given);
  const binding = declared.parent;
  return value !== undefined &&
    isObjectLiteralExpression(value) &&
    isParameterDeclaration(binding) &&
    !writtenAsWhole(binding) &&
    !namedOtherwise(fn, declared)
    ? value
    : undefined;
}

/**
 * Whether the function names what a parameter holds in a way no constant is named, which the walk
 * of its reads does not follow: through `arguments`, or in the parameters themselves, where the
 * default of another binds it to a second name (`other = value`).
 */
function namedOtherwise(fn: Answering, declared: Identifier): boolean {
  const isRead = readsOf(declared, fn);
  const names = (node: Node, isParameter: boolean): boolean => {
    return (
      (isIdentifier(node) && node.text === 'arguments') ||
      (isParameter && isRead(node)) ||
      node.forEachChild((child) => (names(child, isParameter) ? true : undefined)) === true
    );
  };
  return (
    fn.parameters.some((parameter) => names(parameter, true)) ||
    (fn.body !== undefined && names(fn.body, false))
  );
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
