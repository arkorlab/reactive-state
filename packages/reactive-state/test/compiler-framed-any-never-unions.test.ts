import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Whole written any unions retain both conditional results without changing nested any values. */
const CASES = [
  {
    id: 'any-union-empty',
    source:
      'type Failure = (any | (string & number)) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-union-number',
    source:
      'type Failure = (any | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-union-unknown',
    source:
      'type Failure = (any | unknown) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-union-never',
    source:
      'type Failure = (any | never) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'alias-any-union',
    source:
      'type Opaque = any; type Failure = (Opaque | "fixed") extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'bound-any-union',
    source:
      'type Mix<T> = T | number; type Failure = (Mix<any>) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'nested-any-union',
    source:
      'type Failure = (number | ("fixed" | any)) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-intersection-union',
    source:
      'type Failure = ((any & string) | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'nested-union-intersection',
    source:
      'type Failure = (((any | string) & number) | false) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'known-any-opposite-branch',
    source:
      'type Failure = (any | number) extends never ? { stack: string } : Error; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-in-object-field',
    source:
      'type Failure = ({ item: any } | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'any-in-callable-result',
    source:
      'type Failure = ((() => any) | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'any-template',
    source: `type Failure = (\`\${any}\`) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }`,
    argument: '{ stack: "fixed" }',
    refused: true,
  },
  {
    id: 'any-union-template',
    source: `type Failure = (\`\${any | string}\`) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }`,
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'known-empty-any-intersection',
    source:
      'type Failure = (any & never) extends never ? { stack: string } : Error; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'empty-nested-any-union',
    source:
      'type Failure = ((any & (string & number)) | "fixed") extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'finite-empty-union',
    source:
      'type Failure = ((string & number) | (bigint & symbol)) extends never ? { stack: string } : Error; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'ordinary-unknown-union',
    source:
      'type Failure = (unknown | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'ordinary-finite-union',
    source:
      'type Failure = (string | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'empty-any-native-error',
    source:
      'type Failure = (any & never) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'flat-empty-any-union',
    source:
      'type Failure = ((any & string & number) | false) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'any-union-structural',
    source:
      'type Failure = (any | { opaque: unknown }) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-intersection-structural',
    source:
      'type Failure = (any & { opaque: unknown }) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-unknown-intersection-union',
    source:
      'type Failure = ((any & unknown) | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'opaque-awaited-thenable-union',
    source:
      'type Thenable = { then(resolve: (value: string) => void): void }; type Failure = (Awaited<Thenable> | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'nested-property-any-relation',
    source:
      'type Failure = { value: any | number } extends { value: never } ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'nested-callable-any-relation',
    source:
      'type Failure = (() => any | number) extends (() => never) ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'empty-template-any-intersection-union',
    source: `type Failure = ((any & \`\${never}\`) | number) extends never ? Error : { stack: string }; function frames(value: Failure): string { return value.stack ?? ""; }`,
    argument: '{ stack: "fixed" }',
    refused: false,
  },
] as const;

describe('written any union never readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'any-never-unions.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });
});

describe('shared helpers with written any unions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, argument, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(${argument})).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const unsettled = compile(app).refusals.map((item) =>
      item.reason.includes('a shared module that answers otherwise'),
    );

    expect(unsettled).toStrictEqual(refused ? [true] : []);
  });
});

/** Stack observations are read through the original native compiler syntax tree. */
function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
