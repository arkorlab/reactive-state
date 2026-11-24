import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * Computed member names: a constant keeps its exact key, and a name read inexactly (a unique symbol,
 * a member of an object, an assertion) keeps a `keyof` selection incomplete rather than exhaustive.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-const-self',
    source:
      "const field='failure';type Bag={[field]:Error;caption:{stack:string}};type Failure=Bag[keyof Bag];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-literal-selection',
    source:
      "const field='failure';type Bag={[field]:Error;caption:{stack:string}};function frames(value:Bag['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-interface-self',
    source:
      "const field='failure';interface Shape{[field]:Error;caption:{stack:string}}type Failure=Shape[keyof Shape];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-chain-literal',
    source:
      "const base='failure';const chained=base;type Chain={[chained]:Error;caption:{stack:string}};function frames(value:Chain['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-template-literal',
    source:
      "const template=`failure`;type Template={[template]:Error;caption:{stack:string}};function frames(value:Template['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-parenthesized-literal',
    source:
      "const parenthesized=('failure');type Parenthesized={[parenthesized]:Error;caption:{stack:string}};function frames(value:Parenthesized['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-number-self',
    source:
      'const zero=0;type Numbered={[zero]:Error;caption:{stack:string}};type Failure=Numbered[keyof Numbered];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-number-literal',
    source:
      'const zero=0;type Numbered={[zero]:Error;caption:{stack:string}};function frames(value:Numbered[0]){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-minus-literal',
    source:
      'const minus=-1;type Minus={[minus]:Error;caption:{stack:string}};function frames(value:Minus[-1]){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-annotated-literal',
    source:
      "declare const declared:'failure';type Declared={[declared]:Error;caption:{stack:string}};function frames(value:Declared['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-non-self',
    source:
      "const field='failure';type Keys={[field]:0;caption:0};type Other={failure:Error;caption:{stack:string}};type Failure=Other[keyof Keys];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-intersected-string',
    source:
      "const field='failure';type Bag={[field]:Error;caption:{stack:string}};type Failure=Bag[keyof Bag & string];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-getter-self',
    source:
      "const field='failure';type Getters={get [field]():Error;caption:{stack:string}};type Failure=Getters[keyof Getters];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shadowed-const-literal',
    source:
      "const field='caption';function frames(value:unknown){const field='failure';type Local={[field]:Error;caption:{stack:string}};const local:Local['failure']=value as Local['failure'];return local.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-self',
    source:
      "const symbol=Symbol('failure');type Symbolic={[symbol]:Error;caption:{stack:string}};type Failure=Symbolic[keyof Symbolic];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-index-signature-self',
    source:
      "const symbol=Symbol('failure');type Indexed={[name:string]:{stack:string};[symbol]:Error};type Failure=Indexed[keyof Indexed];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-interface-heritage-self',
    source:
      "const symbol=Symbol('failure');interface Base{caption:{stack:string}}interface Derived extends Base{[symbol]:Error}type Failure=Derived[keyof Derived];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'member-key-self',
    source:
      "const Names={failure:'failure'} as const;type Named={[Names.failure]:Error;caption:{stack:string}};type Failure=Named[keyof Named];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'asserted-const-self',
    source:
      "const asserted='failure' as const;type Asserted={[asserted]:Error;caption:{stack:string}};type Failure=Asserted[keyof Asserted];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unreadable-non-self',
    source:
      "const Names={failure:'failure'} as const;type Keys={[Names.failure]:0;caption:0};type Other={failure:Error;caption:{stack:string}};type Failure=Other[keyof Keys];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unreadable-union-keyof',
    source:
      "const Names={failure:'failure'} as const;type Left={[Names.failure]:0;caption:0};type Right={failure:0;caption:0;extra:0};type Other={failure:Error;caption:{stack:string};extra:{stack:string}};type Failure=Other[keyof (Left|Right)];function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-intersected-string',
    source:
      "const symbol=Symbol('failure');type Symbolic={[symbol]:Error;caption:{stack:string}};type Data=Symbolic[keyof Symbolic & string];function frames(value:Data){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'const-literal-data',
    source:
      "const field='failure';type Bag={[field]:Error;caption:{stack:string}};function frames(value:Bag['caption']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'const-self-data',
    source:
      "const field='failure';type Strings={[field]:{stack:string};caption:{stack:string}};type Data=Strings[keyof Strings];function frames(value:Data){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'const-chain-data',
    source:
      "const base='failure';const chained=base;type Chain={[chained]:Error;caption:{stack:string}};function frames(value:Chain['caption']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'symbol-self-data',
    source:
      "const symbol=Symbol('failure');type Symbolic={[symbol]:{stack:string};caption:{stack:string}};type Data=Symbolic[keyof Symbolic];function frames(value:Data){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'symbol-literal-data',
    source:
      "const symbol=Symbol('failure');type Symbolic={[symbol]:Error;caption:{stack:string}};function frames(value:Symbolic['caption']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'complete-keys-unreadable-object',
    source:
      "const symbol=Symbol('failure');type Keys={caption:0};type Symbolic={[symbol]:Error;caption:{stack:string}};type Data=Symbolic[keyof Keys];function frames(value:Data){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unreadable-non-self-data',
    source:
      "const Names={failure:'failure'} as const;type Keys={[Names.failure]:0;caption:0};type Other={failure:{stack:string};caption:{stack:string}};type Data=Other[keyof Keys];function frames(value:Data){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'shadowed-const-data',
    source:
      "const field='caption';function frames(value:unknown){const field='failure';type Local={[field]:Error;caption:{stack:string}};const local:Local['caption']=value as Local['caption'];return local.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'asserted-type-data',
    source:
      "const widened='failure' as string as 'other';type Widened={[widened]:Error;caption:{stack:string}};function frames(value:Widened['caption']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'named-self-data',
    source:
      'type Bag={failure:{stack:string};caption:{stack:string}};type Data=Bag[keyof Bag];function frames(value:Data){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('computed member keyof readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'computed-member-keyof.ts', source);
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

describe('shared computed member keyof admissions', () => {
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
