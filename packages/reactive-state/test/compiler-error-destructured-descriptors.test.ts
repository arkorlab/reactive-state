import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Destructured descriptor values retain their written error observations. */
const CASES = [
  {
    id: 'object-bound-stack',
    source:
      'function frames(error:Error){const {value}=Object.getOwnPropertyDescriptor(error,"stack")!;return value;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'reflect-bound-stack',
    source:
      'function frames(error:Error){const {value}=Reflect.getOwnPropertyDescriptor(error,"stack")!;return value;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'renamed-bound-stack',
    source:
      'function frames(error:Error){const {value:frames}=Object.getOwnPropertyDescriptor(error,"stack")!;return frames;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'aliased-descriptor-bound-stack',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor(error,"stack")!;const {value}=descriptor;return value;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'plural-bound-stack',
    source:
      'function frames(error:Error){const {stack:{value}}=Object.getOwnPropertyDescriptors(error);return value;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'bound-supplied-message',
    source:
      'function frames(error:Error){const {value}=Object.getOwnPropertyDescriptor(error,"message")!;return value;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'bound-local-written-message',
    source:
      'function frames(){const {value}=Object.getOwnPropertyDescriptor(new Error("ours"),"message")!;return value;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'bound-ordinary-data',
    source:
      'function frames(){const {value}=Object.getOwnPropertyDescriptor({stack:"fixed"},"stack")!;return value;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'bound-getter-descriptor-data',
    source:
      'function frames(){const {value}=Object.getOwnPropertyDescriptor({get stack(){return "fixed";}},"stack")!;return value;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'shadow-descriptor-data',
    source:
      'function frames(){const Object={getOwnPropertyDescriptor(){return {value:"fixed"};}};const {value}=Object.getOwnPropertyDescriptor();return value;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'bound-default-error-stack',
    source:
      'function frames(error:Error){const {value="fixed"}=Object.getOwnPropertyDescriptor(error,"stack")!;return value;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'shadow-error-type-data',
    source:
      'type Error={stack:string};function frames(error:Error){const {value}=Object.getOwnPropertyDescriptor(error,"stack")!;return value;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
    sharedRefused: true,
  },
] as const;

describe('destructured descriptor value readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'bounded-error-observation.ts', source);
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

describe('destructured descriptor value shared admission', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, sharedRefused }) => {
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
    const expected = sharedRefused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
