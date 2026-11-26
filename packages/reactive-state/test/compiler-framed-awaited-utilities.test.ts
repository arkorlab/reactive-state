import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Awaited retains resolved native utility results while open thenable-capable parameters stay opaque. */
const CASES = [
  {
    id: 'open-error-constraint-existing-opacity',
    source: 'function frames<T extends Error>(value:Awaited<T>){return value.stack;}',
    invocation: 'frames<Error>(new Error("ours"))',
    refused: false,
    runtime: 'frames',
  },
  {
    id: 'open-thenable-constraint-data',
    source:
      'type ThenableFailure=Error&{then(onfulfilled:(value:{stack:string})=>unknown):unknown};function frames<T extends Error>(value:Awaited<T>){return value.stack;}',
    invocation: 'frames<ThenableFailure>({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-return-error',
    source:
      'type Failure=Awaited<ReturnType<()=>Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-return-promise-error',
    source:
      'type Failure=Awaited<ReturnType<()=>Promise<Error>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-return-thenable-data',
    source:
      'type Failure=Awaited<ReturnType<()=>Error&{then(onfulfilled:(value:{stack:string})=>unknown):unknown}>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-return-data',
    source:
      'type Failure=Awaited<ReturnType<()=>{stack:string}>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-return-generic-alias-error',
    source:
      'type Maker<T>=()=>Promise<T>;type Failure=Awaited<ReturnType<Maker<Error>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-return-generic-default-error',
    source:
      'type Maker<T=Error>=()=>PromiseLike<T>;type Failure=Awaited<ReturnType<Maker>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-nested-native-utility-error',
    source:
      'type Failure=Awaited<Awaited<Promise<Error>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-return-utility-chain-error',
    source:
      'type Failure=Awaited<ReturnType<()=>ReturnType<()=>Promise<Error>>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-global-utility-error',
    source:
      'type Failure=globalThis.Awaited<globalThis.ReturnType<()=>globalThis.Promise<globalThis.Error>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-return-native-overload-last-error',
    source:
      'type Maker={():{stack:string};():Promise<Error>};type Failure=Awaited<ReturnType<Maker>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-return-native-overload-last-data-pin',
    source:
      'type Maker={():Error;():Promise<{stack:string}>};type Failure=Awaited<ReturnType<Maker>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-return-union-error',
    source:
      'type Failure=Awaited<ReturnType<(()=>Error)|(()=>{stack:string})>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-own-generic-return-constraint-error',
    source:
      'type Failure=Awaited<ReturnType<<T extends Error>()=>T>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-own-generic-return-thenable-data-pin',
    source:
      'type ThenableFailure=Error&{then(onfulfilled:(value:{stack:string})=>unknown):unknown};type Failure=Awaited<ReturnType<<T extends ThenableFailure>()=>T>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-generic-return-object-signature-error',
    source:
      'type Failure=Awaited<ReturnType<{<T extends Error>():T}>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-generic-return-chained-constraint-error',
    source:
      'type Failure=Awaited<ReturnType<<T extends Error,U extends T>()=>U>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-generic-return-shadow-data-pin',
    source:
      'type Error={stack:string};type Failure=Awaited<ReturnType<<T extends Error>()=>T>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-return-generic-selected-data-pin',
    source:
      'type Maker<T> = ()=>T;type Failure=Awaited<ReturnType<Maker<{stack:string}>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-local-return-type-shadow-data-pin',
    source:
      'type ReturnType<T>={stack:string};type Failure=Awaited<ReturnType<()=>Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-local-utility-shadow-data-pin',
    source:
      'type Awaited<T>={stack:string};type Failure=Awaited<ReturnType<()=>Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-local-promise-shadow-data-pin',
    source:
      'type Promise<T>={stack:string};type Failure=Awaited<ReturnType<()=>Promise<Error>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-error-shadow-data-pin',
    source:
      'type Error={stack:string};type Failure=Awaited<ReturnType<()=>Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-existing-noinfer-error-pin',
    source:
      'type Failure=Awaited<NoInfer<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-direct-error-pin',
    source: 'type Failure=Awaited<Error>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-thenable-intersection-data-pin',
    source:
      'type Failure=Awaited<Error&{then(onfulfilled:(value:{stack:string})=>unknown):unknown}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-unconstrained-return-data-pin',
    source:
      'type Failure=Awaited<ReturnType<<T>()=>T>>;function frames(value:Failure){return(value as{stack:string}).stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-default-only-return-data-pin',
    source:
      'type Failure=Awaited<ReturnType<<T=Error>()=>T>>;function frames(value:Failure){return(value as{stack:string}).stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-finite-nested-actual-error',
    source:
      'type Result<T>=Awaited<ReturnType<()=>T>>;type Failure=Result<Result<Promise<Error>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-finite-nested-actual-data-pin',
    source:
      'type Result<T>=Awaited<ReturnType<()=>T>>;type Failure=Result<Result<Promise<{stack:string}>>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'awaited-nested-own-constraint-actual-error',
    source:
      'type Result<T>=Awaited<ReturnType<<U extends T>()=>U>>;type Failure=Result<Result<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'awaited-nested-own-constraint-data-pin',
    source:
      'type Result<T>=Awaited<ReturnType<<U extends T>()=>U>>;type Failure=Result<Result<{stack:string}>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
];

describe('awaited utility result readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'awaited-utility-observations.ts', source);
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

describe('shared awaited utility result admissions', () => {
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

// These reader-only cycles are termination controls, outside the strict-valid admission cases.
const TERMINATION_CASES = [
  {
    id: 'recursive-indexed-await-terminates',
    source:
      'type Loop={x:Awaited<Loop["x"]>};function frames(value:Awaited<Loop["x"]>){return(value as{stack:string}).stack;}',
    refused: false,
  },
  {
    id: 'recursive-indexed-await-keeps-error-sibling',
    source:
      'type Loop={x:Awaited<Loop["x"]>|Error};function frames(value:Awaited<Loop["x"]>){return(value as{stack:string}).stack;}',
    refused: true,
  },
  {
    id: 'recursive-indexed-promise-terminates',
    source:
      'type Loop={x:Promise<Loop["x"]>};function frames(value:Awaited<Loop["x"]>){return(value as{stack:string}).stack;}',
    refused: false,
  },
  {
    id: 'recursive-indexed-promise-keeps-error-sibling',
    source:
      'type Loop={x:Promise<Loop["x"]>|Error};function frames(value:Awaited<Loop["x"]>){return(value as{stack:string}).stack;}',
    refused: true,
  },
];

describe('recursive awaited reader termination', () => {
  it.each(TERMINATION_CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-awaited.ts', source);
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
