import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'param-extra-evaluated-rewrite',
    source:
      'function words(error:Error){return(new URLSearchParams("Fixed%3A+fixed=kept").get as(...args:unknown[])=>string|null)(error,Object.assign(error,{message:"fixed",name:"Fixed"}));}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'param-extra-no-rewrite-pin',
    source:
      'function words(error:Error){return(new URLSearchParams("Fixed%3A+fixed=kept").get as(...args:unknown[])=>string|null)(error,0);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-extra-evaluated-rewrite',
    source:
      'function words(error:Error){const event=new Event("initial");(event.initEvent as(...args:unknown[])=>void)(error,false,false,Object.assign(error,{message:"fixed",name:"Fixed"}));return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-earlier-dictionary-getter-rewrite',
    source:
      'function words(error:Error){return new Response(null,{get headers(){Object.assign(error,{message:"fixed",name:"Fixed"});return{};},statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-extra-no-rewrite-pin',
    source:
      'function words(error:Error){const event=new Event("initial");(event.initEvent as(...args:unknown[])=>void)(error,false,false,0);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-borrowed-list-rewrite',
    source:
      'function words(error:Error){const params=new URLSearchParams("Fixed%3A+fixed=kept");return Reflect.apply(URLSearchParams.prototype.get,params,[error,Object.assign(error,{message:"fixed",name:"Fixed"})]);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-wrapper-extra-rewrite',
    source:
      'function words(error:Error){const params=new URLSearchParams("Fixed%3A+fixed=kept");return(URLSearchParams.prototype.get.apply as unknown as(...args:unknown[])=>string|null)(params,[error],Object.assign(error,{message:"fixed",name:"Fixed"}));}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-borrowed-list-rewrite',
    source:
      'function words(error:Error){const event=new Event("initial");Reflect.apply(Event.prototype.initEvent,event,[error,false,false,Object.assign(error,{message:"fixed",name:"Fixed"})]);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-extra-argument-rewrite',
    source:
      'function words(error:Error){const Native=Response as unknown as new(...args:unknown[])=>Response;return new Native(null,{statusText:error as never},Object.assign(error,{message:"fixed",name:"Fixed"})).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-literal-initializer-rewrite',
    source:
      'function words(error:Error){return new Response(null,{statusText:error as never,ignored:Object.assign(error,{message:"fixed",name:"Fixed"})} as ResponseInit).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-headers-conversion-rewrite',
    source:
      'function words(error:Error){return new Response(null,{headers:{fixed:{toString(){Object.assign(error,{message:"fixed",name:"Fixed"});return"value";}}} as unknown as HeadersInit,statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-status-conversion-rewrite',
    source:
      'function words(error:Error){return new Response(null,{status:{valueOf(){Object.assign(error,{message:"fixed",name:"Fixed"});return 200;}} as never,statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-body-conversion-rewrite',
    source:
      'function words(error:Error){const body={toString(){Object.assign(error,{message:"fixed",name:"Fixed"});return"body";}};return new Response(body as never,{statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-spread-getter-rewrite',
    source:
      'function words(error:Error){return new Response(null,{statusText:error as never,...{get ignored(){Object.assign(error,{message:"fixed",name:"Fixed"});return 1;}}} as ResponseInit).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-constructor-input-rewrite',
    source:
      'function words(error:Error){return new URLSearchParams((Object.assign(error,{message:"fixed",name:"Fixed"}),"Fixed%3A+fixed=kept")).get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-constructor-getter-rewrite',
    source:
      'function words(error:Error){const event=new Event("initial",{get bubbles(){Object.assign(error,{message:"fixed",name:"Fixed"});return false;}});event.initEvent(error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-quiet-headers-getter-pin',
    source:
      'function words(error:Error){return new Response(null,{get headers(){return{};},statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-quiet-status-getter-pin',
    source:
      'function words(error:Error){return new Response(null,{get status(){return 200;},statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-quiet-headers-alias-pin',
    source:
      'function words(error:Error){const headers={fixed:"value"};return new Response(null,{headers,statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-quiet-spread-getter-pin',
    source:
      'function words(error:Error){return new Response(null,{...{get statusText(){return error as never;}}}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-borrowed-quiet-tail-pin',
    source:
      'function words(error:Error){const params=new URLSearchParams("fixed=value");return Reflect.apply(URLSearchParams.prototype.get,params,[error,0]);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-borrowed-quiet-tail-pin',
    source:
      'function words(error:Error){const event=new Event("initial");Reflect.apply(Event.prototype.initEvent,event,[error,false,false,0]);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-constant-input-initializer-rewrite',
    source:
      'function words(error:Error){const name=(Object.assign(error,{message:"fixed",name:"Fixed"}),error);return new URLSearchParams("Fixed%3A+fixed=kept").get(name as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-quiet-constant-input-pin',
    source:
      'function words(error:Error){const name=error;return new URLSearchParams("fixed=value").get(name as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-computed-member-rewrite',
    source:
      'function words(error:Error){const params=new URLSearchParams("Fixed%3A+fixed=kept");return params[(Object.assign(error,{message:"fixed",name:"Fixed"}),"get")](error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-computed-member-rewrite',
    source:
      'function words(error:Error){const event=new Event("initial");event[(Object.assign(error,{message:"fixed",name:"Fixed"}),"initEvent")](error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-array-coercion-method-rewrite',
    source:
      'function words(error:Error){const head={toString(){Object.assign(error,{message:"fixed",name:"Fixed"});return"fixed";}};return new URLSearchParams("fixed%2CFixed%3A+fixed=kept").get([head,error] as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-array-opaque-element-rewrite',
    source:
      'function words(error:Error){function selected(head:unknown){return new URLSearchParams("fixed%2CFixed%3A+fixed=kept").get([head,error] as never);}return selected({toString(){Object.assign(error,{message:"fixed",name:"Fixed"});return"fixed";}});}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
];

describe('native text conversion evaluation order readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-text-order.ts', source);
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

describe('native text conversion evaluation order admissions', () => {
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
