import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Selected member paths retain native array element annotations and ordinary data. */
const CASES = [
  {
    id: 'member-array-join',
    source: 'function frames(box:{errors:Error[]}){return box.errors.join();}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'member-array-to-string',
    source: 'function frames(box:{errors:Error[]}){return box.errors.toString();}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'member-array-native-string',
    source: 'function frames(box:{errors:Error[]}){return String(box.errors);}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'member-array-boxed-string',
    source: 'function frames(box:{errors:Error[]}){return new String(box.errors).valueOf();}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'member-array-at',
    source: 'function frames(box:{errors:Error[]}){return box.errors.at(0)!.stack;}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'member-array-find',
    source: 'function frames(box:{errors:Error[]}){return box.errors.find(()=>true)!.stack;}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'member-array-pop',
    source: 'function frames(box:{errors:Error[]}){return box.errors.pop()!.stack;}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'member-array-shift',
    source: 'function frames(box:{errors:Error[]}){return box.errors.shift()!.stack;}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'member-array-dynamic-index',
    source: 'function frames(box:{errors:Error[]},index:number){return box.errors[index]!.stack;}',
    invocation: 'frames({errors:[new Error("ours")]},0)',
    refused: true,
  },
  {
    id: 'destructured-param-array-join',
    source: 'function frames({errors}:{errors:Error[]}){return errors.join();}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'destructured-const-array-at',
    source: 'function frames(box:{errors:Error[]}){const {errors}=box;return errors.at(0)!.stack;}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'nested-member-array-join',
    source: 'function frames(box:{errors:Error[][]}){return box.errors.join();}',
    invocation: 'frames({errors:[[new Error("ours")]]})',
    refused: true,
  },
  {
    id: 'generic-member-array-at',
    source:
      'interface Container<T>{errors:T[];}function frames(box:Container<Error>){return box.errors.at(0)!.stack;}',
    invocation: 'frames({errors:[new Error("ours")]})',
    refused: true,
  },
  {
    id: 'ordinary-member-array-data',
    source: 'function frames(box:{errors:{stack:string}[]}){return box.errors.at(0)!.stack;}',
    invocation: 'frames({errors:[{stack:"fixed"}]})',
    refused: false,
  },
  {
    id: 'ordinary-member-array-join',
    source: 'function frames(box:{errors:string[]}){return box.errors.join();}',
    invocation: 'frames({errors:["fixed"]})',
    refused: false,
  },
  {
    id: 'whole-array-error-pin',
    source: 'function frames(values:Error[]){return values.join();}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'local-member-array-words',
    source: 'function frames(){const box={errors:[new Error("fixed")]};return box.errors.join();}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'local-error-name-shadow',
    source:
      'class Error{stack="fixed";}function frames(box:{errors:Error[]}){return box.errors.at(0)!.stack;}',
    invocation: 'frames({errors:[new Error()]})',
    refused: false,
  },
  {
    id: 'typed-local-member-array-words',
    source:
      'function frames(){const box:{errors:Error[]}={errors:[new Error("fixed")]};return box.errors.join();}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'typed-member-written-error',
    source:
      'function frames(error:Error){const box:{errors:Error[]}={errors:[new Error("fixed")]};box.errors=[error];return box.errors.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'typed-member-closure-mutation',
    source:
      'function frames(error:Error){const box:{errors:Error[]}={errors:[new Error("fixed")]};function change(){box.errors=[error];}change();return box.errors.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('member array annotation readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'member-array.ts', source);
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

describe('member array annotation shared', () => {
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
