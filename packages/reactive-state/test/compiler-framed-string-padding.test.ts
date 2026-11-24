import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native string padding converts its fill value only when padding is required. */
const CASES = [
  {
    id: 'padEnd-supplied',
    source: "function frames(error:Error){return ''.padEnd(100,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'padStart-supplied',
    source: "function frames(error:Error){return ''.padStart(100,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pad-caught',
    source:
      "function frames(){try{JSON.parse('bad');}catch(error){return ''.padEnd(100,error as never);}}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'pad-typed-string',
    source: 'function frames(text:string,error:Error){return text.padStart(100,error as never);}',
    invocation: 'frames("",new Error("ours"))',
    refused: true,
  },
  {
    id: 'pad-borrowed-call',
    source:
      "function frames(error:Error){return String.prototype.padEnd.call('',100,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pad-borrowed-apply',
    source:
      "function frames(error:Error){return String.prototype.padStart.apply('',[100,error as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pad-reflect-apply',
    source:
      "function frames(error:Error){return Reflect.apply(String.prototype.padEnd,'',[100,error]);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pad-bracket',
    source: "function frames(error:Error){return ''['padStart'](100,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pad-plain-data',
    source: "function frames(){return ''.padEnd(100,'fixed');}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'pad-made-words',
    source: "function frames(){return ''.padEnd(100,new Error('ours') as never);}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'pad-zero-size',
    source: "function frames(error:Error){return ''.padEnd(0,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'pad-shorter-size',
    source: "function frames(error:Error){return 'fixed'.padStart(1,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'pad-error-size',
    source: "function frames(error:Error){return ''.padEnd(error as never,'fixed');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'pad-extra-argument-ignored',
    source:
      "function frames(error:Error){return (''.padEnd as (...args:unknown[])=>string)(100,'fixed',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'pad-own-method',
    source:
      "function frames(error:Error){const own={padEnd(_size:unknown,_fill:unknown){return 'fixed';}};return own.padEnd(100,error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'pad-shadowed-String',
    source:
      "function frames(error:Error){const String=()=>({padStart(_size:unknown,_fill:unknown){return 'fixed';}});return String().padStart(100,error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native string padding readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'string-padding-words.ts', source);
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

describe('shared native string padding words', () => {
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
