import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native conditional utilities retain both boolean literals in each original argument environment. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}
const CASES: readonly Case[] = [
  {
    id: 'exclude-reported-data',
    source:
      'type Selected=Exclude<boolean,true|false>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-reported-error',
    source:
      'type Selected=Exclude<boolean,true|false>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-boolean-target-data',
    source:
      'type Selected=Exclude<boolean,boolean>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-boolean-target-error',
    source:
      'type Selected=Exclude<boolean,boolean>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-both-literals-error',
    source:
      'type Selected=Extract<boolean,true|false>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-both-literals-data',
    source:
      'type Selected=Extract<boolean,true|false>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-boolean-target-error',
    source:
      'type Selected=Extract<boolean,boolean>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-boolean-target-data',
    source:
      'type Selected=Extract<boolean,boolean>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-true-data',
    source:
      'type Selected=Extract<boolean,true>;type Failure=Selected extends true?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-true-error',
    source:
      'type Selected=Extract<boolean,true>;type Failure=Selected extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-false-data',
    source:
      'type Selected=Extract<boolean,false>;type Failure=Selected extends false?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-false-error',
    source:
      'type Selected=Extract<boolean,false>;type Failure=Selected extends false?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-true-data',
    source:
      'type Selected=Exclude<boolean,true>;type Failure=Selected extends false?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-true-error',
    source:
      'type Selected=Exclude<boolean,true>;type Failure=Selected extends false?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-false-data',
    source:
      'type Selected=Exclude<boolean,false>;type Failure=Selected extends true?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-false-error',
    source:
      'type Selected=Exclude<boolean,false>;type Failure=Selected extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'checked-alias-data',
    source:
      'type Flags=boolean;type Both=true|false;type Selected=Exclude<Flags,Both>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'checked-alias-error',
    source:
      'type Flags=boolean;type Both=true|false;type Selected=Exclude<Flags,Both>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'target-alias-data',
    source:
      'type Flags=boolean;type Selected=Extract<true|Error,Flags>;type Failure=Selected extends true?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'target-alias-error',
    source:
      'type Flags=boolean;type Selected=Extract<true|Error,Flags>;type Failure=Selected extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-actual-data',
    source:
      'type Pick<T>=Exclude<T,true|false>;type Selected=Pick<boolean>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-actual-error',
    source:
      'type Pick<T>=Exclude<T,true|false>;type Selected=Pick<boolean>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-default-data',
    source:
      'type Pick<T=boolean>=Extract<T,true>;type Selected=Pick;type Failure=Selected extends true?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-default-error',
    source:
      'type Pick<T=boolean>=Extract<T,true>;type Selected=Pick;type Failure=Selected extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-two-environments-data',
    source:
      'type Pick<T,U>=Exclude<T,U>;type Selected=Pick<boolean,true|false>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-two-environments-error',
    source:
      'type Pick<T,U>=Exclude<T,U>;type Selected=Pick<boolean,true|false>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'source-union-keeps-error-data',
    source:
      'type Selected=Exclude<boolean|Error,true|false>;type Failure=Selected extends Error?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'source-union-keeps-error-error',
    source:
      'type Selected=Exclude<boolean|Error,true|false>;type Failure=Selected extends Error?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'written-union-existing-data',
    source:
      'type Selected=Exclude<true|false,true|false>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'written-union-existing-error',
    source:
      'type Selected=Exclude<true|false,true|false>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-unknown-priority-data',
    source:
      'type Selected=Extract<unknown|boolean,boolean>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'whole-unknown-priority-error',
    source:
      'type Selected=Extract<unknown|boolean,boolean>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'never-checked-existing-data',
    source:
      'type Selected=Exclude<never,boolean>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'never-checked-existing-error',
    source:
      'type Selected=Exclude<never,boolean>;type Failure=Selected extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-any-keeps-both',
    source:
      'type Selected=Extract<any|boolean,true>;type Failure=Selected extends never?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'synthetic-awaited-any-data',
    source:
      'type Selected=Extract<Awaited<{then(done:(value:boolean)=>void):void}>,true>;type Failure=Selected extends true?{stack:string}:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'opaque-generic-existing',
    source:
      'type Selected<T>=Exclude<T,true|false>;type Failure<T>=Selected<T> extends never?{stack:string}:Error;function frames<T>(value:Failure<T>){return value.stack;}',
    invocation: 'frames<boolean>({stack:"fixed"})',
    refused: true,
  },
];

describe('utility boolean readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'utility-boolean.ts', source);
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

describe('shared utility boolean results', () => {
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
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(compile(app).refusals.map((item) => item.reason)).toStrictEqual(refused ? [shared] : []);
  });
});
