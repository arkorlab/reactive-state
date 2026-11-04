import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'keyof-string-index',
    source:
      'type Bag = {[key:string]:Error};function frames(error:Bag[keyof Bag]){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-number-index',
    source:
      'type Bag = {[key:number]:Error};function frames(error:Bag[keyof Bag]){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-generic-index',
    source:
      'type Bag<T> = {[key:string]:T};function frames(error:Bag<Error>[keyof Bag<Error>]){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-interface-index',
    source:
      'interface Bag {[key:string]:Error}function frames(error:Bag[keyof Bag]){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-inherited-index',
    source:
      'interface Base<T> {[key:string]:T}interface Bag extends Base<Error>{}function frames(error:Bag[keyof Bag]){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-index-data',
    source:
      'type Bag = {[key:string]:{stack:string}};function frames(error:Bag[keyof Bag]){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'keyof-empty-never',
    source:
      'type Bag = {};function frames(error:Bag[keyof Bag]){return (error as {stack:string}).stack;}',
    invocation: 'frames(undefined as never)',
    reader: false,
    refused: false,
  },
  {
    id: 'keyof-common-data',
    source:
      'type Bag = {same:{stack:string};failure:Error}|{same:{stack:string}};function frames(error:Bag[keyof Bag]){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'awaited-promise',
    source: 'function frames(error:Awaited<Promise<Error>>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'awaited-promise-like',
    source: 'function frames(error:Awaited<PromiseLike<Error>>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'awaited-nested',
    source: 'function frames(error:Awaited<Promise<PromiseLike<Error>>>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'awaited-generic-alias',
    source:
      'type Later<T=Error> = Awaited<Promise<T>>;function frames(error:Later){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'awaited-promise-union',
    source: 'function frames(error:Awaited<Promise<Error|{stack:string}>>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'awaited-local-promise-data',
    source:
      'type Promise<T>={stack:string;value?:T};function frames(error:Awaited<Promise<Error>>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'awaited-local-promise-like-data',
    source:
      'type PromiseLike<T>={stack:string;value?:T};function frames(error:Awaited<PromiseLike<Error>>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'awaited-local-utility-data',
    source:
      'type Awaited<T>={stack:string;value?:T};function frames(error:Awaited<Promise<Error>>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'awaited-ordinary-data',
    source: 'function frames(error:Awaited<Promise<{stack:string}>>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'awaited-direct-error-pin',
    source: 'function frames(error:Awaited<Error>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-merged-index',
    source:
      'interface Bag {failure:Error}interface Bag {[key:string]:Error}function frames(error:Bag[keyof Bag]){return error.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'keyof-nearest-index-data',
    source:
      'type Data={stack:string};interface Base {[key:string]:Error|Data}interface Bag extends Base {[key:string]:Data}function frames(error:Bag[keyof Bag]){return error.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'keyof-number-index-plus-field',
    source:
      'type Bag={[key:number]:Error;label:{stack:string}};function frames(error:Bag[keyof Bag]){return error.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'keyof-finite-union-error',
    source:
      'type Bag = {[key:string]:Error; safe:Error}|{safe:Error};function frames(error:Bag[keyof Bag]){return error.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'keyof-finite-union-data',
    source:
      'type Data={stack:string};type Bag = {[key:string]:Error|Data; safe:Data}|{safe:Data};function frames(error:Bag[keyof Bag]){return error.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'keyof-index-object-environment',
    source:
      'type Bag<T>={[key:string]:T};function frames(error:Bag<{stack:string}>[keyof Bag<Error>]){return error.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'awaited-actual-data',
    source:
      'type Later<T=Error>=Awaited<Promise<T>>;function frames(error:Later<{stack:string}>){return error.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'awaited-qualified-promise',
    source: 'function frames(error:Awaited<globalThis.Promise<Error>>){return error.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'awaited-finite-repeated-generic',
    source:
      'type Later<T>=Promise<T>;function frames(error:Awaited<Later<Later<Error>>>){return error.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('indexed and awaited type readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
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

describe('indexed and awaited type admissions', () => {
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
