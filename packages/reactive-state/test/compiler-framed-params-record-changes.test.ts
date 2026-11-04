import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'params-assigned-record',
    source:
      'function frames(error:Error){const options={x:error as never};options.x="fixed" as never;return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-bracket-assigned-record',
    source:
      'function frames(error:Error){const options={x:error as never};options["x"]="fixed" as never;return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-binding-reassigned',
    source:
      'function frames(error:Error){let options={x:error as never};options={x:"fixed" as never};return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-whole-alias-write',
    source:
      'function frames(error:Error){const original={x:error as never};const options=original;original.x="fixed" as never;return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-indirect-alias-write',
    source:
      'function frames(error:Error){const options={x:error as never};const other=options;other.x="fixed" as never;return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-assign-write',
    source:
      'function frames(error:Error){const options={x:error as never};Object.assign(options,{x:"fixed"});return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-descriptor-write',
    source:
      'function frames(error:Error){const options={x:error as never};Object.defineProperty(options,"x",{value:"fixed"});return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-captured-prepare',
    source:
      'function frames(error:Error){const options={x:error as never};function prepare(){options.x="fixed" as never;}prepare();return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-literal-spread-snapshot',
    source:
      'function frames(error:Error){const original={x:error as never};original.x="fixed" as never;const options={...original};return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-changed-later-spread',
    source:
      'function frames(error:Error){const original:Record<string,string>={x:error as never};original.x="fixed" as never;const options={x:error as never,...original};return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-unchanged-whole-record',
    source:
      'function frames(error:Error){const options={x:error as never};return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-unchanged-alias-chain',
    source:
      'function frames(error:Error){const original={x:error as never};const second=original;const options=second;return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-literal-record-spread',
    source:
      'function frames(error:Error){const original={x:error as never};const options={...original};return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-copy-before-later-write',
    source:
      'function frames(error:Error){const original={x:error as never};const options={...original};original.x="fixed" as never;return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-mutation-after-construction',
    source:
      'function frames(error:Error){const options={x:error as never};const text=new URLSearchParams(options).get("x");options.x="fixed" as never;return text;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-known-skipped-write',
    source:
      'function frames(error:Error){const options={x:error as never};if(false){options.x="fixed" as never;}return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-unrelated-shadow-write',
    source:
      'function frames(error:Error){const options={x:error as never};{const options={x:"data"};options.x="fixed";}return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-ordinary-record-data',
    source:
      'function frames(error:Error){const options={x:"fixed"};return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-local-error-words',
    source:
      'function frames(error:Error){const options={x:new Error("fixed") as never};return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-assigned-record',
    source:
      'function frames(error:Error){const options={x:error as never};options.x="fixed" as never;return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-bracket-assigned-record',
    source:
      'function frames(error:Error){const options={x:error as never};options["x"]="fixed" as never;return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-binding-reassigned',
    source:
      'function frames(error:Error){let options={x:error as never};options={x:"fixed" as never};return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-whole-alias-write',
    source:
      'function frames(error:Error){const original={x:error as never};const options=original;original.x="fixed" as never;return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-indirect-alias-write',
    source:
      'function frames(error:Error){const options={x:error as never};const other=options;other.x="fixed" as never;return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-assign-write',
    source:
      'function frames(error:Error){const options={x:error as never};Object.assign(options,{x:"fixed"});return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-descriptor-write',
    source:
      'function frames(error:Error){const options={x:error as never};Object.defineProperty(options,"x",{value:"fixed"});return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-captured-prepare',
    source:
      'function frames(error:Error){const options={x:error as never};function prepare(){options.x="fixed" as never;}prepare();return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'headers-literal-spread-snapshot',
    source:
      'function frames(error:Error){const original={x:error as never};original.x="fixed" as never;const options={...original};return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-changed-later-spread',
    source:
      'function frames(error:Error){const original:Record<string,string>={x:error as never};original.x="fixed" as never;const options={x:error as never,...original};return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-unchanged-whole-record',
    source:
      'function frames(error:Error){const options={x:error as never};return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'headers-unchanged-alias-chain',
    source:
      'function frames(error:Error){const original={x:error as never};const second=original;const options=second;return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'headers-literal-record-spread',
    source:
      'function frames(error:Error){const original={x:error as never};const options={...original};return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'headers-copy-before-later-write',
    source:
      'function frames(error:Error){const original={x:error as never};const options={...original};original.x="fixed" as never;return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'headers-mutation-after-construction',
    source:
      'function frames(error:Error){const options={x:error as never};const text=new Headers(options).get("x");options.x="fixed" as never;return text;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'headers-known-skipped-write',
    source:
      'function frames(error:Error){const options={x:error as never};if(false){options.x="fixed" as never;}return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'headers-unrelated-shadow-write',
    source:
      'function frames(error:Error){const options={x:error as never};{const options={x:"data"};options.x="fixed";}return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'headers-ordinary-record-data',
    source:
      'function frames(error:Error){const options={x:"fixed"};return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'headers-local-error-words',
    source:
      'function frames(error:Error){const options={x:new Error("fixed") as never};return new Headers(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-ignored-tail-write',
    source:
      'function frames(error:Error){const options={x:error as never};return new (URLSearchParams as new(...args:unknown[])=>URLSearchParams)(options,Object.assign(options,{x:"fixed"})).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-unknown-handoff',
    source:
      'function frames(error:Error){const options={x:error as never};function replace(value:typeof options){value.x="fixed" as never;}replace(options);return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-local-constructor',
    source:
      'function frames(error:Error){class URLSearchParams{constructor(_value:unknown){}get(_key:string){return"fixed";}}const options={x:error};options.x=new Error("fixed");return new URLSearchParams(options).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
];

describe('changed params record word readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'params-record-changes.ts', source);
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

describe('shared changed params record words', () => {
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
