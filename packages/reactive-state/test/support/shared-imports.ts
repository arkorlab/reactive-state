import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isImportDeclaration } from 'typescript/ast';

import { failIn, ReactiveCompileError } from '../../src/compiler/errors.ts';
import { readImports } from '../../src/compiler/imports.ts';
import { checkSharedImports } from '../../src/compiler/middleware-shared-imports.ts';
import { Modules } from '../../src/compiler/modules.ts';
import { openTypeScript } from '../../src/compiler/typescript.ts';

/**
 * What the check that no module is read by both parts of a split middleware says of an application:
 * its files — the middleware's, the modules it imports, the packages in `node_modules` — written to
 * a directory of their own, and the names the guard and the envelope read of the middleware's imports.
 */

const dirs: string[] = [];

/** Removes the applications the checks made: called when each test ends. */
export function cleanUp(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** The application: files by path, with the middleware's source and the names each part reads. */
export interface Application {
  readonly files: Readonly<Record<string, string>>;
  readonly middleware: string;
  readonly guard: readonly string[];
  readonly envelope: readonly string[];
}

/** Why the check refuses the application, or `taken`. */
export function checkOf({ envelope, files, guard, middleware }: Application): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-shared-imports-'));
  dirs.push(dir);
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
  );
  const written = Object.entries({ ...files, 'middleware.ts': middleware });
  for (const [name, text] of written) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  const file = path.join(dir, 'middleware.ts');
  using api = openTypeScript();
  using modules = new Modules(api, dir);
  const parsed = modules.parse(file, true);
  const fail = failIn(parsed.sourceFile, parsed.name);
  try {
    const { modules: imported } = readImports(
      parsed.sourceFile.statements.filter((statement) => isImportDeclaration(statement)),
      parsed.sourceFile,
      (specifier) => modules.targetOf(specifier, file),
      fail,
    );
    const bindings = imported.flatMap((module) => module.bindings);
    checkSharedImports(
      {
        after: { values: new Set(envelope) },
        before: undefined,
        guard: { values: new Set(guard) },
      },
      {
        fail,
        imports: new Map(bindings.map((binding) => [binding.name.text, binding])),
        sourceFile: parsed.sourceFile,
      } as never,
      modules,
    );
    return 'taken';
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      return error.reason;
    }
    throw error;
  }
}
