import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Written key values take precedence over safe annotations; bounded native call spreads retain order. */
describe('computed error key source followups', () => {
  it.each([
    {
      name: 'written key direct assignment overrides type',
      source:
        'function frames(error:Error) { let key:"name"="name"; key="stack" as "name"; return error[key]; }',
      refused: true,
    },
    {
      name: 'written key conditional assignment overrides type',
      source:
        'function frames(error:Error,flag:boolean) { let key:"name"="name"; if(flag) key="stack" as "name"; return error[key]; }',
      refused: true,
    },
    {
      name: 'written key logical assignment overrides type',
      source:
        'function frames(error:Error) { let key:"name"="" as "name"; key ||= "stack" as "name"; return error[key]; }',
      refused: true,
    },
    {
      name: 'written key initializer overrides type',
      source:
        'function frames(error:Error) { let key:"name"="stack" as "name"; return error[key]; }',
      refused: true,
    },
    {
      name: 'written key parameter default overrides type',
      source: 'function frames(error:Error,key:"name"="stack" as "name") { return error[key]; }',
      refused: true,
    },
    {
      name: 'written key safe assignments remain finite',
      source:
        'function frames(error:Error) { let key:"name"="name"; key="name"; return error[key]; }',
      refused: false,
    },
    {
      name: 'written key false branch does not assign stack',
      source:
        'function frames(error:Error) { let key:"name"="name"; if(false) key="stack" as "name"; return error[key]; }',
      refused: false,
    },
    {
      name: 'written key safe parameter default',
      source: 'function frames(error:Error,key:"name"="name") { return error[key]; }',
      refused: false,
    },
    {
      name: 'Reflect spread source tuple stack',
      source: 'function frames(error:Error) { return Reflect.get(...[error,"stack"] as const); }',
      refused: true,
    },
    {
      name: 'Reflect spread source constant tuple stack',
      source:
        'function frames(error:Error) { const args=[error,"stack"] as const; return Reflect.get(...args); }',
      refused: true,
    },
    {
      name: 'Reflect spread key after known receiver',
      source: 'function frames(error:Error) { return Reflect.get(error,...["stack"] as const); }',
      refused: true,
    },
    {
      name: 'Reflect spread ordinary tuple data',
      source: 'function frames() { return Reflect.get(...[{stack:"fixed"},"stack"] as const); }',
      refused: false,
    },
    {
      name: 'Reflect spread safe name key',
      source: 'function frames(error:Error) { return Reflect.get(...[error,"name"] as const); }',
      refused: false,
    },
    {
      name: 'Reflect spread shadow implementation',
      source:
        'function frames(error:Error) { const Reflect={get(_value:unknown,key:string){return key;}}; return Reflect.get(...[error,"stack"] as const); }',
      refused: false,
    },
    {
      name: 'Reflect unknown rest after known receiver',
      source:
        'function frames(error:Error,keys:string[]) { return Reflect.get(error,...keys as [string]); }',
      refused: true,
    },
    {
      name: 'Reflect unknown rest retains known prefix',
      source:
        'function frames(error:Error,keys:string[]) { return Reflect.get(...[],error,...keys as [string]); }',
      refused: true,
    },
    {
      name: 'Reflect wholly unknown arguments stay opaque',
      source: 'function frames(args:[object,string]) { return Reflect.get(...args); }',
      refused: false,
    },
    {
      name: 'Reflect deferred tuple later key mutation',
      source:
        'const error=new Error("ours"); const args=[error,"name"] as const; function frames(){return Reflect.get(...args);} (args as unknown as [Error,string])[1]="stack";',
      refused: true,
    },
    {
      name: 'Reflect deferred immutable tuple keeps safe key',
      source:
        'const error=new Error("ours"); const args=[error,"name"] as const; function frames(){return Reflect.get(...args);}',
      refused: false,
    },
    {
      name: 'Reflect deferred ordinary data tuple mutation',
      source:
        'const error={stack:"fixed",name:"data"}; const args=[error,"name"] as const; function frames(){return Reflect.get(...args);} (args as unknown as [typeof error,string])[1]="stack";',
      refused: false,
    },
  ])('$name', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'computed-key-followups.ts', source);
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
