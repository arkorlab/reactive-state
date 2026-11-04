import path from 'node:path';

import {
  API,
  DiagnosticCategory,
  JsxEmit,
  type RetainedSourceFile,
  ScriptKind,
} from 'typescript/sync';

import { ReactiveCompileError } from './errors.ts';

/**
 * TypeScript 7's compiler, through the API 7.1 publishes: `typescript/sync` starts the native
 * compiler as a child process and speaks to it over pipes, and `typescript/ast` reads the syntax
 * trees it hands back. One `API` serves any number of compiles; it holds a process until it is
 * disposed, so whoever opens one disposes of it (`using`).
 */
export function openTypeScript(cwd: string = process.cwd()): API {
  return new API({ cwd });
}

/** A diagnostic's category is a number on the wire; `DiagnosticCategory` is the enum it names. */
const ERROR: number = DiagnosticCategory.Error;

/** How a module's file is parsed, by its extension. */
const KINDS: ReadonlyMap<string, ScriptKind> = new Map([
  ['.cjs', ScriptKind.JS],
  ['.cts', ScriptKind.TS],
  ['.js', ScriptKind.JS],
  ['.jsx', ScriptKind.JSX],
  ['.mjs', ScriptKind.JS],
  ['.mts', ScriptKind.TS],
  ['.ts', ScriptKind.TS],
  ['.tsx', ScriptKind.TSX],
]);

/** Whether a file is one the compile can parse: TypeScript or JavaScript, with or without JSX. */
export function isScript(file: string): boolean {
  return KINDS.has(path.extname(file));
}

/**
 * Parses a module of the application's: `fileName` names it, and its extension says how it is
 * parsed. The source file is held by the compiler process until the lease returned is disposed.
 */
export function parseModule(api: API, fileName: string, source: string): RetainedSourceFile {
  const kind = KINDS.get(path.extname(fileName)) ?? ScriptKind.TSX;
  return api.createSourceFile(fileName, source, { scriptKind: kind });
}

/**
 * Refuses a module whose code the compile writes again — a component, a custom hook — where it does
 * not parse, with TypeScript's own words for the error: `transpileModule` reports what the parser
 * found, which the source file alone does not say. `name` is the module as what is refused names
 * it. A module the compile only classifies is read as it parses; the application's own build
 * reports its errors.
 */
export function checkSyntax(api: API, fileName: string, source: string, name: string): void {
  const parsed = api.transpileModule(source, {
    compilerOptions: { jsx: JsxEmit.Preserve },
    fileName,
    reportDiagnostics: true,
  });
  const error = parsed.diagnostics?.find((diagnostic) => diagnostic.category === ERROR);
  if (error !== undefined) {
    throw new ReactiveCompileError(error.text, {
      fileName: name,
      position: error.startPosition ?? { character: 0, line: 0 },
    });
  }
}
