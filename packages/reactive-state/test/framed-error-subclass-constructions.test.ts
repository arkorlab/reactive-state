import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Local constructor inheritance retains the native Error frames it actually constructs. */
const CASES = [
  {
    name: 'module local error subclass',
    source:
      'class Failure extends Error {} function frames() { return new Failure("ours").stack; }',
    error: true,
  },
  {
    name: 'nested local error subclass',
    source:
      'function frames() { class Failure extends Error {} return new Failure("ours").stack; }',
    error: true,
  },
  {
    name: 'multiple native class bases',
    source:
      'class Base extends TypeError {} class Failure extends Base {} function frames() { return new Failure("ours").stack; }',
    error: true,
  },
  {
    name: 'constant local class expression',
    source:
      'const First = class extends Error {}; const Failure = First; function frames() { return new Failure("ours").stack; }',
    error: true,
  },
  {
    name: 'type shadow preserves constructor value',
    source:
      'type Error = { stack: string }; class Failure extends Error {} function frames() { return new Failure("ours").stack; }',
    error: true,
  },
  {
    name: 'constructed data constant alias',
    source:
      'class Failure extends Error { stack = "fixed"; } function frames() { const value = new Failure("ours"); return value.stack; }',
    error: false,
  },
  {
    name: 'changed constructed alias stays private',
    source:
      'class Failure extends Error { stack = "fixed"; } function frames() { const value = new Failure("ours"); value.stack = new Error("other").stack ?? ""; return value.stack; }',
    error: true,
  },
  {
    name: 'thenable subclass awaited data',
    source:
      'class Failure extends Error { then(resolve:(data:{stack:string})=>void) { resolve({stack:"fixed"}); } } async function frames() { return (await new Failure("ours")).stack; }',
    error: false,
  },
  {
    name: 'constructor returns native error',
    source:
      'class Failure extends Error { constructor() { super(); return new Error("other"); } } function frames() { return new Failure().stack; }',
    error: true,
  },
  {
    name: 'reflect native replacement remains private',
    source:
      'class Failure extends Error { stack = "fixed"; } function frames(error: Error = new Error("other")) { const args: [unknown, string] = [new Failure("ours"), "stack"]; args[0] = error; return Reflect.get(...args); }',
    error: true,
  },
  {
    name: 'written constructor binding stays opaque',
    source:
      'function frames() { class Failure extends Error {} Failure = class extends Error { stack = "fixed"; }; return new Failure("ours").stack; }',
    error: false,
  },
  {
    name: 'written constructor native replacement',
    source:
      'function frames() { class Failure extends Error { stack = "fixed"; } Failure = class extends Error { declare stack: string; }; return new Failure().stack; }',
    error: true,
  },
  {
    name: 'returned-supplied-error-message',
    source:
      'class Failure extends Error {constructor(error:Error){super();return error;}} function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    error: true,
  },
  {
    name: 'returned-supplied-error-string',
    source:
      'class Failure extends Error {constructor(error:Error){super();return error;}} function frames(error:Error){return String(new Failure(error));}',
    invocation: 'frames(new Error("ours"))',
    error: true,
  },
  {
    name: 'inherited-proxy-skips-own-literal',
    source:
      'class Base extends Error {constructor(){super();return new Proxy(new Error("ours"),{defineProperty(){return true;}});}} class Failure extends Base {stack="fixed";} function frames(){return new Failure().stack;}',
    invocation: 'frames()',
    error: true,
  },
  {
    name: 'decorator-replaces-written-class',
    source:
      'function replace<T extends new (...args:any[])=>Error>(_target:T):T{return Error as unknown as T;} @replace class Failure extends Error {stack="fixed";} function frames(){return new Failure("ours").stack;}',
    invocation: 'frames()',
    error: true,
  },
  {
    name: 'ordinary data class construction',
    source: 'class Failure { stack = "fixed"; } function frames() { return new Failure().stack; }',
    error: false,
  },
  {
    name: 'local Error constructor shadow',
    source:
      'class Error { stack = "fixed"; } class Failure extends Error {} function frames() { return new Failure().stack; }',
    error: false,
  },
  {
    name: 'constant data class base',
    source:
      'const Base = class { stack = "fixed"; }; class Failure extends Base {} function frames() { return new Failure().stack; }',
    error: false,
  },
  {
    name: 'locally written subclass words',
    source:
      'class Failure extends Error {} function frames() { return new Failure("ours").message; }',
    error: false,
  },
  {
    name: 'constructed subclass data stack',
    source:
      'class Failure extends Error { stack = "fixed"; } function frames() { return new Failure("ours").stack; }',
    error: false,
  },
  {
    name: 'constructor returns ordinary data',
    source:
      'class Failure extends Error { constructor() { super(); return { stack: "fixed" }; } } function frames() { return new Failure().stack; }',
    error: false,
  },
] as const;

describe('written local error subclass constructor reader', () => {
  it.each(CASES)('$name', ({ source, error }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'error-subclass.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    const reasons: string[] = [];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const reason = framedRead(node);
      if (reason !== undefined) reasons.push(reason);
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(reasons.length > 0).toBe(error);
  });
});

describe('written local error subclass constructor shared admission', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$name', async (row) => {
    const { source, error } = row;
    const invocation = 'invocation' in row ? row.invocation : 'frames()';
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = error ? [shared] : [];

    expect(compile(app).refusals.map((item) => item.reason)).toStrictEqual(expected);
  });
});
