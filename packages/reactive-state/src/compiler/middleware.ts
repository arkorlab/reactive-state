import {
  type ArrowFunction,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  type ImportDeclaration,
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBlock,
  isCallExpression,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isParenthesizedExpression,
  isReturnStatement,
  isSatisfiesExpression,
  isVariableStatement,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { type Fail, failIn } from './errors.ts';
import { readImports } from './imports.ts';
import { assembleParts, type MiddlewareParts } from './middleware-parts.ts';
import {
  contextOf,
  type MiddlewareNames,
  middlewareNames,
  readsOf,
  type StatementReads,
  unionOf,
} from './middleware-reads.ts';
import { checkContextElision, checkMiddlewareScope } from './middleware-scope.ts';
import { checkSharedImports } from './middleware-shared-imports.ts';
import type { Modules } from './modules.ts';
import { isConstant } from './statements.ts';

/**
 * A route middleware — `<app>/<dir>/middleware.ts`, `export default (async (context, next) => { … })
 * satisfies RouteMiddleware<…>` — read and split at its one `await next()`:
 *
 * - its **guard**: what it does before `next` with the database and the session — the application's
 *   own authorization, its conditions, an early `return new Response(…)` — which the authority runs
 *   again wherever the route's preconditions are checked, with the route's params alone;
 * - its **envelope**: the constants it computes of the request alone before `next` (`const
 *   requestId = crypto.randomUUID()`), and what it does to the response's headers after it, which
 *   the host runs once for each request.
 *
 * What cannot be split so — a guard that reads the request or what the envelope computed, an after
 * part that reads what the guard computed or anything of the response but its headers, a `next`
 * called twice or anywhere but the top of the body — is refused where it stands: a guard is never
 * left out.
 */

export interface MiddlewareSplit extends MiddlewareParts {
  /** Its id: the directory under the app directory it stands in, `''` for the app's own. */
  readonly id: string;
  readonly file: string;
  /** How what is refused names it: its path from the source directory. */
  readonly fileName: string;
  readonly isAsync: boolean;
  readonly names: MiddlewareNames;
  /**
   * The context's type, as the middleware declares it — `Parameters<RouteMiddleware<…>>[0]` of what
   * it `satisfies`, or its parameter's annotation — and the names it reads; none where it declares
   * none.
   */
  readonly contextType: { readonly text: string; readonly reads: ReadonlySet<string> } | undefined;
}

type MiddlewareFunction = ArrowFunction | FunctionDeclaration | FunctionExpression;

/** The names the guard program and the envelope module declare at their top level. */
const OWN_NAMES: ReadonlySet<string> = new Set(['after', 'before', 'guard', 'id']);

const FILE_SHAPE =
  "A route middleware file holds its imports and its `export default` alone — `export default (async ({ params }, next) => { … }) satisfies RouteMiddleware<{ … }>;` — or `export default async function (context, next) { … }`: declare what it uses in a module of the application's, and import it.";

const PARAMETERS =
  'A route middleware takes its context and `next`, each by a name of its own — `({ params }, next)` or `(context, next)` — with no default, and nothing more.';

const CALLS_NEXT =
  "A route middleware calls `next` once, at the top level of its body: `const response = await next();`, or `return next();` — what comes before it is the guard, and what comes after it reads and sets the response's headers.";

const NEXT_ONCE =
  '`next` is called once, as `const response = await next();` or `return next();` at the top level of the middleware: it is handed nowhere, nor called in a condition or twice — the route answers once.';

const AFTER_RETURN = 'Nothing follows `return next()`: it is the last statement of the middleware.';

const EXPRESSION_BODY =
  'An arrow middleware of one expression answers `next()` and does nothing more: write a guard, or what it does to the response, in a body of statements.';

/** `expression` without the parentheses, and the `satisfies` and `as` around it; the type it is said to be. */
function unwrappedFunction(expression: Expression): {
  inner: Expression;
  type: TypeNode | undefined;
} {
  let inner = expression;
  let type: TypeNode | undefined;
  for (;;) {
    if (isParenthesizedExpression(inner)) {
      inner = inner.expression;
    } else if (isSatisfiesExpression(inner) || isAsExpression(inner)) {
      type ??= inner.type;
      inner = inner.expression;
    } else {
      return { inner, type };
    }
  }
}

function hasModifier(
  node: { readonly modifiers?: readonly Node[] | undefined },
  kind: SyntaxKind,
): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

/** The middleware's function, the type it satisfies, and the file's imports. */
function functionOf(
  sourceFile: SourceFile,
  fail: Fail,
): { fn: MiddlewareFunction; satisfied: TypeNode | undefined; imports: ImportDeclaration[] } {
  const imports: ImportDeclaration[] = [];
  let found: { fn: MiddlewareFunction; satisfied: TypeNode | undefined } | undefined;
  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement)) {
      imports.push(statement);
      continue;
    }
    let fn: MiddlewareFunction | undefined;
    let satisfied: TypeNode | undefined;
    if (isExportAssignment(statement) && !statement.isExportEquals) {
      const { inner, type } = unwrappedFunction(statement.expression);
      fn = isArrowFunction(inner) || isFunctionExpression(inner) ? inner : undefined;
      satisfied = type;
    } else if (
      isFunctionDeclaration(statement) &&
      hasModifier(statement, SyntaxKind.ExportKeyword) &&
      hasModifier(statement, SyntaxKind.DefaultKeyword)
    ) {
      fn = statement;
    }
    if (fn === undefined || found !== undefined) {
      fail(FILE_SHAPE, statement);
    }
    found = { fn, satisfied };
  }
  if (found === undefined) {
    return fail(FILE_SHAPE);
  }
  return { ...found, imports };
}

/** The context's parameter and `next`'s, as the function declares them. */
function parametersOf(
  fn: MiddlewareFunction,
  fail: Fail,
): { context: ParameterDeclaration; next: Identifier } {
  const [context, next, ...more] = fn.parameters;
  if (fn.typeParameters !== undefined && fn.typeParameters.length > 0) {
    fail(
      'A route middleware takes no type parameters: its params are typed by `RouteMiddleware<…>`.',
      fn.typeParameters[0],
    );
  }
  if ((isFunctionDeclaration(fn) || isFunctionExpression(fn)) && fn.asteriskToken !== undefined) {
    fail('A route middleware is a function, not a generator.', fn);
  }
  const plain = (
    parameter: ParameterDeclaration | undefined,
  ): parameter is ParameterDeclaration => {
    return (
      parameter !== undefined &&
      parameter.initializer === undefined &&
      parameter.dotDotDotToken === undefined &&
      parameter.questionToken === undefined
    );
  };
  if (!plain(context) || !plain(next) || !isIdentifier(next.name) || more.length > 0) {
    const offending = [context, next, ...more].find(
      (parameter, index) => parameter !== undefined && (index > 1 || !plain(parameter)),
    );
    return fail(PARAMETERS, offending ?? next ?? fn);
  }
  return { context, next: next.name };
}

/** `expression` without parentheses, or what it awaits. */
function awaited(expression: Expression): Expression {
  let inner = expression;
  while (isParenthesizedExpression(inner) || isAwaitExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/** Whether `expression` calls `next` with nothing, awaited or not. */
function callsNext(expression: Expression | undefined, next: string): boolean {
  if (expression === undefined) {
    return false;
  }
  const call = awaited(expression);
  return (
    isCallExpression(call) &&
    isIdentifier(call.expression) &&
    call.expression.text === next &&
    call.arguments.length === 0
  );
}

/** Where the body is split: `const response = await next();` or `return next();`. */
interface Split {
  readonly index: number;
  /** The response `next` answered, as the middleware names it; none for `return next()`. */
  readonly response: Identifier | undefined;
}

/** What a statement is to the split: the call of `next`, or nothing. */
function splitAt(
  statement: Statement,
  next: string,
  sourceFile: SourceFile,
): { response: Identifier | undefined } | undefined {
  if (isReturnStatement(statement)) {
    return callsNext(statement.expression, next) ? { response: undefined } : undefined;
  }
  if (!isVariableStatement(statement)) {
    return undefined;
  }
  const [declaration, ...more] = statement.declarationList.declarations;
  const constant = isConstant(statement, sourceFile);
  const initializer = declaration?.initializer;
  return constant &&
    declaration !== undefined &&
    initializer !== undefined &&
    more.length === 0 &&
    isIdentifier(declaration.name) &&
    isAwaitExpression(initializer) &&
    callsNext(initializer, next)
    ? { response: declaration.name }
    : undefined;
}

/** The split of `statements`: the one call of `next`, at their top level. */
function splitOf(
  statements: readonly Statement[],
  reads: readonly StatementReads[],
  context: { readonly names: MiddlewareNames; readonly fn: MiddlewareFunction },
): Split {
  const { fail, next } = context.names;
  const readers = statements.flatMap((_, index) =>
    (reads[index]?.values.get(next.text) ?? []).map((identifier) => ({ identifier, index })),
  );
  const [first, second] = readers;
  if (first === undefined) {
    return fail(CALLS_NEXT, context.fn);
  }
  if (second !== undefined) {
    fail(NEXT_ONCE, second.identifier);
  }
  const statement = statements[first.index];
  const at =
    statement === undefined ? undefined : splitAt(statement, next.text, context.names.sourceFile);
  if (at === undefined) {
    return fail(NEXT_ONCE, first.identifier);
  }
  const following = statements[first.index + 1];
  if (following !== undefined && at.response === undefined) {
    fail(AFTER_RETURN, following);
  }
  return { index: first.index, response: at.response };
}

/** The context's type as the middleware declares it, and the names it reads. */
function contextTypeOf(
  satisfied: TypeNode | undefined,
  context: ParameterDeclaration,
  names: MiddlewareNames,
): MiddlewareSplit['contextType'] {
  const { sourceFile } = names;
  if (satisfied !== undefined) {
    return {
      reads: readsOf(satisfied, names).types,
      text: `Parameters<${satisfied.getText(sourceFile)}>[0]`,
    };
  }
  return context.type === undefined
    ? undefined
    : { reads: readsOf(context.type, names).types, text: context.type.getText(sourceFile) };
}

export interface MiddlewareReading {
  readonly modules: Modules;
  readonly file: string;
  readonly id: string;
}

/** The middleware at `file`, read and split; refused where it cannot be. */
export function readMiddleware(reading: MiddlewareReading): MiddlewareSplit {
  const { file, id, modules } = reading;
  const parsed = modules.parse(file, true);
  const { sourceFile } = parsed;
  const fail = failIn(sourceFile, parsed.name);
  const { fn, imports, satisfied } = functionOf(sourceFile, fail);
  const { context, next } = parametersOf(fn, fail);
  const read = readImports(
    imports,
    sourceFile,
    (specifier) => modules.targetOf(specifier, file),
    fail,
  );
  const bindings = read.modules.flatMap((module) => module.bindings);
  for (const binding of bindings) {
    if (OWN_NAMES.has(binding.name.text)) {
      fail(
        `\`${binding.name.text}\` is a name the parts of a route middleware declare themselves — \`id\`, \`guard\`, \`before\`, \`after\`: import it under another one.`,
        binding.name,
      );
    }
  }
  if (read.intrinsic !== undefined) {
    fail(
      "A route middleware declares no state: `framework/react` is a component's.",
      read.intrinsic,
    );
  }
  const { body } = fn;
  if (body === undefined) {
    return fail(EXPRESSION_BODY, fn);
  }
  if (!isBlock(body) && !callsNext(body, next.text)) {
    return fail(EXPRESSION_BODY, body);
  }
  const statements = isBlock(body) ? body.statements : [];
  const names = middlewareNames({
    bindings,
    context: contextOf(context.name, fail),
    fail,
    next,
    sourceFile,
    statements,
  });
  checkMiddlewareScope(context.name, body, names, isArrowFunction(fn) ? undefined : fn.name?.text);
  const reads = statements.map((statement) => readsOf(statement, names));
  // A body of `next()` alone, which `callsNext` read, splits nowhere: a block calls it at its top
  // level, an empty one among them, which never calls it.
  const split: Split = isBlock(body)
    ? splitOf(statements, reads, { fn, names })
    : { index: -1, response: undefined };
  const parts = assembleParts({ names, reads, split, statements });
  checkSharedImports(parts, names, modules);
  checkContextElision(names, unionOf(parts.guard?.context, parts.before?.context));
  return {
    ...parts,
    contextType: contextTypeOf(satisfied, context, names),
    file,
    fileName: parsed.name,
    id,
    isAsync: hasModifier(fn, SyntaxKind.AsyncKeyword),
    names,
  };
}
