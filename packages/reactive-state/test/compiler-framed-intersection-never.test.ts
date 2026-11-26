import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Unproved source-written intersection emptiness retains both conditional branches. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-disjoint-primitives',
    source: `type Failure=(string&number) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'number-boolean-disjoint',
    source: `type Failure=(number&boolean) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bigint-symbol-disjoint',
    source: `type Failure=(bigint&symbol) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-undefined-disjoint',
    source: `type Failure=(null&undefined) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'explicit-never-in-intersection',
    source: `type Failure=(unknown&never) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'any-and-never-still-never',
    source: `type Failure=(any&never) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-disjoint-intersection',
    source: `type Failure=((string&number)&{}) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-empty-alias-chain',
    source: `type Both=string&number;type Empty=Both;type Failure=Empty extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'actual-generic-intersection',
    source: `type Both<A,B>=A&B;type Failure=Both<string,number> extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'default-generic-intersection',
    source: `type Both<A=string,B=number>=A&B;type Failure=Both extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'union-of-unproved-empty-intersections',
    source: `type Failure=((string&number)|(bigint&symbol)) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'template-intersection-span',
    source: `type Failure=\`\${string&number}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nonfinite-template-before-intersection',
    source: `type Failure=\`\${number}-\${string&number}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'disjoint-written-discriminants',
    source: `type Failure=({kind:"a"}&{kind:"b"}) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'original-generic-intersection-keeps-uncertainty',
    source: `type Both<A,B>=A&B;type Failure<T>=Both<T,number> extends never?Error:{stack:string};function frames<T>(value:Failure<T>){return value.stack;}`,
    invocation: 'frames<string>(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-string-remains-nonempty',
    source: `type Failure=string extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'ordinary-number-remains-nonempty',
    source: `type Failure=number extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'ordinary-unknown-remains-nonempty',
    source: `type Failure=unknown extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'repeated-primitive-intersection-stays-data',
    source: `type Failure=(string&string) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'overlapping-finite-literal-intersection-stays-data',
    source: `type Failure=("a"&("a"|"b")) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'wide-and-literal-intersection-stays-data',
    source: `type Failure=(string&"fixed") extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'aliased-repeated-primitive-intersection-stays-data',
    source: `type Both<A,B>=A&B;type Failure=Both<string,string> extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-neutral-primitive-intersection-stays-data',
    source: `type Failure=(string&unknown) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'aliased-unknown-neutral-intersection-stays-data',
    source: `type Both<A,B>=A&B;type Failure=Both<unknown,"fixed"> extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-finite-intersection-true-data-branch',
    source: `type Failure=(string&number) extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'explicit-never-dominates-any-true-data-branch',
    source: `type Failure=(never&any) extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nonempty-union-arm-dominates-empty-intersection',
    source: `type Failure=((string&number)|"fixed") extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'same-empty-intersection-data-branches',
    source: `type Failure=(string&number) extends never?{stack:string}:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nonempty-intersection-data-branches',
    source: `type Failure=(string&{}) extends never?{stack:string}:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'known-nonempty-intersection-refuses-native-false-branch',
    source: `type Failure=(string&{}) extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'overlapping-literal-intersection-refuses-native-false-branch',
    source: `type Failure=(("a"|"b")&("b"|"c")) extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'explicit-whole-never-retains-true-branch',
    source: `type Failure=never extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-error-intersection-refuses-native-false-branch',
    source: `type Failure=(Error&{tag?:string}) extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-error-shadow-remains-data',
    source: `type Error={stack:string};type Failure=(string&number) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'lexical-type-parameter-shadow-stays-data',
    source: `type Operand=string&number;function frames<Operand extends {stack:string}>(value:Operand){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'explicit-any-keeps-both-branches',
    source: `type Failure=any extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'any-intersection-keeps-both-branches',
    source: `type Failure=(any&string) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('intersection never readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'intersection-never.ts', source);
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

describe('shared intersection never admissions', () => {
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
