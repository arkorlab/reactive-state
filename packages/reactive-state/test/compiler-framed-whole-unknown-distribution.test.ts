import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Whole source-known unknown unions precede naked-parameter conditional distribution. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-whole-unknown',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'reversed-whole-unknown',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<string|unknown>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-alias',
    source:
      'type U=unknown;type Select<T>=T extends string?Error:{stack:string};type Failure=Select<U|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'argument-alias',
    source:
      'type Input=unknown|string;type Select<T>=T extends string?Error:{stack:string};type Failure=Select<Input>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'outer-generic',
    source:
      'type Box<T>=T;type Select<T>=T extends string?Error:{stack:string};type Failure=Select<Box<unknown|string>>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-union',
    source:
      'type Box<T>=unknown|T;type Select<T>=T extends string?Error:{stack:string};type Failure=Select<Box<string>>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'parenthesized-union',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<(unknown|(string|never))>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-literal',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|"word">;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-number',
    source:
      'type Select<T>=T extends number?Error:{stack:string};type Failure=Select<unknown|number>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-boolean',
    source:
      'type Select<T>=T extends boolean?Error:{stack:string};type Failure=Select<unknown|boolean>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-nested-any-field',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|{item:any}|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-callable-any-result',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|(()=>any)|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-native-Error',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|Error|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-interface',
    source:
      'interface Shape{value:any;}type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|Shape|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-never-existing-pin',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|never>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'direct-unknown-existing-pin',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'whole-any-stays-unsafe',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|any|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'any-alias-stays-unsafe',
    source:
      'type Opaque=any;type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|Opaque|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'intersection-any-stays-unsafe',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|(any&{stack:string})|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-any-only-data-pin',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|{item:any}>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'inverse-unknown-Error',
    source:
      'type Select<T>=T extends string?{stack:string}:Error;type Failure=Select<unknown|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-distribution-Error',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<string|number>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'intersection-is-not-unknown',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown&string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defaulted-generic',
    source:
      'type Box<T=string>=unknown|T;type Select<T>=T extends string?Error:{stack:string};type Failure=Select<Box>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-nullish',
    source:
      'type Select<T>=T extends undefined?Error:{stack:string};type Failure=Select<unknown|undefined|null>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-field-any-and-string',
    source:
      'type Select<T>=T extends string?Error:{stack:string};type Failure=Select<unknown|{stack:any}|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'selected-unknown-result',
    source:
      'type Branch=true extends true?unknown:never;type Select<T>=T extends string?Error:{stack:string};type Failure=Select<Branch|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-extends-unknown-Error',
    source:
      'type Select<T>=T extends unknown?Error:{stack:string};type Failure=Select<unknown|string>;function frames(value:Failure){return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('whole unknown distribution readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'whole-unknown-distribution.ts', source);
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

describe('shared whole unknown distribution admissions', () => {
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
