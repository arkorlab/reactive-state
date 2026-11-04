import type {
  ComponentProgram,
  FieldOperation,
  FieldReceipt,
  ProgramUpdater,
  Value,
} from '../program.ts';
import { checkValue, defaultOf } from '../server/schema.ts';
import {
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE,
  TARGET_CHANGED,
} from '../status.ts';
import { type BindingClaims, verifyBinding } from './bindings.ts';
import { digest } from './canonical.ts';
import { denied, messageOf, refusal } from './errors.ts';
import { Call } from './evaluation.ts';
import type { Core, Session } from './model.ts';
import { replayPath } from './replay.ts';
import { lastComponentStep } from './skeleton.ts';
import { checkUnique } from './transaction.ts';
import { guardedBy, rendererOf } from './views.ts';

/**
 * One write to a field, as a page's setter sends it, in the order its checks run: the session; the
 * binding — signed for this session and build; the update — registered for the binding's state by
 * the component whose state it is; the path the binding names, rendered again (`replayPath`), whose
 * refusal is the write's; a resend of an operation already made, answered with its receipt; the
 * record, which a write never makes; the value — the one a `set` is sent, or the one an `apply`
 * computes from what the field holds and the values the call captured — checked against the field
 * and each `unique` group the field is of; and the record, the operation's receipt and the change
 * log, committed together.
 */

/** A thrown value's message, for a refusal that quotes it: never longer than this. */
const MAX_MESSAGE_LENGTH = 500;

/** What a field write is, which one operation id names: whose, through which state, by which update, of what. */
function fingerprintOf(claims: BindingClaims, operation: FieldOperation): string {
  return digest([
    'field',
    claims.build,
    claims.root,
    claims.path,
    claims.key,
    claims.table,
    claims.record,
    claims.field,
    operation.updaterId,
    operation.value ?? null,
    operation.captures ?? null,
  ]);
}

/**
 * The update `updaterId` the component whose state the binding is registers for that state — its
 * own alone: one another component registered writes what this one never showed — sent what it
 * takes: a `set` the value it writes, and an `apply` none, the values its call captured at most.
 */
function updaterOf(
  program: ComponentProgram | undefined,
  claims: BindingClaims,
  operation: FieldOperation,
): ProgramUpdater {
  const updater =
    program !== undefined && Object.hasOwn(program.updaters, operation.updaterId)
      ? program.updaters[operation.updaterId]
      : undefined;
  if (updater?.keys.includes(claims.key) !== true) {
    throw refusal(
      HTTP_BAD_REQUEST,
      'UNKNOWN_UPDATER',
      'There is no such registered update of this state.',
    );
  }
  if (
    updater.kind === 'set'
      ? operation.value === undefined || operation.captures !== undefined
      : operation.value !== undefined
  ) {
    throw refusal(
      HTTP_BAD_REQUEST,
      'INVALID_OPERATION',
      updater.kind === 'set'
        ? 'This update writes the value it is sent, and nothing else.'
        : 'This update computes the value it writes, and is sent none.',
    );
  }
  return updater;
}

/** The binding's path, rendered again for the write: whether the state is still there to write. */
async function replayed(
  core: Core,
  session: Session,
  claims: BindingClaims,
): Promise<'changed' | 'found'> {
  const call = new Call(`The render of ${claims.root.component} for a write`, core.timeoutMs);
  try {
    const renderer = rendererOf(core, call, session);
    // The route's middleware first, as every render of the root runs it: what its guards hold now,
    // in the queue the write commits in, refuses the write as it refuses the page.
    if ((await guardedBy(core, renderer, claims.root)).refused) {
      throw denied();
    }
    const outcome = await replayPath(renderer, claims);
    if (call.fault !== undefined) {
      throw call.fault.error;
    }
    return outcome;
  } catch (error) {
    throw call.fault === undefined ? error : call.fault.error;
  } finally {
    call.close();
  }
}

/** The value the write writes: the one a `set` was sent, or the one an `apply` computes (422 where it cannot). */
function nextValue(updater: ProgramUpdater, current: Value, operation: FieldOperation): unknown {
  if (updater.kind === 'set') {
    return operation.value;
  }
  try {
    return updater.apply(current, operation.captures ?? {});
  } catch (error) {
    throw refusal(
      HTTP_UNPROCESSABLE,
      'INVALID_VALUE',
      `The update could not be made: ${messageOf(error, MAX_MESSAGE_LENGTH)}`,
    );
  }
}

/** One write to a field, for the session `sessionId` names; its receipt, or a refusal. */
export async function writeField(
  core: Core,
  sessionId: unknown,
  operation: FieldOperation,
): Promise<FieldReceipt> {
  const session = core.session(sessionId);
  const claims = verifyBinding(core.secret, operation.binding, {
    build: core.registry.buildId,
    now: core.clock(),
    session: session.id,
    user: session.userId,
  });
  const issuer = core.registry.programs.get(
    lastComponentStep(claims.path)?.c ?? claims.root.component,
  );
  const updater = updaterOf(issuer, claims, operation);
  const target = await replayed(core, session, claims);
  const fingerprint = fingerprintOf(claims, operation);
  const { operationId } = operation;
  const previous = core.db.operation(session.id, operationId);
  if (previous !== undefined) {
    if (previous.kind !== 'field' || previous.fingerprint !== fingerprint) {
      throw refusal(
        HTTP_CONFLICT,
        'OPERATION_REUSED',
        'That operation id was used for another operation.',
      );
    }
    core.metrics.deduplicated += 1;
    const { committedRevision } = JSON.parse(previous.outcome) as {
      readonly committedRevision: number;
    };
    return { committedRevision, deduplicated: true, operationId };
  }
  if (target === 'changed') {
    throw refusal(HTTP_CONFLICT, TARGET_CHANGED, 'What this writes to has changed.');
  }
  const record = core.tables.get(claims.table, claims.record);
  const table = core.tables.table(claims.table);
  const definition = table.fields[claims.field];
  if (record === null || definition === undefined) {
    throw refusal(HTTP_NOT_FOUND, 'NOT_FOUND', 'There is no such record.');
  }
  const current = record[claims.field] ?? defaultOf(definition);
  core.metrics.updaterRuns += 1;
  const next = nextValue(updater, current, operation);
  const wrong = checkValue(definition, next);
  if (wrong !== undefined) {
    throw refusal(HTTP_UNPROCESSABLE, 'INVALID_VALUE', wrong);
  }
  // An equal value commits the operation, and changes nothing that read the record.
  const after = Object.freeze({ ...record, [claims.field]: next as Value });
  // A `unique` group of the field's is held once, as an operation's write keeps it (409).
  const groups = table.unique.filter((group) => group.includes(claims.field));
  checkUnique(core.tables, groups, { id: claims.record, table: claims.table, values: after });
  const event = core.commit({
    kind: 'state',
    rows:
      next === current ? [] : [{ after, before: record, id: claims.record, table: claims.table }],
    with: (revision) => {
      core.db.insertOperation({
        created: core.clock(),
        fingerprint,
        id: operationId,
        kind: 'field',
        outcome: JSON.stringify({ committedRevision: revision }),
        revision,
        sessionId: session.id,
      });
    },
  });
  return { committedRevision: event.revision, deduplicated: false, operationId };
}
