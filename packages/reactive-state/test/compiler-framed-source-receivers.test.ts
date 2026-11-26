import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native URI arguments and the selected replacement callback retain their consumed words. */
const CASES = [
  {
    id: 'logical-nullish',
    source: 'function frames(value:Error|undefined){return (value ?? new Error("ours"))?.stack;}',
    refused: true,
    topic: 'logical',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'logical-or',
    source: 'function frames(value:Error|undefined){return (value || new Error("ours"))?.stack;}',
    refused: true,
    topic: 'logical',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'logical-and',
    source: 'function frames(value:Error|undefined){return (value && new Error("ours"))?.stack;}',
    refused: true,
    topic: 'logical',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'logical-data-false-and',
    source:
      'function frames(){return (false && new Error("ours") as never as {stack?:string})?.stack;}',
    refused: false,
    topic: 'logical',
    invocation: 'frames()',
  },
  {
    id: 'logical-data-true-or',
    source:
      'function frames(){return (true || new Error("ours") as never as {stack?:string})?.stack;}',
    refused: false,
    topic: 'logical',
    invocation: 'frames()',
  },
  {
    id: 'logical-data-false-nullish',
    source:
      'function frames(){return (false ?? new Error("ours") as never as {stack?:string})?.stack;}',
    refused: false,
    topic: 'logical',
    invocation: 'frames()',
  },
  {
    id: 'logical-data-null-nullish',
    source:
      'function frames(){return (null ?? {stack:"fixed"} as never as {stack?:string})?.stack;}',
    refused: false,
    topic: 'logical',
    invocation: 'frames()',
  },
  {
    id: 'logical-const',
    source:
      'function frames(value:Error){const selected=false;return (selected ? value : {stack:"fixed"}).stack;}',
    refused: false,
    topic: 'logical',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'mutator-defineProperty',
    source:
      "function frames(){return Object.defineProperty(new Error('ours'),'tag',{value:1}).stack;}",
    refused: true,
    topic: 'mutator',
    invocation: 'frames()',
  },
  {
    id: 'mutator-defineProperties',
    source:
      "function frames(){return Object.defineProperties(new Error('ours'),{tag:{value:1}}).stack;}",
    refused: true,
    topic: 'mutator',
    invocation: 'frames()',
  },
  {
    id: 'mutator-setPrototypeOf',
    source:
      "function frames(){return Object.setPrototypeOf(new Error('ours'),Error.prototype).stack;}",
    refused: true,
    topic: 'mutator',
    invocation: 'frames()',
  },
  {
    id: 'mutator-data-defineProperty',
    source:
      "function frames(){return Object.defineProperty({stack:'fixed'},'tag',{value:1}).stack;}",
    refused: false,
    topic: 'mutator',
    invocation: 'frames()',
  },
  {
    id: 'mutator-data-defineProperties',
    source:
      "function frames(){return Object.defineProperties({stack:'fixed'},{tag:{value:1}}).stack;}",
    refused: false,
    topic: 'mutator',
    invocation: 'frames()',
  },
  {
    id: 'mutator-data-own-stack',
    source:
      "function frames(){return Object.defineProperty(new Error('ours'),'stack',{value:'fixed'}).stack;}",
    refused: false,
    topic: 'mutator',
    invocation: 'frames()',
  },
  {
    id: 'mutator-data-own-stack-map',
    source:
      "function frames(){return Object.defineProperties(new Error('ours'),{stack:{value:'fixed'}}).stack;}",
    refused: false,
    topic: 'mutator',
    invocation: 'frames()',
  },
  {
    id: 'borrowed-slice',
    source:
      'function frames(value:Error){return String.prototype.slice.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-trim',
    source:
      'function frames(value:Error){return String.prototype.trim.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-substring',
    source:
      'function frames(value:Error){return String.prototype.substring.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-charAt',
    source:
      'function frames(value:Error){return String.prototype.charAt.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-charCodeAt',
    source:
      'function frames(value:Error){return String.prototype.charCodeAt.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-codePointAt',
    source:
      'function frames(value:Error){return String.prototype.codePointAt.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-at',
    source:
      'function frames(value:Error){return String.prototype.at.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-repeat',
    source:
      'function frames(value:Error){return String.prototype.repeat.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-normalize',
    source:
      'function frames(value:Error){return String.prototype.normalize.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-toUpperCase',
    source:
      'function frames(value:Error){return String.prototype.toUpperCase.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-toLowerCase',
    source:
      'function frames(value:Error){return String.prototype.toLowerCase.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-trimStart',
    source:
      'function frames(value:Error){return String.prototype.trimStart.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-trimEnd',
    source:
      'function frames(value:Error){return String.prototype.trimEnd.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-isWellFormed',
    source:
      'function frames(value:Error){return String.prototype.isWellFormed.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-toWellFormed',
    source:
      'function frames(value:Error){return String.prototype.toWellFormed.call(value as never,0 as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-apply',
    source:
      'function frames(value:Error){return String.prototype.slice.apply(value as never,[0]);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-reflect',
    source: 'function frames(value:Error){return Reflect.apply(String.prototype.trim,value,[]);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-alias',
    source:
      'function frames(value:Error){const trim=String.prototype.trim;return trim.call(value as never);}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-string-brand',
    source: 'function frames(value:Error){return String.prototype.valueOf.call(value as never);}',
    refused: false,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-local-words',
    source: "function frames(){return String.prototype.trim.call(new Error('ours') as never);}",
    refused: false,
    topic: 'borrowed',
    invocation: 'frames()',
  },
  {
    id: 'borrowed-data',
    source: "function frames(){return String.prototype.trim.call('fixed');}",
    refused: false,
    topic: 'borrowed',
    invocation: 'frames()',
  },
  {
    id: 'borrowed-ignored-argument',
    source:
      "function frames(value:Error){return String.prototype.trim.call('fixed',value as never);}",
    refused: false,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-shadow',
    source:
      "function frames(value:Error){const String={prototype:{trim:{call:(_value:unknown)=>'fixed'}}};return String.prototype.trim.call(value);}",
    refused: false,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-anchor',
    source:
      'function frames(value:Error){return String.prototype.anchor.call(value as never,"fixed");}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-fontcolor',
    source:
      'function frames(value:Error){return String.prototype.fontcolor.call(value as never,"red");}',
    refused: true,
    topic: 'borrowed',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'logical-negated-nullish',
    source:
      'function frames(){return ((!null) ?? new Error("ours") as never as {stack?:string})?.stack;}',
    refused: false,
    topic: 'logical',
    invocation: 'frames()',
  },
  {
    id: 'logical-const-nullish',
    source:
      'function frames(){const value=false;return (value ?? new Error("ours") as never as {stack?:string})?.stack;}',
    refused: false,
    topic: 'logical',
    invocation: 'frames()',
  },
];

describe('source receiver readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-encoding-callbacks.ts', source);
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

describe('shared source receivers', () => {
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
