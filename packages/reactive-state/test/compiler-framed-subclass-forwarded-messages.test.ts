import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A local Error subclass whose constructors only call `super` converts what it passes on to the
 * native message as the native constructor does; its own written words stay its own.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-implicit-constructor',
    source:
      'class Failure extends Error {} function frames(error:Error){return new Failure(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'explicit-super-forward',
    source:
      'class Failure extends Error {constructor(error:never){super(error);}} function frames(error:Error){return new Failure(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'implicit-string-conversion',
    source:
      'class Failure extends Error {} function frames(error:Error){return String(new Failure(error as never));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'implicit-chain-forward',
    source:
      'class Base extends Error {} class Failure extends Base {} function frames(error:Error){return new Failure(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'explicit-chain-forward',
    source:
      'class Base extends Error {constructor(text:never){super(text);}} class Failure extends Base {} function frames(error:Error){return new Failure(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'rest-super-forward',
    source:
      'class Failure extends Error {constructor(...args:[never]){super(...args);}} function frames(error:Error){return new Failure(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reordered-super-forward',
    source:
      "class Failure extends Error {constructor(code:string,error:never){super(error);}} function frames(error:Error){return new Failure('code',error as never).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'aggregate-subclass-message',
    source:
      'class Failure extends AggregateError {} function frames(error:Error){return new Failure([],error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'template-super-message',
    source: `class Failure extends Error {constructor(error:unknown){super(\`wrapped: \${error}\`);}} function frames(error:Error){return new Failure(error).message;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-subclass-message',
    source:
      'class Failure extends Error {} function frames(error:Error){return Reflect.construct(Failure,[error as never]).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-literal-words',
    source: "class Failure extends Error {} function frames(){return new Failure('ours').message;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'explicit-literal-super',
    source:
      "class Failure extends Error {constructor(error:Error){super('fixed');}} function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'cause-option-parameter',
    source:
      "class Failure extends Error {constructor(message:string,cause:unknown){super(message,{cause});}} function frames(error:Error){return new Failure('fixed',error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'implicit-cause-option',
    source:
      "class Failure extends Error {} function frames(error:Error){return new Failure('fixed',{cause:error}).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'explicit-chain-literal',
    source:
      "class Base extends Error {constructor(text:string){super(text);}} class Failure extends Base {constructor(error:Error){super('fixed');}} function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'destructured-super-forward',
    source:
      'class Failure extends Error {constructor({message}:{message:never}){super(message);}} function frames(error:Error){return new Failure({message:error as never}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'default-parameter-forward',
    source:
      'function frames(error:Error){class Failure extends Error {constructor(text:unknown=error){super(text as never);}} return new Failure().message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'arguments-super-forward',
    source:
      'class Failure extends Error {constructor(..._:[never]){super(...(arguments as unknown as [never]));}} function frames(error:Error){return new Failure(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-construction-forward',
    source:
      'class Failure extends Error {} function frames(error:Error){return new Failure(...[error as never]).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'template-code-words',
    source: `class Failure extends Error {constructor(code:number){super(\`code \${code}\`);}} function frames(){return new Failure(404).message;}`,
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'status-text-words',
    source: `class HttpError extends Error {constructor(status:number,text:string){super(\`\${status}: \${text}\`);}} function frames(code:number,text:string){return new HttpError(code,text).message;}`,
    invocation: 'frames(404,"Not Found")',
    refused: false,
  },
];

describe('forwarded subclass message readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'subclass-forwarded-messages.ts', source);
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

describe('shared forwarded subclass message admissions', () => {
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
