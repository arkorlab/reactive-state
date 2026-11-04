import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native descriptor maps retain the source values of their selected data entries. */
const CASES = [
  {
    id: 'plural-caught-error',
    source:
      'function read(){try{JSON.parse("{");}catch(error){return Object.getOwnPropertyDescriptors({failure:error}).failure.value.stack;}}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'plural-supplied-error',
    source:
      'function read(error:Error){return Object.getOwnPropertyDescriptors({failure:error}).failure.value.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-constant-map',
    source:
      'function read(error:Error){const descriptors=Object.getOwnPropertyDescriptors({failure:error});return descriptors.failure.value.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-computed-entry',
    source:
      'function read(error:Error){return Object.getOwnPropertyDescriptors({failure:error})["failure"]["value"].stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-native-stack',
    source:
      'function read(){return Object.getOwnPropertyDescriptors(new Error("ours")).stack.value;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'singular-member-error',
    source:
      'function read(error:Error){return Object.getOwnPropertyDescriptor({failure:error},"failure")!.value.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-supplied-words',
    source:
      'function read(error:Error){return Object.getOwnPropertyDescriptors({failure:error}).failure.value.message;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-written-object-before-read',
    source:
      'function read(error:Error){const box={failure:new Error("ours")};box.failure=error;return (Object.getOwnPropertyDescriptors(box).failure.value as Error).message;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-local-words',
    source:
      'function read(){return Object.getOwnPropertyDescriptors({failure:new Error("ours")}).failure.value.message;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'plural-ordinary-data',
    source:
      'function read(){return Object.getOwnPropertyDescriptors({failure:{stack:"fixed"}}).failure.value.stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'plural-object-shadow',
    source:
      'const Object={getOwnPropertyDescriptors:()=>({failure:{value:{stack:"fixed"}}})};function read(){return Object.getOwnPropertyDescriptors({failure:new Error("ours")}).failure.value.stack;}',
    invocation: 'read()',
    refused: false,
  },
] as const;

describe('plural descriptor error readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'plural-descriptors.ts', source);
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

describe('shared plural descriptor error receivers', () => {
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
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
