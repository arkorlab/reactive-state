import { describe, expect, it } from 'vitest';

import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Awaited layout output retains native error reads and deterministic data controls. */
const CASES = [
  {
    id: 'comma-native-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return (0, new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'comma-supplied-error-stack',
    kind: 'intended-refusal',
    source: 'function frames(error: Error) { return (0, error).stack; }',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'comma-right-data',
    kind: 'safe-control',
    source: 'function frames() { return (new Error("ours"), {stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'comma-local-error-words',
    kind: 'safe-control',
    source: 'function frames() { return (0, new Error("ours")).message; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'comma-shadow-error-data',
    kind: 'safe-control',
    source: 'class Error { stack="fixed"; } function frames() { return (0, new Error()).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'freeze-native-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return Object.freeze(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'seal-native-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return Object.seal(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'prevent-extensions-native-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return Object.preventExtensions(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'assign-target-only-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return Object.assign(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'freeze-ordinary-data',
    kind: 'safe-control',
    source: 'function frames() { return Object.freeze({stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'seal-ordinary-data',
    kind: 'safe-control',
    source: 'function frames() { return Object.seal({stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'prevent-extensions-ordinary-data',
    kind: 'safe-control',
    source: 'function frames() { return Object.preventExtensions({stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'assign-target-only-ordinary-data',
    kind: 'safe-control',
    source: 'function frames() { return Object.assign({stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'freeze-local-shadow-data',
    kind: 'safe-control',
    source:
      'const Object={freeze(_value:unknown){return {stack:"fixed"};}}; function frames() { return Object.freeze(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'seal-local-shadow-data',
    kind: 'safe-control',
    source:
      'const Object={seal(_value:unknown){return {stack:"fixed"};}}; function frames() { return Object.seal(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'prevent-extensions-local-shadow-data',
    kind: 'safe-control',
    source:
      'const Object={preventExtensions(_value:unknown){return {stack:"fixed"};}}; function frames() { return Object.preventExtensions(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'assign-local-shadow-data',
    kind: 'safe-control',
    source:
      'const Object={assign(_value:unknown){return {stack:"fixed"};}}; function frames() { return Object.assign(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'await-native-error-stack',
    kind: 'intended-refusal',
    source: 'async function frames() { return (await new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'await-ordinary-data',
    kind: 'safe-control',
    source: 'async function frames() { return (await {stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'await-shadow-error-data',
    kind: 'safe-control',
    source:
      'class Error { stack="fixed"; } async function frames() { return (await new Error()).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'await-error-thenable-resolves-data',
    kind: 'safe-control',
    source:
      'async function frames() { const value=Object.assign(new Error("ours"), {then(resolve:(data:{stack:string})=>void) { resolve({stack:"fixed"}); }}); return (await value).stack; }',
    invocation: 'frames()',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'await-typed-error-thenable-resolves-data',
    kind: 'safe-control',
    source:
      'async function frames(error:Error & PromiseLike<{stack:string}>) { return (await error).stack; }',
    invocation:
      'frames(Object.assign(new Error("ours"),{then(resolve:(data:{stack:string})=>void){resolve({stack:"fixed"});}}))',
    refused: false,
    canonicalOrigin: 'expression22',
  },
  {
    id: 'native Error prototype query',
    kind: 'intended-refusal',
    source:
      'type Failure = typeof Error.prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: true,
    canonicalOrigin: 'typequery9',
  },
  {
    id: 'native TypeError prototype query',
    kind: 'intended-refusal',
    source:
      'type Failure = typeof TypeError.prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: true,
    canonicalOrigin: 'typequery9',
  },
  {
    id: 'local alias to native prototype query',
    kind: 'intended-refusal',
    source:
      'type Prototype = typeof Error.prototype; type Failure = Prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: true,
    canonicalOrigin: 'typequery9',
  },
  {
    id: 'shadowed Error constructor value data',
    kind: 'safe-control',
    source:
      'const Error = { prototype: { stack: "fixed" } }; type Failure = typeof Error.prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: false,
    canonicalOrigin: 'typequery9',
  },
  {
    id: 'shadowed TypeError constructor value data',
    kind: 'safe-control',
    source:
      'const TypeError = { prototype: { stack: "fixed" } }; type Failure = typeof TypeError.prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: false,
    canonicalOrigin: 'typequery9',
  },
  {
    id: 'ordinary application prototype query',
    kind: 'safe-control',
    source:
      'const Data = { prototype: { stack: "fixed" } }; type Failure = typeof Data.prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: false,
    canonicalOrigin: 'typequery9',
  },
  {
    id: 'type-only Error name preserves native value query',
    kind: 'intended-refusal',
    source:
      'type Error = { stack: string }; type Failure = typeof Error.prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: true,
    canonicalOrigin: 'typequery9',
  },
  {
    id: 'global-qualified native Error prototype query',
    kind: 'intended-refusal',
    source:
      'type Failure = typeof globalThis.Error.prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: true,
    canonicalOrigin: 'typequery9',
  },
  {
    id: 'shadowed globalThis value prototype query data',
    kind: 'safe-control',
    source:
      'const globalThis = { Error: { prototype: { stack: "fixed" } } }; type Failure = typeof globalThis.Error.prototype;\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    invocation: 'label("route")',
    originalFramesInvocation: 'frames({ name: "fixed", message: value, stack: value })',
    refused: false,
    canonicalOrigin: 'typequery9',
  },
] as const;

describe('published routes with source-proven error values', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async (row) => {
    const app = await application({
      'domain/error-source.ts': [
        row.source,
        `export function routeValue() { return ${row.invocation}; }`,
      ].join('\n'),
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { routeValue } from '@/domain/error-source';",
        'export default async function Layout({children}:{children:ReactNode}) {',
        '  const shown = await routeValue();',
        '  return <section data-shown={String(shown)}>{children}</section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const reasons = compiled.refusals.map((item) => item.reason);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(reasons).toStrictEqual([]);
    expect(board).toMatchObject({ shared: !row.refused });
    expect(board?.private === undefined).toBe(!row.refused);
  });
});
