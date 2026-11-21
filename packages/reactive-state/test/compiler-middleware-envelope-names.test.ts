import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isFunctionDeclaration, isIdentifier, isVariableStatement } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emitEnvelope } from '../src/compiler/emit-middleware.ts';
import { readMiddleware } from '../src/compiler/middleware.ts';
import { Modules } from '../src/compiler/modules.ts';
import { bindingIdentifiers } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The envelope's `after` takes what `before` answered and the response `next` answered, each by a
 * name the middleware declares nowhere, where the middleware does not use that name for the parameter:
 * a part after `next` that declares `_response` or `_locals` itself would otherwise declare it twice,
 * and the module would not load.
 */

interface Row {
  readonly id: string;
  /** The statements after `const response = await next();`, but its `return response;`. */
  readonly after: string;
  /** The statements before `next`. */
  readonly before?: string;
}

/** A name the middleware declares after `next`, which the part's own parameters took. */
const TAKEN: readonly Row[] = [
  { after: '  const _response = Math.random();', id: 'response-unread-_response-declared' },
  {
    after: "  const _response = 'a';\n  const __response = 'b';",
    id: 'response-unread-two-underscored-names',
  },
  {
    after: "  const _locals = 'a';\n  response.headers.set('x-a', _locals);",
    id: 'no-handed-locals-_locals-declared',
  },
  {
    after: "  const _locals = 'a';\n  const _response = 'b';",
    id: 'both-names-declared-by-the-source',
  },
  {
    after: "  const _locals = params.projectId;\n  response.headers.set('x-a', _locals);",
    id: 'handed-context-name-and-_locals-declared',
  },
];

/** What takes no new name: the parameters keep the names the emitter has always given them. */
const KEPT: readonly Row[] = [
  { after: "  response.headers.set('x-a', 'a');", id: 'response-read' },
  {
    after: "  const note = 'a';\n  response.headers.set('x-a', note);",
    id: 'a-constant-of-its-own',
  },
  { after: '  const locals = 1;', id: 'locals-declared-no-handed-locals' },
];

/** The names the parameters of the envelope's `after` and the declarations of its body bind. */
function bindings(
  text: string,
  api: API,
): { readonly parameters: readonly string[]; readonly declared: readonly string[] } {
  using file = parseModule(api, 'envelope.ts', text);
  const found = file.sourceFile.statements.find(
    (statement) => isFunctionDeclaration(statement) && statement.name?.text === 'after',
  );
  if (found === undefined || !isFunctionDeclaration(found) || found.body === undefined) {
    throw new Error('The envelope has no function `after`.');
  }
  return {
    declared: found.body.statements
      .filter((statement) => isVariableStatement(statement))
      .flatMap((statement) => {
        return statement.declarationList.declarations.flatMap((declaration) =>
          bindingIdentifiers(declaration.name).map((each) => each.text),
        );
      }),
    parameters: found.parameters.flatMap((parameter) =>
      isIdentifier(parameter.name) ? [parameter.name.text] : [],
    ),
  };
}

describe('the names of the envelope’s part after next', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /** The envelope module `emitEnvelope` writes of the middleware. */
  async function emitted(row: Row): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-envelope-names-'));
    roots.push(root);
    const src = path.join(root, 'src');
    const directory = path.join(src, 'app', 'boards', '[projectId]');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    const file = path.join(directory, 'middleware.ts');
    await writeFile(
      file,
      `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params }, next) => {\n${row.before ?? ''}\n  const response = await next();\n${row.after}\n  return response;\n}) satisfies RouteMiddleware<{ projectId: string }>;\n`,
    );
    using modules = new Modules(api, src);
    return emitEnvelope(readMiddleware({ file, id: 'boards/[projectId]', modules }));
  }

  it.each(TAKEN)('names a parameter the middleware does not declare: $id', async (row) => {
    const { declared, parameters } = bindings(await emitted(row), api);

    expect(parameters).toHaveLength(2);
    expect(parameters.filter((each) => declared.includes(each))).toStrictEqual([]);
    expect(new Set(parameters).size).toBe(2);
  });

  it.each(KEPT)('keeps the names it has always given: $id', async (row) => {
    const text = await emitted(row);
    const { parameters } = bindings(text, api);
    const read = row.after.includes('response.headers');

    expect(parameters[1]).toBe(read ? 'response' : '_response');
    expect(parameters[0]).toBe('_locals');
  });
});
