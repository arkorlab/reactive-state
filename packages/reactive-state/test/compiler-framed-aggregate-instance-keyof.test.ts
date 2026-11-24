import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'aggregate-original',
    source: 'function frames(error:Error){return new AggregateError([error]).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-native-call',
    source: 'function frames(error:Error){return AggregateError([error]).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-array-input',
    source: 'function frames(errors:Error[]){return new AggregateError(errors).errors[0].stack;}',
    invocation: 'frames([new Error("ours")])',
    reader: true,
    refused: true,
  },
  {
    id: 'aggregate-selected-data',
    source:
      'function frames(error:Error){return new AggregateError([{stack:"fixed"},error]).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-local-words',
    source:
      'function frames(error:Error){return new AggregateError([new Error("fixed")]).errors[0].message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'aggregate-local-shadow',
    source:
      'function frames(error:Error){class AggregateError{errors=[{stack:"fixed"}];constructor(_values:unknown){}}return new AggregateError([error]).errors[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'instance-local-error-class',
    source:
      'class Boom extends Error{}type Failure=InstanceType<typeof Boom>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'instance-constant-class-alias',
    source:
      'class Boom extends Error{}const Raised=Boom;type Failure=InstanceType<typeof Raised>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'instance-generic-native-base',
    source:
      'class Boom<T=string>extends Error{value?:T}type Failure=InstanceType<typeof Boom>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'instance-ordinary-data-class',
    source:
      'class Data{stack="fixed"}type Failure=InstanceType<typeof Data>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Data())',
    reader: false,
    refused: false,
  },
  {
    id: 'instance-local-error-shadow',
    source:
      'class Error{stack="fixed"}class Boom extends Error{}type Failure=InstanceType<typeof Boom>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Boom())',
    reader: false,
    refused: false,
  },
  {
    id: 'instance-local-utility-shadow',
    source:
      'type InstanceType<T>={stack:string};class Boom extends Error{}type Failure=InstanceType<typeof Boom>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'keyof-interface-original',
    source:
      'interface Box{failure:Error}type Failure=Box[keyof Box];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-interface-merged',
    source:
      'interface Box{safe:string}interface Box{failure:Error}type Failure=Box[keyof Box];function frames(error:Failure){return String(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-interface-heritage-default',
    source:
      'interface Parent<T=Error>{failure:T}interface Box extends Parent{}type Failure=Box[keyof Box];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-interface-generic-supplied',
    source:
      'interface Box<T>{failure:T}type Failure=Box<Error>[keyof Box<Error>];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'keyof-interface-data',
    source:
      'interface Box{failure:{stack:string}}type Failure=Box[keyof Box];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'keyof-interface-union-common-data',
    source:
      'interface First{failure:Error;safe:{stack:string}}interface Second{safe:{stack:string}}type Box=First|Second;type Failure=Box[keyof Box];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('aggregate instance keyof readers', () => {
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

describe('aggregate instance keyof admissions', () => {
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
