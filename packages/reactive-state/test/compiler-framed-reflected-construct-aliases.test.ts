import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import type { RouteRegistration } from '../src/routing.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Object reached through an aliased or borrowed `Reflect.construct`, or a literal's `constructor`. */
interface Case {
  readonly id: string;
  readonly helper: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'construct-const-alias',
    helper:
      'const make = Reflect.construct;\nexport const shown = async (): Promise<string> => (make(Object, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'construct-destructured',
    helper:
      'const { construct: make } = Reflect;\nexport const shown = async (): Promise<string> => (make(Object, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'construct-destructured-compact',
    helper:
      'const{construct:make}=Reflect;\nexport const shown = async (): Promise<string> => (make(Object, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'construct-borrowed-call',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct.call(Reflect, Object, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'construct-borrowed-apply',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct.apply(Reflect, [Object, [new Error("banner")]]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'construct-reflect-apply',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.apply(Reflect.construct, Reflect, [Object, [new Error("banner")]]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'literal-constructor-target',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct({}.constructor, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'prototype-constructor-target',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct(Object.prototype.constructor, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: true,
  },
  {
    id: 'object-identity-member-path',
    helper:
      'export const shown = async (): Promise<string> => (new Object({ inner: new Error("banner") }) as { inner: { stack?: string } }).inner.stack ?? "";',
    refused: true,
  },
  {
    id: 'reflected-identity-member-path',
    helper:
      'export const shown = async (): Promise<string> => (Reflect.construct(Object, [{ inner: new Error("banner") }]) as { inner: { stack?: string } }).inner.stack ?? "";',
    refused: true,
  },
  {
    id: 'alias-custom-new-target',
    helper:
      'const make = Reflect.construct;\nexport const shown = async (): Promise<string> => (make(Object, [new Error("banner")], Array) as { stack?: string }).stack ?? "";',
    refused: false,
  },
  {
    id: 'alias-plain-data',
    helper:
      'const make = Reflect.construct;\nexport const shown = async (): Promise<string> => (make(Object, [{ stack: "fixed" }]) as { stack?: string }).stack ?? "";',
    refused: false,
  },
  {
    id: 'own-constructor-literal',
    helper:
      'function Fixed(): { stack: string } { return { stack: "fixed" }; }\nexport const shown = async (): Promise<string> => (Reflect.construct({ constructor: Fixed }.constructor, [new Error("banner")]) as { stack?: string }).stack ?? "";',
    refused: false,
  },
  {
    id: 'local-make-function',
    helper:
      'function make(_target: unknown, _list: unknown[]): { stack?: string } { return { stack: "fixed" }; }\nexport const shown = async (): Promise<string> => make(Object, [new Error("banner")]).stack ?? "";',
    refused: false,
  },
];

const LAYOUT = 'app/boards/layout.tsx';
const HELPER = 'reflected-alias-banner.ts';

/** A board layout whose rendering reads the value the helper's `shown` answers. */
const LAYOUT_SOURCE = [
  "import type { ReactNode } from 'react';",
  "import { shown } from '@/reflected-alias-banner';",
  'export default async function Layout({ children }: { children: ReactNode }) {',
  '  return <section data-shown={await shown()}>{children}</section>;',
  '}',
].join('\n');

describe('indirect reflected Object readers', () => {
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

describe('boards rendering indirect reflected Object values', () => {
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
