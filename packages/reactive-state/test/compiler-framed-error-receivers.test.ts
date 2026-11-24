import { appendFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known receiver operations retain Error origins and selected literal data. */
const CASES = [
  {
    group: 'proxy',
    id: 'set-trap-frames',
    source: 'function frames(error:Error){return new Proxy(error,{set(){return true;}}).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'proxy',
    id: 'has-trap-words',
    source: 'function frames(error:Error){return new Proxy(error,{has(){return true;}}).message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'proxy',
    id: 'local-error-frames',
    source: 'function frames(){return new Proxy(new Error("ours"),{ownKeys(){return [];}}).stack;}',
    refused: true,
    invocation: 'frames()',
  },
  {
    group: 'proxy',
    id: 'get-trap-data',
    source: 'function frames(error:Error){return new Proxy(error,{get(){return "fixed";}}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'proxy',
    id: 'ordinary-target',
    source: 'function frames(){return new Proxy({stack:"fixed"},{set(){return true;}}).stack;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    group: 'proxy',
    id: 'local-error-words',
    source: 'function frames(){return new Proxy(new Error("ours"),{has(){return true;}}).message;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    group: 'proxy',
    id: 'local-proxy-shadow',
    source:
      'class Proxy{constructor(_target:unknown,_handler:unknown){return {stack:"fixed"};}}function frames(error:Error){return new Proxy(error,{set(){return true;}}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'proxy',
    id: 'spread-intercepting-handler',
    source:
      'function frames(error:Error){return new Proxy(error,{...{get(){return "fixed";}}}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'prototype',
    id: 'installed-frames',
    source: 'function frames(error:Error){return Object.setPrototypeOf({},error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'prototype',
    id: 'installed-words',
    source: 'function frames(error:Error){return Object.setPrototypeOf({},error).message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'prototype',
    id: 'local-prototype-frames',
    source: 'function frames(){return Object.setPrototypeOf({},new Error("ours")).stack;}',
    refused: true,
    invocation: 'frames()',
  },
  {
    group: 'prototype',
    id: 'own-stack-data',
    source:
      'function frames(error:Error){return Object.setPrototypeOf({stack:"fixed"},error).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'prototype',
    id: 'own-message-data',
    source:
      'function frames(error:Error){return Object.setPrototypeOf({message:"fixed"},error).message;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'prototype',
    id: 'ordinary-prototype-data',
    source: 'function frames(){return Object.setPrototypeOf({},{stack:"fixed"}).stack;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    group: 'prototype',
    id: 'local-object-shadow',
    source:
      'function frames(error:Error){const Object={setPrototypeOf:()=>({stack:"fixed"})};return Object.setPrototypeOf({},error).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'factory',
    id: 'conditional-error',
    source:
      'function select(error:Error,flag:boolean){if(flag)return error;return {stack:"fixed"};}function frames(error:Error){return select(error,true).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'factory',
    id: 'else-error',
    source:
      'function select(error:Error,flag:boolean){if(flag){return {stack:"fixed"};}else{return error;}}function frames(error:Error){return select(error,false).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'factory',
    id: 'nested-error',
    source:
      'function select(error:Error,flag:boolean){if(flag){if(flag)return error;}return {stack:"fixed"};}function frames(error:Error){return select(error,true).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'factory',
    id: 'local-conditional-frames',
    source:
      'function select(flag:boolean){if(flag)return new Error("ours");return {stack:"fixed"};}function frames(){return select(true).stack;}',
    refused: true,
    invocation: 'frames()',
  },
  {
    group: 'factory',
    id: 'both-data',
    source:
      'function select(flag:boolean){if(flag)return {stack:"first"};return {stack:"second"};}function frames(){return select(true).stack;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    group: 'factory',
    id: 'unselected-error',
    source:
      'function select(error:Error){if(false)return error;return {stack:"fixed"};}function frames(error:Error){return select(error).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'factory',
    id: 'earlier-data-return',
    source:
      'function select(error:Error){if(true)return {stack:"fixed"};return error;}function frames(error:Error){return select(error).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    group: 'factory',
    id: 'local-conditional-words',
    source:
      'function select(flag:boolean){if(flag)return new Error("first");return new Error("second");}function frames(){return select(true).message;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    group: 'factory',
    id: 'lexical-factory-shadow',
    source:
      'function select(error:Error,flag:boolean){if(flag)return error;return {stack:"outside"};}function frames(error:Error){function select(){return {stack:"fixed"};}return select().stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

/** Actual compiler reasons remain separate from the reader classification. */
function record(source: string, reasons: readonly string[]): void {
  const path = process.env['ERROR_RECEIVER_OBSERVATIONS'];
  if (path !== undefined) appendFileSync(path, `${JSON.stringify({ source, reasons })}\n`);
}

describe('error-receiver readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'pattern-array.ts', source);
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

describe('shared error-receiver', () => {
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
    record(source, reasons);

    expect(reasons.length > 0).toBe(refused);
  });
});
