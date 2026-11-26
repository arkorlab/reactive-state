import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * An argument prefix that ends at a spread the compile cannot read — of a parameter, of a call's
 * result — or at one of a written list other code may have changed keeps what is written past it:
 * the value is known, only its position is not. `Object.assign(box, ...sources, { inner: error })`
 * writes `inner` whatever `sources` holds.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const BOX = 'const box:{inner?:{stack?:string}}={};';
const READ = 'return box.inner!.stack;';
const AS = 'as{inner?:{stack?:string}}';
const NOTE = 'function note(){return 0;}';
const PICK = 'function pick(first:unknown,second:{stack?:string}){void first;return second;}';
const SET =
  'map.set=function(this:Map<string,{stack?:string}>,key:string,first:{stack?:string},...more:{stack?:string}[]){return Map.prototype.set.call(this,key,more.at(-1)??first);};';

const CASES: readonly Case[] = [
  // A source written past a spread the compile cannot read is still copied: its value is known,
  // only its position is not. Each of these was read as nothing.
  {
    id: 'assign-source-past-parameter-spread',
    source: `function frames(error:Error,...sources:object[]){${BOX}Object.assign(box,...sources,{inner:error});${READ}}`,
    refused: true,
  },
  {
    id: 'assign-source-past-call-spread',
    source: `function frames(error:Error){${BOX}Object.assign(box,...defaults(),{inner:error});${READ}function defaults():object[]{return[];}}`,
    refused: true,
  },
  {
    id: 'assign-source-between-two-spreads',
    source: `function frames(error:Error,first:object[]=[],second:object[]=[]){${BOX}Object.assign(box,...first,{inner:error},...second);${READ}}`,
    refused: true,
  },
  {
    id: 'assign-source-past-two-spreads',
    source: `function frames(error:Error,first:object[]=[],second:object[]=[]){${BOX}Object.assign(box,...first,...second,{inner:error});${READ}}`,
    refused: true,
  },
  {
    id: 'assign-named-source-past-spread',
    source: `function frames(error:Error,...sources:object[]){${BOX}const last={inner:error};Object.assign(box,...sources,last);${READ}}`,
    refused: true,
  },
  {
    id: 'assign-listed-source-past-spread',
    source: `function frames(error:Error,...sources:object[]){${BOX}Object.assign(box,...sources,...[{inner:error}]);${READ}}`,
    refused: true,
  },
  // A written list a call may have changed before the spread reads it ends the prefix as well.
  {
    id: 'assign-source-past-exposed-list',
    source: `function frames(error:Error){${BOX}const defaults=[{other:1}];note();Object.assign(box,...defaults,{inner:error});${READ}${NOTE}}`,
    refused: true,
  },
  {
    id: 'assign-source-in-exposed-list',
    source: `function frames(error:Error){${BOX}const sources=[{other:1},{inner:error}];note();Object.assign(box,...sources);${READ}${NOTE}}`,
    refused: true,
  },
  // Past a written list the call's own work may have changed, and then a spread it cannot read.
  {
    id: 'assign-source-past-reordered-and-unread-spreads',
    source: `function frames(error:Error,...sources:object[]){${BOX}const args=[{other:1}];Object.assign(box,note()as{},...args,...sources,{inner:error});${READ}${NOTE}}`,
    refused: true,
  },
  // The result of an assign into a fresh object, read in place or kept.
  {
    id: 'assign-result-source-past-spread',
    source: `function frames(error:Error,...sources:object[]){return(Object.assign({},...sources,{inner:error})${AS}).inner!.stack;}`,
    refused: true,
  },
  {
    id: 'assign-result-source-before-spread',
    source: `function frames(error:Error,...sources:object[]){return(Object.assign({},{inner:error},...sources)${AS}).inner!.stack;}`,
    refused: true,
  },
  {
    id: 'assign-result-source-past-exposed-list',
    source: `function frames(error:Error){const defaults=[{other:1}];note();return(Object.assign({},...defaults,{inner:error})${AS}).inner!.stack;${NOTE}}`,
    refused: true,
  },
  {
    id: 'assign-kept-result-source-past-spread',
    source:
      'function frames(error:Error,...sources:object[]){const merged:{inner?:{stack?:string}}=Object.assign({},...sources,{inner:error});return merged.inner!.stack;}',
    refused: true,
  },
  // A descriptor, an entry's value and an own method's argument past a spread are each possible.
  {
    id: 'define-descriptor-past-key-spread',
    source: `function frames(error:Error,...keys:[]){${BOX}Object.defineProperty(box,...keys,'inner',{value:error});${READ}}`,
    refused: true,
  },
  {
    id: 'define-descriptor-past-spread',
    source: `function frames(error:Error,...none:[]){${BOX}Object.defineProperty(box,'inner',...none,{value:error});${READ}}`,
    refused: true,
  },
  {
    id: 'entry-value-past-spread',
    source:
      "function frames(error:Error,...none:[]){return(Object.fromEntries([['k',...none,error]])as Record<string,{stack?:string}>).k!.stack;}",
    refused: true,
  },
  {
    id: 'open-set-value-past-spread',
    source: `function frames(error:Error,...more:{stack?:string}[]){const map=new Map<string,{stack?:string}>();${SET}(map.set as(...given:unknown[])=>unknown)('k',{stack:'fixed'},...more,error);return map.get('k')!.stack;}`,
    refused: true,
  },
  // Read before: the source stands before the spread, or the spread is of a written list.
  {
    id: 'assign-source-before-spread-pin',
    source: `function frames(error:Error,...sources:object[]){${BOX}Object.assign(box,{inner:error},...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'assign-source-past-written-list-pin',
    source: `function frames(error:Error){${BOX}const sources=[{other:1}];Object.assign(box,...sources,{inner:error});${READ}}`,
    refused: true,
  },
  {
    id: 'assign-result-source-past-written-list-pin',
    source: `function frames(error:Error){const sources=[{other:1}];return(Object.assign({},...sources,{inner:error})${AS}).inner!.stack;}`,
    refused: true,
  },
  {
    id: 'define-descriptor-pin',
    source: `function frames(error:Error){${BOX}Object.defineProperty(box,'inner',{value:error});${READ}}`,
    refused: true,
  },
  // What a source written past the spread holds is still what is read: data stays data.
  {
    id: 'assign-fixed-source-past-spread-data-pin',
    source: `function frames(error:Error,...sources:object[]){void error;${BOX}Object.assign(box,...sources,{inner:{stack:'fixed'}});${READ}}`,
    refused: false,
  },
  {
    id: 'assign-fixed-source-past-written-list-data-pin',
    source: `function frames(error:Error){void error;${BOX}const sources=[{other:1}];Object.assign(box,...sources,{inner:{stack:'fixed'}});${READ}}`,
    refused: false,
  },
  {
    id: 'assign-fixed-source-past-exposed-list-data-pin',
    source: `function frames(error:Error){void error;${BOX}const defaults=[{other:1}];note();Object.assign(box,...defaults,{inner:{stack:'fixed'}});${READ}${NOTE}}`,
    refused: false,
  },
  {
    id: 'assign-fixed-source-past-reordered-and-unread-spreads-data-pin',
    source: `function frames(error:Error,...sources:object[]){void error;${BOX}const args=[{other:1}];Object.assign(box,note()as{},...args,...sources,{inner:{stack:'fixed'}});${READ}${NOTE}}`,
    refused: false,
  },
  {
    id: 'assign-other-field-past-spread-data-pin',
    source: `function frames(error:Error,...sources:object[]){const box:{inner?:{stack?:string};failure?:Error}={inner:{stack:'fixed'}};Object.assign(box,...sources,{failure:error});${READ}}`,
    refused: false,
  },
  {
    id: 'assign-result-fixed-source-past-spread-data-pin',
    source: `function frames(error:Error,...sources:object[]){void error;return(Object.assign({},...sources,{inner:{stack:'fixed'}})${AS}).inner!.stack;}`,
    refused: false,
  },
  {
    id: 'assign-kept-result-fixed-source-data-pin',
    source:
      "function frames(error:Error,...sources:object[]){void error;const merged:{inner?:{stack?:string}}=Object.assign({},...sources,{inner:{stack:'fixed'}});return merged.inner!.stack;}",
    refused: false,
  },
  {
    id: 'define-fixed-descriptor-past-key-spread-data-pin',
    source: `function frames(error:Error,...keys:[]){void error;${BOX}Object.defineProperty(box,...keys,'inner',{value:{stack:'fixed'}});${READ}}`,
    refused: false,
  },
  {
    id: 'entry-fixed-value-past-spread-data-pin',
    source:
      "function frames(error:Error,...none:[]){void error;return(Object.fromEntries([['k',...none,{stack:'fixed'}]])as Record<string,{stack?:string}>).k!.stack;}",
    refused: false,
  },
  // Stated limits. What the spread itself holds is not shown — as for a single source the compile
  // cannot read — and a target inside it names no variable; the readers below take no argument
  // past a spread up, or give the whole call up at one. Each is unread, and pinned as such.
  {
    id: 'assign-spread-alone-limit',
    source: `function frames(error:Error,...sources:object[]){void error;${BOX}Object.assign(box,...sources);${READ}}`,
    refused: false,
  },
  {
    id: 'assign-unread-source-limit',
    source: `function frames(error:Error,source:object={}){void error;${BOX}Object.assign(box,source);${READ}}`,
    refused: false,
  },
  {
    id: 'assign-result-spread-alone-limit',
    source: `function frames(error:Error,...sources:object[]){void error;return(Object.assign({},...sources)${AS}).inner!.stack;}`,
    refused: false,
  },
  {
    id: 'assign-target-in-spread-limit',
    source: `function frames(error:Error,...targets:[]){return(Object.assign(...targets,{},{inner:error})${AS}).inner!.stack;}`,
    refused: false,
  },
  {
    id: 'assign-held-target-result-limit',
    source: `function frames(error:Error){${BOX}return(Object.assign(box,{inner:error})${AS}).inner!.stack;}`,
    refused: false,
  },
  {
    id: 'define-descriptor-in-spread-limit',
    source: `function frames(error:Error,...descriptors:[PropertyDescriptor?]){void error;${BOX}Object.defineProperty(box,'inner',...(descriptors as [PropertyDescriptor]));${READ}}`,
    refused: false,
  },
  {
    id: 'assign-json-value-past-spread-limit',
    source:
      "function frames(error:Error,...sources:object[]){return JSON.stringify(Object.assign({},...sources,{inner:error}),['inner','stack']);}",
    refused: false,
  },
  {
    id: 'from-source-before-spread-limit',
    source:
      'function frames(error:Error,...none:[]){return Array.from([error],...none)[0]!.stack;}',
    refused: false,
  },
  {
    id: 'cause-past-spread-limit',
    source:
      "function frames(error:Error,...none:[]){return(new Error(...none,'failed',{cause:error}).cause as{stack?:string}).stack;}",
    refused: false,
  },
  {
    id: 'create-prototype-past-spread-limit',
    source:
      'function frames(error:Error,...none:[]){return(Object.create(...none,error)as{stack?:string}).stack;}',
    refused: false,
  },
  {
    id: 'factory-argument-past-spread-limit',
    source: `function frames(error:Error,...none:[]){return pick(...none,1,error).stack;${PICK}}`,
    refused: false,
  },
  {
    id: 'borrowed-call-past-spread-limit',
    source:
      'function frames(error:Error,...none:[]){return(Object.call(null,...none,error)as{stack?:string}).stack;}',
    refused: false,
  },
];

describe('sources written past a spread the compile cannot read', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'past-spreads.ts', source);
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

describe('shared sources written past a spread the compile cannot read', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
