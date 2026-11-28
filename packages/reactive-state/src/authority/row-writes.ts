import type { BoundRow, RowWrite, Value } from '../program.ts';
import { checkValue, type RowField } from '../server/schema.ts';
import { HTTP_CONFLICT, HTTP_NOT_FOUND, HTTP_UNPROCESSABLE } from '../status.ts';
import type { RowChange } from './dependencies.ts';
import { denied, refusal } from './errors.ts';
import { Call } from './evaluation.ts';
import type { Core } from './model.ts';

/**
 * One write to a row of the application's tables, once the binding's path has said the session may
 * make it: the application's connection writes the row, under the condition that named it, and a
 * setter's value is held to what the column may hold — and to what the database's own constraints
 * say, which are the application's. A `set` writes what it is sent, so a resend after a write whose
 * answer was lost writes the same. An `apply` reads the row, and writes what it computes of that
 * only where the row holds that still, reading again where it does not: within a call's time, and
 * up to `ATTEMPTS.apply`. One that computes what the row holds has nothing to write.
 *
 * No receipt lands with the row: the row is the application's, and the receipt the authority's. Of
 * a crash between them, or of a statement that outlives its call's time, an `apply` sent again
 * computes again from what the first left (the package's README).
 */

/** How many times an `apply` tries a row that goes on changing, before the page is told so. */
const ATTEMPTS = { apply: 3 } as const;

/** What a write is made of: the column, of the row, of the table, and how its value is made. */
export interface RowTarget {
  readonly table: string;
  readonly field: string;
  readonly column: RowField;
  readonly row: BoundRow;
  /** What a `set` was sent: it reads nothing. */
  readonly value: unknown;
  /** What an `apply` computes of what the row holds: none of a `set`. */
  readonly apply: ((current: Value) => unknown) | undefined;
}

function notFound(table: string): Error {
  return refusal(HTTP_NOT_FOUND, 'NOT_FOUND', `There is no such row of ${table}.`);
}

/** Why `value` cannot be what `column` holds, or nothing where it can. */
function wrongValue({ definition, labels }: RowField, value: unknown): string | undefined {
  const wrong = checkValue(definition, value);
  if (wrong !== undefined || labels === undefined) return wrong;
  return labels.includes(value as string) ? undefined : 'The value is not one the column lists.';
}

/** `value`, held to what `column` may hold: a refusal (422) otherwise. */
function checked(column: RowField, value: unknown): Value {
  const wrong = wrongValue(column, value);
  if (wrong !== undefined) {
    throw refusal(HTTP_UNPROCESSABLE, 'INVALID_VALUE', wrong);
  }
  return value as Value;
}

/** What the database answered of a write: nothing where the row took it, else a refusal. */
function answered(target: RowTarget, outcome: RowWrite): void {
  const { field, table } = target;
  switch (outcome) {
    case 'written': {
      return;
    }
    case 'absent': {
      throw notFound(table);
    }
    case 'denied': {
      throw denied();
    }
    case 'taken': {
      throw refusal(
        HTTP_CONFLICT,
        'UNIQUE_VIOLATION',
        `Another row of ${table} holds the same ${field}.`,
      );
    }
    case 'invalid': {
      throw refusal(
        HTTP_UNPROCESSABLE,
        'INVALID_VALUE',
        `The database does not take this value of ${table}.${field}.`,
      );
    }
  }
}

/** An `apply`, computing by `compute`. */
async function applied(
  call: Call,
  target: RowTarget,
  compute: (current: Value) => unknown,
): Promise<void> {
  const { column, field, row, table } = target;
  for (let attempt = 1; attempt <= ATTEMPTS.apply; attempt += 1) {
    const read = await call.answer(async () => row.read([field]));
    const current = read?.[field];
    if (current === undefined) throw notFound(table);
    const value = checked(column, compute(current));
    if (value === current) return;
    const outcome = await call.answer(async () => row.write(field, value, current));
    if (outcome !== 'absent') {
      answered(target, outcome);
      return;
    }
  }
  throw refusal(HTTP_CONFLICT, 'ROW_CHANGED', `The row of ${table} went on changing: try again.`);
}

/** Writes the row, within the call's time, or refuses to. */
export async function writeRow(core: Core, target: RowTarget): Promise<void> {
  const { apply, column, field, row, table } = target;
  const call = new Call(`The write to ${table}.${field}`, core.timeoutMs);
  try {
    await call.within(async () => {
      if (apply !== undefined) {
        await applied(call, target, apply);
        return;
      }
      const value = checked(column, target.value);
      answered(target, await call.answer(async () => row.write(field, value)));
    });
  } finally {
    call.close();
  }
}

/**
 * The commit's row of a row a write reached, as the log will tell of it: what read it by what its
 * condition names renders again at the receipt's revision, without waiting for the log — of an
 * `apply` that wrote nothing too, which read what the log may not have told of yet.
 */
export function rowChange(table: string, row: BoundRow): RowChange {
  return { after: row.image, before: row.image, id: 'row', table };
}
