import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A reference argument of no written variance holds only where both directions do; else both branches stay. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-contravariant-sink',
    source:
      'interface Sink<T>{consume:(value:T)=>void}type Failure=Sink<string> extends Sink<"fixed">?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contravariant-alias-sink',
    source:
      'type Sink<T>={consume:(value:T)=>void};type Failure=Sink<string> extends Sink<"fixed">?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bivariant-method-sink',
    source:
      'interface Sink<T>{consume(value:T):void}type Failure=Sink<"fixed"> extends Sink<string>?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unused-parameter',
    source:
      'interface Label<T>{label:string}type Failure=Label<string> extends Label<"fixed">?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-alias-contravariant',
    source:
      'interface Sink<T>{consume:(value:T)=>void}type Select<A,B>=Sink<A> extends Sink<B>?Error:{stack:string};function frames(value:Select<string,"fixed">){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'written-in-annotation',
    source:
      'interface Sink<in T>{consume:(value:T)=>void}type Failure=Sink<string> extends Sink<"fixed">?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unwritten-covariant-uncertain',
    source:
      'interface Source<T>{produce:()=>T}type Failure=Source<string> extends Source<"fixed">?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'identical-arguments',
    source:
      'interface Sink<T>{consume:(value:T)=>void}type Failure=Sink<string> extends Sink<string>?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'written-out-covariant-data',
    source:
      'interface Source<out T>{produce:()=>T}type Failure=Source<string> extends Source<"fixed">?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'written-in-data',
    source:
      'interface Sink<in T>{consume:(value:T)=>void}type Failure=Sink<"fixed"> extends Sink<string>?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('unwritten variance readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'unwritten-variance.ts', source);
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

describe('shared unwritten variance admissions', () => {
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
