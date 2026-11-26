import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'escape-direct',
    source: 'function frames(error:Error){return escape(error as never);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'unescape-direct',
    source: 'function frames(error:Error){return unescape(error as never);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'escape-borrowed-call',
    source: 'function frames(error:Error){return escape.call(null,error as never);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'unescape-native-alias',
    source:
      'const decode=unescape;function frames(error:Error){return decode.apply(null,[error as never]);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'escape-reflect-apply',
    source: 'function frames(error:Error){return Reflect.apply(escape,null,[error]);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'escape-local-shadow',
    source:
      'function frames(error:Error){const escape=(_value:unknown)=>"fixed";return escape(error);}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'unescape-object-method',
    source:
      'function frames(error:Error){const data={unescape:(_value:unknown)=>"fixed"};return data.unescape(error);}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'escape-local-error',
    source: 'function frames(){return escape(new Error("fixed")as never);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'escape-ignored-this',
    source: 'function frames(error:Error){return escape.call(error,"fixed");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'unescape-ignored-extra-argument',
    source: 'function frames(error:Error){return Reflect.apply(unescape,null,["fixed",error]);}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
];

describe('native legacy-uri word readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-legacy-uri-words.ts', source);
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

describe('shared native legacy-uri words', () => {
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
