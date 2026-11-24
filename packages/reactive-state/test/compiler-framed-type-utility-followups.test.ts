import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'omit-generic-alias-default',
    source:
      'type Drop<T=Error>=OmitThisParameter<(this:T)=>T>;type Failure=ReturnType<Drop>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'omit-qualified-global-utility',
    source:
      'type Failure=ReturnType<globalThis.OmitThisParameter<(this:object)=>Error>>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'omit-inferred-this-does-not-survive',
    source:
      'type Fn=OmitThisParameter<(this:Error)=>number>;type Failure=Fn extends(this:infer R)=>unknown?R:{stack:string};function frames(error:Failure){return(error as{stack:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'omit-final-data-overload',
    source:
      'interface Fn{(this:Error):Error;(this:Error):{stack:string}}type Failure=ReturnType<OmitThisParameter<Fn>>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'omit-final-error-overload',
    source:
      'interface Fn{(this:Error):{stack:string};(this:Error):Error}type Failure=ReturnType<OmitThisParameter<Fn>>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'indexed-method-supplied-generic',
    source:
      'interface Box<T>{make():T}type Failure=ReturnType<Box<Error>["make"]>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'indexed-method-generic-shadow-pin',
    source:
      'interface Box<T=Error>{make<T>():T}type Failure=ReturnType<Box["make"]>;function frames(error:Failure){return(error as{stack:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'indexed-recursive-method-finite-member',
    source:
      'interface Box{make():Box;error:Error}type Failure=ReturnType<Box["make"]>["error"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'indexed-recursive-method-value-pin',
    source:
      'interface Box{make():Box;error:Error}type Failure=ReturnType<Box["make"]>["make"];function frames(value:Failure){return(value as unknown as{stack:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
];

describe('utility receiver followup readers', () => {
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

describe('shared utility receiver followups', () => {
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
