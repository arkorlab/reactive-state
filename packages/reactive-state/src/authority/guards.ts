import type { MiddlewareProgram, ResponseDescriptor, RouteParams } from '../routing.ts';
import type { Dependencies } from './dependencies.ts';
import { renderEvaluation } from './evaluation.ts';
import type { Core } from './model.ts';
import { isForbidden, type Renderer } from './render.ts';

/**
 * The guards of a route's middleware — what each reads of the database and the session before its
 * `await next()`, and the conditions on it — run as the application wrote them, outermost first, in
 * the call that renders the route's root: what they read joins what the root read, so that a change
 * of either is a change of the route's view. A guard that refuses (`forbidden()`) refuses the
 * route; one that answers a response itself answers the route with it; the session's refusal (401)
 * and anything else they throw are the call's, as a component's are.
 */

export type GuardOutcome =
  | { readonly kind: 'pass' }
  | {
      readonly kind: 'refused';
      /** The middleware whose guard refused, by id. */
      readonly id: string;
    }
  | {
      readonly kind: 'respond';
      readonly response: ResponseDescriptor;
      /** The middleware whose guard answered it, by id. */
      readonly id: string;
    };

/** The lowest and highest status a response a guard answers itself may have. */
const LOWEST_STATUS = 200;
const HIGHEST_STATUS = 599;

/** Whether `headers` are a response's: pairs of text. */
function isHeaderPairs(headers: readonly unknown[]): boolean {
  return headers.every((pair) => {
    return (
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      typeof pair[1] === 'string'
    );
  });
}

/** Whether a guard answered a response itself, as the compile writes one: a status, headers, a body. */
function responseOf(answered: unknown): ResponseDescriptor | undefined {
  if (typeof answered !== 'object' || answered === null) {
    return undefined;
  }
  const { body, headers, status } = answered as Partial<Record<string, unknown>>;
  if (
    typeof status !== 'number' ||
    typeof body !== 'string' ||
    !Array.isArray(headers) ||
    !Number.isSafeInteger(status) ||
    status < LOWEST_STATUS ||
    status > HIGHEST_STATUS ||
    !isHeaderPairs(headers)
  ) {
    return undefined;
  }
  return { body, headers: headers as readonly (readonly [string, string])[], status };
}

/**
 * The guards of the middleware `chain` names, outermost first: a middleware the compile wrote no
 * guard of passed over. One the authority was not told of — neither its guard nor that it has none —
 * is a fault, never passed over: no route that names one is registered (`routeRegistryOf`).
 */
export function guardsOf(core: Core, chain: readonly string[]): readonly MiddlewareProgram[] {
  return chain.flatMap((id) => {
    const program = core.routes.middleware.get(id);
    if (program === undefined) {
      throw new Error(
        `The middleware ${JSON.stringify(id)} is none the authority was given, neither its guard nor that it has none.`,
      );
    }
    return program === null ? [] : [program];
  });
}

/**
 * Runs `guards` in the renderer's call, outermost first, each read noted in `dependencies`: what
 * the first that does not let the route on answers, or `pass`.
 */
export async function runGuards(
  core: Core,
  renderer: Renderer,
  guards: readonly MiddlewareProgram[],
  context: { readonly params: RouteParams; readonly dependencies: Dependencies },
): Promise<GuardOutcome> {
  const { call } = renderer.scope;
  const scope = {
    ...renderer.scope,
    onRead: () => {
      core.metrics.middlewareReads += 1;
    },
  };
  for (const program of guards) {
    core.metrics.guardEvaluations += 1;
    let answered: unknown;
    try {
      answered = await call.run(renderEvaluation(scope, context.dependencies), () =>
        Promise.resolve(program.guard({ params: context.params })),
      );
    } catch (error) {
      const outcome = call.outcome(error);
      if (isForbidden(outcome)) {
        return { id: program.id, kind: 'refused' };
      }
      throw outcome;
    }
    if (call.fault !== undefined) {
      throw call.fault.error;
    }
    if (answered !== undefined) {
      const response = responseOf(answered);
      if (response === undefined) {
        throw new Error(
          `The guard of the middleware ${JSON.stringify(program.id)} answered what is neither nothing nor a response.`,
        );
      }
      return { id: program.id, kind: 'respond', response };
    }
  }
  return { kind: 'pass' };
}
