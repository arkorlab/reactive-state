import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A weak object pattern needs a property in common with a source that holds one. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-weak-target',
    source:
      'type Failure={caption:string} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'two-optional-target-members',
    source:
      'type Failure={caption:string} extends {message?:string;name?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'method-source-member',
    source:
      'type Failure={caption():string} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-source-member',
    source:
      'type Failure={caption?:string} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'weak-infer-pattern',
    source:
      'type Failure={caption:string} extends {message?:infer M}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'union-source-constituent',
    source:
      'type Failure={caption:string}|{message:string} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'distributed-generic-source',
    source:
      'type Select<T>=T extends {message?:string}?{stack:string}:Error;function frames(value:Select<{caption:string}>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'intersection-source',
    source:
      'type Failure={caption:string}&{label:string} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'interface-source',
    source:
      'interface Captioned{caption:string}type Failure=Captioned extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'callable-source',
    source:
      'type Failure={():void} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shared-property-data',
    source:
      'type Failure={caption:string;message:string} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-source-data',
    source:
      'type Failure={} extends {message?:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'required-target-member-data',
    source:
      'type Failure={caption:string} extends {message?:string;caption:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'distributed-shared-data',
    source:
      'type Select<T>=T extends {message?:string}?{stack:string}:Error;function frames(value:Select<{message:string}>){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'required-target-refused',
    source:
      'type Failure={caption:string} extends {message:string}?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('weak object pattern readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'weak-object-patterns.ts', source);
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

describe('shared weak object pattern admissions', () => {
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
