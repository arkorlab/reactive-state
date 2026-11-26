import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Complete written key sets retain empty keyof results before a never comparison. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'generic-any-declaration-empty',
    source:
      'type Data={stack:string};type Keys<T>=keyof ({}|T);type Checked=Keys<any>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-any-inverse-data',
    source:
      'type Data={stack:string};type Keys<T>=keyof ({}|T);type Checked=Keys<any>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-any-declaration-default',
    source:
      'type Data={stack:string};type Keys<T=any>=keyof ({}|T);type Checked=Keys;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-any-reversed-empty',
    source:
      'type Data={stack:string};type Keys<T>=keyof (T|{});type Checked=Keys<any>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'outside-aliased-any-stays-nonempty',
    source:
      'type Data={stack:string};type Union<T>={}|T;type Checked=keyof Union<any>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'outer-alias-any-declaration-empty',
    source:
      'type Data={stack:string};type Keys<T>=keyof ({}|T);type Use<U>=Keys<U>;type Checked=Use<any>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-operand-alias-any',
    source:
      'type Data={stack:string};type Union<U>={}|U;type Keys<T>=keyof Union<T>;type Checked=Keys<any>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-constant-any-alias-data',
    source:
      'type Data={stack:string};type Whole=any;type Keys<T>=keyof ({}|Whole);type Checked=Keys<Error>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-identity-arm-any',
    source:
      'type Data={stack:string};type Identity<U>=U;type Keys<T>=keyof ({}|Identity<T>);type Checked=Keys<any>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-opaque-any-actual',
    source:
      'type Data={stack:string};type Keys<T>=keyof ({}|T);type Checked=Keys<ReturnType<()=>any>>;type Fits=Checked extends never?true:false;type Failure=Checked extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inline-unbound-generic-error',
    source:
      'type Data={stack:string};function frames<T>(value:keyof({}|T) extends never?Error:Data){return value.stack;}',
    invocation: 'frames<any>(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inline-unbound-generic-data',
    source:
      'type Data={stack:string};function frames<T>(value:keyof({}|T) extends never?Data:Error){return value.stack;}',
    invocation: 'frames<any>({stack:"fixed"})',
    refused: false,
  },
];

describe('generic keyof union never readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'keyof-generic-union-never.ts', source);
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

describe('shared generic keyof union never admissions', () => {
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
