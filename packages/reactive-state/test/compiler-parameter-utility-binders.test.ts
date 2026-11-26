import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native argument utilities close each selected signature's own generic binders before its slots. */
const CASES = [
  {
    id: 'parameters-direct',
    source:
      'type Failure = Parameters<<T>(value: T extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-constraint-string',
    source:
      'type Failure = Parameters<<T extends string>(value: T extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'parameters-constraint-number',
    source:
      'type Failure = Parameters<<T extends number>(value: T extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-signature',
    source:
      'type Failure = Parameters<{ <T>(value: T extends string ? Error : { stack: string }): void }>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-interface',
    source:
      'interface Factory { <T>(value: T extends string ? Error : { stack: string }): void } type Failure = Parameters<Factory>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-outer-data',
    source:
      'type Select<Outer> = Parameters<<T>(value: T extends string ? Error : Outer) => void>[0]; type Failure = Select<{ stack: string }>; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-last-generic',
    source:
      'type Failure = Parameters<{ (value: Error): void; <T>(value: T extends string ? Error : { stack: string }): void }>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-last-error',
    source:
      'type Failure = Parameters<{ <T>(value: T extends string ? Error : { stack: string }): void; (value: Error): void; }>[0]; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'parameters-intersection',
    source:
      'type Failure = Parameters<((value: Error) => void) & (<T>(value: T extends string ? Error : { stack: string }) => void)>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-optional',
    source:
      'type Failure = Parameters<<T>(value?: T extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value?.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-rest-array',
    source:
      'type Failure = Parameters<<T>(...values: (T extends string ? Error : { stack: string })[]) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-rest-tuple',
    source:
      'type Failure = Parameters<<T>(...values: [(T extends string ? Error : { stack: string })]) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-keyof-error',
    source:
      'type Failure = Parameters<<T>(value: keyof T extends never ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'parameters-unknown-ext',
    source:
      'type Failure = Parameters<<T>(value: unknown extends T ? { stack: string } : Error) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-dependent-back',
    source:
      'type Failure = Parameters<<T, U extends T>(value: U extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-dependent-forward',
    source:
      'type Failure = Parameters<<T extends U, U>(value: T extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-local-shadow',
    source:
      'type Parameters<Value> = [{ stack: string }]; type Failure = Parameters<<T>(value: T extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-shadowed-binder',
    source:
      'type Select<T> = Parameters<<T>(value: T extends string ? Error : { stack: string }) => void>[0]; type Failure = Select<string>; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-empty',
    source:
      'type Failure = Parameters<<T>() => void> extends [] ? { stack: string } : Error; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-direct',
    source:
      'type Failure = ConstructorParameters<new <T>(value: T extends string ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-constraint-string',
    source:
      'type Failure = ConstructorParameters<new <T extends string>(value: T extends string ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'constructor-constraint-number',
    source:
      'type Failure = ConstructorParameters<new <T extends number>(value: T extends string ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-signature',
    source:
      'type Failure = ConstructorParameters<{ new<T>(value: T extends string ? Error : { stack: string }): object }>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-interface',
    source:
      'interface Factory { new<T>(value: T extends string ? Error : { stack: string }): object } type Failure = ConstructorParameters<Factory>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-outer-data',
    source:
      'type Select<Outer> = ConstructorParameters<new <T>(value: T extends string ? Error : Outer) => object>[0]; type Failure = Select<{ stack: string }>; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-last-generic',
    source:
      'type Failure = ConstructorParameters<{ new(value: Error): object; new<T>(value: T extends string ? Error : { stack: string }): object }>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-last-error',
    source:
      'type Failure = ConstructorParameters<{ new<T>(value: T extends string ? Error : { stack: string }): object; new(value: Error): object; }>[0]; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'constructor-intersection',
    source:
      'type Failure = ConstructorParameters<(new (value: Error) => object) & (new <T>(value: T extends string ? Error : { stack: string }) => object)>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-optional',
    source:
      'type Failure = ConstructorParameters<new <T>(value?: T extends string ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value?.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-rest-array',
    source:
      'type Failure = ConstructorParameters<new <T>(...values: (T extends string ? Error : { stack: string })[]) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-rest-tuple',
    source:
      'type Failure = ConstructorParameters<new <T>(...values: [(T extends string ? Error : { stack: string })]) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-keyof-error',
    source:
      'type Failure = ConstructorParameters<new <T>(value: keyof T extends never ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'constructor-unknown-ext',
    source:
      'type Failure = ConstructorParameters<new <T>(value: unknown extends T ? { stack: string } : Error) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-dependent-back',
    source:
      'type Failure = ConstructorParameters<new <T, U extends T>(value: U extends string ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-dependent-forward',
    source:
      'type Failure = ConstructorParameters<new <T extends U, U>(value: T extends string ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-local-shadow',
    source:
      'type ConstructorParameters<Value> = [{ stack: string }]; type Failure = ConstructorParameters<new <T>(value: T extends string ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-shadowed-binder',
    source:
      'type Select<T> = ConstructorParameters<new <T>(value: T extends string ? Error : { stack: string }) => object>[0]; type Failure = Select<string>; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-empty',
    source:
      'type Failure = ConstructorParameters<new <T>() => object> extends [] ? { stack: string } : Error; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'parameters-explicit-this',
    source:
      'type Failure = Parameters<<T>(this: unknown, value: T extends string ? Error : { stack: string }) => void>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'constructor-abstract',
    source:
      'type Failure = ConstructorParameters<abstract new<T>(value: T extends string ? Error : { stack: string }) => object>[0]; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
] as const;

describe('native parameter utility own binders', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'parameter-utility-binders.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });
});

describe('shared helpers with closed parameter utilities', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, argument, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(${
          argument
        })).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) =>
      item.reason.includes('a shared module that answers otherwise'),
    );

    expect(reasons).toStrictEqual(refused ? [true] : []);
  });
});

/** Frame observations use the original native compiler syntax tree. */
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
