import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'event-init-supplied-words',
    source:
      'function words(error:Error){const event=new Event("initial");event.initEvent(error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-init-caught-words',
    source:
      'function words(){try{JSON.parse("{");}catch(error){const event=new Event("initial");event.initEvent(error as never);return event.type;}}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'event-init-custom-event',
    source:
      'function words(error:Error){const event=new CustomEvent("initial");event.initEvent(error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-init-native-aliases',
    source:
      'function words(error:Error){const Native=Event;const first=new Native("initial");const event=first;event.initEvent(error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-init-borrowed-call',
    source:
      'function words(error:Error){const event=new Event("initial");Event.prototype.initEvent.call(event,error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-init-borrowed-apply',
    source:
      'function words(error:Error){const event=new Event("initial");Event.prototype.initEvent.apply(event,[error as never]);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-init-reflect-apply',
    source:
      'function words(error:Error){const event=new Event("initial");Reflect.apply(Event.prototype.initEvent,event,[error]);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-init-borrowed-ignores-own',
    source:
      'function words(error:Error){const event=new Event("initial");event.initEvent=()=>{};Event.prototype.initEvent.call(event,error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-init-error-array',
    source:
      'function words(error:Error){const event=new Event("initial");event.initEvent([error] as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'event-init-local-words-pin',
    source:
      'function words(){const event=new Event("initial");event.initEvent(new Error("fixed") as never);return event.type;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'event-init-plain-type-pin',
    source:
      'function words(){const event=new Event("initial");event.initEvent("fixed");return event.type;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'event-init-own-assignment-pin',
    source:
      'function words(error:Error){const event=new Event("initial");event.initEvent=()=>{};event.initEvent(error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-init-own-descriptor-pin',
    source:
      'function words(error:Error){const event=new Event("initial");Object.defineProperty(event,"initEvent",{value:()=>{}});event.initEvent(error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-init-own-object-pin',
    source:
      'function words(error:Error){const event={type:"fixed",initEvent(_name:unknown){}};event.initEvent(error);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-init-local-constructor-pin',
    source:
      'class Event{type="fixed";constructor(_name:string){}initEvent(_name:unknown){}}function words(error:Error){const event=new Event("initial");event.initEvent(error);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-init-booleans-not-text-pin',
    source:
      'function words(error:Error){const event=new Event("initial");event.initEvent("fixed",error as never,error as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-init-ignored-tail-pin',
    source:
      'function words(error:Error){const event=new Event("initial");(event.initEvent as unknown as(...values:unknown[])=>void)("fixed",false,false,error);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-init-own-array-text-pin',
    source:
      'function words(error:Error){const name=Object.assign([error],{toString(){return"fixed";}});const event=new Event("initial");event.initEvent(name as never);return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'event-init-opaque-apply-list-pin',
    source:
      'function words(error:Error){function packed():[string,Error]{return["fixed",error];}const event=new Event("initial");Reflect.apply(Event.prototype.initEvent,event,packed());return event.type;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
];

describe('native event type method conversions readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'event-init-observations.ts', source);
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

describe('native event type method conversions admissions', () => {
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
