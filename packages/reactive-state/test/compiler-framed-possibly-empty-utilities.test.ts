import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * An `Exclude` or `Extract` result whose relations are unsettled may be empty, so no uncertain
 * source stands for the whole operand of an enclosing conditional check.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-exclude-empty',
    source:
      'type Data={stack:string};type Failure=Exclude<Data,{stack:string}> extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-same-alias',
    source:
      'type Data={stack:string};type Failure=Exclude<Data,Data> extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-optional-target',
    source:
      'type Data={stack:string};type Failure=Exclude<Data,{stack?:string}> extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-aliased-operand',
    source:
      'type Data={stack:string};type Left=Exclude<Data,{stack:string}>;type Failure=Left extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-empty',
    source:
      'type Data={stack:string};type Failure=Extract<Data,{other:string}> extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'wrapped-never-check',
    source:
      'type Data={stack:string};type IsEmpty<T>=[T] extends [never]?Error:Data;type Failure=IsEmpty<Exclude<Data,{stack:string}>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-kept-uncertain',
    source:
      'type Data={stack:string};type Failure=Exclude<Data,{other:string}> extends never?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'exclude-literal-settled',
    source:
      "type Data={stack:string};type Failure=Exclude<'a'|Data,'a'> extends never?Error:Data;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-native-settled',
    source:
      'type Data={stack:string};type Failure=Exclude<Error,Error> extends never?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-parameter-data',
    source:
      'type Data={stack:string};function frames(value:Exclude<Data,{other:string}>){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-error-removed',
    source:
      'type Data={stack:string};function frames(value:Exclude<Data|TypeError,Error>){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('possibly empty conditional utility readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'possibly-empty-utilities.ts', source);
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

describe('shared possibly empty conditional utility admissions', () => {
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
