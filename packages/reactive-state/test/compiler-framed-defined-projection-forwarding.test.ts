import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'singular-write-reported',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});box.failure=error;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'plural-write-same-boundary',
    source:
      'function frames(error:Error){const box=Object.defineProperties({failure:error},{failure:{value:{stack:"fixed"},writable:true}});box.failure=error;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'whole-target-alias-write',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const alias=box;alias.failure=error;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'assigned-target-write',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});Object.assign(box,{failure:error});const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'saved-projected-data-control',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'direct-data-control',
    source:
      'function frames(error:Error){return Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'computed-map-target-alternative-reported',
    source:
      'function frames(error:Error,key:"failure"|"other"){return Object.defineProperties({failure:error},{[key]:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"other")',
    reader: true,
    refused: true,
  },
  {
    id: 'computed-map-exact-key-data-control',
    source:
      'function frames(error:Error){const key="failure";return Object.defineProperties({failure:error},{[key]:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'computed-map-earlier-descriptor-alternative',
    source:
      'function frames(error:Error,key:"failure"|"other"){return Object.defineProperties({failure:{stack:"fixed"}},{failure:{value:error},[key]:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"other")',
    reader: true,
    refused: true,
  },
  {
    id: 'computed-map-later-exact-data-control',
    source:
      'function frames(error:Error,key:"failure"|"other"){return Object.defineProperties({failure:error},{[key]:{value:error},failure:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"other")',
    reader: false,
    refused: false,
  },
  {
    id: 'whole-target-quiet-alias-data',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const alias=box;const failure:Error=alias.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'whole-target-alias-then-original-write',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const alias=box;box.failure=error;const failure:Error=alias.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'projected-quiet-alias-data',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const failure:Error=box.failure;const alias=failure;return alias.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'projected-data-captured-before-target-write',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const failure:Error=box.failure;box.failure=error;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'data-read-before-later-write',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const failure:Error=box.failure;const result=failure.stack;box.failure=error;return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'statically-skipped-target-write-data',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});if(false)box.failure=error;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'unreferenced-writer-data',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});function skipped(){box.failure=error;}const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'called-writer-exposure',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});function change(){box.failure=error;}change();const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'lexical-unrelated-writer-data',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});function skipped(){const box={failure:error};box.failure=error;return box;}const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'singular-installed-error-pin',
    source:
      'function frames(error:Error){return Object.defineProperty({failure:{stack:"fixed"}},"failure",{value:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'plural-installed-error-pin',
    source:
      'function frames(error:Error){const box=Object.defineProperties({failure:{stack:"fixed"}},{failure:{value:error}});return box.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'plural-redefined-target-error',
    source:
      'function frames(error:Error){const box=Object.defineProperties({failure:error},{failure:{value:{stack:"fixed"},writable:true,configurable:true}});Object.defineProperty(box,"failure",{value:error});const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'saved-readonly-quiet-data',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:false,configurable:false});const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-native-shadow-data',
    source:
      'function frames(error:Error){const Object={defineProperty:(target:{failure:{stack:string}},_key:string,_descriptor:unknown)=>target};return Object.defineProperty({failure:{stack:"fixed"}},"failure",{value:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'computed-map-unrelated-names-target-error',
    source:
      'function frames(error:Error,key:"left"|"right"){return Object.defineProperties({failure:error},{[key]:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"left")',
    reader: true,
    refused: true,
  },
  {
    id: 'computed-map-unrelated-names-target-data',
    source:
      'function frames(error:Error,key:"left"|"right"){return Object.defineProperties({failure:{stack:"fixed"}},{[key]:{value:error}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"left")',
    reader: false,
    refused: false,
  },
  {
    id: 'computed-map-possible-error-installed',
    source:
      'function frames(error:Error,key:"failure"|"other"){return Object.defineProperties({failure:{stack:"fixed"}},{[key]:{value:error}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"failure")',
    reader: true,
    refused: true,
  },
  {
    id: 'computed-map-only-data-alternatives',
    source:
      'function frames(error:Error,key:"failure"|"other"){return Object.defineProperties({failure:{stack:"fixed"}},{[key]:{value:{stack:"other"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"other")',
    reader: false,
    refused: false,
  },
  {
    id: 'computed-map-numeric-key-alternatives',
    source:
      'function frames(error:Error,key:0|1){return Object.defineProperties({0:error},{[key]:{value:{stack:"fixed"}}})[0].stack;}',
    invocation: 'frames(new Error("ours"),1)',
    reader: true,
    refused: true,
  },
  {
    id: 'computed-map-later-definite-error',
    source:
      'function frames(error:Error,key:"failure"|"other"){return Object.defineProperties({failure:{stack:"fixed"}},{[key]:{value:{stack:"fixed"}},failure:{value:error}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"other")',
    reader: true,
    refused: true,
  },
  {
    id: 'readonly-failed-write-caught-data',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:false,configurable:false});try{box.failure=error;}catch{}const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'unrelated-own-data-write',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error,other:0},"failure",{value:{stack:"fixed"},writable:true});box.other=1;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'projected-own-stack-primitive-write',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const failure:Error=box.failure;failure.stack="fixed2";return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'additional-unused-whole-alias-data',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:error},"failure",{value:{stack:"fixed"},writable:true});const unused=box;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'original-target-write',
    source:
      'function frames(error:Error){const original={failure:error};const box=Object.defineProperty(original,"failure",{value:{stack:"fixed"},writable:true});original.failure=error;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'original-target-quiet-data',
    source:
      'function frames(error:Error){const original={failure:error};const box=Object.defineProperty(original,"failure",{value:{stack:"fixed"},writable:true});const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'original-target-whole-alias-write',
    source:
      'function frames(error:Error){const original={failure:error};const alias=original;const box=Object.defineProperty(alias,"failure",{value:{stack:"fixed"},writable:true});original.failure=error;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-target-write',
    source:
      'function frames(error:Error,target:{failure:Error}){const box=Object.defineProperty(target,"failure",{value:{stack:"fixed"},writable:true});target.failure=error;const failure:Error=box.failure;return failure.stack;}',
    invocation: 'frames(new Error("ours"),{failure:new Error("first")})',
    reader: true,
    refused: true,
  },
  {
    id: 'computed-getter-overwritten-by-definite-data',
    source:
      'function frames(error:Error,key:"failure"|"other"){return Object.defineProperties({failure:error},{get [key](){return{value:error};},failure:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"failure")',
    reader: false,
    refused: false,
  },
  {
    id: 'unselected-descriptor-value-getter-rewrite',
    source:
      'function frames(error:Error,key:"failure"|"other"){return Object.defineProperties({failure:error},{prepare:{get value(){Object.assign(error,{stack:"fixed"});return 0;}},[key]:{value:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"),"other")',
    reader: false,
    refused: false,
  },
  {
    id: 'ignored-definition-tail-rewrite',
    source:
      'function frames(error:Error,key:"failure"|"other"){return(Object.defineProperties as(...args:unknown[])=>{failure:Error})({failure:error},{[key]:{value:{stack:"fixed"}}},Object.assign(error,{stack:"fixed"})).failure.stack;}',
    invocation: 'frames(new Error("ours"),"other")',
    reader: false,
    refused: false,
  },
  {
    id: 'quiet-definition-tail-control',
    source:
      'function frames(error:Error,key:"failure"|"other"){return(Object.defineProperties as(...args:unknown[])=>{failure:Error})({failure:error},{[key]:{value:{stack:"fixed"}}},0).failure.stack;}',
    invocation: 'frames(new Error("ours"),"other")',
    reader: true,
    refused: true,
  },
  {
    id: 'computed-prior-callback-bridge-data',
    source:
      'function frames(error:Error){function collect(value:Error,key:"failure"|"other",prepare:()=>void){prepare();return Object.defineProperties({failure:value},{[key]:{value:{stack:"fixed"}}}).failure.stack;}return collect(error,"other",()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'computed-quiet-owner-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,key:"failure"|"other",prepare:()=>void){const unused=0;return Object.defineProperties({failure:value},{[key]:{value:{stack:"fixed"}}}).failure.stack;}return collect(error,"other",()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'computed-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,key:"failure"|"other",prepare:()=>void){prepare();function read(){return Object.defineProperties({failure:value},{[key]:{value:{stack:"fixed"}}}).failure.stack;}return read();}return collect(error,"other",()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'unselected-aliased-attribute-getter-words',
    source:
      'function frames(error: Error, key: "failure" | "other") { const prepare = { get value() { Object.assign(error, { stack: "fixed" }); return 0; } }; return Object.defineProperties({ failure: error }, { prepare, [key]: { value: { stack: "fixed" } } }).failure.stack; }',
    invocation: 'frames(new Error("ours"), "other")',
    refused: false,
    reader: false,
  },
  {
    id: 'unselected-aliased-data-descriptor-positive',
    source:
      'function frames(error: Error, key: "failure" | "other") { const prepare = { value: 0 }; return Object.defineProperties({ failure: error }, { prepare, [key]: { value: { stack: "fixed" } } }).failure.stack; }',
    invocation: 'frames(new Error("ours"), "other")',
    refused: true,
    reader: true,
  },
  {
    id: 'unselected-aliased-enumerable-getter-words',
    source:
      'function frames(error: Error, key: "failure" | "other") { const descriptor = { get enumerable() { Object.assign(error, { stack: "fixed" }); return true; }, value: 0 }; return Object.defineProperties({ failure: error }, { prepare: descriptor, [key]: { value: { stack: "fixed" } } }).failure.stack; }',
    invocation: 'frames(new Error("ours"), "other")',
    refused: false,
    reader: false,
  },
  {
    id: 'unselected-captured-descriptor-getter-words',
    source:
      'function frames(error: Error) { const descriptor = { get value() { Object.assign(error, { stack: "fixed" }); return 0; } }; function collect(value: Error, key: "failure" | "other") { return Object.defineProperties({ failure: value }, { prepare: descriptor, [key]: { value: { stack: "fixed" } } }).failure.stack; } return collect(error, "other"); }',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'unselected-whole-aliased-data-descriptor-positive',
    source:
      'function frames(error: Error, key: "failure" | "other") { const original = { value: 0 }; const prepare = original; return Object.defineProperties({ failure: error }, { prepare, [key]: { value: { stack: "fixed" } } }).failure.stack; }',
    invocation: 'frames(new Error("ours"), "other")',
    refused: true,
    reader: true,
  },
] as const;

describe('native Iterator from words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'defined-projection-forwarding.ts', source);
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

describe('shared native Iterator from admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_FORWARDING_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: refused, reasons });
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
