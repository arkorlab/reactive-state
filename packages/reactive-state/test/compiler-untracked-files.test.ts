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
} from './fixtures/application.ts';

/** A File made without a defined timestamp takes the clock, even through an imported route helper. */
const LAYOUT = 'app/boards/layout.tsx';

function layoutOf(code: string): string {
  return [
    "import type { ReactNode } from 'react';",
    code,
    'export default function Layout({ children }: { children: ReactNode }) {',
    '  return <section data-stamp={shown()}>{children}</section>;',
    '}',
  ].join('\n');
}

describe('file timestamps in shared route admission', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps) await removed(app);
  });

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

  it.each([
    "new File([], 'banner').lastModified",
    "new File([], 'banner', { lastModified: undefined }).lastModified",
  ])('shares no layout that reads its default File timestamp: %s', async (read) => {
    const layout = layoutOf(`const shown = () => String(${read});`);

    await expect(boardWith({ [LAYOUT]: layout })).resolves.toMatchObject({
      shared: false,
      private: '`app/boards/layout.tsx` reads `File.lastModified`, an input nothing tracks',
    });
  });

  it('shares no layout whose reached helper supplies no File timestamp', async () => {
    const layout = layoutOf("import { shown } from '@/file-banner';");
    const helper =
      "const options = { lastModified: undefined }; export function shown() { return String(new File([], 'banner', options).lastModified); }";

    await expect(boardWith({ [LAYOUT]: layout, 'file-banner.ts': helper })).resolves.toMatchObject({
      shared: false,
      private: '`app/boards/layout.tsx` reads `File.lastModified`, an input nothing tracks',
    });
  });

  it.each([
    'const Other = 0; const Make = File; export { Other as Make };',
    'import { Make as Data } from "./file-data"; const Make = File;',
    'const Make = File; export { Make as Exposed } from "./file-data";',
    'const Make = File; export { Other as Make } from "./file-data";',
    'const Make = File; const data = { Make: 0 };',
    'const Make = File; Make: for (;;) { break Make; }',
  ])('shares fixed File constructors despite unrelated labels: %s', async (code) => {
    const helper = `${code} export function shown() { return String(new Make([], 'banner', { lastModified: 0 }).lastModified); }`;

    await expect(
      boardWith({
        [LAYOUT]: layoutOf("import { shown } from '@/file-banner';"),
        'file-banner.ts': helper,
        'file-data.ts': 'export const Make = 0; export const Other = 0;',
      }),
    ).resolves.toMatchObject({ shared: true });
  });

  it.each([
    'const Other = 0; export { Other as File };',
    'import { File as Data } from "./file-data";',
    'export { File as Exposed } from "./file-data";',
    'export { Other as File } from "./file-data";',
  ])('shares helpers whose File name is only an import or export label: %s', async (code) => {
    await expect(
      boardWith({
        [LAYOUT]: layoutOf("import { shown } from '@/file-banner';"),
        'file-banner.ts': `${code} export function shown() { return 'fixed'; }`,
        'file-data.ts': 'export const File = 0; export const Other = 0;',
      }),
    ).resolves.toMatchObject({ shared: true });
  });

  it.each([
    'const Make = File; export { Make };',
    'const Make = File; export { Make as Exposed };',
    'export const Make = File;',
  ])('shares no helper exporting its actual File constructor: %s', async (code) => {
    const helper = `${code} export function shown() { return String(new Make([], 'banner', { lastModified: 0 }).lastModified); }`;

    await expect(
      boardWith({
        [LAYOUT]: layoutOf("import { shown } from '@/file-banner';"),
        'file-banner.ts': helper,
      }),
    ).resolves.toMatchObject({
      shared: false,
      private: '`app/boards/layout.tsx` reads `File.lastModified`, an input nothing tracks',
    });
  });

  it.each([
    "function read(Make: typeof File) { return new Make([], 'banner').lastModified; } const shown = () => String(read(File));",
    "function constructorOf() { return File; } const shown = () => String(new (constructorOf())([], 'banner').lastModified);",
    "const Make = File; function read(Input: typeof Make) { return new Input([], 'banner').lastModified; } const shown = () => String(read(Make));",
  ])('shares no layout that hands its File constructor on: %s', async (code) => {
    await expect(boardWith({ [LAYOUT]: layoutOf(code) })).resolves.toMatchObject({
      shared: false,
      private: '`app/boards/layout.tsx` reads `File.lastModified`, an input nothing tracks',
    });
  });

  it.each([
    "const shown = () => String(new File([], 'banner', { lastModified: 0 }).lastModified);",
    "const Make = File; declare class Data extends Make {} const shown = () => String(new Make([], 'banner', { lastModified: 0 }).lastModified);",
    "declare class Data extends File {} const shown = () => String(new File([], 'banner', { lastModified: 0 }).lastModified);",
    "const Make = File; declare namespace Types { namespace Nested { class Data extends Make {} } } const shown = () => String(new Make([], 'banner', { lastModified: 0 }).lastModified);",
    "const Make = File; const Alias = Make; const shown = () => String(new Alias([], 'banner', { lastModified: 0 }).lastModified);",
    "const Make = File; export type Constructor = typeof Make; const shown = () => String(new Make([], 'banner', { lastModified: 0 }).lastModified);",
    'class File { lastModified = 0; } const shown = () => String(new File().lastModified);',
    'class File { lastModified = 0; } function read(Make: typeof File) { return new Make().lastModified; } const shown = () => String(read(File));',
  ])('keeps a fixed timestamp or application File shared: %s', async (code) => {
    await expect(boardWith({ [LAYOUT]: layoutOf(code) })).resolves.toMatchObject({ shared: true });
  });

  it.each([
    "function read(Make: typeof File) { return new Make([], 'x').lastModified; } read(File);",
    "function constructorOf() { return File; } new (constructorOf())([], 'x').lastModified;",
    "const Make = File; function read(Input: typeof Make) { return new Input([], 'x').lastModified; } read(Make);",
    'export const Make = File;',
    'const Make = File; export { Make };',
    'const Make = File; const holder = { Make };',
    'const Make = File; function constructorOf() { return Make; }',
    "const Make = File; class Data extends Make {} new Make([], 'x', { lastModified: 0 });",
    "new File([], 'x').lastModified;",
    "new File([], 'x', undefined).lastModified;",
    "new File([], 'x', {}).lastModified;",
    "new File([], 'x', { lastModified: undefined }).lastModified;",
    "new File([], 'x', { lastModified: void 0 }).lastModified;",
    "const stamp = undefined; new File([], 'x', { lastModified: stamp }).lastModified;",
    "const lastModified = undefined; new File([], 'x', { lastModified }).lastModified;",
    "const options = { lastModified: undefined }; const alias = options; new File([], 'x', alias).lastModified;",
    "const options = { lastModified: undefined }; new File([], 'x', { lastModified: 0, ...options }).lastModified;",
    "function read(unknown: FilePropertyBag) { new File([], 'x', { lastModified: 0, ...unknown }).lastModified; }",
    "function read(options: FilePropertyBag) { return new File([], 'x', options).lastModified; }",
    "const Make = File; new Make([], 'x').lastModified;",
    "function other(File: unknown) { return File; } new File([], 'x').lastModified;",
  ])('recognizes the File constructor’s implicit clock input: %s', (code) => {
    using parsed = parseModule(api, 'file-clock.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBe('File.lastModified');
  });

  it.each([
    "const Make = File; declare class Data extends Make {} new Make([], 'x', { lastModified: 0 });",
    "declare class Data extends File {} new File([], 'x', { lastModified: 0 });",
    "declare namespace Types { class Data extends File {} } new File([], 'x', { lastModified: 0 });",
    "const Make = File; declare namespace Types { namespace Nested { class Data extends Make {} } } new Make([], 'x', { lastModified: 0 });",
    "const Make = File; function read(value: typeof Make): void; function read(value: unknown) {} new Make([], 'x', { lastModified: 0 });",
    "new File([], 'x', { lastModified: 0 }).lastModified;",
    "const stamp = 0; new File([], 'x', { lastModified: stamp }).lastModified;",
    "const lastModified = 0; new File([], 'x', { lastModified }).lastModified;",
    "const options = { lastModified: 0 }; new File([], 'x', options).lastModified;",
    "const options = { lastModified: undefined }; new File([], 'x', { ...options, lastModified: 0 }).lastModified;",
    "function read(unknown: FilePropertyBag) { new File([], 'x', { ...unknown, lastModified: 0 }).lastModified; }",
    "const Make = File; new Make([], 'x', { lastModified: 0 }).lastModified;",
    "const Make = File; const Alias = Make; new Alias([], 'x', { lastModified: 0 }).lastModified;",
    "const Make = File; type Constructor = typeof Make; new Make([], 'x', { lastModified: 0 }).lastModified;",
    "const Make = File; export type { Make }; new Make([], 'x', { lastModified: 0 }).lastModified;",
    "const Make = File; export { type Make }; new Make([], 'x', { lastModified: 0 }).lastModified;",
    'type Constructor = typeof File; interface Holder { constructor: typeof File }',
    'class File { lastModified = 0; } new File().lastModified;',
    'class File { lastModified = 0; } function read(Make: typeof File) { return new Make().lastModified; } read(File);',
    'function read(File: new () => { lastModified: number }) { return new File().lastModified; }',
    'const Make = File; function read(Make: new () => { lastModified: number }) { return new Make().lastModified; }',
  ])('keeps explicit timestamps and local constructor bindings: %s', (code) => {
    using parsed = parseModule(api, 'fixed-file-time.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBeUndefined();
  });
});
