import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'readonly-interface-heritage-original',
    source:
      'interface Failure extends Readonly<Error>{}function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'readonly-qualified-interface-heritage',
    source:
      'interface Failure extends globalThis.Readonly<Error>{}function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'readonly-local-shadow-pin',
    source:
      'type Readonly<T>={stack:string};interface Failure extends Readonly<Error>{}function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'readonly-heritage-local-default',
    source:
      'type Parent<T=Error>=Readonly<T>;interface Failure extends Parent{}function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'omit-this-returntype-original',
    source:
      'type Factory=OmitThisParameter<(this:object)=>Error>;type Failure=ReturnType<Factory>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'omit-this-return-data-pin',
    source:
      'type Factory=OmitThisParameter<(this:Error)=>{stack:string}>;type Failure=ReturnType<Factory>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'omit-this-receiver-does-not-survive-pin',
    source:
      'type Factory=OmitThisParameter<(this:Error)=>number>;type Failure=ThisParameterType<Factory>;function frames(error:Failure){return(error as {stack:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'omit-this-parameters-keep-value',
    source:
      'type Factory=OmitThisParameter<(this:Error,value:Error)=>void>;type Failure=Parameters<Factory>[0];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'omit-this-local-shadow-pin',
    source:
      'type OmitThisParameter<T>=()=>{stack:string};type Failure=ReturnType<OmitThisParameter<()=>Error>>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'indexed-interface-method-original',
    source:
      'interface Box{make():Error}type Failure=ReturnType<Box["make"]>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'indexed-method-value-is-not-result-pin',
    source:
      'interface Box{make():Error}type Failure=Box["make"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'indexed-method-final-data-overload-pin',
    source:
      'interface Box{make():Error;make():{stack:string}}type Failure=ReturnType<Box["make"]>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'indexed-method-final-error-overload',
    source:
      'interface Box{make():{stack:string};make():Error}type Failure=ReturnType<Box["make"]>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'indexed-method-generic-default',
    source:
      'interface Box<T=Error>{make():T}type Failure=ReturnType<Box["make"]>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'indexed-method-local-returntype-pin',
    source:
      'interface Box{make():Error}type ReturnType<T>={stack:string};type Failure=ReturnType<Box["make"]>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
];

describe('written utility result readers', () => {
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

describe('shared written utility results', () => {
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
