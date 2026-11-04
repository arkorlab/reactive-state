import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Pattern-bound data retains its selected type instead of its containing error type. */
const CASES = [
  {
    id: 'destructured-data-message',
    source:
      'function frames(error:Error&{body:{message:string}}){const {body}=error;return body.message;}',
    invocation: 'frames(Object.assign(new Error("ours"),{body:{message:"fixed",stack:"fixed"}}))',
    refused: false,
  },
  {
    id: 'destructured-data-stack',
    source:
      'function frames(error:Error&{body:{stack:string}}){const {body}=error;return body.stack;}',
    invocation: 'frames(Object.assign(new Error("ours"),{body:{message:"fixed",stack:"fixed"}}))',
    refused: false,
  },
  {
    id: 'parameter-pattern-data',
    source: 'function frames({body}:Error&{body:{stack:string}}){return body.stack;}',
    invocation: 'frames(Object.assign(new Error("ours"),{body:{message:"fixed",stack:"fixed"}}))',
    refused: false,
  },
  {
    id: 'renamed-pattern-data',
    source:
      'function frames(error:Error&{body:{stack:string}}){const {body:data}=error;return data.stack;}',
    invocation: 'frames(Object.assign(new Error("ours"),{body:{message:"fixed",stack:"fixed"}}))',
    refused: false,
  },
  {
    id: 'nested-pattern-data',
    source:
      'function frames(error:Error&{payload:{body:{stack:string}}}){const {payload:{body}}=error;return body.stack;}',
    invocation: 'frames(Object.assign(new Error("ours"),{payload:{body:{stack:"fixed"}}}))',
    refused: false,
  },
  {
    id: 'selected-error-stays-error',
    source: 'function frames(error:Error&{body:Error}){const {body}=error;return body.stack;}',
    invocation: 'frames(Object.assign(new Error("ours"),{body:new Error("nested")}))',
    refused: true,
  },
  {
    id: 'selected-name-error-assignment',
    source:
      'function frames(error:Error&{body:{stack:string}}){let {body}=error;body=new Error("assigned");return body.stack;}',
    invocation: 'frames(Object.assign(new Error("ours"),{body:{message:"fixed",stack:"fixed"}}))',
    refused: true,
  },
  {
    id: 'selected-default-error',
    source:
      'function frames(error:Error&{body?:{stack?:string}}){const {body=new Error("fallback")}=error;return body.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'selected-default-data',
    source:
      'function frames(error:Error&{body?:{message:string}}){const {body={message:"fixed"}}=error;return body.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-error-still-error',
    source: 'function frames(error:Error){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-default-error-stays-error',
    source:
      'function frames(error:Error&{payload?:{body?:{stack?:string}}}){const {payload:{body}={body:new Error("fallback")}}=error;return body?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-default-data-stays-data',
    source:
      'function frames(error:Error&{payload?:{body:{message:string}}}){const {payload:{body}={body:{message:"fixed"}}}=error;return body.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('destructured error data readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'destructured-error-data.ts', source);
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

describe('shared destructured error data', () => {
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
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
