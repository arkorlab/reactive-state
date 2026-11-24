import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Local value queries retain written annotations and directly constructed native instance types. */
const CASES = [
  {
    id: 'local-query-annotated-parameter',
    source:
      'function frames(error:Error){function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'local-query-constructed-initializer',
    source:
      'function frames(){const error=new Error("ours");function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'local-query-annotated-alias',
    source:
      'function frames(error:Error){const alias=error;function read(value:typeof alias){return value.stack;}return read(alias);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'local-query-data-shadow-pin',
    source:
      'function frames(error:Error){const data={stack:"fixed"};function read(value:typeof data){return value.stack;}void error;return read(data);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'query-native-constructor-alias',
    source:
      'const Raised=TypeError;function frames(){const error=new Raised("ours");function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'query-global-native-constructor',
    source:
      'function frames(){const error=new globalThis.Error("ours");function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'query-native-call-initializer',
    source:
      'function frames(){const error=Error("ours");function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'query-generic-member-annotation',
    source:
      'type Box<T>={value:T};function frames(error:Box<Error>){const alias=error;function read(value:typeof alias){return value.value.stack;}return read(alias);}',
    invocation: 'frames({value:new Error("ours")})',
    refused: true,
    reader: true,
  },
  {
    id: 'query-constrained-annotation',
    source:
      'function frames<T extends Error>(error:T){function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'query-explicit-data-annotation',
    source:
      'function frames(){const error:{stack:string}=new Error("ours");function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'query-explicit-unknown-annotation',
    source:
      'function frames(){const error:unknown=new Error("ours");function read(value:typeof error){return(value as {stack:string}).stack;}return read(error);}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'query-data-assertion-precedence',
    source:
      'function frames(){const error=new Error("ours") as {stack:string};function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'query-local-value-constructor-shadow',
    source:
      'function frames(){class Error{stack="fixed";}const error=new Error();function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'query-local-globalThis-value-shadow',
    source:
      'function frames(){const globalThis={Error:class{stack="fixed";}};const error=new globalThis.Error();function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'query-type-only-constructor-shadow',
    source:
      'function frames(){type Error={stack:string};const error=new Error("ours");function read(value:typeof error){return value.stack;}return read(error);}',
    invocation: 'frames()',
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

describe('local value query readers', () => {
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

describe('shared local value queries', () => {
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
