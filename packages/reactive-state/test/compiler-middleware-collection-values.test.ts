import { isFunctionDeclaration, isVariableStatement } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkComputedOnce, checkContextDefaults } from '../src/compiler/middleware-alike.ts';
import { contextOf } from '../src/compiler/middleware-reads.ts';
import { bindingIdentifiers } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const fail = (reason: string): never => {
  throw new Error(reason);
};

/**
 * A constant of a route middleware's params alone that both the guard and the host read, and a
 * default of the context's pattern that both bind, is made by each part anew: where it is a
 * collection, a write by one is absent from the other. A conditional or a logical operation of which
 * one branch or operand may make a collection is read as one written out: written, it is refused;
 * where nothing writes it, or it makes primitives alone, it is taken.
 */

interface Row {
  readonly id: string;
  /** The context parameter. */
  readonly context?: string;
  /** The statements of the middleware's body, around `next`. */
  readonly body: string;
}

const AFTER_MODE = '  void String(options.mode);';
const AFTER_TAGS = '  void String(tags.length);';
const AFTER_LIST = '  void String(list.length);';

/** A shared constant that may make a collection, which the middleware writes: refused. */
const WRITTEN: readonly Row[] = [
  {
    body: `  const options = params.projectId === 'x' ? { mode: 'a' } : { mode: 'b' };\n  options.mode = 'changed';\n${AFTER_MODE}`,
    id: 'conditional-of-objects',
  },
  {
    body: `  const options = params.projectId === 'x' ? { mode: 'a' } : 'none';\n  options.mode = 'changed';\n${AFTER_MODE}`,
    id: 'conditional-of-an-object-and-text',
  },
  {
    body: `  const options = params.projectId === 'x' ? 'none' : params.projectId === 'y' ? { mode: 'a' } : 'none';\n  options.mode = 'changed';\n${AFTER_MODE}`,
    id: 'nested-conditional',
  },
  {
    body: `  const list = params.items ?? [];\n  list.push('x');\n${AFTER_LIST}`,
    id: 'nullish-with-an-array',
  },
  {
    body: `  const list = params.items || [];\n  list.push('x');\n${AFTER_LIST}`,
    id: 'or-with-an-array',
  },
  {
    body: `  const list = params.projectId && [params.projectId];\n  list.push('x');\n${AFTER_LIST}`,
    id: 'and-with-an-array',
  },
  {
    body: `  const list = (params.items ?? []) as string[];\n  list.push('x');\n${AFTER_LIST}`,
    id: 'nullish-cast',
  },
  {
    body: `  const options = params.projectId === 'x' ? { mode: 'a' } : { mode: 'b' };\n  const touched = (options.mode = request.headers.get('x-mode') ?? 'none');\n  void touched;\n  void String(options.mode);`,
    context: '{ params, request }',
    id: 'written-by-a-constant-of-the-host',
  },
];

/** A default of the context's pattern that may make a collection, which the middleware writes. */
const DEFAULTS_WRITTEN: readonly Row[] = [
  {
    body: `  tags.push('x');\n${AFTER_TAGS}`,
    context: '{ params: { tags = true ? [] : [] } }',
    id: 'conditional-of-arrays',
  },
  {
    body: `  tags.push('x');\n${AFTER_TAGS}`,
    context: '{ params: { tags = undefined ?? [] } }',
    id: 'nullish-with-an-array',
  },
  {
    body: `  tags.push('x');\n${AFTER_TAGS}`,
    context: "{ params: { tags = 'a' === 'a' ? [] : 'none' } }",
    id: 'conditional-of-an-array-and-text',
  },
];

/** What makes no collection, or writes none, which is taken as before. */
const TAKEN: readonly Row[] = [
  {
    body: `  const mode = params.projectId === 'x' ? 'a' : 'b';\n  void String(mode);`,
    id: 'conditional-of-text',
  },
  {
    body: `  const mode = params.items ?? 'none';\n  void String(mode);`,
    id: 'nullish-with-text',
  },
  {
    body: `  const options = params.projectId === 'x' ? { mode: 'a' } : { mode: 'b' };\n  if (options.mode === 'z') return new Response('no', { status: 403 });\n${AFTER_MODE}`,
    id: 'conditional-of-objects-written-nowhere',
  },
  {
    body: `  const list = params.items ?? [];\n  if (list.length > 5) return new Response('no', { status: 403 });\n${AFTER_LIST}`,
    id: 'nullish-with-an-array-written-nowhere',
  },
  {
    body: `  if (tags.length > 5) return new Response('no', { status: 403 });\n${AFTER_TAGS}`,
    context: '{ params: { tags = true ? [] : [] } }',
    id: 'default-conditional-written-nowhere',
  },
  {
    body: `  void String(n);`,
    context: '{ params: { n = true ? 1 : 2 } }',
    id: 'default-conditional-of-numbers',
  },
];

/** What was refused already, as an array or an object written out. */
const WRITTEN_OUT: readonly Row[] = [
  {
    body: `  const options = { mode: 'b' };\n  options.mode = 'changed';\n${AFTER_MODE}`,
    id: 'object-written-out',
  },
  {
    body: `  tags.push('x');\n${AFTER_TAGS}`,
    context: '{ params: { tags = [] } }',
    id: 'default-array-written-out',
  },
];

describe('a collection a conditional or a logical operation of a route middleware may make', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What the checks of the middleware's constants and of its context's defaults refuse, or `undefined`. */
  function refused(row: Row): string | undefined {
    using file = parseModule(
      api,
      'middleware.ts',
      `export default function middleware(${row.context ?? '{ params }'}, next) {\n${row.body}\n}\n`,
    );
    const declared = file.sourceFile.statements.find((statement) =>
      isFunctionDeclaration(statement),
    );
    if (declared === undefined || !isFunctionDeclaration(declared) || declared.body === undefined) {
      throw new Error('The middleware is not a function.');
    }
    const [parameter] = declared.parameters;
    if (parameter === undefined) {
      throw new Error('The middleware has no context.');
    }
    const context = contextOf(parameter.name, fail);
    const constants = declared.body.statements
      .filter((statement) => isVariableStatement(statement))
      .map((statement) => {
        return {
          declares: statement.declarationList.declarations.flatMap((declaration) =>
            bindingIdentifiers(declaration.name).map((name) => name.text),
          ),
          statement,
        };
      });
    try {
      checkComputedOnce(constants, { both: () => true, host: () => true }, context, fail);
      checkContextDefaults(context, { guard: () => true, host: () => true }, fail);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it.each(WRITTEN)('refuses a shared constant a conditional makes, written: $id', (row) => {
    expect(refused(row)).toContain('is mutated or passed to a call that may mutate it');
  });

  it.each(DEFAULTS_WRITTEN)('refuses a default that may make a collection, written: $id', (row) => {
    expect(refused(row)).toContain('holds an object or an array the middleware writes');
  });

  it.each(WRITTEN_OUT)('refuses what was refused already: $id', (row) => {
    expect(refused(row)).toMatch(
      /is mutated or passed to a call that may mutate it|holds an object or an array the middleware writes/u,
    );
  });

  it.each(TAKEN)('takes what makes no collection or writes none: $id', (row) => {
    expect(refused(row)).toBeUndefined();
  });
});
