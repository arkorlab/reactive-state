import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import type { RouteRegistration } from '../src/routing.ts';
import {
  application,
  type Application,
  compiledApp,
  output,
  removed,
} from './fixtures/application.ts';

/** Written error shapes keep engine-dependent rendering outside shared route admission. */
describe('error shapes read while rendering a route', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    for (const app of apps) await removed(app);
    api[Symbol.dispose]();
  });

  async function board(code: string): Promise<RouteRegistration | undefined> {
    const app = await application({
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        code,
        'export default function Layout({ children }: { children: ReactNode }) {',
        '  return <section data-shown={shown()}>{children}</section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compiledApp(app, api);

    expect(compiled.refusals).toStrictEqual([]);

    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      readonly routes: readonly RouteRegistration[];
    };
    return manifest.routes.find((route) => route.route === '/boards/[projectId]');
  }

  it.each([
    'function borrowedConcat(error: Error) { return String.prototype.concat.call("", error as unknown as string); } export function shown() { return borrowedConcat(new Error("banner")); }',
    'function borrowedConcat(error: Error) { return String.prototype.concat.apply("", [error as unknown as string]); } export function shown() { return borrowedConcat(new Error("banner")); }',
    'function borrowedConcat(error: Error) { return Reflect.apply(String.prototype.concat, "", [error]); } export function shown() { return borrowedConcat(new Error("banner")); }',
    'function read(error: Error) { return Array.prototype.join.call([error], ","); } export function shown() { return read(new Error("banner")); }',
    'function read(error: Error) { return Reflect.apply(Array.prototype.toString, [error], []); } export function shown() { return read(new Error("banner")); }',
    'function read(error: Error, flag: boolean) { return error[flag ? "stack" : "name"] ?? ""; } export function shown() { return read(new Error("banner"), true); }',
    'function read(error: Error, field: string) { const { [field]: value } = error; return value ?? ""; } export function shown() { return read(new Error("banner"), "stack"); }',
    'function own() { return "banner"; } function read(error: Error) { const values = [error]; values.join = own; return values.join(","); } restore(); function restore() { own = Array.prototype.join; } export function shown() { return read(new Error("banner")); }',
    'function read(error: Error) { const values = [error]; values.join = () => "banner"; delete (values as { join?: () => string }).join; return values.join(); } export function shown() { return read(new Error("banner")); }',
    'function read(flag: boolean) { return (flag ? new Error("a") : new TypeError("b")).stack ?? ""; } export function shown() { return read(true); }',
    'function read(error: Error) { return Object(error).stack ?? ""; } export function shown() { return read(new Error("banner")); }',
    'function read(error: Error & string) { return "".concat(...[error]); } export function shown() { return read(new Error("banner") as Error & string); }',
    'function read() { let value: { stack?: string } = {}; value = new Error("banner"); return value.stack ?? ""; } export function shown() { return read(); }',
    'function read(error: Error) { return Reflect.get(error, "stack") ?? ""; } export function shown() { return read(new Error("banner")); }',
    'const NativeError = Error; export function shown() { return new NativeError("banner").stack ?? ""; }',
    'function read(error: Error) { return Error.prototype.toString.call(error); } export function shown() { return read(new Error("banner")); }',
    'export function shown() { try { JSON.parse("{"); } catch (error: any) { return "".concat(error); } return ""; }',
    'function read(prefix: string, error: Error) { return prefix.concat(error as unknown as string); } export function shown() { return read("", new Error("banner")); }',
    'function read(flag: boolean) { switch (flag) { case true: const error: Error = new Error("banner"); return error.stack ?? ""; default: return ""; } } export function shown() { return read(true); }',
    'function read(value: unknown) { return (value as Error).stack ?? ""; } export function shown() { return read(new Error("banner")); }',
    'export function shown() { return (() => new Error("banner"))().stack ?? ""; }',
    'function make() { return new Error("banner"); } export function shown() { return make().stack ?? ""; }',
    'function read() { try { throw new Error("banner"); } catch (error) { const { stack } = (error as Error); return stack ?? ""; } } export function shown() { return read(); }',
    'function read(error: Error) { const native = Array.prototype.join; const values = [error]; values.join = native; return values.join(","); } export function shown() { return read(new Error("banner")); }',
    'function read(error: ReturnType<() => Error>) { return error.stack ?? ""; } export function shown() { return read(new Error("banner")); }',
    'type Made<T> = T extends new () => infer R ? R : never; function read(error: Made<new () => Error>) { return error.stack ?? ""; } export function shown() { return read(new Error("banner")); }',
    'type Result<T> = T extends { make(): infer R } ? R : never; function read(error: Result<{ make(): Error }>) { return error.stack ?? ""; } export function shown() { return read(new Error("banner")); }',
    'type Result<T> = T extends (value: string | undefined) => infer R ? R : never; function read(error: Result<(value?: string) => Error>) { return error.stack ?? ""; } export function shown() { return read(new Error("banner")); }',
    'type Result<T> = T extends new (value: string | undefined) => infer R ? R : never; function read(error: Result<new (value?: string) => Error>) { return error.stack ?? ""; } export function shown() { return read(new Error("banner")); }',
    'function read({ stack }: Error) { return stack ?? ""; } export function shown() { return read(new Error("banner")); }',
    'function read(box: { error: Error }) { return box.error.stack ?? ""; } export function shown() { return read({ error: new Error("banner") }); }',
    'const field = "stack"; function read(error: Error) { return error[field] ?? ""; } export function shown() { return read(new Error("banner")); }',
    'function read(error: Error) { return [error].join(","); } export function shown() { return read(new Error("banner")); }',
    'function read(error: Error) { const values = [error]; values.join = () => "banner"; return Array.prototype.toString.call(values); } export function shown() { return read(new Error("banner")); }',
    'function read(error: Error) { const values = [error]; values.join = 0; return Array.prototype.toString.call(values); } export function shown() { return read(new Error("banner")); }',
  ])('keeps an explicit error read private: %s', async (code) => {
    await expect(board(code)).resolves.toMatchObject({ shared: false });
  });

  it.each([
    'function borrowedConcat() { return String.prototype.concat.call("", new Error("banner") as unknown as string); } export function shown() { return borrowedConcat(); }',
    'function borrowedConcat() { return String.prototype.concat.apply("", ["banner"]); } export function shown() { return borrowedConcat(); }',
    'const String = { prototype: { concat(_value: unknown) { return "banner"; } } }; function borrowedConcat(error: Error) { return String.prototype.concat.call("", error); } export function shown() { return borrowedConcat(new Error("banner")); }',
    'function read(flag: boolean) { return (flag ? { stack: "a" } : { stack: "b" }).stack; } export function shown() { return read(true); }',
    'const Object = (data: { stack: string }) => data; export function shown() { return Object({ stack: "banner" }).stack; }',
    'const NativeError = class { stack = "banner"; }; export function shown() { return new NativeError().stack; }',
    'const Reflect = { get(data: { stack: string }, _key: string) { return data.stack; } }; export function shown() { return Reflect.get({ stack: "banner" }, "stack"); }',
    'export function shown() { return Error.prototype.toString.call(new Error("banner")); }',
    'function read(error: Error & { data: string }, field: "data") { return error[field]; } export function shown() { return read({ data: "banner" } as Error & { data: string }, "data"); }',
    'function read(flag: boolean) { return (flag ? new Error("a") : new TypeError("b")).message; } export function shown() { return read(true); }',
    'export function shown() { return "".concat(...["ban", "ner"]); }',
    'function read(data: ReturnType<() => { stack: string }>) { return data.stack; } export function shown() { return read({ stack: "banner" }); }',
    'const words = { concat(_value: unknown) { return "banner"; } }; export function shown() { try { JSON.parse("{"); } catch (error) { return words.concat(error); } return ""; }',
    'export function shown() { try { JSON.parse("{"); } catch (error) { return [error].concat([]).length.toString(); } return ""; }',
    'function read(flag: boolean) { switch (flag) { case true: const data: { stack: string } = { stack: "banner" }; return data.stack; default: return ""; } } export function shown() { return read(true); }',
    'function read(value: unknown) { return (value as { stack: string }).stack; } export function shown() { return read({ stack: "banner" }); }',
    'export function shown() { return (() => ({ stack: "banner" }))().stack; }',
    'function make() { return { stack: "banner" }; } export function shown() { return make().stack; }',
    'const field = "stack"; function read(error: Error & { data: string }) { { var field: "data" = "data"; } return error[field]; } export function shown() { return read({ data: "banner" } as Error & { data: string }); }',
    'type Made<T> = T extends new () => infer R ? R : never; function read(data: Made<new () => { stack: string }>) { return data.stack; } export function shown() { return read({ stack: "banner" }); }',
    'type Result<T> = T extends { make(): infer R } ? R : never; function read(data: Result<{ make(): { stack: string } }>) { return data.stack; } export function shown() { return read({ stack: "banner" }); }',
    'type Result<T> = T extends (value: string | undefined) => infer R ? R : Error; function read(data: Result<(value?: string) => { stack: string }>) { return data.stack; } export function shown() { return read({ stack: "banner" }); }',
    'type Result<T> = T extends new (value: string | undefined) => infer R ? R : Error; function read(data: Result<new (value?: string) => { stack: string }>) { return data.stack; } export function shown() { return read({ stack: "banner" }); }',
    'function read({ stack }: { stack: string }) { return stack; } export function shown() { return read({ stack: "banner" }); }',
    'function read(box: { error: { stack: string } }) { return box.error.stack; } export function shown() { return read({ error: { stack: "banner" } }); }',
    'const field = "stack"; function read(data: { stack: string }) { return data[field]; } export function shown() { return read({ stack: "banner" }); }',
    'function read(data: { toString(): string }) { return [data].join(","); } export function shown() { return read({ toString() { return "banner"; } }); }',
  ])('keeps written application data shared: %s', async (code) => {
    await expect(board(code)).resolves.toMatchObject({ shared: true });
  });
});
