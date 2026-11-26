import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Headers consume Error words; CustomEvent retains its existing shared-global policy. */
const CASES = [
  {
    id: 'headers-entry-value',
    source: 'function frames(error:Error){return new Headers([["x",error as never]]).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    actualRefused: true,
  },
  {
    id: 'headers-record-value',
    source: 'function frames(error:Error){return new Headers({x:error as never}).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    actualRefused: true,
  },
  {
    id: 'headers-constructor-alias',
    source:
      'const Native=Headers;function frames(error:Error){return new Native({x:error as never}).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    actualRefused: true,
  },
  {
    id: 'headers-literal-spread',
    source: 'function frames(error:Error){return new Headers({...{x:error as never}}).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    actualRefused: true,
  },
  {
    id: 'headers-data',
    source: 'function frames(){return new Headers({x:"fixed"}).get("x");}',
    invocation: 'frames()',
    refused: false,
    reader: true,
    actualRefused: false,
  },
  {
    id: 'headers-overwritten-data',
    source:
      'function frames(error:Error){return new Headers({...{x:error as never},x:"fixed"}).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    reader: true,
    actualRefused: false,
  },
  {
    id: 'headers-local-words',
    source: 'function frames(){return new Headers({x:new Error("fixed")as never}).get("x");}',
    invocation: 'frames()',
    refused: false,
    reader: true,
    actualRefused: false,
  },
  {
    id: 'headers-local-shadow',
    source:
      'const Headers=class{constructor(_value:unknown){}get(_key:string){return "fixed";}};function frames(error:Error){return new Headers({x:error}).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    reader: true,
    actualRefused: false,
  },
  {
    id: 'event-detail-stack',
    source:
      'function frames(error:Error){return new CustomEvent("fixed",{detail:error}).detail.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: false,
    actualRefused: true,
  },
  {
    id: 'event-detail-words',
    source:
      'function frames(error:Error){return new CustomEvent("fixed",{detail:error}).detail.message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: false,
    actualRefused: true,
  },
  {
    id: 'event-detail-alias',
    source:
      'const Native=CustomEvent;function frames(error:Error){return new Native("fixed",{detail:error}).detail.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: false,
    actualRefused: true,
  },
  {
    id: 'event-detail-literal-spread',
    source:
      'function frames(error:Error){return new CustomEvent("fixed",{...{detail:error}}).detail.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: false,
    actualRefused: true,
  },
  {
    id: 'event-detail-data',
    source:
      'function frames(error:Error){return new CustomEvent("fixed",{detail:{stack:"fixed"}}).detail.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    reader: false,
    actualRefused: true,
  },
  {
    id: 'event-detail-overwritten',
    source:
      'function frames(error:Error){return new CustomEvent("fixed",{...{detail:error},detail:{stack:"fixed"}}).detail.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    reader: false,
    actualRefused: true,
  },
  {
    id: 'event-detail-local-words',
    source:
      'function frames(){return new CustomEvent("fixed",{detail:new Error("fixed")}).detail.message;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
    actualRefused: true,
  },
  {
    id: 'event-detail-local-stack',
    source:
      'function frames(){return new CustomEvent("fixed",{detail:new Error("fixed")}).detail.stack;}',
    invocation: 'frames()',
    refused: true,
    reader: false,
    actualRefused: true,
  },
  {
    id: 'event-detail-local-shadow',
    source:
      'const CustomEvent=class{readonly detail={stack:"fixed"};constructor(_type:string,_options:unknown){}};function frames(error:Error){return new CustomEvent("fixed",{detail:error}).detail.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    reader: false,
    actualRefused: false,
  },
];

describe('native header and global policy word readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-events-words.ts', source);
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

describe('shared native header and global policy words', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, actualRefused }) => {
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
