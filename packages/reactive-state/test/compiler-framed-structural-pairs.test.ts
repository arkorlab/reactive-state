import {
  isConditionalTypeNode,
  isIdentifier,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  SyntaxKind,
  type Node,
  type TypeAliasDeclaration,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import {
  boundTypeBody,
  initialTypeReading,
  type TypeReading,
} from '../src/compiler/local-type-environment.ts';
import { inferPattern } from '../src/compiler/local-type-inference.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Repeated non-inference requirements retain their actual environments and original obligations. */
const CASES = [
  {
    id: 'repeated-object-error',
    source:
      'type A0=number;type A1={x:A0,y:A0};type A2={x:A1,y:A1};type A3={x:A2,y:A2};type A4={x:A3,y:A3};type Failure=A4 extends A4?Error:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'repeated-object-data',
    source:
      'type A0=number;type A1={x:A0,y:A0};type A2={x:A1,y:A1};type A3={x:A2,y:A2};type A4={x:A3,y:A3};type Failure=A4 extends A4?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'different-bindings-error',
    source:
      'type Box<T>={value:T};type L={x:Box<string>,y:Box<number>};type R={x:Box<number>,y:Box<number>};type Failure=L extends R?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'different-bindings-data',
    source:
      'type Box<T>={value:T};type L={x:Box<string>,y:Box<number>};type R={x:Box<number>,y:Box<number>};type Failure=L extends R?Error:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'same-bindings-error',
    source:
      'type Box<T>={value:T};type L={x:Box<number>,y:Box<number>};type R={x:Box<number>,y:Box<number>};type Failure=L extends R?Error:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'same-bindings-data',
    source:
      'type Box<T>={value:T};type L={x:Box<number>,y:Box<number>};type R={x:Box<number>,y:Box<number>};type Failure=L extends R?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'finite-reentry-error',
    source:
      'type Nest<T>={x:T,y:T};type N=Nest<Nest<number>>;type Failure=N extends N?Error:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'finite-reentry-data',
    source:
      'type Nest<T>={x:T,y:T};type N=Nest<Nest<number>>;type Failure=N extends N?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'repeated-infer-error',
    source:
      'type Failure={x:Error,y:{stack:string}} extends {x:infer U,y:infer U}?U:never;\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'repeated-infer-data',
    source:
      'type Failure={x:{stack:string},y:{stack:string}} extends {x:infer U,y:infer U}?U:never;\nfunction frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'infer-union-error',
    source:
      'type Failure={x:Error} extends ({x:infer U}|{y:infer U})?U:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'infer-failed-branch-data',
    source:
      'type Failure={x:Error,y:{stack:string}} extends ({x:infer U,z:number}|{y:infer U})?U:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'infer-failed-branch-error',
    source:
      'type Failure={x:{stack:string},y:Error} extends ({x:infer U,z:number}|{y:infer U})?U:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'union-pattern-data',
    source:
      'type N={x:number};type S={x:string};type Failure=N extends (S|N)?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
    nativeExpected: 'fixed',
  },
  {
    id: 'union-source-error',
    source:
      'type N={x:number};type S={x:string};type Failure=(N|S) extends N?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'recursive-alias-error',
    source:
      'type R={next:R};type Failure=R extends R?Error:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'nested-conditional-error',
    source:
      'type Peel<T>=T extends {item:infer U}?Peel<U>:T;type L={x:Peel<{item:Error}>,y:Peel<{item:Error}>};type Failure=L extends {x:Error,y:Error}?Error:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'noinfer-uncertain-error',
    source:
      'type Leaf<T>=NoInfer<T>;type Failure={x:Leaf<Error>,y:Leaf<Error>} extends {x:Error,y:Error}?Error:{stack:string};\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'weak-mismatch-error',
    source:
      'type Failure={a:number} extends {b?:number}?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
    nativeExpected: 'frames',
  },
  {
    id: 'empty-optional-data',
    source:
      'type E={};type O={p?:number};type Failure={x:E,y:E} extends {x:O,y:O}?{stack:string}:Error;\nfunction frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
    nativeExpected: 'fixed',
  },
] as const;

const STRUCTURE = { small: 4, large: 8, stepsPerLevel: 6, overhead: 6 } as const;

describe('repeated resolved structural requirements', () => {
  it.each([STRUCTURE.small, STRUCTURE.large])(
    'keeps depth %s within a linear resolver budget',
    (depth) => {
      const aliases = ['type A0=number;'];
      for (let index = 1; index <= depth; index++)
        aliases.push(`type A${index}={x:A${index - 1},y:A${index - 1}};`);
      const source = `${aliases.join('\n')}\ntype Check=A${depth} extends A${depth}?true:false;`;
      const { result, resolutions } = matchedComparison(source);

      expect(result.matches).toBe(true);
      expect(resolutions).toBeLessThanOrEqual(depth * STRUCTURE.stepsPerLevel + STRUCTURE.overhead);
    },
  );

  it('retains a repeated failing member obligation', () => {
    const { result } = matchedComparison(
      'type L={value:number};type R={value:string};type Check={x:L,y:L} extends {x:R,y:R}?true:false;',
    );

    expect(result.matches).toBe(false);
  });

  it('retains a repeated unresolved member obligation', () => {
    const { result } = matchedComparison(
      'type L={value:unknown};type R={value:number};type Check={x:L,y:L} extends {x:R,y:R}?true:false;',
    );

    expect(result.matches).toBeUndefined();
  });

  it('retains unresolved recursive alias obligations', () => {
    const { result } = matchedComparison(
      'type R={next:R,other:R};type Check=R extends R?true:false;',
    );

    expect(result.matches).toBeUndefined();
  });
});

describe('structural comparison semantic pins', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'structural-semantics.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });
});

describe('shared structural comparison semantic pins', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, argument, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(${argument})).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) =>
      item.reason.includes('a shared module that answers otherwise'),
    );

    expect(reasons).toStrictEqual(refused ? [true] : []);
  });
});

/** The actual Error observation, on its original compiler syntax tree. */
function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** The matcher under test, with actual parsed aliases and the compiler's binding/cycle helper. */
function matchedComparison(source: string) {
  using api = openTypeScript();
  using parsed = parseModule(api, 'structural-step-budget.ts', source);
  const declarations = new Map<string, TypeAliasDeclaration>();
  for (const statement of parsed.sourceFile.statements) {
    if (isTypeAliasDeclaration(statement)) declarations.set(statement.name.text, statement);
  }
  const conditional = declarations.get('Check')?.type;
  if (conditional === undefined || !isConditionalTypeNode(conditional))
    throw new Error('missing conditional');
  let resolutions = 0;
  const resolve = (at: TypeReading): TypeReading | undefined => {
    resolutions += 1;
    let reading = at;
    while (isTypeReferenceNode(reading.type) && isIdentifier(reading.type.typeName)) {
      const declaration = declarations.get(reading.type.typeName.text);
      if (declaration === undefined) return reading;
      const bound = boundTypeBody(declaration, reading.type, reading);
      if (bound === undefined) return undefined;
      reading = { ...bound, type: declaration.type };
    }
    return reading;
  };
  const result = inferPattern(
    initialTypeReading(conditional.checkType),
    initialTypeReading(conditional.extendsType),
    resolve,
    (checked, pattern) => {
      if (
        checked.type.kind === SyntaxKind.NumberKeyword &&
        pattern.type.kind === SyntaxKind.NumberKeyword
      )
        return true;
      return checked.type.kind === SyntaxKind.NumberKeyword &&
        pattern.type.kind === SyntaxKind.StringKeyword
        ? false
        : undefined;
    },
  );
  return { result, resolutions };
}
