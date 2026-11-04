import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native instance results close only their selected constructor signature own binders. */
const CASES = [
  {
    id: 'reported-own-unknown',
    source:
      'type Failure = InstanceType<new<T>() => T extends string ? Error : {stack: string}>; function frames(value: Failure) { return value.stack; }',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'own-default-is-not-constraint',
    source:
      'type Slot=InstanceType<new<T=string>()=>T>; type Failure=unknown extends Slot?{stack:string}:Error; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'written-construct-signature',
    source:
      'type Failure=InstanceType<{new<T>():T extends string?Error:{stack:string}}>; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'interface-outer-data-scope',
    source:
      'interface Maker<Outer>{new<T>():T extends string?Error:Outer} type Failure=InstanceType<Maker<{stack:string}>>; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'last-generic-overload',
    source:
      'type Slot=InstanceType<{new():Error;new<T>():T}>; type Failure=unknown extends Slot?{stack:string}:Error; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'abstract-generic-constructor',
    source:
      'type Failure=InstanceType<abstract new<T>()=>T extends string?Error:{stack:string}>; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'own-name-shadows-outer',
    source:
      'type Select<T>=InstanceType<new<T>()=>T extends string?Error:{stack:string}>; type Failure=Select<string>; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'unknown-extends-own',
    source:
      'type Failure=InstanceType<new<T>()=>unknown extends T?{stack:string}:Error>; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'written-string-constraint',
    source:
      'type Failure=InstanceType<new<T extends string>()=>T extends string?Error:{stack:string}>; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'outer-error-constraint-scope',
    source:
      'type Select<Outer>=InstanceType<new<T extends Outer>()=>T>; type Failure=Select<Error>; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'keyof-own-unknown',
    source:
      'type Failure=InstanceType<new<T>()=>keyof T extends never?Error:{stack:string}>; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'dependent-constraint-environment',
    source:
      'type Failure=InstanceType<new<T,U extends T>()=>U extends string?Error:{stack:string}>; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
] as const;

describe('native InstanceType own binder readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'instance-type-own-binders.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });
});

describe('shared helpers with InstanceType own binders', () => {
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
