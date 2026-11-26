import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Self-key indexed values retain complete written native index domains in their lexical environment. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
  {
    id: 'self-key-string-symbol',
    source:
      'type Bag={[key:string|symbol]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-number-symbol',
    source:
      'type Bag={[key:number|symbol]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-string-number',
    source:
      'type Bag={[key:string|number]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-all-domains',
    source:
      'type Bag={[key:string|number|symbol]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-parenthesized-union',
    source:
      'type Bag={[key:(string|symbol)]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-string-alias',
    source:
      'type Keys=string;type Bag={[key:Keys]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-number-alias',
    source:
      'type Keys=number;type Bag={[key:Keys]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-symbol-alias',
    source:
      'type Keys=symbol;type Bag={[key:Keys]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-union-alias',
    source:
      'type Keys=string|symbol;type Bag={[key:Keys]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-union-of-aliases',
    source:
      'type Strings=string;type Symbols=symbol;type Bag={[key:Strings|Symbols]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-repeated-alias',
    source:
      'type Keys=string|symbol;type Bag={[key:Keys|Keys]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-generic-value',
    source:
      'type Bag<T>={[key:string|symbol]:T};type Failure=Bag<Error>[keyof Bag<Error>];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-inherited-value-environment',
    source:
      'interface Base<T>{[key:string|symbol]:T}interface Bag extends Base<Error>{[key:string]:Error}type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-uncovered-parent-domain',
    source:
      'interface Base<T>{[key:symbol]:T}interface Bag extends Base<Error>{[key:string|number]:{stack:string}}type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-named-field-beside-union',
    source:
      'type Bag={[key:string|symbol]:Error;failure:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-string-native-pin',
    source:
      'type Bag={[key:string]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-number-native-pin',
    source:
      'type Bag={[key:number]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-symbol-native-pin',
    source:
      'type Bag={[key:symbol]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-union-data-pin',
    source:
      'type Bag={[key:string|symbol]:{stack:string}};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'self-key-aliased-data-pin',
    source:
      'type Keys=string|symbol;type Bag={[key:Keys]:{stack:string}};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'self-key-local-Error-data-pin',
    source:
      'type Error={stack:string};type Bag={[key:string|symbol]:Error};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'self-key-generic-data-pin',
    source:
      'type Keys=string|symbol;type Bag<T>={[key:Keys]:T};type Failure=Bag<{stack:string}>[keyof Bag<{stack:string}>];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'self-key-nearest-union-shadow-data-pin',
    source:
      'interface Base{[key:string|symbol]:Error|{stack:string}}interface Bag extends Base{[key:string|symbol]:{stack:string}}type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'self-key-nearest-alias-shadow-data-pin',
    source:
      'type Keys=string|symbol;interface Base{[key:Keys]:Error|{stack:string}}interface Bag extends Base{[key:Keys]:{stack:string}}type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'literal-index-aliased-data-pin',
    source:
      'type Keys=string|symbol;type Bag={[key:Keys]:{stack:string}};type Failure=Bag["caption"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'unrelated-self-key-data-pin',
    source:
      'type Keys={[key:string|symbol]:unknown};type Bag={[key:string|symbol]:{stack:string}};type Failure=Bag[keyof Keys];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'self-key-default-value-environment',
    source:
      'type Keys=string|symbol;type Bag<T=Error>={[key:Keys]:T};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-inherited-default-value-environment',
    source:
      'interface Base<T=Error>{[key:string|symbol]:T}interface Bag extends Base{}type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'self-key-generic-Error-name-data-pin',
    source:
      'type Bag<Error>={[key:string|symbol]:Error};type Failure=Bag<{stack:string}>[keyof Bag<{stack:string}>];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'self-key-default-data-environment-pin',
    source:
      'type Keys=string|symbol;type Bag<T={stack:string}>={[key:Keys]:T};type Failure=Bag[keyof Bag];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
];

describe('keyof index domain readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'filter-results.ts', source);
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

describe('shared keyof index domain admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, files }) => {
    const app = await application({
      ...files,
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
