import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native HTML string methods convert their first attribute after the receiver and operand evaluation. */
const CASES = [
  {
    id: 'reported-link-attribute',
    source: "function frames(error: Error) { return 'x'.link(error as never); }",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'anchor-attribute',
    source: "function frames(error:Error){return 'x'.anchor(error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fontcolor-attribute',
    source: "function frames(error:Error){return 'x'.fontcolor(error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fontsize-attribute',
    source: "function frames(error:Error){return 'x'.fontsize(error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-link-attribute',
    source: "function frames(error:Error){return 'x'['link'](error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-link-call',
    source: "function frames(error:Error){return String.prototype.link.call('x',error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-anchor-apply',
    source:
      "function frames(error:Error){return String.prototype.anchor.apply('x',[error as never]);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflected-fontcolor-apply',
    source:
      "function frames(error:Error){return Reflect.apply(String.prototype.fontcolor,'x',[error]);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-method-alias',
    source:
      "function frames(error:Error){const html=String.prototype.fontsize;return html.call('x',error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'known-argument-spread',
    source:
      "function frames(error:Error){return ('x'.link as(...args:unknown[])=>string)(...[error]);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constant-apply-list',
    source:
      "function frames(error:Error){const args=[error as never];return String.prototype.link.apply('x',args as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'error-binding-alias',
    source: "function frames(error:Error){const failure=error;return 'x'.link(failure as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constant-text-receiver',
    source: "function frames(error:Error){const text='x';return text.link(error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-attribute-words',
    source: "function frames(error:Error){return 'x'.link([error]as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-array-attribute-words',
    source: "function frames(error:Error){return 'x'.anchor(['prefix',[error]]as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-error-receiver-existing-origin',
    source:
      "function frames(error:Error){return String.prototype.link.call(error as never,'fixed');}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'plain-attribute',
    source: "function frames(_error:Error){return 'x'.link('fixed');}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'omitted-attribute',
    source: "function frames(_error:Error){return ('x'.link as(...args:unknown[])=>string)();}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-trailing-error',
    source:
      "function frames(error:Error){return ('x'.link as(...args:unknown[])=>string)('fixed',error);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'html-without-attribute-ignores-error',
    source: "function frames(error:Error){return ('x'.bold as(...args:unknown[])=>string)(error);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'html-big-without-attribute-ignores-error',
    source: "function frames(error:Error){return ('x'.big as(...args:unknown[])=>string)(error);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'locally-made-attribute-words',
    source: "function frames(_error:Error){return 'x'.fontcolor(new Error('fixed')as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'source-written-own-error-text',
    source:
      "function frames(error:Error){Object.assign(error,{toString(){return 'fixed';}});return 'x'.link(error as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-html-implementation',
    source:
      "function frames(error:Error){const own={link(_value:unknown){return 'fixed';}};return own.link(error);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-String-shadow',
    source:
      "function frames(error:Error){const String={prototype:{link(_value:unknown){return 'fixed';}}};return String.prototype.link.call('x',error);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-trailing-evaluation-repairs-words',
    source:
      "function frames(error:Error){return ('x'.link as(...args:unknown[])=>string)(error,Object.assign(error,{name:'',message:'fixed'}));}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-receiver-conversion-repairs-words',
    source:
      "function frames(error:Error){return String.prototype.link.call({toString(){Object.assign(error,{name:'',message:'fixed'});return 'x';}}as never,error as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'apply-getter-repairs-words',
    source:
      "function frames(error:Error){return String.prototype.link.apply('x',{get 0(){Object.assign(error,{name:'',message:'fixed'});return error;},length:1}as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'prior-application-work-repairs-words',
    source:
      "function frames(error:Error){Object.assign(error,{name:'',message:'fixed'});return 'x'.link(error as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-receiver-conversion-boundary',
    source:
      'function frames(error:Error,receiver:unknown){return String.prototype.link.call(receiver as never,error as never);}',
    refused: false,
    invocation:
      "(()=>{const error=new Error('ours');return frames(error,{toString(){Object.assign(error,{name:'',message:'fixed'});return 'x';}});})()",
  },
  {
    id: 'earlier-array-element-conversion-boundary',
    source: "function frames(error:Error,value:unknown){return 'x'.link([value,error]as never);}",
    refused: false,
    invocation:
      "(()=>{const error=new Error('ours');return frames(error,{toString(){Object.assign(error,{name:'',message:'fixed'});return 'prefix';}});})()",
  },
  {
    id: 'bound-data-control',
    source: "function frames(_error:Error){return String.prototype.link.bind('x')('fixed');}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'null-receiver-attribute-not-evaluated',
    source:
      "function frames(error:Error){try{return String.prototype.link.call(null,error as never);}catch{return 'fixed';}}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'undefined-receiver-attribute-not-evaluated',
    source:
      "function frames(error:Error){try{return String.prototype.link.call(undefined,error as never);}catch{return 'fixed';}}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('native HTML attribute readers', () => {
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

describe('shared native HTML attribute text', () => {
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
