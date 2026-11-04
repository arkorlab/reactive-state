import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'in-new-error-file-name',
    source: 'function frames(){return "fileName" in new Error("ours");}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'in-supplied-error-line-number',
    source: 'function frames(error:Error){return "lineNumber" in error;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'in-caught-error-column-number',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){return "columnNumber" in(error as Error);}}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'in-key-const-alias',
    source: 'function frames(error:Error){const key="fileName";return key in error;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'in-opaque-key',
    source: 'function frames(error:Error,key:string){return key in error;}',
    invocation: 'frames(new Error("ours"),"fileName")',
    refused: true,
  },
  {
    id: 'in-ordinary-name-pin',
    source: 'function frames(error:Error){return "name" in error;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'in-ordinary-data-pin',
    source: 'function frames(){return "fileName" in{fileName:"fixed"};}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'in-own-data-pin',
    source:
      'function frames(){return "fileName" in Object.defineProperty(new Error("ours"),"fileName",{value:"fixed"});}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'in-shadowed-error-pin',
    source: 'class Error{fileName="fixed";}function frames(){return "fileName" in new Error();}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'in-proxy-own-has-pin',
    source:
      'function frames(error:Error){return "fileName" in new Proxy(error,{has(){return false;}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'in-proxy-alias-own-has-pin',
    source:
      'function frames(error:Error){const proxy=new Proxy(error,{has(){return false;}});return "fileName" in proxy;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'in-proxy-own-get-forwards-has',
    source:
      'function frames(error:Error){return "fileName" in new Proxy(error,{get(){return "fixed";}});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'in-primitive-number-pin',
    source: 'function frames(error:Error){return 1 in error;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'in-symbol-key-pin',
    source: 'function frames(error:Error){return Symbol.iterator in error;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native Error presence readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-presence.ts', source);
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

describe('shared native Error presence', () => {
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
