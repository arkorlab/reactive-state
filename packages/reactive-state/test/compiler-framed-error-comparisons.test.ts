import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only comparisons that convert an error may observe its engine-chosen words. */
const CASES = [
  {
    id: 'compare-alias-loose-equal',
    source:
      "type Failure=Error;function matches(error:Failure){return (error as unknown as string)=='Error: x';}",
    invocation: 'matches(new Error("ours"))',
    refused: true,
  },
  {
    id: 'compare-loose-not-equal',
    source: "function matches(error:Error){return (error as unknown as string)!='Error: x';}",
    invocation: 'matches(new Error("ours"))',
    refused: true,
  },
  {
    id: 'compare-less',
    source: "function matches(error:Error){return (error as unknown as string)<'Error: x';}",
    invocation: 'matches(new Error("ours"))',
    refused: true,
  },
  {
    id: 'compare-less-equal',
    source: "function matches(error:Error){return (error as unknown as string)<='Error: x';}",
    invocation: 'matches(new Error("ours"))',
    refused: true,
  },
  {
    id: 'compare-greater',
    source: "function matches(error:Error){return (error as unknown as string)>'Error: x';}",
    invocation: 'matches(new Error("ours"))',
    refused: true,
  },
  {
    id: 'compare-greater-equal',
    source: "function matches(error:Error){return (error as unknown as string)>='Error: x';}",
    invocation: 'matches(new Error("ours"))',
    refused: true,
  },
  {
    id: 'compare-reversed',
    source: "function matches(error:Error){return 'Error: x'==(error as unknown as string);}",
    invocation: 'matches(new Error("ours"))',
    refused: true,
  },
  {
    id: 'compare-caught',
    source:
      "function matches(){try{JSON.parse('bad');}catch(error){return (error as unknown as string)=='Error: x';}}",
    invocation: 'matches()',
    refused: true,
  },
  {
    id: 'compare-unknown-other',
    source: 'function matches(error:Error,other:unknown){return error==other;}',
    invocation: 'matches(new Error("ours"),"Error: x")',
    refused: true,
  },
  {
    id: 'compare-mutable-other',
    source:
      "function matches(error:Error){let other={};other='Error: x' as never;return error==other;}",
    invocation: 'matches(new Error("ours"))',
    refused: true,
  },
  {
    id: 'compare-strict-equal',
    source: "function matches(error:Error){return (error as unknown as string)==='Error: x';}",
    invocation: 'matches(new Error("ours"))',
    refused: false,
  },
  {
    id: 'compare-strict-not-equal',
    source: "function matches(error:Error){return (error as unknown as string)!=='Error: x';}",
    invocation: 'matches(new Error("ours"))',
    refused: false,
  },
  {
    id: 'compare-null',
    source: 'function matches(error:Error){return error==null;}',
    invocation: 'matches(new Error("ours"))',
    refused: false,
  },
  {
    id: 'compare-undefined',
    source: 'function matches(error:Error){return error!=undefined;}',
    invocation: 'matches(new Error("ours"))',
    refused: false,
  },
  {
    id: 'compare-object-literal',
    source: 'function matches(error:Error){return error=={};}',
    invocation: 'matches(new Error("ours"))',
    refused: false,
  },
  {
    id: 'compare-array-literal',
    source: 'function matches(error:Error){return error!=[];}',
    invocation: 'matches(new Error("ours"))',
    refused: false,
  },
  {
    id: 'compare-same-error',
    source: 'function matches(error:Error){return error==error;}',
    invocation: 'matches(new Error("ours"))',
    refused: false,
  },
  {
    id: 'compare-other-error',
    source: 'function matches(error:Error,other:Error){return error!=other;}',
    invocation: 'matches(new Error("ours"),new Error("other"))',
    refused: false,
  },
  {
    id: 'compare-constant-object',
    source:
      'function matches(error:Error){const object={};const alias=object;return error==alias;}',
    invocation: 'matches(new Error("ours"))',
    refused: false,
  },
  {
    id: 'compare-made-words',
    source: "function matches(){return (new Error('ours') as unknown as string)=='Error: ours';}",
    invocation: 'matches()',
    refused: false,
  },
  {
    id: 'compare-data',
    source: "function matches(){const data={message:'fixed'};return data=='fixed' as never;}",
    invocation: 'matches()',
    refused: false,
  },
  {
    id: 'compare-shadowed-Error',
    source:
      "class Error{toString(){return 'fixed';}}function matches(error:Error){return (error as unknown as string)=='fixed';}",
    invocation: 'matches(new Error())',
    refused: false,
  },
  {
    id: 'different-parameter-fields',
    source:
      'function frames({error,text}:{error:Error;text:string}){return (error as unknown as string)==text;}',
    invocation: 'frames({error:new Error("ours"),text:""})',
    refused: true,
  },
  {
    id: 'different-variable-fields',
    source:
      'function frames(given:Error){const {error,text}:{error:Error;text:string}={error:given,text:""};return (error as unknown as string)==text;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'same-pattern-name',
    source: 'function frames({error}:{error:Error}){return error==error;}',
    invocation: 'frames({error:new Error("ours")})',
    refused: false,
  },
  {
    id: 'different-error-fields-are-objects',
    source: 'function frames({error,other}:{error:Error;other:Error}){return error==other;}',
    invocation: 'frames({error:new Error("ours"),other:new Error("other")})',
    refused: false,
  },
];

describe('coercive error comparison readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'coercive-error-comparisons.ts', source);
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

describe('shared coercive error comparisons', () => {
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
