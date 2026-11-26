import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Selected tuple rests retain source-written element environments without shifting fixed prefixes. */
const CASES = [
  {
    id: 'literal-array-rest-error',
    source:
      'type Failure=[string,...Error[]][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-array-rest-later-error',
    source:
      'type Failure=[string,...Error[]][7];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-readonly-array-rest-error',
    source:
      'type Failure=[string,...ReadonlyArray<Error>][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-array-reference-rest-error',
    source:
      'type Failure=[string,...Array<Error>][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-alias-rest-error',
    source:
      'type Errs=Error[];type Failure=[string,...Errs][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-alias-chain-rest-error',
    source:
      'type Errs=ReadonlyArray<Error>;type More=Errs;type Failure=[string,...More][2];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-generic-rest-error',
    source:
      'type List<T>=ReadonlyArray<T>;type Failure=[string,...List<Error>][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-generic-variadic-rest-error',
    source:
      'type Box<T extends unknown[]>=[string,...T];type Failure=Box<Error[]>[1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-generic-finite-alias-rest-error',
    source:
      'type List<T>=[{stack:string},T];type Failure=[string,...List<Error>][2];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-readonly-named-rest-error',
    source:
      'type Failure=(readonly [head:string,...failures:Error[]])[1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-string-index-rest-error',
    source:
      'type Failure=[string,...Error[]]["1"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'number-readonly-rest-error',
    source:
      'type Failure=[{stack:string},...ReadonlyArray<Error>][number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'number-alias-rest-error',
    source:
      'type Errs=Error[];type Failure=[{stack:string},...Errs][number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'number-generic-rest-error',
    source:
      'type List<T>=ReadonlyArray<T>;type Failure=[{stack:string},...List<Error>][number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'number-rest-only-alias-error',
    source:
      'type List<T>=ReadonlyArray<T>;type Failure=[...List<Error>][number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'number-nonterminal-rest-error',
    source:
      'type Errs=Error[];type Failure=[...Errs,{stack:string}][number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'number-array-rest-error-pin',
    source:
      'type Failure=[{stack:string},...Error[]][number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'fixed-prefix-error-pin',
    source:
      'type Failure=[Error,...string[]][0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'fixed-prefix-data-pin',
    source:
      'type Failure=[{stack:string},...Error[]][0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'fixed-prefix-before-alias-data-pin',
    source:
      'type Errs=Error[];type Failure=[{stack:string},...Errs][0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'finite-written-rest-suffix-error-pin',
    source:
      'type Failure=[...[string,string],Error][2];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'finite-written-rest-suffix-data-pin',
    source:
      'type Failure=[...[Error,Error],{stack:string}][2];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'literal-rest-data-pin',
    source:
      'type Failure=[Error,...{stack:string}[]][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'literal-generic-rest-data-pin',
    source:
      'type List<T>=ReadonlyArray<T>;type Failure=[Error,...List<{stack:string}>][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'literal-finite-alias-selected-data-pin',
    source:
      'type List<T>=[{stack:string},T];type Failure=[string,...List<Error>][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'number-rest-data-pin',
    source:
      'type Data={stack:string}[];type Failure=[{stack:string},...Data][number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'number-unused-generic-error-pin',
    source:
      'type List<T>={stack:string}[];type Failure=[{stack:string},...List<Error>][number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'shadow-readonly-array-data-pin',
    source:
      'type ReadonlyArray<T>={stack:string}[];type Failure=[string,...ReadonlyArray<Error>][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'shadow-error-data-pin',
    source:
      'type Error={stack:string};type Failure=[string,...Error[]][1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'generic-nested-selected-data-pin',
    source:
      'type List<T>=T[];type Pair<A,B>=[A,...List<B>];type Failure=Pair<Error,{stack:string}>[1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'negative-at-alias-suffix-data-pin',
    source:
      'type Errs=Error[];function frames(values:[...Errs,{stack:string}]){return values.at(-1)?.stack;}',
    invocation: 'frames([{stack:"fixed"}])',
    refused: false,
  },
  {
    id: 'negative-at-alias-prefix-data-pin',
    source:
      'type Errs=Error[];function frames(values:[{stack:string},...Errs]){return values.at(-1)?.stack;}',
    invocation: 'frames([{stack:"fixed"}])',
    refused: true,
  },
  {
    id: 'direct-array-number-rest-delegate-error',
    source:
      'type Failure=ReadonlyArray<Error>[number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'decreasing-generic-rest-error',
    source:
      'type Wrap<T extends unknown[]>=[string,...T];type Failure=Wrap<Wrap<Error[]>>[2];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'decreasing-generic-rest-data-pin',
    source:
      'type Wrap<T extends unknown[]>=[Error,...T];type Failure=Wrap<Wrap<{stack:string}[]>>[2];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nested-selected-generic-field-error',
    source:
      'type Box<T>=[string,...{failure:T}[]];function frames(value:Box<Error>[1]){return value.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'nested-unselected-generic-field-data-pin',
    source:
      'type Box<T>=[string,...{failure:T,chosen:{stack:string}}[]];function frames(value:Box<Error>[1]){return value.chosen.stack;}',
    invocation: 'frames({failure:new Error("ours"),chosen:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'numeric-runtime-rest-index-error',
    source: 'function frames(values:[string,...ReadonlyArray<Error>]){return values[1].stack;}',
    invocation: 'frames(["fixed",new Error("ours")])',
    refused: true,
  },
  {
    id: 'numeric-runtime-fixed-prefix-data-pin',
    source: 'function frames(values:[{stack:string},...Error[]]){return values[0].stack;}',
    invocation: 'frames([{stack:"fixed"},new Error("ours")])',
    refused: false,
  },
  {
    id: 'finite-nested-written-rest-offset-data-pin',
    source:
      'type Failure=[...[...[Error,Error],{stack:string}],Error][2];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'union-index-includes-rest-error',
    source:
      'type Failure=[{stack:string},...Error[]][0|1];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('written tuple rest readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tuple-rest-observations.ts', source);
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

describe('shared written tuple rest admissions', () => {
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
