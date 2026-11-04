import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native URI arguments and the selected replacement callback retain their consumed words. */
const CASES = [
  {
    id: 'uri-encodeURI',
    source: 'function frames(error:Error){return encodeURI(error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'uri',
  },
  {
    id: 'uri-encodeURIComponent',
    source: 'function frames(error:Error){return encodeURIComponent(error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'uri',
  },
  {
    id: 'uri-decodeURI',
    source: 'function frames(error:Error){return decodeURI(error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'uri',
  },
  {
    id: 'uri-decodeURIComponent',
    source: 'function frames(error:Error){return decodeURIComponent(error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'uri',
  },
  {
    id: 'uri-call',
    source: 'function frames(error:Error){return encodeURI.call(undefined,error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'uri',
  },
  {
    id: 'uri-reflect',
    source: 'function frames(error:Error){return Reflect.apply(decodeURI,undefined,[error]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'uri',
  },
  {
    id: 'uri-alias',
    source:
      'function frames(error:Error){const convert=encodeURIComponent;return convert(error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'uri',
  },
  {
    id: 'uri-data',
    source: "function frames(){return encodeURIComponent('fixed');}",
    invocation: 'frames()',
    refused: false,
    topic: 'uri',
  },
  {
    id: 'uri-shadow',
    source:
      "function frames(error:Error){const encodeURI=(_value:unknown)=>'fixed';return encodeURI(error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'uri',
  },
  {
    id: 'uri-own-words',
    source: "function frames(){return encodeURI(new Error('ours') as never);}",
    invocation: 'frames()',
    refused: false,
    topic: 'uri',
  },
  {
    id: 'uri-ignored-tail',
    source:
      "function frames(error:Error){return (encodeURI as (...args:unknown[])=>string)('fixed',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'uri',
  },
  {
    id: 'callback-reassigned-before',
    source:
      "function frames(error:Error){function replacement(){return 'fixed';}replacement=()=>error as never;return 'x'.replace('x',replacement);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'callback',
  },
  {
    id: 'callback-reassigned-after',
    source:
      "function frames(error:Error){function replacement(){return 'fixed';}const text='x'.replace('x',replacement);replacement=()=>error as never;return text;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'callback',
  },
  {
    id: 'callback-false-write',
    source:
      "function frames(error:Error){function replacement(){return 'fixed';}if(false)replacement=()=>error as never;return 'x'.replace('x',replacement);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'callback',
  },
  {
    id: 'callback-capture-before',
    source:
      "function frames(error:Error){function replacement(){return 'fixed';}const captured=replacement;replacement=()=>error as never;return 'x'.replace('x',captured);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'callback',
  },
  {
    id: 'callback-capture-after',
    source:
      "function frames(error:Error){function replacement(){return 'fixed';}replacement=()=>error as never;const captured=replacement;return 'x'.replace('x',captured);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'callback',
  },
  {
    id: 'callback-let-write',
    source:
      "function frames(error:Error){let replacement=()=> 'fixed';replacement=()=>error as never;return 'x'.replace('x',replacement);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'callback',
  },
  {
    id: 'callback-const-data',
    source:
      "function frames(){const replacement=()=> 'fixed';return 'x'.replace('x',replacement);}",
    invocation: 'frames()',
    refused: false,
    topic: 'callback',
  },
  {
    id: 'uri-ignored-this',
    source: "function frames(error:Error){return encodeURI.call(error,'fixed');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'uri',
  },
];

describe('native encoding and callback readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-encoding-callbacks.ts', source);
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

describe('shared native encoding and callbacks', () => {
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
