import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Inherited Object members are not proven absent by an unwritten field. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-inherited-toString',
    source:
      'type Failure={} extends {toString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nonempty-source-toString',
    source:
      'type Failure={caption:string} extends {toString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-generic-actual',
    source:
      'type Read<T>=T extends {toString():string}?Error:{stack:string};type Selected=Read<{}>;type Failure=Selected extends Error?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-toLocaleString',
    source:
      'type Failure={} extends {toLocaleString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-valueOf',
    source:
      'type Failure={} extends {valueOf():Object}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-hasOwnProperty',
    source:
      'type Failure={} extends {hasOwnProperty(key:PropertyKey):boolean}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-constructor',
    source:
      'type Failure={} extends {constructor:Function}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-isPrototypeOf',
    source:
      'type Failure={} extends {isPrototypeOf(value:Object):boolean}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-propertyIsEnumerable',
    source:
      'type Failure={} extends {propertyIsEnumerable(key:PropertyKey):boolean}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'intersection-source',
    source:
      'type Failure=({caption:string}&{label:string}) extends {toString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'interface-source',
    source:
      'interface Box{}type Failure=Box extends {toString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'weak-inherited-name-is-not-written-common-property',
    source:
      'type Failure={caption:string} extends {toString?:()=>string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'incompatible-optional-inherited',
    source:
      'type Failure={} extends {toString?:number}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-method-incompatible',
    source:
      'type Failure={toString():number} extends {toString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'own-method-data',
    source:
      'type Failure={toString():string} extends {toString():string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'inherited-written-interface-shadow',
    source:
      'interface Base{toString():number}interface Box extends Base{}type Failure=Box extends {toString():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'ordinary-missing-member',
    source:
      'type Failure={} extends {missing():string}?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'ordinary-weak-mismatch-existing',
    source:
      'type Failure={caption:string} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('inherited Object pattern readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'weak-object-patterns.ts', source);
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

describe('shared inherited Object pattern admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
