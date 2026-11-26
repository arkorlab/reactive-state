import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import type { RouteRegistration } from '../src/routing.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Object reached through Reflect or a borrowed call answers the object it is given. */
interface Case {
  readonly id: string;
  readonly helper: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reflected-object-stack',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct(Object, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'reflected-object-alias',
    helper:
      'const Box = Object;\nexport const shown = async (): Promise<string> => (Reflect.construct(Box, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'reflected-list-alias',
    helper:
      'const list = [new Error("banner")];\nexport const shown = async (): Promise<string> => (Reflect.construct(Object, list) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'reflected-object-new-target',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct(Object, [new Error("banner")], Object) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'reflect-apply-object',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.apply(Object, undefined, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'object-borrowed-call',
    helper:
      'export const shown = async (): Promise<string> => (Object.call(undefined, new Error("banner")) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'object-borrowed-apply',
    helper:
      'export const shown = async (): Promise<string> => (Object.apply(undefined, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'reflected-supplied-words',
    helper:
      'function read(error: Error): string { return String(Reflect.construct(Object, [error])); }\nexport const shown = async (): Promise<string> => read(new Error("banner"));',
    refused: true,
  },
  {
    id: 'direct-object-construction',
    helper:
      'export const shown = async (): Promise<string> => (new Object(new Error("banner")) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'custom-new-target-data',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct(Object, [new Error("banner")], Array) as { stack?: string }).stack ?? "";',
    refused: false,
  },
  {
    id: 'local-object-function-data',
    helper:
      'function Object(): { stack: string } { return { stack: "fixed" }; }\nexport const shown = async (): Promise<string> => (Reflect.construct(Object, []) as { stack?: string }).stack ?? "";',
    refused: false,
  },
  {
    id: 'reflected-plain-data',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct(Object, [{ stack: "fixed" }]) as { stack?: string }).stack ?? "";',
    refused: false,
  },
  {
    id: 'local-reflect-data',
    helper:
      'const Reflect = { construct: (_target: unknown, _list: unknown[]): { stack?: string } => ({ stack: "fixed" }) };\nexport const shown = async (): Promise<string> => Reflect.construct(Object, [new Error("banner")]).stack ?? "";',
    refused: false,
  },
];

const LAYOUT = 'app/boards/layout.tsx';
const HELPER = 'reflected-banner.ts';

/** A board layout whose rendering reads the value the helper's `shown` answers. */
const LAYOUT_SOURCE = [
  "import type { ReactNode } from 'react';",
  "import { shown } from '@/reflected-banner';",
  'export default async function Layout({ children }: { children: ReactNode }) {',
  '  return <section data-shown={await shown()}>{children}</section>;',
  '}',
].join('\n');

describe('reflected Object readers', () => {
  it.each(CASES)('$id', ({ helper, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, HELPER, helper);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('boards rendering reflected Object values', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ helper, refused }) => {
    const app = await application({ [LAYOUT]: LAYOUT_SOURCE, [HELPER]: helper });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      readonly routes: readonly RouteRegistration[];
    };
    const board = manifest.routes.find((route) => route.route === '/boards/[projectId]');

    expect(board?.shared).toBe(!refused);
  });
});
