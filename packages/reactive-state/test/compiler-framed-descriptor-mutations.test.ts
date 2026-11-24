import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'direct-descriptor-value-write',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;descriptor.value=error;return descriptor.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-descriptor-value-write',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;const alias=descriptor;alias.value=error;return descriptor.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-descriptor-value-write',
    source:
      'function frames(error:Error){const descriptor=Reflect.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;descriptor["value"]=error;return Reflect.get(descriptor,"value").stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assigned-descriptor-value-write',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;Object.assign(descriptor,{value:error});return descriptor.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'descriptor-data-value',
    source:
      'function frames(){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;return descriptor.value.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'later-value-write',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;const result=descriptor.value.stack;descriptor.value=error;return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unselected-value-write',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;if(false)descriptor.value=error;return descriptor.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'metadata-only-write',
    source:
      'function frames(){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;descriptor.enumerable=true;return descriptor.value.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'local-made-message-write',
    source:
      'function frames(){const descriptor=Object.getOwnPropertyDescriptor({value:new Error("first")},"value")!;descriptor.value=new Error("ours");return descriptor.value.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'descriptor-default-source-write',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;const {a=descriptor.value.stack}=(descriptor.value=error,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'descriptor-default-source-other',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor({value:{stack:"fixed"}},"value")!;const other=Object.getOwnPropertyDescriptor({value:0},"value")!;const {a=descriptor.value.stack}=(other.value=error,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('descriptor-mutations readers', () => {
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

describe('shared descriptor-mutations', () => {
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
