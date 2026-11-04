import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native conditional utilities normalize written whole unknown before distributing constituents. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}
const CASES: readonly Case[] = [
  {
    id: 'extract-reported-data',
    source:
      'type Selected=Extract<unknown|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-reported-error',
    source:
      'type Selected=Extract<unknown|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-reverse-data',
    source:
      'type Selected=Extract<string|unknown,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-reverse-error',
    source:
      'type Selected=Extract<string|unknown,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-unknown-alias-data',
    source:
      'type U=unknown;type Selected=Extract<U|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-unknown-alias-error',
    source:
      'type U=unknown;type Selected=Extract<U|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-whole-alias-data',
    source:
      'type Input=unknown|string;type Selected=Extract<Input,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-whole-alias-error',
    source:
      'type Input=unknown|string;type Selected=Extract<Input,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-nested-alias-data',
    source:
      'type Box<T>=T;type Selected=Extract<Box<unknown|string>,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-nested-alias-error',
    source:
      'type Box<T>=T;type Selected=Extract<Box<unknown|string>,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-generic-union-data',
    source:
      'type Box<T>=unknown|T;type Selected=Extract<Box<string>,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-generic-union-error',
    source:
      'type Box<T>=unknown|T;type Selected=Extract<Box<string>,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-generic-default-data',
    source:
      'type Box<T=string>=unknown|T;type Selected=Extract<Box,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-generic-default-error',
    source:
      'type Box<T=string>=unknown|T;type Selected=Extract<Box,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-nested-union-data',
    source:
      'type Selected=Extract<unknown|(string|never),string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-nested-union-error',
    source:
      'type Selected=Extract<unknown|(string|never),string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-literal-data',
    source:
      'type Selected=Extract<unknown|"word",string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-literal-error',
    source:
      'type Selected=Extract<unknown|"word",string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-number-data',
    source:
      'type Selected=Extract<unknown|number,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-number-error',
    source:
      'type Selected=Extract<unknown|number,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-boolean-data',
    source:
      'type Selected=Extract<unknown|boolean,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-boolean-error',
    source:
      'type Selected=Extract<unknown|boolean,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-nested-any-data',
    source:
      'type Selected=Extract<unknown|{value:any}|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-nested-any-error',
    source:
      'type Selected=Extract<unknown|{value:any}|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-callable-any-data',
    source:
      'type Selected=Extract<unknown|(()=>any)|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-callable-any-error',
    source:
      'type Selected=Extract<unknown|(()=>any)|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-native-error-data',
    source:
      'type Selected=Extract<unknown|Error|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-native-error-error',
    source:
      'type Selected=Extract<unknown|Error|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-interface-data',
    source:
      'interface Shape{value:any}type Selected=Extract<unknown|Shape|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-interface-error',
    source:
      'interface Shape{value:any}type Selected=Extract<unknown|Shape|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-class-data',
    source:
      'class Shape{value=1}type Selected=Extract<unknown|Shape|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-class-error',
    source:
      'class Shape{value=1}type Selected=Extract<unknown|Shape|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-array-data',
    source:
      'type Selected=Extract<unknown|Array<any>|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-array-error',
    source:
      'type Selected=Extract<unknown|Array<any>|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-tuple-data',
    source:
      'type Selected=Extract<unknown|[any]|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-tuple-error',
    source:
      'type Selected=Extract<unknown|[any]|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-selected-unknown-data',
    source:
      'type Branch=true extends true?unknown:never;type Selected=Extract<Branch|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-selected-unknown-error',
    source:
      'type Branch=true extends true?unknown:never;type Selected=Extract<Branch|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-control-38',
    source:
      'type Selected=Exclude<unknown|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-control-39',
    source:
      'type Selected=Exclude<unknown|string,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-control-40',
    source:
      'type Selected=Exclude<unknown|Error,Error>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-control-41',
    source:
      'type Selected=Exclude<unknown|Error,Error>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-control-42',
    source:
      'type Selected=Exclude<unknown|string,unknown>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-control-43',
    source:
      'type Selected=Exclude<unknown|string,unknown>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-control-44',
    source:
      'type Selected=Extract<unknown|string,unknown>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-control-45',
    source:
      'type Selected=Extract<unknown|string,unknown>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-control-46',
    source:
      'type Selected=Extract<unknown|never,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-control-47',
    source:
      'type Selected=Extract<unknown|never,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-control-48',
    source:
      'type Selected=Extract<unknown,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-control-49',
    source:
      'type Selected=Extract<unknown,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-control-50',
    source:
      'type Selected=Extract<string|number,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-control-51',
    source:
      'type Selected=Extract<string|number,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-control-52',
    source:
      'type Selected=Exclude<string|number,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-control-53',
    source:
      'type Selected=Exclude<string|number,string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-control-54',
    source:
      'type Selected=Extract<Error,unknown|string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-control-55',
    source:
      'type Selected=Extract<Error,unknown|string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-control-56',
    source:
      'type Selected=Exclude<Error,unknown|string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-control-57',
    source:
      'type Selected=Exclude<Error,unknown|string>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'preserve-any',
    source:
      'type Selected=Extract<unknown|any|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'preserve-alias-any',
    source:
      'type Any=any;type Selected=Extract<unknown|Any|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'preserve-intersection-any',
    source:
      'type Selected=Extract<unknown|(any&{stack:string})|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'synthetic-any-await-result',
    source:
      'type Selected=Extract<unknown|Awaited<{then(done:(value:Error)=>void):void}>|string,string>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'unresolved-generic',
    source:
      'type Selected<T>=Extract<unknown|T|string,string>;type Failure<T>=Selected<T> extends never?{stack:string}:Error;function frames<T>(value:Failure<T>){return value.stack;}',
    invocation: 'frames<unknown>({stack:"fixed"})',
    refused: true,
  },
];

describe('utility whole unknown readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'utility-whole-unknown.ts', source);
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

describe('shared utility whole unknown results', () => {
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
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(compile(app).refusals.map((item) => item.reason)).toStrictEqual(refused ? [shared] : []);
  });
});
