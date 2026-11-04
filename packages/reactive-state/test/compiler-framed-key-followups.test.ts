import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Actual shared helpers retain locally written key contradictions and statically ordered spreads. */
describe('shared computed error key source followups', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      name: 'written key direct assignment overrides type',
      source:
        'function frames(error:Error) { let key:"name"="name"; key="stack" as "name"; return error[key]; }',
      invocation: 'frames(new Error("ours"))',
      refused: true,
    },
    {
      name: 'written key conditional assignment overrides type',
      source:
        'function frames(error:Error,flag:boolean) { let key:"name"="name"; if(flag) key="stack" as "name"; return error[key]; }',
      invocation: 'frames(new Error("ours"),true)',
      refused: true,
    },
    {
      name: 'written key logical assignment overrides type',
      source:
        'function frames(error:Error) { let key:"name"="" as "name"; key ||= "stack" as "name"; return error[key]; }',
      invocation: 'frames(new Error("ours"))',
      refused: true,
    },
    {
      name: 'written key initializer overrides type',
      source:
        'function frames(error:Error) { let key:"name"="stack" as "name"; return error[key]; }',
      invocation: 'frames(new Error("ours"))',
      refused: true,
    },
    {
      name: 'written key parameter default overrides type',
      source: 'function frames(error:Error,key:"name"="stack" as "name") { return error[key]; }',
      invocation: 'frames(new Error("ours"))',
      refused: true,
    },
    {
      name: 'written key safe assignments remain finite',
      source:
        'function frames(error:Error) { let key:"name"="name"; key="name"; return error[key]; }',
      invocation: 'frames(new Error("ours"))',
      refused: false,
    },
    {
      name: 'written key false branch does not assign stack',
      source:
        'function frames(error:Error) { let key:"name"="name"; if(false) key="stack" as "name"; return error[key]; }',
      invocation: 'frames(new Error("ours"))',
      refused: false,
    },
    {
      name: 'written key safe parameter default',
      source: 'function frames(error:Error,key:"name"="name") { return error[key]; }',
      invocation: 'frames(new Error("ours"))',
      refused: false,
    },
    {
      name: 'Reflect spread source tuple stack',
      source: 'function frames(error:Error) { return Reflect.get(...[error,"stack"] as const); }',
      invocation: 'frames(new Error("ours"))',
      refused: true,
    },
    {
      name: 'Reflect spread source constant tuple stack',
      source:
        'function frames(error:Error) { const args=[error,"stack"] as const; return Reflect.get(...args); }',
      invocation: 'frames(new Error("ours"))',
      refused: true,
    },
    {
      name: 'Reflect spread key after known receiver',
      source: 'function frames(error:Error) { return Reflect.get(error,...["stack"] as const); }',
      invocation: 'frames(new Error("ours"))',
      refused: true,
    },
    {
      name: 'Reflect spread ordinary tuple data',
      source: 'function frames() { return Reflect.get(...[{stack:"fixed"},"stack"] as const); }',
      invocation: 'frames()',
      refused: false,
    },
    {
      name: 'Reflect spread safe name key',
      source: 'function frames(error:Error) { return Reflect.get(...[error,"name"] as const); }',
      invocation: 'frames(new Error("ours"))',
      refused: false,
    },
    {
      name: 'Reflect spread shadow implementation',
      source:
        'function frames(error:Error) { const Reflect={get(_value:unknown,key:string){return key;}}; return Reflect.get(...[error,"stack"] as const); }',
      invocation: 'frames(new Error("ours"))',
      refused: false,
    },
    {
      name: 'Reflect unknown rest after known receiver',
      source:
        'function frames(error:Error,keys:string[]) { return Reflect.get(error,...keys as [string]); }',
      invocation: 'frames(new Error("ours"),["stack"])',
      refused: true,
    },
    {
      name: 'Reflect unknown rest retains known prefix',
      source:
        'function frames(error:Error,keys:string[]) { return Reflect.get(...[],error,...keys as [string]); }',
      invocation: 'frames(new Error("ours"),["stack"])',
      refused: true,
    },
    {
      name: 'Reflect wholly unknown arguments stay opaque',
      source: 'function frames(args:[object,string]) { return Reflect.get(...args); }',
      invocation: 'frames([{stack:"fixed"},"stack"])',
      refused: false,
    },
    {
      name: 'Reflect deferred tuple later key mutation',
      source:
        'const error=new Error("ours"); const args=[error,"name"] as const; function frames(){return Reflect.get(...args);} (args as unknown as [Error,string])[1]="stack";',
      invocation: 'frames()',
      refused: true,
    },
    {
      name: 'Reflect deferred immutable tuple keeps safe key',
      source:
        'const error=new Error("ours"); const args=[error,"name"] as const; function frames(){return Reflect.get(...args);}',
      invocation: 'frames()',
      refused: false,
    },
    {
      name: 'Reflect deferred ordinary data tuple mutation',
      source:
        'const error={stack:"fixed",name:"data"}; const args=[error,"name"] as const; function frames(){return Reflect.get(...args);} (args as unknown as [typeof error,string])[1]="stack";',
      invocation: 'frames()',
      refused: false,
    },
  ])('$name', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((refusal) => refusal.reason);

    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
