import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A constructor parameter's default, and a binding element's on the way to a destructured name,
 * stand for what the construction leaves `undefined`, with the parameters they read.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly native: string;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-bare-typeof',
    source:
      'class Failure extends Error{constructor(value:unknown){super(typeof value);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'asserted-identifier-typeof',
    source:
      'class Failure extends Error{constructor(value:unknown){super(typeof ((value as never)));}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'reflect-construction-typeof',
    source:
      'class Failure extends Error{constructor(value:unknown){super(typeof value);}}function frames(error:Error){return Reflect.construct(Failure,[error]).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'typeof-default',
    source:
      'class Failure extends Error{constructor(value:unknown,word=typeof value){super(word);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'default-parameter-typeof',
    source:
      'class Failure extends Error{constructor(fallback:unknown,value=fallback){super(typeof value);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'destructured-typeof',
    source:
      'class Failure extends Error{constructor({value}:{value:unknown}){super(typeof value);}}function frames(error:Error){return new Failure({value:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'array-pattern-typeof',
    source:
      'class Failure extends Error{constructor([value]:readonly unknown[]){super(typeof value);}}function frames(error:Error){return new Failure([error]).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'aggregate-typeof',
    source:
      'class Failure extends AggregateError{constructor(value:unknown){super([],typeof value);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'dom-message-typeof',
    source:
      'class Failure extends DOMException{constructor(value:unknown){super(typeof value);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'String-typeof',
    source:
      'class Failure extends Error{constructor(value:unknown){super(String(typeof value));}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'typeof-arguments',
    source:
      'class Failure extends Error{constructor(value:unknown){super(typeof arguments);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'omitted-undefined-data',
    source:
      'class Failure extends Error{constructor(value?:unknown){super(typeof value);}}function frames(error:Error){return new Failure().message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'undefined',
  },
  {
    id: 'primitive-data',
    source:
      'class Failure extends Error{constructor(value:unknown){super(typeof value);}}function frames(error:Error){return new Failure(42).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'number',
  },
  {
    id: 'direct-word-control',
    source:
      'class Failure extends Error{constructor(value:unknown){super(value as never);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'String-word-control',
    source:
      'class Failure extends Error{constructor(value:unknown){super(String(value));}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'separate-word-read-control',
    source:
      'class Failure extends Error{constructor(value:unknown,words:unknown){super(typeof value+String(words));}}function frames(error:Error){return new Failure(error,error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'objectError: supplied',
  },
  {
    id: 'property-stack-existing-refusal',
    source:
      'class Failure extends Error{constructor(value:Error){super(typeof value.stack);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'string',
  },
  {
    id: 'local-Error-data',
    source:
      'class Error{message="fixed";constructor(_value?:unknown){}}class Failure extends Error{constructor(value:unknown){super(typeof value);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
];

describe('constructor typeof parameter readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'constructor-typeof-parameters.ts', source);
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

describe('shared constructor typeof parameter admissions', () => {
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
