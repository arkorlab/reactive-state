import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** JSON property lists retain actual inherited member observations separately from nested values. */
const CASES = [
  {
    id: 'reported-inherited-stack',
    source:
      "function frames(error: Error) { return JSON.stringify({__proto__: error}, ['stack']); }",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quoted-prototype-stack',
    source: "function frames(error:Error){return JSON.stringify({'__proto__':error},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'two-literal-prototype-levels',
    source:
      "function frames(error:Error){return JSON.stringify({__proto__:{__proto__:error}},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-listed-prototype-record',
    source:
      "function frames(error:Error){return JSON.stringify({failure:{__proto__:error}},['failure','stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-prototype-error-stack',
    source: "function frames(){return JSON.stringify({__proto__:new Error('ours')},['stack']);}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'supplied-prototype-message',
    source: "function frames(error:Error){return JSON.stringify({__proto__:error},['message']);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-receiver-and-key-aliases',
    source:
      "function frames(error:Error){const value={__proto__:error};const keys=['stack'];return JSON.stringify(value,keys);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-call-inherited-stack',
    source:
      "function frames(error:Error){return JSON.stringify.call(null,{__proto__:error},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-reflect-inherited-stack',
    source:
      "function frames(error:Error){return Reflect.apply(JSON.stringify,null,[{__proto__:error},['stack']]);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-contained-prototype-record',
    source: "function frames(error:Error){return JSON.stringify([{__proto__:error}],['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-error-value-existing-pin',
    source:
      "function frames(box:{failure:Error}){return JSON.stringify({__proto__:box},['failure','stack']);}",
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'own-stack-data-shadows-prototype',
    source:
      "function frames(error:Error){return JSON.stringify({__proto__:error,stack:'fixed'},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-stack-getter-shadows-prototype',
    source:
      "function frames(error:Error){return JSON.stringify({__proto__:error,get stack(){return'fixed';}},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-setter-only-shadows-prototype',
    source:
      "function frames(error:Error){return JSON.stringify({__proto__:error,set stack(_value:unknown){}},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-proto-is-own-data',
    source: "function frames(error:Error){return JSON.stringify({['__proto__']:error},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'shorthand-proto-is-own-data',
    source:
      "function frames(error:Error){const __proto__=error;return JSON.stringify({__proto__},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'null-prototype-literal-data',
    source: "function frames(){return JSON.stringify({__proto__:null,stack:'fixed'},['stack']);}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'empty-property-list-keeps-data',
    source: 'function frames(error:Error){return JSON.stringify({__proto__:error},[]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'default-enumeration-keeps-data',
    source: 'function frames(error:Error){return JSON.stringify({__proto__:error});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unselected-frame-name-keeps-data',
    source: "function frames(error:Error){return JSON.stringify({__proto__:error},['name']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-prototype-error-words',
    source: "function frames(){return JSON.stringify({__proto__:new Error('ours')},['message']);}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'opaque-spread-does-not-copy-stack',
    source: "function frames(error:Error){return JSON.stringify({...error},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-tojson-replaces-prototype-record',
    source:
      "function frames(error:Error){return JSON.stringify({__proto__:error,toJSON(){return{stack:'fixed'};}},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'inherited-tojson-replaces-record',
    source:
      "function frames(error:Error){return JSON.stringify({__proto__:{__proto__:error,toJSON(){return{stack:'fixed'};}}},['stack']);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fresh-prototype-installed-stack-data',
    source:
      "function frames(){return JSON.stringify({__proto__:Object.defineProperty(new Error('ours'),'stack',{value:'fixed'})},['stack']);}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'fresh-prototype-installed-stack-getter',
    source:
      "function frames(){return JSON.stringify({__proto__:Object.defineProperty(new Error('ours'),'stack',{get(){return'fixed';}})},['stack']);}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'earlier-local-assign-repair-keeps-boundary',
    source:
      "function frames(){const error=new Error('ours');Object.assign(error,{stack:'fixed'});return JSON.stringify({__proto__:error},['stack']);}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'earlier-getter-assign-repair-keeps-boundary',
    source:
      "function frames(){const error=new Error('ours');return JSON.stringify({__proto__:error,get repair(){Object.assign(error,{stack:'fixed'});return 0;}},['repair','stack']);}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'third-argument-repair-keeps-boundary',
    source:
      "function frames(error:Error){return JSON.stringify({__proto__:error},['stack'],(Object.assign(error,{stack:'fixed'}),0));}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('inherited JSON listed-member readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'inherited-json-members.ts', source);
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

describe('shared inherited JSON listed-member text', () => {
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
