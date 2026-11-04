import { writeFileSync } from 'node:fs';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'retained-assignment',
    source:
      "const state={banner:'initial'};export function caption(value:string){const alias=state;alias.banner=value;return alias.banner;}",
    shared: false,
  },
  {
    id: 'retained-alias-chain',
    source:
      "const state={banner:'initial'};export function caption(value:string){const first=state;const alias=first;alias.banner=value;return alias.banner;}",
    shared: false,
  },
  {
    id: 'retained-wrapped-alias',
    source:
      "const state={banner:'initial'};export function caption(value:string){const alias=(state as {banner:string})!;alias.banner=value;return alias.banner;}",
    shared: false,
  },
  {
    id: 'retained-alias-inner-block',
    source:
      "const state={banner:'initial'};export function caption(value:string){{const alias=state;alias.banner=value;}return state.banner;}",
    shared: false,
  },
  {
    id: 'retained-native-set-alias',
    source:
      'const state=new Set<string>();export function caption(value:string){const alias=state;alias.add(value);return String(alias.size);}',
    shared: false,
  },
  {
    id: 'retained-native-array-alias',
    source:
      'const state:string[]=[];export function caption(value:string){const alias=state;alias.push(value);return String(alias.length);}',
    shared: false,
  },
  {
    id: 'retained-borrowed-array-alias',
    source:
      'const state:string[]=[];export function caption(value:string){const alias=state;Array.prototype.push.call(alias,value);return String(alias.length);}',
    shared: false,
  },
  {
    id: 'retained-native-assign-alias',
    source:
      "const state={banner:'initial'};export function caption(value:string){const alias=state;Object.assign(alias,{banner:value});return alias.banner;}",
    shared: false,
  },
  {
    id: 'retained-own-method-alias',
    source:
      'const state={count:0,bump(){return ++this.count;}};export function caption(value:string){const alias=state;return value+String(alias.bump());}',
    shared: false,
  },
  {
    id: 'retained-class-method-alias',
    source:
      'class Counter{count=0;bump(){return ++this.count;}}const state=new Counter();export function caption(value:string){const alias=state;return value+String(alias.bump());}',
    shared: false,
  },
  {
    id: 'retained-optional-property-delete',
    source:
      "const state:{banner?:string}={banner:'initial'};export function caption(value:string){const alias=state;delete alias.banner;return value;}",
    shared: false,
  },
  {
    id: 'direct-retained-write-existing-pin',
    source:
      "const state={banner:'initial'};export function caption(value:string){state.banner=value;return state.banner;}",
    shared: false,
  },
  {
    id: 'fresh-local-alias-data',
    source:
      "export function caption(value:string){const state={banner:'initial'};const alias=state;alias.banner=value;return alias.banner;}",
    shared: true,
  },
  {
    id: 'fresh-local-set-data',
    source:
      'export function caption(value:string){const state=new Set<string>();const alias=state;alias.add(value);return String(alias.size);}',
    shared: true,
  },
  {
    id: 'fresh-local-own-method-data',
    source:
      'export function caption(value:string){const state={count:0,bump(){return ++this.count;}};const alias=state;return value+String(alias.bump());}',
    shared: true,
  },
  {
    id: 'parameter-shadow-data',
    source:
      "const state={banner:'retained'};function write(state:{banner:string},value:string){const alias=state;alias.banner=value;return alias.banner;}export function caption(value:string){return write({banner:'fresh'},value);}",
    shared: true,
  },
  {
    id: 'block-shadow-data',
    source:
      "const state={banner:'retained'};export function caption(value:string){{const state={banner:'fresh'};const alias=state;alias.banner=value;return alias.banner;}}",
    shared: true,
  },
  {
    id: 'switch-shadow-data',
    source:
      "const state={banner:'retained'};export function caption(value:string){switch(value){default:const state={banner:'fresh'};const alias=state;alias.banner=value;return alias.banner;}}",
    shared: true,
  },
  {
    id: 'primitive-number-freeze-data',
    source:
      'const state=1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'primitive-string-assign-data',
    source:
      "const state='fixed';export function caption(value:string){const alias=state;const result=Object.assign(alias,{banner:value});return result.banner;}",
    shared: true,
  },
  {
    id: 'primitive-chain-freeze-data',
    source:
      'const state=true;const initial=state;export function caption(value:string){const alias=initial;Object.freeze(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'fresh-destructured-holder-data',
    source:
      "const state={banner:'retained'};export function caption(value:string){const {state}={state:{banner:'fresh'}};const alias=state;alias.banner=value;return alias.banner;}",
    shared: true,
  },
  {
    id: 'retained-own-setTime-origin-alias',
    source:
      "const receiver={setTime(_value:number){return {banner:'x'};}};const state=receiver.setTime(NaN);export function caption(value:string){const alias=state;alias.banner=value;return alias.banner;}",
    shared: false,
  },
  {
    id: 'retained-own-setTime-direct-pin',
    source:
      "const receiver={setTime(_value:number){return {banner:'x'};}};const state=receiver.setTime(NaN);export function caption(value:string){state.banner=value;return state.banner;}",
    shared: false,
  },
  {
    id: 'native-nan-freeze-data',
    source:
      'export function caption(value:string){const alias=NaN;Object.freeze(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'native-nan-seal-data',
    source:
      'export function caption(value:string){const alias=NaN;Object.seal(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'native-nan-preventExtensions-data',
    source:
      'export function caption(value:string){const alias=NaN;Object.preventExtensions(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'native-nan-chain-data',
    source:
      'const initial=NaN;const middle=initial;export function caption(value:string){const alias=middle;Object.freeze(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'shadow-nan-object-held',
    source:
      'const NaN={banner:"initial"};export function caption(value:string){const alias=NaN;Object.freeze(alias);return value;}',
    shared: false,
  },
  {
    id: 'shadow-nan-primitive-data',
    source:
      'const NaN=2;export function caption(value:string){const alias=NaN;Object.freeze(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'shadow-nan-local-object-data',
    source:
      'export function caption(value:string){const NaN={banner:"initial"};const alias=NaN;Object.freeze(alias);return value;}',
    shared: true,
  },
  {
    id: 'native-infinity-freeze-data',
    source:
      'export function caption(value:string){const alias=Infinity;Object.freeze(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'native-infinity-seal-data',
    source:
      'export function caption(value:string){const alias=Infinity;Object.seal(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'native-infinity-preventExtensions-data',
    source:
      'export function caption(value:string){const alias=Infinity;Object.preventExtensions(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'native-infinity-chain-data',
    source:
      'const initial=Infinity;const middle=initial;export function caption(value:string){const alias=middle;Object.freeze(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'shadow-infinity-object-held',
    source:
      'const Infinity={banner:"initial"};export function caption(value:string){const alias=Infinity;Object.freeze(alias);return value;}',
    shared: false,
  },
  {
    id: 'shadow-infinity-primitive-data',
    source:
      'const Infinity=2;export function caption(value:string){const alias=Infinity;Object.freeze(alias);return value+String(alias);}',
    shared: true,
  },
  {
    id: 'shadow-infinity-local-object-data',
    source:
      'export function caption(value:string){const Infinity={banner:"initial"};const alias=Infinity;Object.freeze(alias);return value;}',
    shared: true,
  },
] as const;

describe('kept value identity through whole local constants', () => {
  it.each(CASES)('$id', ({ source, shared }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'kept-constant-aliases.ts', source);

    expect(unsettledIn(parsed.sourceFile) !== undefined).toBe(!shared);
  });
});

describe('shared module admission of kept constant aliases', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_ALIAS_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, shared }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        "export function normalizeFilter(value:string):TodoFilter{return String(caption(value)).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: !shared, reasons });
    const refused = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(shared ? [] : [refused]);
  });
});
