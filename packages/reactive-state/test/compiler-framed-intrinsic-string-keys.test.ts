import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Finite native string mappings retain literal indexed members and lexical mapping shadows. */
const CASES = [
  {
    id: 'intrinsic-uppercase-error',
    source:
      'type Failure={"FAILURE":Error}[Uppercase<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-uppercase-data-pin',
    source:
      'type Failure={"FAILURE":{stack:string};other:Error}[Uppercase<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-lowercase-error',
    source:
      'type Failure={"failure":Error}[Lowercase<"FAILURE">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-lowercase-data-pin',
    source:
      'type Failure={"failure":{stack:string};other:Error}[Lowercase<"FAILURE">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-capitalize-error',
    source:
      'type Failure={"Failure":Error}[Capitalize<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-capitalize-data-pin',
    source:
      'type Failure={"Failure":{stack:string};other:Error}[Capitalize<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-uncapitalize-error',
    source:
      'type Failure={"failure":Error}[Uncapitalize<"Failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-uncapitalize-data-pin',
    source:
      'type Failure={"failure":{stack:string};other:Error}[Uncapitalize<"Failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-union-error',
    source:
      'type Failure={FAILURE:Error;SAFE:{stack:string}}[Uppercase<"failure"|"safe">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-union-data-pin',
    source:
      'type Failure={FAILURE:{stack:string};SAFE:{stack:string}}[Uppercase<"failure"|"safe">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-alias-actual-error',
    source:
      'type Key<S extends string>=Uppercase<S>;type Failure={FAILURE:Error}[Key<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-alias-default-error',
    source:
      'type Key<S extends string="failure">=Uppercase<S>;type Failure={FAILURE:Error}[Key];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-template-input-error',
    source: `type Failure={FAILURE:Error}[Uppercase<\`fail\${"ure"}\`>];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-template-span-error',
    source: `type Failure={pre_FAILURE:Error}[\`pre_\${Uppercase<"failure">}\`];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-nested-mapping-error',
    source:
      'type Failure={failure:Error}[Lowercase<Uppercase<"failure">>];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-return-utility-error',
    source:
      'type Failure={FAILURE:Error}[Uppercase<ReturnType<()=>"failure">>];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-global-qualified-error',
    source:
      'type Failure={FAILURE:Error}[globalThis.Uppercase<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-local-shadow-data-pin',
    source:
      'type Uppercase<S extends string>="safe";type Failure={safe:{stack:string};FAILURE:Error}[Uppercase<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-namespace-shadow-data-pin',
    source:
      'namespace globalThis{export type Uppercase<S extends string>="safe";}type Failure={safe:{stack:string};FAILURE:Error}[globalThis.Uppercase<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
    readerOnly: true,
  },
  {
    id: 'intrinsic-selected-data-argument-pin',
    source:
      'type Key<S extends string>=Uppercase<S>;type Failure={SAFE:{stack:string};FAILURE:Error}[Key<"safe">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-empty-key-error',
    source:
      'type Failure={"":Error}[Capitalize<"">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-empty-key-data-pin',
    source:
      'type Failure={"":{stack:string};other:Error}[Uncapitalize<"">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-unicode-expanding-uppercase',
    source:
      'type Failure={SS:Error}[Uppercase<"ß">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-unicode-expanding-lowercase',
    source:
      'type Failure={"i̇":Error}[Lowercase<"İ">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-capitalize-first-code-point',
    source:
      'type Failure={"𐐀":Error}[Capitalize<"𐐨">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-uncapitalize-first-code-point',
    source:
      'type Failure={"𐐨":Error}[Uncapitalize<"𐐀">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-uppercase-astral-character',
    source:
      'type Failure={"𐐀":Error}[Uppercase<"𐐨">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-capitalize-expands-first-unit',
    source:
      'type Failure={SSafe:Error}[Capitalize<"ßafe">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-nonfinite-data-pin',
    source:
      'type Failure=Record<string,{stack:string}>[Uppercase<string>];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-nonfinite-existing-opacity',
    source:
      'type Failure=Record<string,Error>[Uppercase<string>];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: false,
    runtime: 'frames',
  },
  {
    id: 'intrinsic-repeated-alias-arguments-error',
    source:
      'type Key<S extends string>=Uppercase<S>;type Twice<S extends string>=Key<Key<S>>;type Failure={FAILURE:Error}[Twice<"failure">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-repeated-alias-data-pin',
    source:
      'type Key<S extends string>=Uppercase<S>;type Twice<S extends string>=Key<Key<S>>;type Failure={SAFE:{stack:string};FAILURE:Error}[Twice<"safe">];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intrinsic-index-intersection-opacity',
    source:
      'type Failure={SAFE:{stack:string};FAILURE:Error}[Uppercase<"safe">&Uppercase<"failure">];function frames(value:Failure){return (value as {stack:string}).stack;}',
    invocation: 'frames({stack:"fixed"} as never)',
    refused: false,
  },
  {
    id: 'intrinsic-argument-intersection-opacity',
    source:
      'type Failure={SAFE:{stack:string};FAILURE:Error}[Uppercase<"safe"&"failure">];function frames(value:Failure){return (value as {stack:string}).stack;}',
    invocation: 'frames({stack:"fixed"} as never)',
    refused: false,
  },
  {
    id: 'intrinsic-existing-literal-intersection-error',
    source:
      'type Failure={FAILURE:Error}["FAILURE"&Uppercase<string>];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'intrinsic-never-argument-data-pin',
    source:
      'type Failure={FAILURE:Error}[Uppercase<never>];function frames(value:Failure){return (value as {stack:string}).stack;}',
    invocation: 'frames({stack:"fixed"} as never)',
    refused: false,
  },
];

describe('intrinsic string key readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'intrinsic-string-keys.ts', source);
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

describe('shared intrinsic string key admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES.filter((each) => each.readerOnly !== true))(
    '$id',
    async ({ source, invocation, refused }) => {
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
    },
  );
});
