import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A spread of a constant's array holds what it was written with only where nothing the call
 * evaluates before it runs code: its receiver, and each argument before it.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const ARGS = 'const args:[{stack?:string}]=[{stack:"fixed"}];';
const BUMP = 'function bump(){args[0]=error;return{};}';
const ITEMS = '([{stack:"fixed"}]as{stack?:string}[])';
const INDEX = 'const index:[number]=[0];';
const KEYS = "const keys:[string]=['safe'];";
const ERROR = 'const args:[Error]=[error];';
const IGNORE = 'function ignore(){return null;}';
const INNER = 'const box:{inner?:{stack?:string}}={};';

const CASES: readonly Case[] = [
  {
    id: 'arrayof-earlier-write',
    source: `function frames(error:Error){${ARGS}return Array.of<{stack?:string}>((args[0]=error,{}),...args)[1]!.stack;}`,
    refused: true,
  },
  {
    id: 'arrayof-earlier-unshift',
    source:
      'function frames(error:Error){const args:{stack?:string}[]=[{stack:"fixed"}];return Array.of<{stack?:string}>((args.unshift(error),{}),...args)[1]!.stack;}',
    refused: true,
  },
  {
    id: 'arrayof-earlier-hoisted-call',
    source: `function frames(error:Error){${ARGS}return Array.of<{stack?:string}>(bump(),...args)[1]!.stack;${BUMP}}`,
    refused: true,
  },
  {
    id: 'arrayof-earlier-valueof',
    source: `function frames(error:Error){${ARGS}const box={valueOf:bump};return(Array.of(+box,...args)as{stack?:string}[])[1]!.stack;${BUMP}}`,
    refused: true,
  },
  {
    id: 'arrayof-nested-earlier-write',
    source: `function frames(error:Error){${ARGS}return Array.of<{stack?:string}>(...[(args[0]=error,{}),...args])[1]!.stack;}`,
    refused: true,
  },
  {
    id: 'arrayof-quiet-earlier-pin',
    source: `function frames(error:Error){${ARGS}return Array.of<{stack?:string}>({},...args)[1]!.stack;}`,
    refused: false,
  },
  {
    id: 'arrayof-quiet-comma-pin',
    source: `function frames(error:Error){${ARGS}return Array.of<{stack?:string}>((void 0,{}),...args)[1]!.stack;}`,
    refused: false,
  },
  {
    id: 'arrayof-expanded-spread-pin',
    source: `function frames(error:Error){${ARGS}const head=[{}];return Array.of<{stack?:string}>(...head,...args)[1]!.stack;}`,
    refused: false,
  },
  {
    id: 'arrayof-fresh-literal-pin',
    source: `function frames(error:Error){${ARGS}return Array.of<{stack?:string}>((args[0]=error,{}),...[{stack:"fixed"}])[1]!.stack;}`,
    refused: false,
  },
  {
    id: 'with-earlier-write',
    source: `function frames(error:Error){${ARGS}return ${ITEMS}.with((args[0]=error,0),...args)[0]!.stack;}`,
    refused: true,
  },
  {
    id: 'with-earlier-hoisted-call',
    source: `function frames(error:Error){${ARGS}return ${ITEMS}.with(at(),...args)[0]!.stack;function at(){args[0]=error;return 0;}}`,
    refused: true,
  },
  {
    id: 'with-quiet-earlier-pin',
    source: `function frames(error:Error){${ARGS}return ${ITEMS}.with(0,...args)[0]!.stack;}`,
    refused: false,
  },
  {
    id: 'at-receiver-write',
    source: `function frames(error:Error){${INDEX}return([(index[0]=1,{stack:"fixed"}),error]as{stack?:string}[]).at(...index)!.stack;}`,
    refused: true,
  },
  {
    id: 'at-receiver-hoisted-call',
    source: `function frames(error:Error){${INDEX}return([first(),error]as{stack?:string}[]).at(...index)!.stack;function first(){index[0]=1;return{stack:"fixed"};}}`,
    refused: true,
  },
  {
    id: 'at-quiet-receiver-pin',
    source: `function frames(error:Error){${INDEX}return([{stack:"fixed"},error]as{stack?:string}[]).at(...index)!.stack;}`,
    refused: false,
  },
  {
    id: 'map-get-receiver-write',
    source: `function frames(error:Error){${KEYS}return new Map<string,{stack?:string}>([['bad',error],['safe',(keys[0]='bad',{stack:'fixed'})]]).get(...keys)!.stack;}`,
    refused: true,
  },
  {
    id: 'map-get-constructed-receiver-pin',
    source: `function frames(error:Error){${KEYS}return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...keys)!.stack;}`,
    refused: false,
  },
  {
    id: 'at-borrowed-global-pin',
    source: `function frames(error:Error){${INDEX}const items:{stack?:string}[]=[{stack:"fixed"},error];return(Array.prototype.at.call(items,...index)as{stack?:string}).stack;}`,
    refused: false,
  },
  {
    id: 'shape-call-earlier-call',
    source: `function frames(error:Error){${ERROR}return Object.getOwnPropertyNames.call(ignore(),...args).join(',');${IGNORE}}`,
    refused: true,
  },
  {
    id: 'shape-apply-earlier-call',
    source: `function frames(error:Error){${ERROR}return Object.getOwnPropertyNames.apply(ignore(),args).join(',');${IGNORE}}`,
    refused: true,
  },
  {
    id: 'shape-reflect-earlier-call',
    source: `function frames(error:Error){${ERROR}return Reflect.apply(Object.getOwnPropertyNames,ignore(),args).join(',');${IGNORE}}`,
    refused: true,
  },
  {
    id: 'shape-call-quiet-pin',
    source: `function frames(error:Error){const args:[{stack?:string}]=[{stack:'fixed'}];return Object.getOwnPropertyNames.call(null,...args).join(',');}`,
    refused: false,
  },
  {
    id: 'assign-source-earlier-call',
    source: `function frames(error:Error){${INNER}const args=[{inner:error}];Object.assign(box,ignore() as {},...args);return box.inner!.stack;${IGNORE}}`,
    refused: true,
  },
  {
    id: 'define-descriptor-earlier-call',
    source: `function frames(error:Error){${INNER}const args:[PropertyDescriptor]=[{value:error}];Object.defineProperty(box,(ignore(),'inner'),...args);return box.inner!.stack;${IGNORE}}`,
    refused: true,
  },
  // A target that is a member read is no quiet value, so the spread after it is unresolved and the
  // key it holds is not shown: the write is under any name, of each value the spread may supply.
  {
    id: 'define-key-past-member-target',
    source: `function frames(error:Error){const holder:{box:{failure?:{stack?:string}}}={box:{failure:{stack:'fixed'}}};const args=['failure',{value:error}] as const;Object.defineProperty(holder.box,...args);return holder.box.failure!.stack;}`,
    refused: true,
  },
  {
    id: 'define-key-past-member-target-data-pin',
    source: `function frames(error:Error){void error;const holder:{box:{failure?:{stack?:string}}}={box:{failure:{stack:'fixed'}}};const args=['failure',{value:{stack:'other'}}] as const;Object.defineProperty(holder.box,...args);return holder.box.failure!.stack;}`,
    refused: false,
  },
  // The list an `apply` hands on stands past a spread the receiver's work leaves unresolved: it is
  // not shown, and the key it may hold is any.
  {
    id: 'apply-list-past-receiver-work',
    source:
      "function frames(error:Error){const lists:[string[]]=[['stack']];return Object.prototype.hasOwnProperty.apply((work(),error),...lists);function work(){return 0;}}",
    refused: true,
  },
  {
    id: 'assign-source-quiet-pin',
    source: `function frames(error:Error){${INNER}const args=[{inner:{stack:'fixed'}}];Object.assign(box,{},...args);return box.inner!.stack;}`,
    refused: false,
  },
  {
    id: 'concat-earlier-call',
    source: `function frames(error:Error){const args:[Error[]]=[[error]];return([] as {stack?:string}[]).concat(none(),...args)[0]!.stack;function none():{stack?:string}[]{return [];}}`,
    refused: true,
  },
  {
    id: 'fromentries-earlier-call',
    source: `function frames(error:Error){const pair:[Error]=[error];return(Object.fromEntries([[key(),...pair]]) as Record<string,{stack?:string}>).k!.stack;function key(){return 'k';}}`,
    refused: true,
  },
];

describe('argument spreads past what the call evaluates first', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'own-effects.ts', source);
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

describe('shared argument spreads past what the call evaluates first', () => {
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
