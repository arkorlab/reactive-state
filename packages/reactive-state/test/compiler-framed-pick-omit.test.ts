import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native utility and object-identity boundaries preserve Error observations and data. */
const CASES = [
  {
    id: 'pick-error-member',
    source:
      'type Box=Pick<{failure:Error},"failure">;function frames(box:Box){return box.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'omit-keeps-error-member',
    source:
      'type Box=Omit<{failure:Error;data:string},"data">;function frames(box:Box){return box.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'pick-data-member',
    source:
      'type Box=Pick<{failure:Error;data:{stack:string}},"data">;function frames(box:Box){return box.data.stack;}',
    invocation: 'frames({data:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'omit-error-member-data',
    source:
      'type Box=Omit<{failure:Error;data:{stack:string}},"failure">;function frames(box:Box){return box.data.stack;}',
    invocation: 'frames({data:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'pick-generic-error',
    source:
      'type Box<T>=Pick<{failure:T},"failure">;function frames(box:Box<Error>){return box.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'omit-generic-default-error',
    source:
      'type Box<T=Error>=Omit<{failure:T;data:string},"data">;function frames(box:Box){return box.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'pick-key-alias-error',
    source:
      'type Key="failure";type Box=Pick<{failure:Error;data:string},Key>;function frames(box:Box){return box.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'pick-indexed-error',
    source:
      'type Failure=Pick<{failure:Error},"failure">["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pick-local-shadow-data',
    source:
      'type Pick<T,K>={failure:{stack:string}};type Box=Pick<{failure:Error},"failure">;function frames(box:Box){return box.failure.stack;}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'omit-local-shadow-data',
    source:
      'type Omit<T,K>={failure:{stack:string}};type Box=Omit<{failure:Error},never>;function frames(box:Box){return box.failure.stack;}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
  },
];

describe('pick-omit readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-noinfer.ts', source);
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

describe('shared pick-omit results', () => {
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
