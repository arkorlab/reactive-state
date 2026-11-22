import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const load = createRequire(import.meta.url);

const instantLoader = load('../src/next/loader-instant.cjs') as (source: string) => string;

/** The parser the loader reads a page with, which refuses a name declared or exported twice. */
const { parse } = load('next/dist/compiled/babel/parser') as {
  readonly parse: (
    source: string,
    options: { readonly plugins: readonly string[]; readonly sourceType: 'module' },
  ) => unknown;
};

/** Whether `source` is a module: one that declares no name twice, and exports none twice. */
function isModule(source: string): boolean {
  try {
    parse(source, { plugins: ['typescript', 'jsx'], sourceType: 'module' });
    return true;
  } catch {
    try {
      parse(source, { plugins: ['typescript'], sourceType: 'module' });
      return true;
    } catch {
      return false;
    }
  }
}

/** The permission, as a module that names nothing `instant` is given it. */
const PERMISSION = '\nexport const instant = false;\n';

/** The permission, as a module that names something `instant` is given it: under `local`. */
function permissionAs(local: string): string {
  return `\nconst ${local} = false;\nexport { ${local} as instant };\n`;
}

/** Only actual module value exports suppress the blocking page permission. */
const CASES = [
  {
    id: 'reported-jsx-export-text',
    source:
      'export default async function Page({params}:{params:Promise<{id:string}>}){const{id}=await params;return <p>export const instant = true{id}</p>;}\n',
    unchanged: false,
  },
  {
    id: 'multiline-jsx-export-text',
    source: 'export default()=> <p>export\nconst\ninstant = true</p>;\n',
    unchanged: false,
  },
  {
    id: 'nested-jsx-export-text',
    source: 'export default()=> <section><p>export const instant = true</p></section>;\n',
    unchanged: false,
  },
  {
    id: 'same-line-jsx-quote-real-export',
    source:
      "const note=<p>Don't</p>;export const instant=true;\nexport default async function Page(){return null;}\n",
    unchanged: true,
  },
  {
    id: 'jsx-expression-string',
    source: "export default()=> <p>{'export const instant = true'}</p>;\n",
    unchanged: false,
  },
  {
    id: 'jsx-attribute-string',
    source: 'export default()=> <p title="export const instant = true">fixed</p>;\n',
    unchanged: false,
  },
  {
    id: 'ordinary-string',
    source:
      "const note='export const instant = true';\nexport default async function Page(){return null;}\n",
    unchanged: false,
  },
  {
    id: 'block-comment',
    source:
      '/*export const instant = true;*/\nexport default async function Page(){return null;}\n',
    unchanged: false,
  },
  {
    id: 'regular-expression',
    source:
      'const note=/export const instant = true/u;\nexport default async function Page(){return null;}\n',
    unchanged: false,
  },
  {
    id: 'template-text',
    source:
      'const note=`export const instant = true`;\nexport default async function Page(){return null;}\n',
    unchanged: false,
  },
  {
    id: 'real-typed-const',
    source:
      'export const instant:boolean=true;\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
  {
    id: 'real-value-export-alias',
    source:
      'const blocked=false;export {blocked as instant};\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
  {
    id: 'real-let-export',
    source: 'export let instant=false;\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
  {
    id: 'real-following-declarator',
    source:
      'export const other=1,instant=true;\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
  {
    id: 'typescript-angle-assertion',
    source:
      'const value=<boolean>true;export const instant=value;\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
] as const;

describe('blocking page instant module exports', () => {
  it.each(CASES)('$id', ({ source, unchanged }) => {
    const expected = unchanged ? source : `${source}${PERMISSION}`;

    expect(instantLoader(source)).toBe(expected);
    expect(isModule(expected)).toBe(true);
  });
});

const PAGE = 'export default async function Page(){return null;}\n';

/** A page that opens with `statements`. */
function page(statements: string): string {
  return `${statements}\n${PAGE}`;
}

/**
 * A value export of the name in each other form a module has: Next.js reads the setting off the
 * module's exports as it runs, so each is the page's own, and a second export of the name would be
 * no module.
 */
const OWN = [
  { id: 'destructured', source: page('export const {instant}={instant:true};') },
  { id: 'destructured-renamed', source: page('export const {blocks:instant}={blocks:true};') },
  {
    id: 'destructured-nested',
    source: page('export const {segment:{instant}}={segment:{instant:true}};'),
  },
  { id: 'destructured-default', source: page('export const {instant=true}={};') },
  {
    id: 'destructured-rest',
    source: page('export const {level,...instant}={level:1,on:true};'),
  },
  { id: 'list', source: page('export const [instant]=[true];') },
  { id: 'list-nested', source: page('export const [,[instant]]=[0,[true]];') },
  { id: 'list-rest', source: page('export const [first,...instant]=[0,true];') },
  {
    id: 'list-pattern-default',
    source: page('export const [{instant}={instant:true}]=[];'),
  },
  { id: 'following-pattern', source: page('export const other=1,{instant}={instant:true};') },
  { id: 'function', source: page('export function instant(){}') },
  { id: 'class', source: page('export class instant{}') },
  { id: 'enum', source: page('export enum instant{on}') },
  { id: 'namespace', source: page('export namespace instant{export const on=true;}') },
  {
    id: 'import-alias',
    source: page('namespace segment{export const on=true;}export import instant=segment.on;'),
  },
  // Read as an export of the name before: kept as they were.
  { id: 'module-as-the-name', source: page("export * as instant from './segment';") },
  { id: 'from-another-module', source: page("export {instant} from './segment';") },
  { id: 'named-by-text', source: page("const blocks=false;export {blocks as 'instant'};") },
] as const;

describe('a page’s own instant export, in each form a module has', () => {
  it.each(OWN)('$id', ({ source }) => {
    expect(isModule(source)).toBe(true);
    expect(instantLoader(source)).toBe(source);
  });
});

/**
 * An export of the name in a form TypeScript erases some of, where it leaves a value as the module
 * runs: the page's own setting still, and nothing is added. A list that exports an ambient value
 * is kept by the compiler, and so is counted with them: a second export of the name would be no
 * module.
 */
const VALUES = [
  {
    id: 'namespace-of-a-namespace-of-a-value',
    source: page('export namespace instant{export namespace inner{export const on=true;}}'),
  },
  {
    id: 'dotted-namespace-of-a-value',
    source: page('export namespace instant.inner{export const on=true;}'),
  },
  { id: 'namespace-of-a-statement', source: page('export namespace instant{console.log(1);}') },
  { id: 'namespace-of-a-function', source: page('export namespace instant{function on(){}}') },
  { id: 'namespace-of-an-enum', source: page('export namespace instant{export enum E{on}}') },
  {
    id: 'namespace-of-a-const-enum',
    source: page('export namespace instant{export const enum E{on}}'),
  },
  {
    id: 'namespace-of-a-declared-constant',
    source: page('export namespace instant{declare const on:boolean;}'),
  },
  {
    id: 'namespace-of-an-import-alias',
    source: page(
      'namespace other{export const on=true;}export namespace instant{import on=other.on;}',
    ),
  },
  {
    id: 'namespace-of-a-declared-one-of-a-value',
    source: page('export namespace instant{declare namespace inner{const on:boolean;}}'),
  },
  {
    id: 'namespace-in-two-blocks',
    source: page(
      'export namespace instant{export type T=1;}export namespace instant{export const on=true;}',
    ),
  },
  { id: 'const-enum', source: page('export const enum instant{on}') },
  { id: 'abstract-class', source: page('export abstract class instant{}') },
  // Whether what an alias names is a type cannot be told where another module declares it.
  {
    id: 'import-alias-of-a-type',
    source: page('namespace segment{export type T=1;}export import instant=segment.T;'),
  },
  {
    id: 'list-of-a-value-import',
    source: page("import {instant} from './segment';export {instant};"),
  },
  {
    id: 'list-of-a-type-and-a-constant',
    source: page('type instant=boolean;const instant=true;export {instant};'),
  },
  {
    id: 'list-of-an-interface-and-a-class',
    source: page('interface instant{on:boolean}class instant{}export {instant};'),
  },
  {
    id: 'list-of-a-declared-constant',
    source: page('declare const instant:boolean;export {instant};'),
  },
  {
    id: 'list-of-a-declared-function',
    source: page('declare function instant():void;export {instant};'),
  },
  { id: 'list-of-a-declared-class', source: page('declare class instant{}export {instant};') },
  { id: 'list-of-a-declared-enum', source: page('declare enum instant{on}export {instant};') },
  {
    id: 'list-of-a-declared-namespace-of-a-value',
    source: page('declare namespace instant{const on:boolean;}export {instant};'),
  },
  {
    id: 'list-of-a-type-and-a-declared-constant',
    source: page('type instant=boolean;declare const instant:boolean;export {instant};'),
  },
] as const;

describe('an export of the name that leaves a value as the module runs', () => {
  it.each(VALUES)('$id', ({ source }) => {
    expect(instantLoader(source)).toBe(source);
  });
});

/**
 * An export of the name TypeScript erases: nothing of it is there as the module runs, so it is no
 * setting of the page's, and the permission is added — as a constant of another name where the
 * module names something `instant`, which each of these does but the one that names it by text.
 */
const ERASED = [
  { id: 'type-alias', source: page('export type instant=boolean;') },
  { id: 'interface', source: page('export interface instant{on:boolean}') },
  { id: 'declared-function', source: page('export declare function instant():void;') },
  { id: 'declared-class', source: page('export declare class instant{}') },
  { id: 'declared-enum', source: page('export declare enum instant{on}') },
  {
    id: 'declared-namespace',
    source: page('export declare namespace instant{const on:boolean;}'),
  },
  { id: 'signature-alone', source: page('export function instant():void;') },
  { id: 'type-import-alias', source: page("export import type instant=require('./segment');") },
  { id: 'type-list-from-a-module', source: page("export type {instant} from './segment';") },
  { id: 'type-module-as-the-name', source: page("export type * as instant from './segment';") },
  { id: 'empty-namespace', source: page('export namespace instant{}') },
  {
    id: 'namespace-of-a-type',
    source: page('export namespace instant{export type Options={enabled:boolean};}'),
  },
  {
    id: 'namespace-of-an-interface',
    source: page('export namespace instant{export interface Options{enabled:boolean}}'),
  },
  {
    id: 'namespace-of-an-unexported-type',
    source: page('export namespace instant{type Options=boolean;}'),
  },
  {
    id: 'namespace-of-a-namespace-of-types',
    source: page('export namespace instant{export namespace inner{export type T=1;}}'),
  },
  {
    id: 'dotted-namespace-of-types',
    source: page('export namespace instant.inner{export type T=1;}'),
  },
  {
    id: 'namespace-of-an-empty-namespace',
    source: page('export namespace instant{namespace inner{}}'),
  },
  {
    id: 'namespace-of-a-declared-one-of-types',
    source: page('export namespace instant{declare namespace inner{type T=1;}}'),
  },
  {
    id: 'namespace-beside-an-interface',
    source: page('export interface instant{on:boolean}export namespace instant{export type T=1;}'),
  },
  { id: 'list-of-a-type', source: page('type instant=boolean;export {instant};') },
  { id: 'list-of-an-interface', source: page('interface instant{on:boolean}export {instant};') },
  { id: 'list-of-a-renamed-type', source: page('type Blocks=boolean;export {Blocks as instant};') },
  {
    id: 'list-of-a-type-import',
    source: page("import type {instant} from './segment';export {instant};"),
  },
  {
    id: 'list-of-an-inline-type-import',
    source: page("import {type instant} from './segment';export {instant};"),
  },
  {
    id: 'list-of-a-default-type-import',
    source: page("import type instant from './segment';export {instant};"),
  },
  {
    id: 'list-of-a-module-type-import',
    source: page("import type * as instant from './segment';export {instant};"),
  },
  {
    id: 'list-of-a-type-import-alias',
    source: page("import type instant=require('./segment');export {instant};"),
  },
  {
    id: 'list-of-a-namespace-of-types',
    source: page('namespace instant{export type T=1;}export {instant};'),
  },
  {
    id: 'list-of-a-declared-namespace-of-types',
    source: page('declare namespace instant{type T=1;}export {instant};'),
  },
  // The compiler reads a module's own statements for what a list exports: a `var` in a block is
  // none of them, and the list is erased with the type.
  {
    id: 'list-of-a-type-and-a-var-in-a-block',
    source: page('type instant=boolean;if(globalThis.on){var instant=1;}export {instant};'),
  },
] as const;

describe('an export of the name that TypeScript erases', () => {
  it.each(ERASED)('$id', ({ source }) => {
    expect(instantLoader(source)).toBe(`${source}${permissionAs('instant$1')}`);
  });

  it('adds the constant itself where the erased export names it by text alone', () => {
    const source = page("type Blocks=boolean;export {Blocks as 'instant'};");

    expect(instantLoader(source)).toBe(`${source}${PERMISSION}`);
  });
});

/**
 * A module that names something `instant` and exports no value by the name: a second declaration
 * of the name would be no module, so the permission is a constant of another name, exported as
 * `instant`. Whatever is named so, a type and a property too: the rule reads no scopes.
 */
const NAMED = [
  { id: 'constant', source: page('const instant=true;') },
  { id: 'let', source: page('let instant=true;') },
  { id: 'var-in-a-block', source: page('if(process.env.MODE){var instant=1;}') },
  { id: 'destructured-constant', source: page('const {instant}={instant:true};') },
  { id: 'function', source: page('function instant(){}') },
  { id: 'class', source: page('class instant{}') },
  { id: 'enum', source: page('enum instant{on}') },
  { id: 'default-function', source: 'export default async function instant(){return null;}\n' },
  { id: 'default-import', source: page("import instant from './search';") },
  { id: 'named-import', source: page("import {instant} from './search';") },
  { id: 'renamed-import', source: page("import {search as instant} from './search';") },
  { id: 'namespace-import', source: page("import * as instant from './search';") },
  { id: 'exported-by-another-name', source: page('const instant=1;export {instant as other};') },
  { id: 'exported-default', source: 'const instant=()=>null;export default instant;\n' },
  { id: 'pattern-key-alone', source: page('export const {instant:blocks}={instant:true};') },
  { id: 'ambient-constant', source: page('declare const instant:boolean;') },
  { id: 'exported-ambient-constant', source: page('export declare const instant:boolean;') },
  { id: 'inline-type-only-export', source: page('type instant=boolean;export {type instant};') },
  { id: 'whole-type-only-export', source: page('type instant=boolean;export type {instant};') },
  { id: 'type-import', source: page("import type {instant} from './search';") },
  { id: 'property', source: page('const options={instant:true};') },
  {
    id: 'unexported-import-alias',
    source: page('namespace segment{export const on=true;}import instant=segment.on;'),
  },
  // JSX's braces hold code: an assertion, to a type of the name.
  {
    id: 'jsx-export-list-text',
    source: 'export default()=> <p>export { blocking as instant }</p>;\n',
  },
  {
    id: 'local-of-a-function',
    source: 'export default function Page(){const instant=1;return instant;}\n',
  },
] as const;

describe('a blocking page that names something instant', () => {
  it.each(NAMED)('$id', ({ source }) => {
    const expected = `${source}${permissionAs('instant$1')}`;

    expect(instantLoader(source)).toBe(expected);
    expect(isModule(expected)).toBe(true);
  });

  it.each([
    {
      id: 'the-next-name-taken',
      local: 'instant$2',
      source: page('const instant=1,instant$1=2;'),
    },
    {
      id: 'two-names-taken',
      local: 'instant$3',
      source: page("import instant,{instant$2} from './search';const at=instant.instant$1;"),
    },
  ])('$id', ({ local, source }) => {
    const expected = `${source}${permissionAs(local)}`;

    expect(instantLoader(source)).toBe(expected);
    expect(isModule(expected)).toBe(true);
  });
});

describe('a blocking page’s module, as Node runs what the loader made of it', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  /** What the module the loader makes of `source` exports, run as it is. */
  function exportsOf(source: string): Readonly<Record<string, unknown>> {
    const directory = mkdtempSync(path.join(tmpdir(), 'reactive-state-instant-'));
    directories.push(directory);
    const file = path.join(directory, 'page.mjs');
    writeFileSync(file, instantLoader(source));
    return { ...(load(file) as Readonly<Record<string, unknown>>) };
  }

  it.each([
    {
      exported: { instant: false, kept: true },
      id: 'constant-kept',
      source: 'const instant = true;\nexport const kept = instant;\n',
    },
    {
      exported: { instant: false, made: 'made' },
      id: 'function-kept',
      source: "function instant() {\n  return 'made';\n}\nexport const made = instant();\n",
    },
    {
      exported: { instant: false, other: 1 },
      id: 'var-in-a-block-kept',
      source: 'if (true) {\n  var instant = 1;\n}\nexport { instant as other };\n',
    },
    {
      exported: { instant: true },
      id: 'destructured-own',
      source: 'export const { instant } = { instant: true };\n',
    },
    { exported: { instant: false }, id: 'nothing-named', source: 'export {};\n' },
  ])('$id', ({ exported, source }) => {
    expect(exportsOf(source)).toStrictEqual(exported);
  });
});
