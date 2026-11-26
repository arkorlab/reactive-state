import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A non-inference requirement is met by any written overload of a source method, as TypeScript's
 * relation is; inference keeps reading the final overload.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-string-overload',
    source:
      'type Data={stack:string};type Failure={f(value:string):void;f(value:number):void} extends {f(value:string):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reversed-overloads',
    source:
      'type Data={stack:string};type Failure={f(value:number):void;f(value:string):void} extends {f(value:string):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'property-target',
    source:
      'type Data={stack:string};type Failure={f(value:string):void;f(value:number):void} extends {f:(value:string)=>void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-overloads',
    source:
      'type Data={stack:string};interface Merged{f(value:string):void}interface Merged{f(value:number):void}type Failure=Merged extends {f(value:string):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-reversed',
    source:
      'type Data={stack:string};interface Merged{f(value:number):void}interface Merged{f(value:string):void}type Failure=Merged extends {f(value:string):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'aliased-overloads',
    source:
      'type Data={stack:string};type Source={f(value:string):void;f(value:number):void};type Failure=Source extends {f(value:string):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'no-matching-overload',
    source:
      'type Data={stack:string};type Failure={f(value:number):void;f(value:boolean):void} extends {f(value:string):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'result-mismatch-overloads',
    source:
      'type Data={stack:string};type Failure={f():string;f(value:number):number} extends {f():number}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'inferred-final-overload',
    source:
      'type Data={stack:string};type Failure={f(value:string):Error;f(value:number):Data} extends {f(value:number):infer R}?R:never;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'single-mismatch',
    source:
      'type Data={stack:string};type Failure={f(value:number):void} extends {f(value:string):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('overloaded relation readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'overloaded-relations.ts', source);
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

describe('shared overloaded relation admissions', () => {
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
