import { isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { borrowedTextCall } from '../src/compiler/framed-array-borrowing.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly actualRefused?: boolean;
  readonly consumerReader?: boolean;
}
const CASES: readonly Case[] = [
  {
    id: 'reported-generic-message',
    source:
      "function frames(error:Error){return Error.prototype.toString.call({name:'ours',message:error});}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-name',
    source:
      "function frames(error:Error){return Error.prototype.toString.call({name:error,message:'ours'});}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-name-and-message',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:error,message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-name-message',
    source: 'function frames(error:Error){return Error.prototype.toString.call({message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-name-message',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:undefined,message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-name-message',
    source:
      "function frames(error:Error){return Error.prototype.toString.call({name:'',message:error});}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-name-message',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:null,message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-message-name',
    source: 'function frames(error:Error){return Error.prototype.toString.call({name:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-message-name',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:error,message:undefined});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-message-name',
    source:
      "function frames(error:Error){return Error.prototype.toString.call({name:error,message:''});}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-message-name',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:error,message:null});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quoted-field-names',
    source:
      "function frames(error:Error){return Error.prototype.toString.call({'name':'ours','message':error});}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-literal-fields',
    source:
      "function frames(error:Error){return Error.prototype.toString.call({['name']:'ours',['message']:error});}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-receiver-alias',
    source:
      "function frames(error:Error){const receiver={name:'ours',message:error};return Error.prototype.toString.call(receiver);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-receiver-chain',
    source:
      "function frames(error:Error){const first={name:'ours',message:error};const receiver=first;return Error.prototype.toString.call(receiver);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-error-alias',
    source:
      "function frames(error:Error){const same=error;return Error.prototype.toString.call({name:'ours',message:same});}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shorthand-name',
    source:
      'function frames(error:Error){const name="ours";return Error.prototype.toString.call({name,message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shorthand-message',
    source:
      'function frames(error:Error){const message=error;return Error.prototype.toString.call({name:"ours",message});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'message-array-words',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:"ours",message:[error]});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'name-array-words',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:[error],message:"ours"});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-native-alias',
    source:
      'function frames(error:Error){const native=Error.prototype.toString;return native.call({name:"ours",message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-native-apply',
    source:
      'function frames(error:Error){return Error.prototype.toString.apply({name:"ours",message:error},[]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflected-native',
    source:
      'function frames(error:Error){return Reflect.apply(Error.prototype.toString,{name:"ours",message:error},[]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'existing-whole-error-pin',
    source: 'function frames(error:Error){return Error.prototype.toString.call(error);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'written-name-message-data',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:"ours",message:"fixed"});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'written-local-error-data',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:"ours",message:new Error("fixed")});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'undefined-data-fields',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:undefined,message:undefined});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'primitive-data-fields',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({name:0,message:false});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-native-shadow',
    source:
      'function frames(error:Error){const Error={prototype:{toString(){return "fixed";}}};return Error.prototype.toString.call({name:"ours",message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-reflect-shadow',
    source:
      'function frames(error:Error){const Reflect={apply(...values:unknown[]){return "fixed";}};return Reflect.apply(Error.prototype.toString,{name:"ours",message:error},[]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-method-data',
    source:
      'function frames(error:Error){const own={toString(){return "fixed";}};return own.toString.call({name:"ours",message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prior-error-hook-data',
    source:
      'function frames(error:Error){error.toString=()=>"fixed";return Error.prototype.toString.call({name:"ours",message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    consumerReader: false,
  },
  {
    id: 'prior-receiver-message-data',
    source:
      'function frames(error:Error){const receiver:{name:string,message:unknown}={name:"ours",message:error};receiver.message="fixed";return Error.prototype.toString.call(receiver);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'opaque-name-conversion-boundary',
    source:
      'function frames(error:Error){const name={toString(){error.toString=()=>"fixed";return "ours";}};return Error.prototype.toString.call({name, message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    consumerReader: false,
  },
  {
    id: 'getter-name-conversion-boundary',
    source:
      'function frames(error:Error){return Error.prototype.toString.call({get name(){error.toString=()=>"fixed";return "ours";},message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    consumerReader: false,
  },
  {
    id: 'ignored-tail-effects-boundary',
    source:
      'function frames(error:Error){const native:(this:{name:unknown,message:unknown},...values:unknown[])=>string=Error.prototype.toString;return native.call({name:"ours",message:error},error.toString=()=>"fixed");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    consumerReader: false,
  },
  {
    id: 'apply-list-effects-boundary',
    source:
      'function frames(error:Error){const args={get length(){error.toString=()=>"fixed";return 0;}};return Reflect.apply(Error.prototype.toString,{name:"ours",message:error},args);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    consumerReader: false,
  },
  {
    id: 'prior-unknown-work-boundary',
    source:
      'function frames(error:Error){function prepare(){error.toString=()=>"fixed";}prepare();return Error.prototype.toString.call({name:"ours",message:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    consumerReader: false,
  },
  {
    id: 'captured-receiver-boundary',
    source:
      'function frames(error:Error){const receiver={name:"ours",message:error};function text(){return Error.prototype.toString.call(receiver);}error.toString=()=>"fixed";return text();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    consumerReader: false,
  },
];

describe('native generic frame readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'frame-pair.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('native generic shared admission', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, actualRefused = refused }) => {
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
    const expected = actualRefused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});

describe('generic Error native consumer boundaries', () => {
  it.each(CASES.filter((row) => row.consumerReader !== undefined))(
    '$id',
    ({ source, consumerReader }) => {
      using api = openTypeScript();
      using parsed = parseModule(api, 'generic-consumer.ts', source);
      const pending: Node[] = [parsed.sourceFile];
      let found = false;
      let consumers = 0;
      for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
        if (
          isCallExpression(node) &&
          borrowedTextCall(node)?.path.join('.') === 'Error.prototype.toString'
        ) {
          consumers += 1;
          if (framedRead(node) !== undefined) found = true;
        }
        node.forEachChild((child) => {
          pending.push(child);
        });
      }

      expect(consumers).toBe(1);
      expect(found).toBe(consumerReader);
    },
  );
});
