import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'reported-then-second-assignment',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,(Object.assign(error,{stack:"fixed"}),undefined))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-second-define-property',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,(Object.defineProperty(error,"stack",{value:"fixed"}),undefined))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-bracket-second-assignment',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error)["then"](undefined,(Object.assign(error,{stack:"fixed"}),undefined))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-second-void-replacement',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,void Object.assign(error,{stack:"fixed"}))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-second-immediate-helper',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,(()=>{Object.assign(error,{stack:"fixed"});return undefined;})())).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-second-property-getter',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,({get absent(){Object.assign(error,{stack:"fixed"});return undefined;}}).absent)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'finally-ignored-second-assignment',
    source:
      'type Finally=(callback?:()=>void,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).finally as Finally)(()=>{},(Object.assign(error,{stack:"fixed"}),undefined))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'finally-ignored-third-assignment',
    source:
      'type Finally=(callback?:()=>void,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).finally as Finally)(()=>{},undefined,(Object.assign(error,{stack:"fixed"}),undefined))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-ignored-third-assignment',
    source:
      'type Then=(fulfilled?:undefined,rejected?:undefined,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).then as Then)(undefined,undefined,(Object.assign(error,{stack:"fixed"}),undefined))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-spread-tail-assignment',
    source:
      'type Then=(fulfilled?:undefined,rejected?:undefined,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).then as Then)(undefined,undefined,...([(Object.assign(error,{stack:"fixed"}),undefined)] as const))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'finally-outer-chain-tail-assignment',
    source:
      'type Finally=(callback?:()=>void,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).then(undefined).finally as Finally)(()=>{},(Object.assign(error,{stack:"fixed"}),undefined))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-plain-undefined-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,undefined)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-rejection-callback-creation-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,()=>{Object.assign(error,{stack:"fixed"});return error;})).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-rejection-function-creation-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,function(){Object.assign(error,{stack:"fixed"});return error;})).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-quiet-spread-tail-pin',
    source:
      'type Then=(fulfilled?:undefined,rejected?:undefined,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).then as Then)(undefined,undefined,...([undefined,1] as const))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-quiet-alias-spread-tail-pin',
    source:
      'type Then=(fulfilled?:undefined,rejected?:undefined,...tail:unknown[])=>Promise<Error>;const tail=[undefined,1] as const;async function frames(error:Error){return(await (Promise.resolve(error).then as Then)(undefined,undefined,...tail)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'finally-no-tail-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'finally-quiet-tail-pin',
    source:
      'type Finally=(callback?:()=>void,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).finally as Finally)(()=>{},undefined,0)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'finally-ignored-function-creation-pin',
    source:
      'type Finally=(callback?:()=>void,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).finally as Finally)(()=>{},()=>{Object.assign(error,{stack:"fixed"});})).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'finally-quiet-spread-tail-pin',
    source:
      'type Finally=(callback?:()=>void,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).finally as Finally)(()=>{},...([undefined,0] as const))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'catch-existing-effect-boundary-pin',
    source:
      'type Catch=(rejected?:undefined,...tail:unknown[])=>Promise<Error>;async function frames(error:Error){return(await (Promise.resolve(error).catch as Catch)(undefined,(Object.assign(error,{stack:"fixed"}),undefined))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-fixed-data-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve({stack:"fixed"}).then(undefined,undefined)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
] as const;

describe('native Promise trailing evaluation readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('native Promise trailing evaluation admissions', () => {
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
