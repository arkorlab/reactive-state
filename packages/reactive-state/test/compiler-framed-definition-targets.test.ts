import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A definition's installed value replaces the target's own member only on a target shown to install it. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-annotated-define-trap',
    source:
      'function frames(error:Error){const failure:Error=Object.defineProperty(new Proxy({failure:error},{defineProperty(){return true;}}),"failure",{value:{stack:"fixed"}}).failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'define-trap-selection',
    source:
      'function frames(error:Error){return Object.defineProperty(new Proxy({failure:error},{defineProperty(){return true;}}),"failure",{value:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-define-trap',
    source:
      'function frames(error:Error){return Object.defineProperties(new Proxy({failure:error},{defineProperty(){return true;}}),{failure:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-annotated-define-trap',
    source:
      'function frames(error:Error){const failure:Error=Object.defineProperties(new Proxy({failure:error},{defineProperty(){return true;}}),{failure:{value:{stack:"fixed"}}}).failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'saved-define-trap-result',
    source:
      'function frames(error:Error){const box=Object.defineProperty(new Proxy({failure:error},{defineProperty(){return true;}}),"failure",{value:{stack:"fixed"}});const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proxy-alias-target',
    source:
      'function frames(error:Error){const proxy=new Proxy({failure:error},{defineProperty(){return true;}});return Object.defineProperty(proxy,"failure",{value:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'get-trap-target',
    source:
      'function frames(error:Error){return Object.defineProperty(new Proxy({failure:error},{get(){return error;}}),"failure",{value:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'annotated-unknown-handler',
    source:
      'function frames(error:Error,handler:ProxyHandler<{failure:Error}>){const failure:Error=Object.defineProperty(new Proxy({failure:error},handler),"failure",{value:{stack:"fixed"}}).failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"),{defineProperty(){return true;}})',
    refused: true,
  },
  {
    id: 'parameter-target',
    source:
      'function frames(error:Error,box:{failure:Error}){return Object.defineProperty(box,"failure",{value:{stack:"fixed"}}).failure.stack;}',
    invocation:
      'frames(new Error("ours"),new Proxy({failure:new Error("ours")},{defineProperty(){return true;}}))',
    refused: true,
  },
  {
    id: 'installed-error-define-trap',
    source:
      'function frames(error:Error){return Object.defineProperty(new Proxy({failure:{stack:"fixed"}},{defineProperty(){return true;}}),"failure",{value:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-target-data',
    source:
      'function frames(error:Error){return Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'annotated-literal-target-data',
    source:
      'function frames(error:Error){const failure:Error=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"}}).failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'plural-literal-target-data',
    source:
      'function frames(error:Error){return Object.defineProperties({failure:error},{failure:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'literal-alias-target-data',
    source:
      'function frames(error:Error){const box={failure:error};return Object.defineProperty(box,"failure",{value:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-handler-target-data',
    source:
      'function frames(error:Error){return Object.defineProperty(new Proxy({failure:error},{}),"failure",{value:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'assigned-literal-target-data',
    source:
      'function frames(error:Error){return Object.defineProperty(Object.assign({failure:error},{}),"failure",{value:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'created-target-data',
    source:
      'function frames(error:Error){const failure:Error=Object.defineProperty(Object.create(null) as {failure:Error},"failure",{value:{stack:"fixed"}}).failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'literal-installed-error',
    source:
      'function frames(error:Error){return Object.defineProperty({failure:{stack:"fixed"}},"failure",{value:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('definition target readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'definition-targets.ts', source);
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

describe('shared definition target admissions', () => {
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
