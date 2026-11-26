import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Logical assignment results retain native errors without retaining a falsy error receiver. */
const CASES = [
  {
    id: 'nullish-native-error-frames',
    source: 'function read(value:Error|undefined){return (value??=new Error()).stack;}',
    invocation: 'read(undefined)',
    refused: true,
  },
  {
    id: 'or-native-error-frames',
    source: 'function read(value:Error|undefined){return (value||=new Error()).stack;}',
    invocation: 'read(undefined)',
    refused: true,
  },
  {
    id: 'and-native-error-frames',
    source: 'function read(value:Error|undefined){return (value&&=new Error())?.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nullish-supplied-error-words',
    source: 'function read(value:Error|undefined,error:Error){return (value??=error).message;}',
    invocation: 'read(undefined,new Error("ours"))',
    refused: true,
  },
  {
    id: 'or-supplied-error-words',
    source: 'function read(value:Error|undefined,error:Error){return (value||=error).message;}',
    invocation: 'read(undefined,new Error("ours"))',
    refused: true,
  },
  {
    id: 'and-supplied-error-words',
    source: 'function read(value:Error|undefined,error:Error){return (value&&=error)?.message;}',
    invocation: 'read(new Error("ours"),new Error("given"))',
    refused: true,
  },
  {
    id: 'nullish-ordinary-data',
    source:
      'function read(value:{stack:string}|undefined){return (value??={stack:"fixed"}).stack;}',
    invocation: 'read(undefined)',
    refused: false,
  },
  {
    id: 'or-ordinary-data',
    source:
      'function read(value:{stack:string}|undefined){return (value||={stack:"fixed"}).stack;}',
    invocation: 'read(undefined)',
    refused: false,
  },
  {
    id: 'and-ordinary-data',
    source:
      'function read(value:{stack:string}|undefined){return (value&&={stack:"fixed"})?.stack;}',
    invocation: 'read({stack:"given"})',
    refused: false,
  },
  {
    id: 'and-replaces-error-with-data',
    source: 'function read(value:Error|{stack:string}){return (value&&={stack:"fixed"}).stack;}',
    invocation: 'read(new Error("ours"))',
    refused: false,
  },
  {
    id: 'and-replaces-with-own-error-words',
    source: 'function read(value:Error){return (value&&=new Error("ours")).message;}',
    invocation: 'read(new Error("given"))',
    refused: false,
  },
  {
    id: 'shadowed-error-is-ordinary-data',
    source:
      'class Error{stack="fixed";}function read(value:Error|undefined){return (value??=new Error()).stack;}',
    invocation: 'read(undefined)',
    refused: false,
  },
] as const;

describe('logical assignment error readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'logical-assignment.ts', source);
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

describe('shared logical assignment error receivers', () => {
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
