import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'nested-native-join',
    source: 'function frames(errors:Error[][]){return errors.join(",");}',
    invocation: 'frames([[new Error("ours")]])',
    refused: true,
  },
  {
    id: 'generic-array-to-string',
    source: 'function frames(errors:Array<Error[]>){return errors.toString();}',
    invocation: 'frames([[new Error("ours")]])',
    refused: true,
  },
  {
    id: 'readonly-nested-join',
    source: 'function frames(errors:ReadonlyArray<readonly Error[]>){return errors.join(",");}',
    invocation: 'frames([[new Error("ours")]])',
    refused: true,
  },
  {
    id: 'nested-tuple-text',
    source: 'function frames(errors:[Error[],string]){return errors.toString();}',
    invocation: 'frames([[new Error("ours")],"fixed"])',
    refused: true,
  },
  {
    id: 'generic-alias-nested-join',
    source: 'type Layers<T>=T[][];function frames(errors:Layers<Error>){return errors.join(",");}',
    invocation: 'frames([[new Error("ours")]])',
    refused: true,
  },
  {
    id: 'nested-global-string',
    source: 'function frames(errors:Error[][]){return String(errors);}',
    invocation: 'frames([[new Error("ours")]])',
    refused: true,
  },
  {
    id: 'flat-global-string-control',
    source: 'function frames(errors:Error[]){return String(errors);}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'literal-nested-join-control',
    source: 'function frames(error:Error){return [[error]].join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-nested-data',
    source: 'function frames(values:string[][]){return values.join(",");}',
    invocation: 'frames([["fixed"]])',
    refused: false,
  },
  {
    id: 'shadowed-error-data',
    source:
      'class Error{message="fixed"}function frames(values:Error[][]){return values.join(",");}',
    invocation: 'frames([[new Error()]])',
    refused: false,
  },
  {
    id: 'own-outer-join-data',
    source:
      'function frames(error:Error){const values=[[error]];values.join=()=>"fixed";return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-inner-text-data',
    source:
      'function frames(error:Error){const inner=[error];inner.toString=()=>"fixed";return [inner].join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-made-words-data',
    source: 'function frames(){const values=[[new Error("ours")]];return values.join(",");}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'numeric-object-custom-data',
    source: 'function frames(values:{[key:number]:Error[];join():string}){return values.join();}',
    invocation: 'frames({join(){return "fixed";}})',
    refused: false,
  },
  {
    id: 'typed-local-made-words-data',
    source:
      'function frames(){const values:Error[][]=[[new Error("ours")]];return values.join(",");}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'typed-inner-custom-text-data',
    source:
      'function frames(error:Error){const inner=[error];inner.toString=()=>"fixed";const values:Error[][]=[inner];return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'global-string-own-array-text-data',
    source:
      'function frames(error:Error){const values=[[error]];values.toString=()=>"fixed";return String(values);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'global-string-local-words-data',
    source: 'function frames(){return String([[new Error("ours")]]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'exposed-literal-keeps-typed-error',
    source:
      'function frames(error:Error){const values:Error[][]=[[new Error("ours")]];function corrupt(value:Error[][]){value.push([error]);}corrupt(values);return values.join(",");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'deferred-write-keeps-error',
    source:
      'function frames(error:Error){const values:Error[][]=[[new Error("ours")]];corrupt();return values.join(",");function corrupt(){values.push([error]);}}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'later-unreachable-write-data',
    source:
      'function frames(error:Error){const values:Error[][]=[[new Error("ours")]];return values.join(",");values.push([error]);}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'whole-alias-local-words-data',
    source:
      'function frames(){const values:Error[][]=[[new Error("ours")]];const alias=values;return alias.join(",");}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'local-string-shadow-data',
    source:
      'function frames(errors:Error[][]){const String=(_value:unknown)=>"fixed";return String(errors);}',
    invocation: 'frames([[new Error("ours")]])',
    refused: false,
  },
  {
    id: 'nested-default-source-corrupt',
    source:
      'function frames(error:Error){const values:Error[][]=[[new Error("ours")]];function corrupt(value:Error[][]){value.push([error]);}const {a=values.join(",")}=(corrupt(values),{} as {a?:string});return a;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'nested-default-source-other',
    source:
      'function frames(error:Error){const values:Error[][]=[[new Error("ours")]];const other:Error[][]=[];function corrupt(value:Error[][]){value.push([error]);}const {a=values.join(",")}=(corrupt(other),{} as {a?:string});return a;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
];

describe('nested array readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared nested arrays', () => {
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

describe('nested array type cycles', () => {
  it.each([
    'type Nest=Nest[];function frames(values:Nest){return values.join(",");}',
    'type Nest<T>=T[]|Nest<T>[];function frames(values:Nest<string>){return values.join(",");}',
  ])('terminates on %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-cycle.ts', source);
    const pending: Node[] = [parsed.sourceFile];

    expect(() => {
      for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
        framedRead(node);
        node.forEachChild((child) => {
          pending.push(child);
        });
      }
    }).not.toThrow();
  });
});
