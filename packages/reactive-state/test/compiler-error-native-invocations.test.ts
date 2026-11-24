import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error invocations retain their written error observations. */
const CASES = [
  {
    id: 'native-call-stack',
    source: 'function frames(){return Error.call(null,"ours").stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'native-apply-stack',
    source: 'function frames(){return Error.apply(null,["ours"]).stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'native-reflect-apply-stack',
    source: 'function frames(){return Reflect.apply(Error,null,["ours"]).stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'global-type-error-call-stack',
    source: 'function frames(){return globalThis.TypeError.call(null,"ours").stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'constant-constructor-apply-stack',
    source: 'function frames(){const Make=Error;return Make.apply(null,["ours"]).stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'computed-native-call-stack',
    source: 'function frames(){return Error["call"](null,"ours").stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'native-call-written-words',
    source: 'function frames(){return Error.call(null,"ours").message;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'native-apply-written-words',
    source: 'function frames(){return Error.apply(null,["ours"]).message;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'local-error-call-data',
    source:
      'function frames(){function Error(){return {stack:"fixed"};}return Error.call(null).stack;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'local-error-apply-data',
    source:
      'function frames(){function Error(){return {stack:"fixed"};}return Error.apply(null,[]).stack;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'ordinary-call-data',
    source: 'function frames(){const make=()=>({stack:"fixed"});return make.call(null).stack;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'shadow-reflect-apply-data',
    source:
      'function frames(){const Reflect={apply(){return {stack:"fixed"};}};return Reflect.apply().stack;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'native-call-empty-stack',
    source: 'function frames(){return Error.call().stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'native-apply-empty-stack',
    source: 'function frames(){return Error.apply().stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
] as const;

describe('native error invocation readers', () => {
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

describe('native error invocation shared admission', () => {
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
