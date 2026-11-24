import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A direct native Error initializer retains its own words beside a destructuring annotation. */
const CASES = [
  {
    id: 'direct-typed-native-error-message',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error=new Error("ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'renamed-typed-native-type-error',
    source:
      'function words(error:Error,choose:boolean){const {message:result}:TypeError=new TypeError("ours");return result;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'computed-typed-native-range-error',
    source:
      'function words(error:Error,choose:boolean){const {["message"]:result}:RangeError=new RangeError("ours");return result;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-native-error-call',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error=Error("ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-native-dom-exception',
    source:
      'function words(error:Error,choose:boolean){const {message}:DOMException=new DOMException("ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-native-aggregate-error',
    source:
      'function words(error:Error,choose:boolean){const {message}:AggregateError=new AggregateError([],"ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-native-constructor-alias',
    source:
      'function words(error:Error,choose:boolean){const Native=Error;const {message}:Error=new Native("ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-global-native-constructor',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error=new globalThis.Error("ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-local-type-alias',
    source:
      'type LocalError=Readonly<Error>;function words(error:Error,choose:boolean){const {message}:LocalError=new Error("ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'asserted-native-initializer',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error=(new Error("ours") as Error);return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-reflect-native-construction',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error=Reflect.construct(Error,["ours"]) as Error;return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-reflect-native-call',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error=Reflect.apply(Error,undefined,["ours"]) as Error;return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'unannotated-native-message-pin',
    source:
      'function words(error:Error,choose:boolean){const {message}=new Error("ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-ordinary-data-opacity-pin',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error={name:"Error",message:"ours"};return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-local-value-alias-opacity-pin',
    source:
      'function words(error:Error,choose:boolean){const original=new Error("ours");const {message}:Error=original;return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-nested-local-container-opacity-pin',
    source:
      'function words(error:Error,choose:boolean){const {nested:{message}}:{nested:Error}={nested:new Error("ours")};return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-array-local-container-opacity-pin',
    source:
      'function words(error:Error,choose:boolean){const [{message}]:readonly Error[]=[new Error("ours")];return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-native-stack-stays-refused',
    source:
      'function words(error:Error,choose:boolean){const {stack}:Error=new Error("ours");return stack;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'stack',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'unannotated-native-stack-stays-refused',
    source:
      'function words(error:Error,choose:boolean){const {stack}=new Error("ours");return stack;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'stack',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-supplied-message-stays-refused',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error=error;return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'supplied',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-opaque-producer-stays-refused',
    source:
      'function words(error:Error,choose:boolean){const load=()=>error;const {message}:Error=load();return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'supplied',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-mixed-local-and-supplied-stays-refused',
    source:
      'function words(error:Error,choose:boolean){const {message}:Error=choose?new Error("ours"):error;return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'supplied',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-nested-supplied-stays-refused',
    source:
      'function words(error:Error,choose:boolean){const {nested:{message}}:{nested:Error}={nested:error};return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'supplied',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'typed-imported-value-stays-refused',
    source:
      'import {supplied} from "@/domain/incoming";function words(error:Error,choose:boolean){const {message}:Error=supplied;return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'supplied',
    native: false,
    beside: {
      'domain/incoming.ts': 'export const supplied=new Error("supplied");',
    },
    sharedRefused: true,
  },
  {
    id: 'typed-local-factory-opacity-pin',
    source:
      'function words(error:Error,choose:boolean){function make(){return new Error("ours");}const {message}:Error=make();return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-subclass-message-opacity-pin',
    source:
      'function words(error:Error,choose:boolean){class Failure extends Error{}const {message}:Error=new Failure("ours");return message;}',
    invocation: 'words(new Error("supplied"),false)',
    refused: false,
    nativeExpected: 'ours',
    native: true,
    beside: {},
    sharedRefused: false,
  },
  {
    id: 'typed-parameter-default-retains-supplied-message',
    source:
      'function take({message}:Error=new Error("ours")){return message;}function words(error:Error,choose:boolean){return take(error);}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'supplied',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'renamed-parameter-default-retains-supplied-message',
    source:
      'function take({message:result}:TypeError=new TypeError("ours")){return result;}function words(error:Error,choose:boolean){return take(error);}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'supplied',
    native: true,
    beside: {},
    sharedRefused: true,
  },
  {
    id: 'computed-aliased-parameter-default-retains-supplied-message',
    source:
      'type LocalError=Readonly<Error>;function take({["message"]:result}:LocalError=new Error("ours")){return result;}function words(error:Error,choose:boolean){return take(error);}',
    invocation: 'words(new Error("supplied"),false)',
    refused: true,
    nativeExpected: 'supplied',
    native: true,
    beside: {},
    sharedRefused: true,
  },
] as const;

describe('typed Error destructuring readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'typed-error-destructuring.ts', source);
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

describe('shared typed Error destructuring', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, sharedRefused, beside }) => {
    const app = await application({
      ...beside,
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?"all":value==="active"||value==="done"?value:"all";}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = sharedRefused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
