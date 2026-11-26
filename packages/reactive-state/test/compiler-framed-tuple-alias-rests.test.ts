import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Finite aliased tuple rests retain known suffix offsets and original type environments. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'empty-prefix-review',
    source:
      'type Prefix=[];type Selected=[...Prefix,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'one-data-prefix',
    source:
      'type Prefix=[string];type Selected=[...Prefix,Error][1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-empty-prefix',
    source:
      'type Empty=[];type Prefix=Empty;type Selected=[...Prefix,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'generic-prefix-actual',
    source:
      'type Prefix<T>=[T];type Selected=[...Prefix<string>,Error][1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'generic-empty-actual',
    source:
      'type Joined<T extends unknown[]>=[...T,Error];type Selected=Joined<[]>[0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'generic-prefix-own-slot',
    source:
      'type Joined<T extends unknown[]>=[...T,{stack:"fixed"}];type Selected=Joined<[Error]>[0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'default-error-prefix',
    source:
      'type Prefix<T=Error>=[T];type Selected=[...Prefix,{stack:"fixed"}][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'default-data-prefix',
    source:
      'type Prefix<T=string>=[T];type Selected=[...Prefix,Error][1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'readonly-empty-prefix',
    source:
      'type Prefix=readonly[];type Selected=[...Prefix,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'readonly-filled-prefix',
    source:
      'type Prefix=readonly[string];type Selected=[...Prefix,Error][1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'named-rest-prefix',
    source:
      'type Prefix=[];type Selected=[...prefix:Prefix,failure:Error][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'two-alias-rests',
    source:
      'type Empty=[];type Prefix=[string];type Selected=[...Empty,...Prefix,Error][1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'parenthesized-alias-rest',
    source:
      'type Prefix=[];type Selected=[...(Prefix),Error][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'namespace-alias-rest',
    source:
      'namespace Types{export type Prefix=[]};type Selected=[...Types.Prefix,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'finite-union-rest-empty',
    source:
      'type Prefix=[]|[{stack:"fixed"}];type Selected=[...Prefix,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'finite-union-rest-slot-one',
    source:
      'type Prefix=[]|[{stack:"fixed"}];type Selected=[...Prefix,Error][1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'union-numeric-selection',
    source:
      'type Prefix=[{stack:"fixed"}];type Selected=[...Prefix,Error][0|1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'generic-reused-body',
    source:
      'type Box<T extends unknown[]>=[...T];type Prefix=[...Box<[string]>,...Box<[]>];type Selected=[...Prefix,Error][1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'supplied-error-words',
    source:
      'type Prefix=[];type Selected=[...Prefix,Error][0];function frames(value:Selected){return value!.message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'number-index-pin',
    source:
      'type Prefix=[];type Selected=[...Prefix,Error][number];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'direct-rest-pin',
    source: ';type Selected=[...[],Error][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'trailing-alias-rest-pin',
    source:
      'type Failure=[Error];type Selected=[string,...Failure][1];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-prefix-data',
    source:
      'type Prefix=[];type Selected=[...Prefix,{stack:"fixed"}][0];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'selected-prefix-data',
    source:
      'type Prefix=[{stack:"fixed"}];type Selected=[...Prefix,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'selected-suffix-data',
    source:
      'type Prefix=[Error];type Selected=[...Prefix,{stack:"fixed"}][1];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'generic-actual-data',
    source:
      'type Prefix<T=Error>=[T];type Selected=[...Prefix<{stack:"fixed"}>,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'readonly-data',
    source:
      'type Prefix=readonly[{stack:"fixed"}];type Selected=[...Prefix,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'native-name-shadow-data',
    source:
      'type Error={stack:"fixed"};type Prefix=[];type Selected=[...Prefix,Error][0];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'native-unknown-length-data',
    source:
      'type Prefix={stack:"fixed"}[];type Selected=[...Prefix,{stack:"fixed"}][0];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'numeric-finite-data',
    source:
      'type Prefix=[{stack:"fixed"}];type Selected=[...Prefix,{stack:"fixed"}][number];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'finite-union-all-data',
    source:
      'type Prefix=[]|[{stack:"fixed"}];type Selected=[...Prefix,{stack:"fixed"}][0];function frames(value:Selected){return value!.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'optional-standalone-pin',
    source: ';type Selected=[Error?][0];function frames(value:Selected){return value!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('finite aliased tuple rest readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'finite-aliased-tuple-rests.ts', source);
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

describe('shared finite aliased tuple rest admissions', () => {
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
