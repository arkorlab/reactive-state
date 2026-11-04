import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Possible native abort reasons survive simple conditional prefixes before nested reads. */
const CASES = [
  {
    id: 'conditional-true-prior-error',
    source:
      'function frames(error:Error){const c=new AbortController();if(true)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-unknown-prior-error',
    source:
      'function frames(error:Error,flag:boolean){const c=new AbortController();if(flag)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"),true)',
    refused: true,
  },
  {
    id: 'conditional-false-prior-error-pin',
    source:
      'function frames(error:Error){const c=new AbortController();if(false)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-selected-else-error',
    source:
      'function frames(error:Error){const c=new AbortController();if(false)c.abort({stack:"fixed"});else c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-selected-data-else-error-pin',
    source:
      'function frames(error:Error){const c=new AbortController();if(true)c.abort({stack:"fixed"});else c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-unknown-data-or-error',
    source:
      'function frames(error:Error,flag:boolean){const c=new AbortController();if(flag)c.abort({stack:"fixed"});else c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'conditional-first-data-pin',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort({stack:"fixed"});if(true)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-block-prior-error',
    source:
      'function frames(error:Error){const c=new AbortController();if(true){c.abort(error);}{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-default-prior-error',
    source:
      'function frames(error:Error){const c=new AbortController();if(true)c.abort();{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-own-abort-pin',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort=()=>{};if(true)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason?.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-borrowed-ignores-own',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort=()=>{};if(true)AbortController.prototype.abort.call(c,error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-borrowed-apply',
    source:
      'function frames(error:Error){const c=new AbortController();if(true)AbortController.prototype.abort.apply(c,[error]);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-borrowed-reflect',
    source:
      'function frames(error:Error){const c=new AbortController();if(true)Reflect.apply(AbortController.prototype.abort,c,[error]);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-native-restoration',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort=()=>{};c.abort=AbortController.prototype.abort;if(true)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-selected-own-abort-pin',
    source:
      'function frames(error:Error){const c=new AbortController();if(true){c.abort=()=>{};c.abort(error);}{c.abort({stack:"fixed"});return c.signal.reason?.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-controller-shadow-pin',
    source:
      'function frames(error:Error){const c=new AbortController();if(true)c.abort(error);{const c=new AbortController();c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-constructor-shadow-pin',
    source:
      'function frames(error:Error){class AbortController{signal={reason:{stack:"fixed"}};abort(_reason?:unknown){}}const c=new AbortController();if(true)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-prebirth-data-pin',
    source:
      'function frames(error:Error){const reason=Object.defineProperty(new Error("fixed"),"stack",{value:"fixed"});const c=new AbortController();if(true)c.abort(reason);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-outer-prebirth-data-pin',
    source:
      'function frames(error:Error){const reason=Object.defineProperty(new Error("fixed"),"stack",{value:"fixed"});{const c=new AbortController();if(true)c.abort(reason);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-local-words-pin',
    source:
      'function frames(error:Error,flag:boolean){const c=new AbortController();if(flag)c.abort(new Error("fixed"));{c.abort(new Error("fixed"));return(c.signal.reason as Error).message;}}',
    invocation: 'frames(new Error("ours"),true)',
    refused: false,
  },
  {
    id: 'conditional-existing-immediate-error-pin',
    source:
      'function frames(error:Error){JSON.parse("{}");{const c=new AbortController();c.abort(error);return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-replaced-signal-pin',
    source:
      'function frames(error:Error){const c=new AbortController();Object.defineProperty(c,"signal",{value:{reason:{stack:"fixed"}}});if(true)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-native-undefined-false-pin',
    source:
      'function frames(error:Error){const c=new AbortController();const off=undefined;if(off)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-negated-undefined-true',
    source:
      'function frames(error:Error){const c=new AbortController();const off=undefined;if(!off)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-shadowed-undefined-true',
    source:
      'function frames(error:Error){const c=new AbortController();const undefined=true;if(undefined)c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-negated-undefined-skipped-error-pin',
    source:
      'function frames(error:Error){const c=new AbortController();const off=undefined;if(!off)c.abort({stack:"fixed"});else c.abort(error);{c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('conditional enclosing abort reason readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'abort-reason-observations.ts', source);
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

describe('conditional enclosing abort reason admissions', () => {
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
