import { refresh } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';

import { AUTHORITY_UNAVAILABLE, type Failure, type SessionId } from '../client/index.ts';
import {
  type Json,
  type OperationArgument,
  type OperationCall,
  PREPARED_LIMIT,
  REQUEST_LIMITS,
} from '../program.ts';
import { type JsonBudget, jsonBudget, spendJson, toJson } from '../runtime/json.ts';
import { argumentsOf } from '../runtime/operation-arguments.ts';
import { operationDigest } from '../runtime/outcome.ts';
import { HTTP_INTERNAL_ERROR } from '../status.ts';
import { authority, requestSession, type SessionSource } from './authority.ts';
import { expireKeptRootsOf } from './kept.ts';

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
 * is rendered again in the same answer (`refresh`), so the page shows what it changed. Of a build
 * whose roots the deployment's cache keeps, an operation that ran first expires the session's kept
 * roots at once (`revalidateTag` of a window of none), so that the render is the authority's, not
 * the one kept from before the operation, while the browser keeps the pages it prefetched where the
 * `refresh()` follows; a refusal and an unknown outcome expire nothing (`OperatedBy.kept`).
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
 * How the application applies the change of its own session that a server operation asks for
 * (`changeSession` of `./server`), on its server: it is handed the change, which is JSON of 4 KiB
 * at most, once the operation has succeeded and before the route renders again — to set a cookie,
 * for one. The compile writes the application's into the stubs (`--session-change`). An error it
 * throws is the Server Action's: the operation ran all the same, and its page is not rendered again
 * — save of a build whose roots the deployment's cache keeps, where the expiry of the session's
 * kept roots before it has the error's answer render the page.
 */
export type SessionChange = (change: Json) => void | Promise<void>;

/**
 * The operation a hook prepares, as the application's server is about to send it: where it is, and
 * what its function will read.
 */
export interface OperationToPrepare {
  readonly module: string;
  readonly name: string;
  /** As the operation will read them: copies, JSON as it crosses, a form as a FormData of its text entries. */
  readonly args: readonly unknown[];
}

/**
 * How the application prepares an operation on its own server (`prepareOperation` of
 * `withReactiveState`, `--prepare-operation` of the compile): it runs once for a call, in the
 * Server Action, before the authority is called, for a request that carries a session. It does not
 * run where `requestSession` answers `null`, which the demo's cookie sessions do for no cookie
 * alone:
 * an empty or junk cookie is a session, and a session the authority then finds unknown has had its
 * hook run before the 401. What it answers — JSON of 4 KiB at most, checked at run time (non-JSON
 * is a `TypeError`), though typed `unknown` so that an interface-typed object is accepted —
 * travels with the call, and the operation reads it with `prepared()` of `./server`; none where it
 * answers `undefined`. An error it throws is the Server Action's: nothing is sent. It is the
 * application's server's own context — a token only that server holds — and the
 * authority keeps none of it.
 */
export type OperationPreparation = (operation: OperationToPrepare) => unknown;

/**
 * What a stub runs an operation by: the build, and the application's session source, where it
 * signs its users in itself (`SessionSource`). A stub of the demo's sessions names the build alone.
 */
export interface OperatedBy {
  readonly build: string;
  readonly session?: SessionSource | undefined;
  /** How the application applies the session change an operation asks for (`SessionChange`). */
  readonly sessionChange?: SessionChange | undefined;
  /** How the application prepares the operation before it is sent (`OperationPreparation`). */
  readonly prepareOperation?: OperationPreparation | undefined;
  /**
   * Whether the build keeps its roots in the deployment's cache (`prefetchCache: 'remote'`): an
   * operation that ran expires the session's at once (`revalidateTag` of a window of none), before
   * the session change it asked for is applied and the route renders again. A refusal ran nothing,
   * and an unknown outcome — the authority unreachable, out of time, or at fault — expires nothing
   * either, though it may have committed: the expiry would have the error's answer render the
   * route (`pathWasRevalidated`, `action-handler.js`) against the authority that just failed, each
   * root refused and the page's state inside it lost, where a private build leaves the page as it
   * was. Of one that did commit, a reload within the lifetime shows the render kept from before it
   * until its stream sets it right.
   */
  readonly kept?: boolean | undefined;
}

/**
 * Applies the session change an operation that succeeded asked for, where it asked for one: by the
 * application's applier, awaited. A change with no applier to take it is logged and left, since the
 * operation succeeded all the same; an applier that throws is logged and thrown, as the Server
 * Action's error.
 */
async function applied(
  module: string,
  name: string,
  change: Json | undefined,
  apply: SessionChange | undefined,
): Promise<void> {
  if (change === undefined) {
    return;
  }
  if (apply === undefined) {
    // eslint-disable-next-line no-console -- the operation succeeded: the application's server is told in its log
    console.error(
      `${module}#${name} asked for a change of the session, and the application names no applier: name one with \`sessionChange\` (\`--session-change\`). The change was not applied.`,
    );
    return;
  }
  try {
    await apply(change);
  } catch (error) {
    // Next.js's control flow — `redirect()`, `notFound()` — is no failure to log.
    unstable_rethrow(error);
    // eslint-disable-next-line no-console -- logged, then thrown as the Server Action's error
    console.error(`The session change that ${module}#${name} asked for was not applied:`, error);
    throw error;
  }
}

/**
 * What the application's hook prepares for an operation, checked: JSON of `PREPARED_LIMIT` bytes at
 * most, or `undefined` for none. The hook is handed copies of the arguments, so that what it does to
 * them changes nothing that is sent. An error it throws is logged, and thrown as the Server Action's
 * error; nothing is sent. The log names the operation and holds the hook's error, never what was
 * prepared.
 */
async function preparedBy(
  call: OperationCall,
  prepare: OperationPreparation,
): Promise<Json | undefined> {
  const { module, name } = call;
  const args = argumentsOf(
    call.args.map((argument) =>
      'json' in argument ? { json: structuredClone(argument.json) } : argument,
    ),
  );
  let answer: unknown;
  try {
    answer = await prepare({ args, module, name });
  } catch (error) {
    // Next.js's control flow — `redirect()`, `notFound()` — is no failure to log.
    unstable_rethrow(error);
    // eslint-disable-next-line no-console -- logged, then thrown as the Server Action's error
    console.error(
      `The preparation of ${module}#${name} failed; the operation was not sent:`,
      error,
    );
    throw error;
  }
  if (answer === undefined) {
    return undefined;
  }
  const where = `The preparation of ${module}#${name}`;
  // A value of the answer writes a byte of its text at least: more values than bytes is too large.
  const json: Json = toJson(answer, where, PREPARED_LIMIT);
  const bytes = new TextEncoder().encode(JSON.stringify(json)).byteLength;
  if (bytes > PREPARED_LIMIT) {
    throw new TypeError(
      `${where} is ${String(bytes)} bytes of JSON, ${String(PREPARED_LIMIT)} at most.`,
    );
  }
  return json;
}

/**
 * The error of a call to `module#name` the authority answered `failure` to: one of an outcome
 * unknown — it may have run — or a refusal, which says it did not.
 */
function operationError(of: {
  readonly module: string;
  readonly name: string;
  readonly failure: Failure;
  readonly unknown: boolean;
}): OperationError {
  const { failure, module, name, unknown } = of;
  const { code, message, status } = failure;
  return new OperationError(
    unknown
      ? `Whether ${module}#${name} ran is unknown: ${message}`
      : `${module}#${name} was refused (${String(status)} ${code}): ${message}`,
    { cause: failure, code, outcome: unknown ? 'unknown' : 'refused', status },
  );
}

/** The call of `args` to `module#name`, prepared where the application's hook says to be. */
async function callOf(
  call: OperationCall,
  session: SessionId,
  prepare: OperationPreparation | undefined,
): Promise<OperationCall> {
  // No hook runs for a request of no session: the authority refuses it (401) before any operation.
  if (session === null || prepare === undefined) {
    return call;
  }
  const prepared = await preparedBy(call, prepare);
  return prepared === undefined ? call : { ...call, prepared };
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
  const {
    build,
    kept,
    prepareOperation,
    session: source,
    sessionChange,
  } = typeof built === 'string' ? { build: built } : built;
  // The arguments share one count of values, as many as the authority's text of them could hold.
  const budget = jsonBudget(REQUEST_LIMITS.arguments);
  const encoded: OperationCall = {
    args: args.map((argument, index) => encodeArgument(argument, index, budget)),
    build,
    module,
    name,
    operationId: crypto.randomUUID(),
  };
  const session = await requestSession(source);
  // Prepared once: a resend below sends this call again, not a new preparation.
  const call = await callOf(encoded, session, prepareOperation);
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
    // Neither a refusal, which ran nothing, nor an unknown outcome expires a kept root: an expiry
    // would have the error's answer render the route (`pathWasRevalidated`) against the authority
    // that just failed. Of one that did commit, a reload within the lifetime shows the render kept
    // from before it until its stream sets it right: inside the option's trade-off.
    throw operationError({
      failure: result,
      module,
      name,
      unknown: unknownBefore || isUnknown(result),
    });
  }
  // An operation that ran expires the session's kept roots before anything else can end the Server
  // Action — the applier below, which may throw or redirect: Next.js applies what a Server Action
  // expired whether it answers or throws.
  if (kept === true) {
    await expireKeptRootsOf(session);
  }
  await applied(module, name, result.value.sessionChange, sessionChange);
  try {
    refresh();
  } catch {
    // Called from somewhere other than a Server Action — another server function's code — there
    // is no route of a page to render again: the operation ran all the same.
  }
  return result.value.result;
}
