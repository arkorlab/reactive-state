import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Qualified local queries select the root annotation before retaining the written member path. */
const CASES = [
  {
    id: 'qualified-direct-error',
    source:
      'function frames(box:{failure:Error}){type Failure=typeof box.failure;function read(error:Failure){return error.stack;}return read(box.failure);}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
    reader: true,
  },
  {
    id: 'qualified-nested-error',
    source:
      'function frames(box:{nested:{failure:Error}}){type Failure=typeof box.nested.failure;function read(error:Failure){return error.stack;}return read(box.nested.failure);}',
    invocation: 'frames({nested:{failure:new Error("ours")}})',
    refused: true,
    reader: true,
  },
  {
    id: 'qualified-whole-alias',
    source:
      'function frames(box:{failure:Error}){const alias=box;type Failure=typeof alias.failure;function read(error:Failure){return error.stack;}return read(alias.failure);}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
    reader: true,
  },
  {
    id: 'qualified-destructured-holder',
    source:
      'function frames(input:{box:{failure:Error}}){const {box}=input;type Failure=typeof box.failure;function read(error:Failure){return error.stack;}return read(box.failure);}',
    invocation: 'frames({box:{failure:new Error("ours")}})',
    refused: true,
    reader: true,
  },
  {
    id: 'qualified-generic-error',
    source:
      'type Box<T>={failure:T};function frames(box:Box<Error>){type Failure=typeof box.failure;function read(error:Failure){return error.stack;}return read(box.failure);}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
    reader: true,
  },
  {
    id: 'qualified-generic-nested-error',
    source:
      'type Box<T>={nested:{failure:T}};function frames(box:Box<Error>){type Failure=typeof box.nested.failure;function read(error:Failure){return error.stack;}return read(box.nested.failure);}',
    invocation: 'frames({nested:{failure:new Error("ours")}})',
    refused: true,
    reader: true,
  },
  {
    id: 'qualified-data-field-pin',
    source:
      'function frames(box:{failure:{stack:string}}){type Failure=typeof box.failure;function read(error:Failure){return error.stack;}return read(box.failure);}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
    reader: false,
  },
  {
    id: 'qualified-unselected-error-pin',
    source:
      'function frames(box:{failure:Error;data:{stack:string}}){type Failure=typeof box.data;function read(error:Failure){return error.stack;}return read(box.data);}',
    invocation: 'frames({failure:new Error("ours"),data:{stack:"fixed"}})',
    refused: false,
    reader: false,
  },
  {
    id: 'qualified-error-holder-data-pin',
    source:
      'function frames(box:Error&{data:{stack:string}}){type Failure=typeof box.data;function read(error:Failure){return error.stack;}return read(box.data);}',
    invocation: 'frames(Object.assign(new Error("ours"),{data:{stack:"fixed"}}))',
    refused: false,
    reader: false,
  },
  {
    id: 'qualified-annotation-precedence-pin',
    source:
      'function frames(){const box:{failure:{stack?:string}}={failure:new Error("ours")};type Failure=typeof box.failure;function read(error:Failure){return error.stack;}return read(box.failure);}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'qualified-local-type-shadow-pin',
    source:
      'type Error={stack:string};function frames(box:{failure:Error}){type Failure=typeof box.failure;function read(error:Failure){return error.stack;}return read(box.failure);}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
    reader: false,
  },
  {
    id: 'native-prototype-query-pin',
    source: 'function frames(error:typeof Error.prototype){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
];

/** Cyclic value queries stop at their original syntax rather than executing a value initializer. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'local-value-queries.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

describe('qualified local value query readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    expect(readsFrames(source)).toBe(reader);
  });
});

describe('local query cycle boundaries', () => {
  it.each([
    {
      id: 'self-referential-query',
      source: 'function frames(error:typeof error){return(error as {stack:string}).stack;}',
    },
    {
      id: 'cyclic-value-aliases',
      source:
        'const first=second;const second=first;function read(value:typeof first){return(value as {stack:string}).stack;}',
    },
  ])('$id', ({ source }) => {
    expect(readsFrames(source)).toBe(false);
  });
});

describe('shared qualified local value queries', () => {
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

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
