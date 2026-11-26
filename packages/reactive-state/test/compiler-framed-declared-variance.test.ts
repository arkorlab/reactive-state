import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Declared generic variance changes only non-inference reference relations in original scopes. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'declared-in-string-to-literal-error',
    source:
      'type Data={stack:string};interface Consumer<in T>{consume(value:T):void}type Failure=Consumer<string> extends Consumer<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-in-literal-to-string-data',
    source:
      'type Data={stack:string};interface Consumer<in T>{consume(value:T):void}type Failure=Consumer<"x"> extends Consumer<string>?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'declared-in-same-literal-error-pin',
    source:
      'type Data={stack:string};interface Consumer<in T>{consume(value:T):void}type Failure=Consumer<"x"> extends Consumer<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-in-unrelated-data-pin',
    source:
      'type Data={stack:string};interface Consumer<in T>{consume(value:T):void}type Failure=Consumer<number> extends Consumer<string>?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'declared-in-property-callable-error',
    source:
      'type Data={stack:string};interface Consumer<in T>{consume:(value:T)=>void}type Failure=Consumer<string> extends Consumer<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-in-alias-error',
    source:
      'type Data={stack:string};interface Consumer<in T>{consume(value:T):void}type Input<T>=Consumer<T>;type Failure=Input<string> extends Input<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-in-default-error',
    source:
      'type Data={stack:string};interface Consumer<in T=string>{consume(value:T):void}type Failure=Consumer extends Consumer<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-in-merged-error',
    source:
      'type Data={stack:string};interface Consumer<T>{consume(value:T):void}interface Consumer<in T>{}type Failure=Consumer<string> extends Consumer<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-in-class-error',
    source:
      'type Data={stack:string};class Consumer<in T>{consume(value:T):void{void value;}}type Failure=Consumer<string> extends Consumer<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-out-literal-to-string-error-pin',
    source:
      'type Data={stack:string};interface Producer<out T>{readonly value:T}type Failure=Producer<"x"> extends Producer<string>?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-out-string-to-literal-data-pin',
    source:
      'type Data={stack:string};interface Producer<out T>{readonly value:T}type Failure=Producer<string> extends Producer<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'declared-inout-literal-to-string-data',
    source:
      'type Data={stack:string};interface Cell<in out T>{value:T;write(value:T):void}type Failure=Cell<"x"> extends Cell<string>?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'declared-inout-string-to-literal-data-pin',
    source:
      'type Data={stack:string};interface Cell<in out T>{value:T;write(value:T):void}type Failure=Cell<string> extends Cell<"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'declared-inout-same-type-error-pin',
    source:
      'type Data={stack:string};interface Cell<in out T>{value:T;write(value:T):void}type Failure=Cell<string> extends Cell<string>?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-input-output-distinct-error',
    source:
      'type Data={stack:string};interface Pipe<in I,out O>{read(input:I):O}type Failure=Pipe<string,"x"> extends Pipe<"x",string>?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-input-output-distinct-data',
    source:
      'type Data={stack:string};interface Pipe<in I,out O>{read(input:I):O}type Failure=Pipe<"x",string> extends Pipe<string,"x">?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'declared-in-infer-error-pin',
    source:
      'type Data={stack:string};interface Consumer<in T>{consume(value:T):void}type Extract<T>=T extends Consumer<infer R>?R:never;type Failure=Extract<Consumer<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-in-infer-data-pin',
    source:
      'type Data={stack:string};interface Consumer<in T>{consume(value:T):void}type Extract<T>=T extends Consumer<infer R>?R:never;type Failure=Extract<Consumer<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'declared-inout-infer-error-pin',
    source:
      'type Data={stack:string};interface Cell<in out T>{consume(value:T):void;value:T}type Extract<T>=T extends Cell<infer R>?R:never;type Failure=Extract<Cell<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-inout-infer-data-pin',
    source:
      'type Data={stack:string};interface Cell<in out T>{consume(value:T):void;value:T}type Extract<T>=T extends Cell<infer R>?R:never;type Failure=Extract<Cell<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('declared variance readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'declared-variance.ts', source);
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

describe('shared declared variance admissions', () => {
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
