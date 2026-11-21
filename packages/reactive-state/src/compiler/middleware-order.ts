import {
  isVariableStatement,
  type Node,
  NodeFlags,
  type SourceFile,
  type Statement,
} from 'typescript/ast';

import type { Fail } from './errors.ts';
import { boundBeforeNext } from './middleware-bound-defaults.ts';
import type { CompiledMiddleware } from './routes.ts';

/**
 * The order a route middleware's parts run in, held to the order its source runs them in. The host
 * runs each envelope's part before `next`, outermost first, ahead of the route, and the guards run
 * below the envelopes, as the route is answered; so code the source runs after a guard — further
 * down the same middleware, or in a middleware inside one with a guard — would run ahead of it, for a
 * request the guard refuses too: `await request.json()` throwing in place of the refusal, a helper's
 * side effect. Such code is refused, saying where it goes: ahead of the guard, or after
 * `await next()`. What the source runs before every guard — a request's id — runs as written.
 */

/** How long a statement's text is in a refusal at most: its first line, cut short. */
const EXCERPT_LENGTH = 60;

/** The text of `node` a refusal names it by: its first line, cut short. */
function excerpt(node: Node, sourceFile: SourceFile): string {
  const [line = ''] = node.getText(sourceFile).split('\n', 1);
  return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH)}…` : line;
}

/**
 * Refuses a `using` or `await using` declaration the middleware makes before `next`, at the scope of
 * its own body (`before`): the source disposes its resource as the middleware returns, after the
 * route has run, where the guard written for it returns before the route starts and the host's part
 * before `next` returns ahead of it. One within a block that ends before `next` is disposed there,
 * where the source disposes it, and is no part's.
 */
export function checkResources(
  before: readonly Statement[],
  context: { readonly sourceFile: SourceFile; readonly fail: Fail },
): void {
  const held = before.find(
    // eslint-disable-next-line no-bitwise -- TypeScript says `using` and `await using` in this flag.
    (each) => isVariableStatement(each) && (each.declarationList.flags & NodeFlags.Using) !== 0,
  );
  if (held !== undefined) {
    context.fail(
      `\`${excerpt(held, context.sourceFile)}\` holds a resource until the middleware returns, after the route has run: the guard it would be written into returns before the route starts, and the part the host runs before \`next\` returns ahead of it, so the resource would be disposed early. Declare it within a block that ends before \`next\`, or release it where it is no longer needed.`,
      held,
    );
  }
}

/**
 * Refuses a statement of a middleware's part before `next` (`before`, as the host runs it) that the
 * source writes after the first statement of its guard (`guards`, in the order the source holds
 * them): it would run ahead of the guard it follows.
 */
export function checkBeforeGuard(
  before: readonly Statement[],
  guards: readonly Statement[],
  context: { readonly sourceFile: SourceFile; readonly fail: Fail },
): void {
  const [first] = guards;
  const late = first === undefined ? undefined : before.find((each) => each.pos > first.pos);
  if (first !== undefined && late !== undefined) {
    const { sourceFile } = context;
    context.fail(
      `\`${excerpt(late, sourceFile)}\` runs before \`next\` for each request, which the host runs ahead of the route, and of the guard the middleware writes before it (\`${excerpt(first, sourceFile)}\`), which runs below the envelopes: written after the guard, it would run ahead of it, for a request the guard refuses too. Move it ahead of the guard, or after \`await next()\`.`,
      late,
    );
  }
}

/**
 * Refuses `middleware`'s part before `next` where a middleware outside it (`outer`, outermost first)
 * has a guard: the source runs it inside that guard's `next`, the host ahead of the guard — a
 * statement of it, or a default or a pattern of the context's pattern it binds that may throw or
 * have an effect (`boundBeforeNext`), which runs first.
 */
export function checkUnderGuard(
  middleware: CompiledMiddleware,
  outer: readonly CompiledMiddleware[],
): void {
  const guarded = outer.find((each) => each.registration.guard);
  if (guarded === undefined) return;
  const { fail, sourceFile } = middleware.split.names;
  const guard = guarded.split.fileName;
  const bound = boundBeforeNext(middleware.split);
  const [first] = middleware.split.before?.statements ?? [];
  if (bound !== undefined) {
    fail(
      `\`${excerpt(bound, sourceFile)}\`, of the context's pattern, is bound before \`next\` for each request, which the host runs ahead of the route, and of the guard of \`${guard}\`, around this middleware, which runs below the envelopes: the source binds it inside that guard's \`next\`, and it would run ahead of the guard, for a request the guard refuses too, where it may throw or have an effect. Give it a default of literals and of the names bound before it, or compute it after \`await next()\`.`,
      bound,
    );
  } else if (first !== undefined) {
    fail(
      `\`${excerpt(first, sourceFile)}\` runs before \`next\` for each request, which the host runs ahead of the route, and of the guard of \`${guard}\`, around this middleware, which runs below the envelopes: the source runs it inside that guard's \`next\`, and it would run ahead of the guard, for a request the guard refuses too. Move it after \`await next()\`, or into \`${guard}\` ahead of its guard.`,
      first,
    );
  }
}
