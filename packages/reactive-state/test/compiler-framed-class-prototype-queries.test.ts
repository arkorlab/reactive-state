import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Local class prototype queries retain constructor heritage with generic prototype erasure. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'local-class-prototype-error',
    source:
      'class Boom extends Error{}function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames(new Boom("ours"))',
    refused: true,
  },
  {
    id: 'local-class-prototype-alias-error',
    source:
      'class Boom extends Error{}const Alias=Boom;function frames(error:typeof Alias.prototype){return error.stack;}',
    invocation: 'frames(new Boom("ours"))',
    refused: true,
  },
  {
    id: 'local-class-prototype-two-aliases-error',
    source:
      'class Boom extends Error{}const First=Boom;const Alias=First;function frames(error:typeof Alias.prototype){return error.stack;}',
    invocation: 'frames(new Boom("ours"))',
    refused: true,
  },
  {
    id: 'class-expression-prototype-error',
    source:
      'const Boom=class extends Error{};function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames(new Boom("ours"))',
    refused: true,
  },
  {
    id: 'local-class-prototype-base-alias-error',
    source:
      'const Native=Error;class Boom extends Native{}function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames(new Boom("ours"))',
    refused: true,
  },
  {
    id: 'local-class-prototype-interface-first-error',
    source:
      'interface Boom{}class Boom extends Error{}function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames(new Boom("ours"))',
    refused: true,
  },
  {
    id: 'local-class-prototype-generic-error',
    source:
      'class Boom<T extends Error=Error> extends Error{}function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames(new Boom("ours"))',
    refused: true,
  },
  {
    id: 'local-class-prototype-data-pin',
    source:
      'class Boom{stack="fixed"}function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'local-class-prototype-native-shadow-pin',
    source:
      'class Error{stack="fixed"}class Boom extends Error{}function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'local-class-prototype-annotation-data-pin',
    source:
      'class Boom extends Error{}const Alias:{prototype:{stack?:string}}=Boom;function frames(error:typeof Alias.prototype){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'local-class-prototype-mutable-alias-opacity',
    source:
      'class Boom extends Error{}let Alias=Boom;function frames(error:typeof Alias.prototype){return error.stack;}',
    invocation: 'frames({name:"Error",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'local-class-prototype-replaced-class-opacity',
    source:
      'let Boom=class extends Error{};class DataError{name="Error";message="fixed";stack="fixed"}Boom=DataError as unknown as typeof Boom;function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames(new DataError())',
    refused: false,
  },
  {
    id: 'local-class-prototype-replaced-base-opacity',
    source:
      'class DataError{name="Error";message="fixed";stack="fixed"}let Base:new()=>Error=DataError;class Boom extends Base{}function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames(new Boom())',
    refused: false,
  },
  {
    id: 'native-constructor-prototype-pin',
    source: 'function frames(error:typeof Error.prototype){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-native-prototype-alias-error',
    source: 'const Boom=Error;function frames(error:typeof Boom.prototype){return error.stack;}',
    invocation: 'frames(new Boom("ours"))',
    refused: true,
  },
  {
    id: 'class-prototype-erases-default-member-pin',
    source:
      'class Box<T extends Error=Error>{failure!:T}function frames(value:typeof Box.prototype){return value.failure.stack;}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'class-prototype-erases-inherited-default-member-pin',
    source:
      'class Base<T>{failure!:T}class Box<T extends Error=Error>extends Base<T>{}function frames(value:typeof Box.prototype){return value.failure.stack;}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
  },
];

describe('class prototype query readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'class-prototype-queries.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('shared class prototype query admissions', () => {
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
