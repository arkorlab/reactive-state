import { refresh } from 'next/cache';

import { AUTHORITY_UNAVAILABLE, type Failure } from '../client/index.ts';
import type { OperationArgument, OperationCall } from '../program.ts';
import { type JsonBudget, jsonBudget, spendJson, toJson } from '../runtime/json.ts';
import { operationDigest } from '../runtime/outcome.ts';
import { HTTP_INTERNAL_ERROR } from '../status.ts';
import { authority, requestSession, type SessionSource } from './authority.ts';

/**
 * A server operation, as the `'use server'` stub a compile writes in place of the application's
 * own runs it (`<out>/actions/…`): the authority runs the application's function, in a transaction,
 * as the session's user; this sends it there.
 *
 * The operation's id is made here, on the application's server, never by the browser: a Server
 * Function's arguments are the browser's to choose, and an id it chose could name another session's
 * operation. A call whose outcome is unknown — the authority could not be reached, did not answer
 * in time, or answered a fault of its own — is sent again under the same id, which the authority
 * runs once at most; one the authority refused is not, since it would refuse it again. Once the operation has run, the route
 * is rendered again in the same answer (`refresh`), so the page shows what it changed.
 */

/** Sends again of a call whose outcome is unknown, after the first. */
const MAX_RETRIES = 3;
/** The wait before the first resend; each one after waits twice as long. */
const RETRY_DELAY_MS = 200;
/** What a form a server operation is sent may hold, as the authority reads one: 16 KiB. */
const MAX_FORM_ENTRIES = 64;
const MAX_FORM_BYTES = 16_384;
/**
 * What React adds to a form that posts to a Server Function, to find the function again where the
 * page has no script: no part of what the application's function reads.
 */
const REACT_FIELD = '$ACTION_';

interface OperationErrorOptions extends ErrorOptions {
  /** Whether the authority refused the operation, or whether it ran is unknown. */
  readonly outcome: 'refused' | 'unknown';
  readonly status: number;
  readonly code: string;
}

/**
 * A server operation that did not run, or that may not have. Its `digest` says which, with the
 * authority's code, where the page reads it: Next.js keeps an error's own digest across the RSC
 * boundary when it hides the message, and the page's error boundary tells the two apart with
 * `operationOutcome` (`@arkorlab/reactive-state/react`).
 */
export class OperationError extends Error {
  readonly outcome: 'refused' | 'unknown';
  readonly status: number;
  readonly code: string;
  readonly digest: string;

  constructor(message: string, options: OperationErrorOptions) {
    super(message, options);
    this.name = 'OperationError';
    this.outcome = options.outcome;
    this.status = options.status;
    this.code = options.code;
    this.digest = operationDigest(options.outcome, options.code);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A form's text fields, as the authority rebuilds the form from them; a file is refused. Its bytes
 * are counted with the call's other arguments (`budget`).
 */
function formOf(form: FormData, where: string, budget: JsonBudget): (readonly [string, string])[] {
  const encoder = new TextEncoder();
  const entries: (readonly [string, string])[] = [];
  let bytes = 0;
  for (const [name, value] of form) {
    if (name.startsWith(REACT_FIELD)) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new TypeError(
        `${where} holds a file in ${name}: a server operation is sent a form's text alone.`,
      );
    }
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
    entries.push([name, value]);
  }
  if (entries.length > MAX_FORM_ENTRIES || bytes > MAX_FORM_BYTES) {
    throw new RangeError(
      `${where} holds ${String(entries.length)} fields of ${String(bytes)} bytes: a server operation is sent ${String(MAX_FORM_ENTRIES)} fields of ${String(MAX_FORM_BYTES)} bytes at most.`,
    );
  }
  spendJson(budget, bytes + 2, where);
  return entries;
}

/**
 * An argument as it crosses to the authority: a form's text fields, or JSON as it is — within what
 * `budget` has left of the JSON one request carries, which the arguments of a call are counted
 * against together: an object a caller's arguments hold many times over is counted each time, in
 * one argument or across them.
 */
function encodeArgument(argument: unknown, index: number, budget: JsonBudget): OperationArgument {
  const where = `Argument ${String(index + 1)}`;
  return argument instanceof FormData
    ? { form: formOf(argument, where, budget) }
    : { json: toJson(argument, where, budget) };
}

/**
 * What the authority answers an operation that committed and then did not settle as it should —
 * threw after its commit, or was cut off — first and on every resend alike: unknown, and final.
 */
const SETTLED_UNKNOWN: ReadonlySet<string> = new Set(['OPERATION_FAILED', 'OPERATION_UNSETTLED']);

/**
 * Whether a failed call may have run nonetheless: the authority's answer never came, or it was a
 * fault (5xx) — the Node authority's own `500`, as the Durable Object's binding answers its own as
 * `503` — and not a refusal, which says the operation did not run.
 */
function isUnknown(failure: Failure): boolean {
  return failure.status >= HTTP_INTERNAL_ERROR || failure.code === AUTHORITY_UNAVAILABLE;
}

/** Whether a resend may answer more than this did: an unknown outcome the authority keeps none of. */
function isResendable(failure: Failure): boolean {
  return isUnknown(failure) && !SETTLED_UNKNOWN.has(failure.code);
}

/**
 * What a stub runs an operation by: the build, and the application's session source, where it
 * signs its users in itself (`SessionSource`). A stub of the demo's sessions names the build alone.
 */
export interface OperatedBy {
  readonly build: string;
  readonly session?: SessionSource | undefined;
}

/**
 * Runs `name` of the `'use server'` module `module` in the authority with `args`, and answers what
 * it returned. Throws an `OperationError` when it was refused, or when whether it ran is unknown.
 */
export async function operate(
  module: string,
  name: string,
  args: readonly unknown[],
  built: string | OperatedBy,
): Promise<unknown> {
  const { build, session: source } = typeof built === 'string' ? { build: built } : built;
  const budget = jsonBudget();
  const call: OperationCall = {
    args: args.map((argument, index) => encodeArgument(argument, index, budget)),
    build,
    module,
    name,
    operationId: crypto.randomUUID(),
  };
  const session = await requestSession(source);
  const client = authority();
  let result = await client.operate(session, call);
  // Once an attempt's outcome was unknown, a later refusal does not say it never ran: the session
  // may have ended meanwhile, with the record of it, or a newer build may refuse the resend.
  let unknownBefore = false;
  for (let retry = 0; !result.ok && isResendable(result) && retry < MAX_RETRIES; retry += 1) {
    unknownBefore = true;
    await sleep(RETRY_DELAY_MS * 2 ** retry);
    result = await client.operate(session, call);
  }
  if (!result.ok) {
    const { code, message, status } = result;
    const unknown = unknownBefore || isUnknown(result);
    throw new OperationError(
      unknown
        ? `Whether ${module}#${name} ran is unknown: ${message}`
        : `${module}#${name} was refused (${String(status)} ${code}): ${message}`,
      { cause: result, code, outcome: unknown ? 'unknown' : 'refused', status },
    );
  }
  try {
    refresh();
  } catch {
    // Called from somewhere other than a Server Action — another server function's code — there
    // is no route of a page to render again: the operation ran all the same.
  }
  return result.value.result;
}
