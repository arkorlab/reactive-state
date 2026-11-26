import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Boolean-only comparison operands do not become native Error message values. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly native: string;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-strict-undefined',
    source:
      "class Failure extends Error{constructor(error:Error){super(error===undefined?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'strict-not-undefined',
    source:
      "class Failure extends Error{constructor(error:Error){super(error!==undefined?'present':'missing');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'reverse-strict-undefined',
    source:
      "class Failure extends Error{constructor(error:Error){super(undefined===error?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'same-identity-test',
    source:
      "class Failure extends Error{constructor(error:Error){super(error===error?'same':'different');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'same',
  },
  {
    id: 'separate-object-identity',
    source:
      "class Failure extends Error{constructor(error:Error,other:Error){super(error===other?'same':'different');}}function frames(error:Error){return new Failure(error,new Error(\"other\")).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'different',
  },
  {
    id: 'strict-result-String',
    source:
      'class Failure extends Error{constructor(error:Error){super(String(error===undefined));}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'false',
  },
  {
    id: 'strict-result-native-message',
    source:
      'class Failure extends Error{constructor(error:Error){super((error!==undefined)as never);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'true',
  },
  {
    id: 'wrapped-strict-operand',
    source:
      "class Failure extends Error{constructor(error:Error){super(((error as Error)!)!==undefined?'present':'missing');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'strict-constructor-default',
    source:
      "class Failure extends Error{constructor(error:Error,message=error===undefined?'missing':'present'){super(message);}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'destructured-strict-parameter',
    source:
      "class Failure extends Error{constructor({error}:{error:Error}){super(error===undefined?'missing':'present');}}function frames(error:Error){return new Failure({error}).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'array-pattern-strict-parameter',
    source:
      "class Failure extends Error{constructor([error]:readonly Error[]){super(error===undefined?'missing':'present');}}function frames(error:Error){return new Failure([error]).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'aggregate-strict-message',
    source:
      "class Failure extends AggregateError{constructor(error:Error){super([],error===undefined?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'DOM-strict-message',
    source:
      "class Failure extends DOMException{constructor(error:Error){super(error===undefined?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'reflected-strict-message',
    source:
      "class Failure extends Error{constructor(error:Error){super(error===undefined?'missing':'present');}}function frames(error:Error){return Reflect.construct(Failure,[error]).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'bound-strict-message',
    source:
      "class Failure extends Error{constructor(error:Error){super(error===undefined?'missing':'present');}}function frames(error:Error){return new (Failure.bind(null))(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'loose-null-test',
    source:
      "class Failure extends Error{constructor(error:Error){super(error==null?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'loose-undefined-test',
    source:
      "class Failure extends Error{constructor(error:Error){super(error!=undefined?'present':'missing');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'loose-void-test',
    source:
      "class Failure extends Error{constructor(error:Error){super(error==void 0?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'present',
  },
  {
    id: 'typeof-existing-data-pin',
    source:
      'class Failure extends Error{constructor(error:Error){super(typeof error);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'object',
  },
  {
    id: 'literal-message-data-pin',
    source:
      'class Failure extends Error{constructor(error:Error){super("fixed");}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'direct-Error-words-pin',
    source:
      'class Failure extends Error{constructor(error:Error){super(error as never);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'Error: ours',
  },
  {
    id: 'String-Error-words-pin',
    source:
      'class Failure extends Error{constructor(error:Error){super(String(error));}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'Error: ours',
  },
  {
    id: 'implicit-Error-words-pin',
    source:
      'class Failure extends Error{constructor(error:Error){super(""+error);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'Error: ours',
  },
  {
    id: 'selected-Error-value-branch-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super((error!==undefined?error:'missing')as never);}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'Error: ours',
  },
  {
    id: 'loose-string-coercion-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super((error as unknown)=='Error: ours'?'match':'miss');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'match',
  },
  {
    id: 'relational-coercion-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super((error as unknown as number)<0?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'present',
  },
  {
    id: 'stack-member-comparison-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super(error.stack===undefined?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'present',
  },
  {
    id: 'message-member-comparison-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super(error.message==='ours'?'match':'miss');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'match',
  },
  {
    id: 'reflected-stack-comparison-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super(Reflect.get(error,'stack')===undefined?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'present',
  },
  {
    id: 'reflected-message-comparison-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super(Reflect.get(error,'message')==='ours'?'match':'miss');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'match',
  },
  {
    id: 'unknown-call-message-pin',
    source:
      'function words(value:unknown){return String(value);}class Failure extends Error{constructor(error:Error){super(words(error));}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'Error: ours',
  },
  {
    id: 'reflected-value-message-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super(Reflect.get({error},'error')as never);}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'Error: ours',
  },
  {
    id: 'coercing-comparison-peer-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super((error as unknown)===String(error)?'match':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'present',
  },
  {
    id: 'void-operand-conversion-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super(error===void String(error)?'missing':'present');}}function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'present',
  },
  {
    id: 'shadowed-undefined-loose-pin',
    source:
      "class Failure extends Error{constructor(error:unknown,undefined:unknown){super(error==undefined?'match':'miss');}}function frames(error:Error){return new Failure(error,\"Error: ours\").message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'match',
  },
  {
    id: 'subclass-stack-still-local-pin',
    source:
      "class Failure extends Error{constructor(error:Error){super(error===undefined?'missing':'present');}}function frames(error:Error){return new Failure(error).stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    native: 'stack-present',
  },
];

describe('constructor boolean comparison readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'constructor-boolean-comparisons.ts', source);
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

describe('shared constructor boolean comparison admissions', () => {
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
