import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isIdentifier,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import type { RecordFields } from './framed-record-captured-writes.ts';
import { framedRecordForm } from './framed-record-forms.ts';
import { framedSourceValues } from './framed-sources.ts';

/** How the records a form's operands make are put together, and what a name's form starts from. */

/** A record with no field. */
export const NO_FIELDS: RecordFields = { named: new Map(), unknown: [] };

/** Adds candidate expressions without duplicating AST nodes across shared replacement paths. */
export function addExpressions(target: Set<Expression>, values: readonly Expression[]): void {
  for (const each of values) target.add(each);
}

/** Whether a value is a branch or a native form: what it answers is what its operands hold. */
export function isForm(value: Expression): boolean {
  return framedSourceValues(value) !== undefined || framedRecordForm(value) !== undefined;
}

/** How many ways a branch may go: `a && b` answers `a` as well, which no record's field comes from. */
export function alternativesOf(value: Expression, branches: readonly Expression[]): number {
  const skipped =
    isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken;
  return branches.length + (skipped ? 1 : 0);
}

/**
 * The fields any of the records may hold, with the values of each; a field is definite only where
 * every record defines it, and is otherwise one that may be there.
 */
export function unionFields(records: readonly RecordFields[]): RecordFields {
  const named = new Map<string, readonly Expression[]>();
  const unknown = new Set<Expression>();
  for (const record of records) {
    for (const [key, values] of record.named) {
      if (records.some((each) => !each.named.has(key))) {
        addExpressions(unknown, values);
        continue;
      }
      const merged = new Set<Expression>(named.get(key));
      addExpressions(merged, values);
      named.set(key, [...merged]);
    }
    addExpressions(unknown, record.unknown);
  }
  return { named, unknown: [...unknown] };
}

/**
 * The record `Object.assign` makes of what it is given, a later definite field replacing an earlier
 * one as in a spread; an operand that may be one of several records replaces nothing for sure.
 */
export function copiedInOrder(
  parts: readonly { readonly records: readonly RecordFields[] }[],
): RecordFields {
  const named = new Map<string, readonly Expression[]>();
  const unknown = new Set<Expression>();
  for (const part of parts) {
    const [only, ...more] = part.records;
    if (only !== undefined && more.length === 0) {
      for (const [key, values] of only.named) named.set(key, values);
      addExpressions(unknown, only.unknown);
      continue;
    }
    for (const record of part.records) {
      for (const values of record.named.values()) addExpressions(unknown, values);
      addExpressions(unknown, record.unknown);
    }
  }
  return { named, unknown: [...unknown] };
}

/** What a name's constant initializer chain ends at, where it ends at a native form or a list. */
export function formInitializer(name: Identifier): Expression | undefined {
  const seen = new Set<FrameBinding>();
  let value: Expression = name;
  while (isIdentifier(value)) {
    const reading = frameBindingOf(value);
    if (reading === undefined || reading.keys.length > 0 || seen.has(reading.binding))
      return undefined;
    seen.add(reading.binding);
    const { initializer } = reading.binding;
    if (initializer === undefined) return undefined;
    value = unwrapped(initializer);
  }
  return isForm(value) || isArrayLiteralExpression(value) ? value : undefined;
}
