import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'params-own-error-text-pin',
    source:
      'function words(error:Error){Object.defineProperty(error,"toString",{value(){return"fixed";}});return new URLSearchParams("fixed=kept").get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-own-error-text-pin',
    source:
      'function words(error:Error){Object.defineProperty(error,"toString",{value(){return"fixed";}});const event=new Event("initial");event.initEvent(error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-own-error-text-pin',
    source:
      'function words(error:Error){Object.defineProperty(error,"toString",{value(){return"fixed";}});return new Response(null,{statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-own-error-assignment-existing-refusal-pin',
    source:
      'function words(error:Error){error.toString=()=>"fixed";return new URLSearchParams("fixed=kept").get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-own-error-primitive-pin',
    source:
      'function words(error:Error){Object.defineProperty(error,Symbol.toPrimitive,{value(){return"fixed";}});return new URLSearchParams("fixed=kept").get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-own-error-alias-pin',
    source:
      'function words(error:Error){const name=error;Object.defineProperty(error,"toString",{value(){return"fixed";}});return new URLSearchParams("fixed=kept").get(name as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-selected-before-own-error-pin',
    source:
      'function words(error:Error){const options={statusText:error as never};Object.defineProperty(error,"toString",{value(){return"fixed";}});return new Response(null,options).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-getter-before-own-error-pin',
    source:
      'function words(error:Error){const options={get statusText(){return error as never;}};Object.defineProperty(error,"toString",{value(){return"fixed";}});return new Response(null,options).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-array-own-error-text-pin',
    source:
      'function words(error:Error){Object.defineProperty(error,"toString",{value(){return"fixed";}});return new URLSearchParams("fixed=kept").get([error] as never);}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-array-own-error-text-pin',
    source:
      'function words(error:Error){Object.defineProperty(error,"toString",{value(){return"fixed";}});const event=new Event("initial");event.initEvent([error] as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-array-own-error-text-pin',
    source:
      'function words(error:Error){Object.defineProperty(error,"toString",{value(){return"fixed";}});return new Response(null,{statusText:[error] as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'params-unchanged-error-alias-sensitive',
    source:
      'function words(error:Error){const name=error;return new URLSearchParams("fixed=kept").get(name as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-unchanged-error-alias-sensitive',
    source:
      'function words(error:Error){const name=error;const event=new Event("initial");event.initEvent(name as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-unchanged-error-holder-sensitive',
    source:
      'function words(error:Error){const options={statusText:error as never};return new Response(null,options).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-unchanged-error-getter-sensitive',
    source:
      'function words(error:Error){return new Response(null,{get statusText(){return error as never;}}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-dead-own-error-sensitive',
    source:
      'function words(error:Error){if(false){Object.defineProperty(error,"toString",{value(){return"fixed";}});}return new URLSearchParams("fixed=kept").get(error as never);}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'params-later-own-error-sensitive',
    source:
      'function words(error:Error){const text=new URLSearchParams("fixed=kept").get(error as never);Object.defineProperty(error,"toString",{value(){return"fixed";}});return text;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'init-event-default-use',
    source:
      'function words(error:Error){const event=new Event("initial");const {a=typeof error}=(event.initEvent(error as never),{} as {a?:string});return event.type+a;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'init-event-default-data',
    source:
      'function words(error:Error){const event=new Event("initial");const {a=typeof error}=(event.initEvent("next"),{} as {a?:string});return event.type+a;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
];

describe('native Error input conversion exposure readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-inputs.ts', source);
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

describe('native Error input conversion exposure admissions', () => {
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
