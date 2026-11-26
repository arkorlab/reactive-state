import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import { untrackedIn } from '../src/compiler/reach.ts';
import { parseModule } from '../src/compiler/typescript.ts';
import type { RouteRegistration } from '../src/routing.ts';
import {
  application,
  type Application,
  compiledApp,
  output,
  removed,
  source,
} from './fixtures/application.ts';

const BOARD = 'app/boards/[projectId]/page.tsx';
const LAYOUT = 'app/boards/layout.tsx';

/** A layout whose rendering reads the value of `shown`, declared by `code`. */
function layoutOf(code: string): string {
  return [
    "import type { ReactNode } from 'react';",
    code,
    'export default async function Layout({ children }: { children: ReactNode }) {',
    '  return <section data-shown={await shown()}>{children}</section>;',
    '}',
  ].join('\n');
}

describe('untracked inputs in route rendering', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps) {
      await removed(app);
    }
  });

  /** The board's admission and reason, after compiling the route's changed sources. */
  async function boardWith(
    files: Readonly<Record<string, string>>,
  ): Promise<RouteRegistration | undefined> {
    const app = await application(files);
    apps.push(app);
    const compiled = compiledApp(app, api);

    expect(compiled.refusals).toStrictEqual([]);

    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      readonly routes: readonly RouteRegistration[];
    };
    return manifest.routes.find((route) => route.route === '/boards/[projectId]');
  }

  it('shares no page whose imported code reads bare CacheStorage', async () => {
    const page = `import '@/cached-page';\n${await source(BOARD)}`;
    const helper = "export const hit = caches.match('https://cms.test/banner');";

    await expect(boardWith({ [BOARD]: page, 'cached-page.ts': helper })).resolves.toMatchObject({
      private: '`app/boards/[projectId]/page.tsx` reads `caches`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no layout that reads bare CacheStorage', async () => {
    const layout = layoutOf(
      'const shown = async (): Promise<string> => (await caches.keys()).join();',
    );

    await expect(boardWith({ [LAYOUT]: layout })).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `caches`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no layout whose helper receives bare CacheStorage', async () => {
    const layout = layoutOf("import { shown } from '@/cached-banner';");
    const helper = [
      'const storage = caches;',
      "export const shown = async (): Promise<string> => (await storage.match('https://cms.test/banner'))?.statusText ?? '';",
    ].join('\n');

    await expect(
      boardWith({ [LAYOUT]: layout, 'cached-banner.ts': helper }),
    ).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `caches`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no layout whose helper reads the stack of an aliased error type', async () => {
    const layout = layoutOf("import { shown } from '@/traced-banner';");
    const helper = [
      'type Wrapped = Error;',
      "function stackOf(error: Wrapped): string { return error.stack ?? ''; }",
      "export const shown = async (): Promise<string> => stackOf(new Error('banner'));",
    ].join('\n');

    await expect(
      boardWith({ [LAYOUT]: layout, 'traced-banner.ts': helper }),
    ).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `stack`, an input nothing tracks',
      shared: false,
    });
  });

  it.each([
    'type Wrapped<T> = T extends unknown ? T : never; type Failure = Wrapped<Error>;',
    'class Failure extends Error {}',
    'declare namespace Types { type Failure = Error; } type Failure = Types.Failure;',
  ])('shares no rendered helper with an explicit error frame: %s', async (declaration) => {
    const layout = layoutOf("import { shown } from '@/typed-frames';");
    const helper = [
      declaration,
      "function read(error: Failure): string { return error.stack ?? ''; }",
      "export const shown = (): string => read(new Error('banner'));",
    ].join('\n');

    await expect(boardWith({ [LAYOUT]: layout, 'typed-frames.ts': helper })).resolves.toMatchObject(
      {
        private: '`app/boards/layout.tsx` reads `stack`, an input nothing tracks',
        shared: false,
      },
    );
  });

  it.each([
    'interface Failure extends Error {}',
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; type Failure = Select<(value: string | undefined) => void>;',
    'type Value<T> = T extends (value: { nested: infer V }) => unknown ? V : never; type Failure = Value<(value: { nested: Error } | { nested: TypeError }) => void>;',
    'type Result<T> = T extends () => infer R ? R : never; type Failure = Result<() => Error>;',
    'type Result<T> = T extends (...args: never[]) => infer R ? R : never; type Failure = Result<() => Error>;',
    'type Value<T> = T extends { [key: string]: infer V } ? V : never; type Failure = Value<{ [key: string]: Error }>;',
    'type Value<T> = T extends { [key: number]: infer V } ? V : never; type Failure = Value<{ [key: number]: Error }>;',
    'type Value<T> = T extends { [key: string]: infer V } ? V : never; type Failure = Value<{ [key: string]: Promise<Error> }> extends Promise<infer V> ? V : never;',
    'type Result<T> = T extends (value?: string) => infer R ? R : { stack: string }; type Failure = Result<(value: string | undefined) => Error>;',
    'type Value<T> = T extends (value: { nested: infer V }) => unknown ? V : never; type Failure = Value<(value: { nested: Error }) => void>;',
  ])('r8 declared error frames keep the rendered route private: %s', async (declaration) => {
    const code = [
      declaration,
      'function frames(error: Failure): string { return error.stack ?? ""; }',
      'export function shown(): string { return frames(new Error("banner")); }',
    ].join('\n');

    await expect(boardWith({ [LAYOUT]: layoutOf(code) })).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `stack`, an input nothing tracks',
      shared: false,
    });
  });

  it.each([
    'interface Data { stack: string } interface Failure extends Data {}',
    'type Select<T> = T extends (value?: string) => unknown ? { stack: string } : Error; type Failure = Select<(value: string | undefined) => void>;',
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; type Failure = Select<(value: void) => void>;',
    'type Result<T> = T extends () => infer R ? R : never; type Failure = Result<() => { stack: string }>;',
    'type Result<T> = T extends (...args: never[]) => infer R ? R : never; type Failure = Result<() => { stack: string }>;',
    'type Value<T> = T extends { [key: string]: infer V } ? V : never; type Failure = Value<{ [key: string]: { stack: string } }>;',
    'type Value<T> = T extends { [key: number]: infer V } ? V : never; type Failure = Value<{ [key: number]: { stack: string } }>;',
    'type Value<T> = T extends { [key: string]: infer V } ? V : never; type Failure = Value<{ [key: string]: Promise<{ stack: string }> }> extends Promise<infer V> ? V : never;',
    'type Result<T> = T extends (value?: string) => infer R ? R : { stack: string }; type Failure = Result<(value: string | undefined) => { stack: string }>;',
    'type Value<T> = T extends (value: { nested: infer V }) => unknown ? V : never; type Failure = Value<(value: { nested: { stack: string } }) => void>;',
  ])('r8 declared stack data keeps the rendered route shared: %s', async (declaration) => {
    const code = [
      declaration,
      'function frames(error: Failure): string { return error.stack; }',
      'export function shown(): string { return frames({ stack: "banner" }); }',
    ].join('\n');

    await expect(boardWith({ [LAYOUT]: layoutOf(code) })).resolves.toMatchObject({ shared: true });
  });

  it('shares a layout whose caches and stack are application data', async () => {
    const layout = layoutOf(
      [
        'type Wrapped = { readonly stack: string };',
        "const caches = { match: async (): Promise<Wrapped> => ({ stack: 'banner' }) };",
        'const shown = async (): Promise<string> => (await caches.match()).stack;',
      ].join('\n'),
    );

    await expect(boardWith({ [LAYOUT]: layout })).resolves.toMatchObject({ shared: true });
  });

  it.each([
    'type Wrapped = Error; function read(error: Wrapped) { return error.stack; }',
    'type Base = TypeError; type Wrapped = (Base | null); function read(error: Wrapped) { return error?.["stack"]; }',
    'type Wrapped = Error; function read(value: unknown) { const error: Wrapped = value as Wrapped; return error.stack; }',
    'function read(error: Error) { type Wrapped = Error; const wrapped: Wrapped = error; return wrapped.stack; }',
    'namespace Model { export type Wrapped = Error; export function read(error: Wrapped) { return error.stack; } }',
  ])('recognizes a declared error through aliases in route rendering: %s', (code) => {
    using parsed = parseModule(api, 'error-alias.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBe('stack');
  });

  it.each([
    'type Maybe<T> = T | undefined; function read(error: Maybe<Error>) { return error?.stack; }',
    'type Identity<T> = T; type Maybe<T> = Identity<T> | undefined; function read(error: Maybe<Identity<TypeError>>) { return error?.stack; }',
    'type Wrapped<T = Error> = T; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T, U = T> = U; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T & { tag?: string }; function read(error: Wrapped<Error>) { return error.stack; }',
    'class Holder { [(() => { type Wrapped = Error; const read = (error: Wrapped) => error.stack; return read(new Error()) ?? "x"; })()]<Error>() {} }',
  ])('recognizes generic error aliases and computed-name scopes: %s', (code) => {
    using parsed = parseModule(api, 'generic-error-stack.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBe('stack');
  });

  it.each([
    'type Wrapped<T> = T extends unknown ? T : never; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends string ? { stack: string } : Error; function read(error: Wrapped<number>) { return error.stack; }',
    'class Failure extends Error {} type Wrapped = Failure; function read(error: Wrapped) { return error.stack; }',
    'class Failure extends Error {} type Wrapped = Failure; function other(Error: unknown) { return Error; } function read(error: Wrapped) { return error.stack; }',
    'class Failure extends Error {} type Wrapped = Failure; function other(globalThis: unknown) { return globalThis; } function read(error: Wrapped) { return error.stack; }',
    'declare namespace Types { type Failure = Error; } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Failure<T> = T; } function read(error: Types.Failure<Error>) { return error.stack; }',
    'function dec(_value: unknown) { return () => {}; } class Holder { method<Error>(@dec((() => { type Wrapped = Error; const read = (error: Wrapped) => error.stack; return read(new Error()); })()) value: unknown) {} }',
  ])('recognizes conditional, class and namespace error types: %s', (code) => {
    using parsed = parseModule(api, 'nested-error-type.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBe('stack');
  });

  it.each([
    'type Wrapped<T> = T extends string ? Error : { stack: string }; function read(error: Wrapped<number>) { return error.stack; }',
    'type Wrapped<T> = T extends unknown ? T : never; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
    'type Wrapped = Error extends Error ? { stack: string } : Error; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = \'x\' extends "x" ? { stack: string } : Error; function read(error: Wrapped) { return error.stack; }',
    'class Failure { stack = "data"; } type Wrapped = Failure; function read(error: Wrapped) { return error.stack; }',
    'function outer(Error: new () => { stack: string }) { class Failure extends Error {} type Wrapped = Failure; return (error: Wrapped) => error.stack; }',
    'declare namespace Types { type Failure = { stack: string }; } function read(error: Types.Failure) { return error.stack; }',
    'import type { Types } from "./data"; function read(error: Types.Failure) { return error.stack; }',
    'function dec(_value: unknown) { return () => {}; } const Holder = class Error { @dec((() => { type Wrapped = Error; const read = (error: Wrapped) => error.stack; return read({ stack: "data" }); })()) method() {} };',
  ])('keeps conditional, class and namespace data stacks: %s', (code) => {
    using parsed = parseModule(api, 'nested-data-type.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBeUndefined();
  });

  it.each([
    'type Wrapped = Readonly<Error>; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T> = T extends string ? Wrapped<Error> : T; function read(error: Wrapped<string>) { return error.stack; }',
    "type Wrapped = { error: Error }['error']; function read(error: Wrapped) { return error.stack; }",
    'interface Failure {} class Failure extends Error {} type Wrapped = Failure; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T> = T extends infer U ? U : never; function read(error: Wrapped<Error>) { return error.stack; }',
  ])('retains errors selected by explicit type operations: %s', (code) => {
    using parsed = parseModule(api, 'selected-error-types.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBe('stack');
  });

  it.each([
    'type Wrapped = Readonly<{ stack: string }>; function read(error: Wrapped) { return error.stack; }',
    'type Readonly<T> = { stack: string }; type Wrapped = Readonly<Error>; function read(error: Wrapped) { return error.stack; }',
    "type Wrapped = { error: Error; data: { stack: string } }['data']; function read(error: Wrapped) { return error.stack; }",
    'interface Failure { stack: string } class Failure { stack = "data"; } type Wrapped = Failure; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T> = T extends infer Error ? Error : never; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
    'type Wrapped<T> = T extends string ? Wrapped<{ stack: string }> : T; function read(error: Wrapped<string>) { return error.stack; }',
  ])('keeps selected data and utility-name shadows: %s', (code) => {
    using parsed = parseModule(api, 'selected-data-types.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBeUndefined();
  });

  it.each([
    'type Wrapped<T> = T extends { value: infer U } ? U : never; function frames(error: Wrapped<{ value: Error }>): string { return error.stack ?? ""; }',
    'type Wrapped = globalThis.Error; function frames(error: Wrapped): string { return error.stack ?? ""; }',
    'function frames<T extends Error>(error: T): string { return error.stack ?? ""; }',
    'type Element<T> = T extends Array<infer U> ? U : never; function frames(error: Element<Error[]>): string { return error.stack ?? ""; }',
    'type Element<T> = T extends ReadonlyArray<infer U> ? U : never; function frames(error: Element<readonly Error[]>): string { return error.stack ?? ""; }',
    'type Unwrap<T> = T extends Promise<infer U> ? U : never; function frames(error: Unwrap<Promise<Error>>): string { return error.stack ?? ""; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function frames(error: Head<[Error]>): string { return error.stack ?? ""; }',
    'type Bag = { [key: string]: Error }; function frames(error: Bag["failure"]): string { return error.stack ?? ""; }',
  ])('shares no layout that reads an explicit transformed error: %s', async (declaration) => {
    const code = `${declaration} export function shown(): string { return frames(new Error("example")); }`;

    await expect(boardWith({ [LAYOUT]: layoutOf(code) })).resolves.toMatchObject({
      private: expect.stringContaining('reads `stack`'),
      shared: false,
    });
  });

  it.each([
    'type Wrapped<T> = T extends object ? { stack: string } : Error; function frames(error: Wrapped<string[]>): string { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer U } ? U : never; function frames(error: Wrapped<{ value: { stack: string } }>): string { return error.stack; }',
    'function frames<T extends { stack: string }>(error: T): string { return error.stack; }',
    'type Wrapped<T> = T extends boolean | Error ? { stack: string } : Error; function frames(error: Wrapped<boolean>): string { return error.stack; }',
    'type Element<T> = T extends Array<infer U> ? U : never; function frames(error: Element<{ stack: string }[]>): string { return error.stack; }',
    'type Unwrap<T> = T extends Promise<infer U> ? U : never; function frames(error: Unwrap<Promise<{ stack: string }>>): string { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function frames(error: Head<[{ stack: string }]>): string { return error.stack; }',
    'type Bag = { [key: string]: { stack: string } }; function frames(error: Bag["failure"]): string { return error.stack; }',
    'type Selected<T> = T extends number ? { stack: string } : Error; function frames(error: Selected<-1>): string { return error.stack; }',
    'type Selected<T> = T extends RangeError ? { stack: string } : Error; function frames(error: Selected<TypeError>): string { return error.stack; }',
  ])('shares a layout whose transformed stack stays data: %s', async (declaration) => {
    const code = `${declaration} export function shown(): string { return frames({ stack: "banner" }); }`;

    await expect(boardWith({ [LAYOUT]: layoutOf(code) })).resolves.toMatchObject({ shared: true });
  });

  it('keeps both branches when utility assignability is outside the syntax reader', () => {
    const code =
      'type Wrapped<T> = T extends Error ? Error : { stack: string }; function read(error: Wrapped<Partial<Error>>) { return error.stack; }';
    using parsed = parseModule(api, 'unresolved-utility-condition.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBe('stack');
  });

  it.each([
    'type Error = { stack: string };',
    'interface Error { stack: string }',
    'class Error { stack = "data"; }',
  ])('keeps aliased data stacks in a switch scope: %s', (declaration) => {
    const code = `function read(value: unknown) { switch (value) { case "data": ${declaration} type Wrapped = Error; const shown = (error: Wrapped) => error.stack; return shown({ stack: "data" }); default: return ""; } }`;
    using parsed = parseModule(api, 'switch-data-stack.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBeUndefined();
  });

  it.each([
    'type Wrapped<T> = { stack: string }; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Identity<T> = T; type Maybe<T> = Identity<T> | undefined; function read(error: Maybe<{ stack: string }>) { return error?.stack; }',
    'type Maybe<T = { stack: string }> = T | undefined; function read(error: Maybe) { return error?.stack; }',
    'type Wrapped<Error> = Error; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
    'type Identity<T> = T; function read<Error extends { stack: string }>(error: Identity<Error>) { return error.stack; }',
  ])('keeps generic data stacks outside declared errors: %s', (code) => {
    using parsed = parseModule(api, 'generic-data-stack.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBeUndefined();
  });

  it.each([
    'import type { Error } from "./data";',
    'import { type Error } from "./data";',
    'import type { RecordError as Error } from "./data";',
    'import { RecordError as Error } from "./data";',
    'import type Error from "./data";',
    'import Error from "./data";',
  ])('keeps data behind an imported error type name: %s', (imported) => {
    const code = `${imported} type Wrapped = Error; function read(error: Wrapped) { return error.stack; }`;
    using parsed = parseModule(api, 'imported-data-stack.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBeUndefined();
  });

  it.each([
    'import type { Error as RecordError } from "./data";',
    'import type RecordError from "./data";',
  ])('still recognizes global Error beside unrelated imported types: %s', (imported) => {
    const code = `${imported} type Wrapped = Error; function read(error: Wrapped) { return error.stack; }`;
    using parsed = parseModule(api, 'global-error-stack.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBe('stack');
  });

  it('shares a layout whose imported error type names an application data stack', async () => {
    const layout = layoutOf("import { shown } from '@/data-banner';");
    const helper = [
      "import type { RecordError as Error } from '@/data';",
      'type Wrapped = Error;',
      'export function shown(): string { const data: Wrapped = { stack: "banner" }; return data.stack; }',
    ].join('\n');

    await expect(
      boardWith({
        [LAYOUT]: layout,
        'data-banner.ts': helper,
        'data.ts': 'export interface RecordError { readonly stack: string }',
      }),
    ).resolves.toMatchObject({ shared: true });
  });

  it.each([
    'type Wrapped = { readonly stack: string }; function read(error: Wrapped) { return error.stack; }',
    'interface Error { readonly stack: string } type Wrapped = Error; function read(error: Wrapped) { return error.stack; }',
    'class Error { stack = "data" } type Wrapped = Error; function read(error: Wrapped) { return error.stack; }',
    'const Data = class Error { stack = "data"; read() { type Wrapped = Error; const self: Wrapped = this; return self.stack; } };',
    'namespace Model { export type Error = { stack: string }; export type Wrapped = Error; export function read(error: Wrapped) { return error.stack; } }',
    'type Wrapped = Error; function read() { type Wrapped = { readonly stack: string }; function inner(error: Wrapped) { return error.stack; } return inner({ stack: "data" }); }',
    'type Wrapped = Error; function read<Wrapped extends { stack: string }>(error: Wrapped) { return error.stack; }',
    'type Left = Right; type Right = Left; function read(error: Left) { return error.stack; }',
  ])('keeps stack fields outside declared errors and terminates alias cycles: %s', (code) => {
    using parsed = parseModule(api, 'data-stack.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBeUndefined();
  });
});
