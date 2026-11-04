import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Direct positional arguments retain unchanged simple parameter origins. */
const CASES = [
  {
    id: 'arguments-first-error',
    source: 'function frames(error:Error){return arguments[0].stack;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-second-error',
    source: 'function frames(first:string,error:Error){return arguments[1].stack;}',
    refused: true,
    reader: true,
    invocation: 'frames("first",new Error("ours"))',
  },
  {
    id: 'arguments-string-index-error',
    source: 'function frames(error:Error){return arguments["0"].stack;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-qualified-alias-error',
    source: 'type Failure=Error;function frames(error:Failure){return arguments[0].stack;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-nested-field-error',
    source: 'function frames(box:{failure:Error}){return arguments[0].failure.stack;}',
    refused: true,
    reader: true,
    invocation: 'frames({failure:new Error("ours")})',
  },
  {
    id: 'arguments-selected-tuple-error',
    source: 'function frames(box:[{stack:string},Error]){return arguments[0][1].stack;}',
    refused: true,
    reader: true,
    invocation: 'frames([{stack:"fixed"},new Error("ours")])',
  },
  {
    id: 'arguments-function-expression-error',
    source: 'const frames=function(error:Error){return arguments[0].stack;};',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-direct-method-error',
    source:
      'function frames(error:Error){return({read(value:Error){return arguments[0].stack;}}).read(error);}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-explicit-this-pseudo-param',
    source: 'function frames(this:{tag:string},error:Error){return arguments[0].stack;}',
    refused: true,
    reader: true,
    invocation: 'frames.call({tag:"fixed"},new Error("ours"))',
  },
  {
    id: 'arguments-strict-directive-error',
    source: 'function frames(error:Error){"use strict";return arguments[0].stack;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-data-param-pin',
    source: 'function frames(value:{stack:string}){return arguments[0].stack;}',
    refused: false,
    reader: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'arguments-unselected-field-data-pin',
    source:
      'function frames(box:{failure:Error,data:{stack:string}}){return arguments[0].data.stack;}',
    refused: false,
    reader: false,
    invocation: 'frames({failure:new Error("ours"),data:{stack:"fixed"}})',
  },
  {
    id: 'arguments-slot-write-data-pin',
    source: 'function frames(error:Error){arguments[0]={stack:"fixed"};return arguments[0].stack;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-slot-descriptor-data-pin',
    source:
      'function frames(error:Error){Object.defineProperty(arguments,"0",{get(){return{stack:"fixed"};}});return arguments[0].stack;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-error-own-stack-data-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return arguments[0].stack;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-earlier-callback-data-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:()=>void){head();return arguments[0].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-parameter-reassignment-data-pin',
    source:
      'function frames(value:{stack?:string}){value=new Error("local");return arguments[0].stack;}',
    refused: false,
    reader: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'arguments-default-omitted-slot-pin',
    source: 'function frames(error:Error=new Error("fixed")){return arguments[0]?.stack;}',
    refused: false,
    reader: false,
    invocation: 'frames()',
  },
  {
    id: 'arguments-extra-omitted-slot-pin',
    source: 'function frames(error:Error){return arguments[1]?.stack;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-noncanonical-string-index-pin',
    source:
      'function frames(error:Error){return (arguments as unknown as Record<string,{stack?:string}>)["00"]?.stack;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'arguments-property-shadow-data-pin',
    source: 'function frames(box:{arguments:{stack:string}[]}){return box.arguments[0]?.stack;}',
    refused: false,
    reader: false,
    invocation: 'frames({arguments:[{stack:"fixed"}]})',
  },
  {
    id: 'arguments-local-error-type-data-pin',
    source: 'type Error={stack:string};function frames(value:Error){return arguments[0].stack;}',
    refused: false,
    reader: false,
    invocation: 'frames({stack:"fixed"})',
  },
];

describe('positional arguments readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reflected-blob.ts', source);
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

describe('positional arguments admissions', () => {
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
