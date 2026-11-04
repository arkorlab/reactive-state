import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Each finite member step may revisit a recursive alias in its original argument environment. */
const CASES = [
  {
    id: 'recursive-chain-member',
    source:
      'type Chain={error:Error;next?:Chain};function frames(c:Chain){return c.next!.error.stack;}',
    invocation: 'frames({error:new Error("ours"),next:{error:new Error("ours")}})',
    refused: true,
  },
  {
    id: 'recursive-chain-second-next',
    source:
      'type Chain={error:Error;next?:Chain};function frames(c:Chain){return c.next!.next!.error.stack;}',
    invocation:
      'frames({error:new Error("ours"),next:{error:new Error("ours"),next:{error:new Error("ours")}}})',
    refused: true,
  },
  {
    id: 'mutually-recursive-members',
    source:
      'type Left={next:Right};type Right={error:Error;next?:Left};function frames(c:Left){return c.next.next!.next.error.stack;}',
    invocation: 'frames({next:{error:new Error("ours"),next:{next:{error:new Error("ours")}}}})',
    refused: true,
  },
  {
    id: 'recursive-default-argument',
    source:
      'type Chain<T=Error>={error:T;next?:Chain<T>};function frames(c:Chain){return c.next!.error.stack;}',
    invocation: 'frames({error:new Error("ours"),next:{error:new Error("ours")}})',
    refused: true,
  },
  {
    id: 'recursive-data-member',
    source:
      'type Chain={error:{stack:string};next?:Chain};function frames(c:Chain){return c.next!.error.stack;}',
    invocation: 'frames({error:{stack:"fixed"},next:{error:{stack:"fixed"}}})',
    refused: false,
  },
  {
    id: 'recursive-shadowed-Error',
    source:
      'type Error={stack:string};type Chain={error:Error;next?:Chain};function frames(c:Chain){return c.next!.error.stack;}',
    invocation: 'frames({error:{stack:"fixed"},next:{error:{stack:"fixed"}}})',
    refused: false,
  },
  {
    id: 'unproductive-alias-cycle',
    source: 'type Loop=Loop;function frames(c:Loop){return c.next.error.stack;}',
    invocation: 'frames({} as never)',
    refused: false,
  },
  {
    id: 'first-member-retains-error',
    source: 'type Chain={error:Error;next?:Chain};function frames(c:Chain){return c.error.stack;}',
    invocation: 'frames({error:new Error("ours")})',
    refused: true,
  },
];

describe('recursive error member readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared recursive error members', () => {
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
