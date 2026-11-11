import {
  type ClassDeclaration,
  isClassDeclaration,
  isExpressionWithTypeArguments,
  isTypeAliasDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { heritageReference } from '../src/compiler/local-type-class-bases.ts';
import { initialTypeReading } from '../src/compiler/local-type-environment.ts';
import { actualQueryArgument } from '../src/compiler/local-type-query-argument-scope.ts';

/**
 * A class base written through namespaces, `class Local extends NS.Base`, is the class `Base` the
 * namespaces export, where the code shows that `NS` is a namespace: no nearer value is called `NS`,
 * and the member is an exported class. Where it does not show that, the base stays a value the code
 * does not show, as an import is. A base that is no local value's path (`Intl.DateTimeFormat`) is
 * still read as the global's path, and a local namespace called `Intl` hides the global one.
 */

const ERROR_BASE = 'class Base extends Error {}';

const RESOLVED = [
  {
    what: 'a class exported by a namespace',
    source: `namespace NS { export ${ERROR_BASE} }\nclass Local extends NS.Base {}`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class two namespaces down',
    source: `namespace A { export namespace B { export ${ERROR_BASE} } }\nclass Local extends A.B.Base {}`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class of a dotted namespace',
    source: `namespace A.B { export ${ERROR_BASE} }\nclass Local extends A.B.Base {}`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class in the other body of a merged namespace',
    source: `namespace NS { export class Other {} }\nnamespace NS { export ${ERROR_BASE} }\nclass Local extends NS.Base {}`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class in a namespace merged with a class',
    source: `class NS {}\nnamespace NS { export ${ERROR_BASE} }\nclass Local extends NS.Base {}`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class in a namespace merged with a function',
    source: `function NS() {}\nnamespace NS { export ${ERROR_BASE} }\nclass Local extends NS.Base {}`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class in a namespace merged with an enum',
    source: `enum NS { A }\nnamespace NS { export ${ERROR_BASE} }\nclass Local extends NS.Base {}`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class of an ambient namespace',
    source: `declare namespace NS { class Base extends Error {} }\nclass Local extends NS.Base {}`,
    base: ERROR_BASE,
  },
  {
    what: 'a class named from inside its own namespace',
    source: `namespace NS { export ${ERROR_BASE}\n export class Local extends NS.Base {} }`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class reached through a constant',
    source: `namespace NS { export ${ERROR_BASE} }\nconst Alias = NS.Base;\nclass Local extends Alias {}`,
    base: `export ${ERROR_BASE}`,
  },
  {
    what: 'a class in a local namespace called as a global is',
    source: `namespace Intl { export class DateTimeFormat {} }\nclass Local extends Intl.DateTimeFormat {}`,
    base: 'export class DateTimeFormat {}',
  },
  {
    what: 'a class written without a namespace (a pin)',
    source: `${ERROR_BASE}\nclass Local extends Base {}`,
    base: ERROR_BASE,
  },
] as const;

const OPAQUE = [
  {
    what: 'a parameter called as the namespace',
    source: `namespace NS { export ${ERROR_BASE} }\nfunction make(NS: { Base: new () => Error }) { class Local extends NS.Base {} }`,
  },
  {
    what: 'a constant of a block called as the namespace',
    source: `namespace NS { export ${ERROR_BASE} }\n{ const NS = { Base: class {} }; class Local extends NS.Base {} }`,
  },
  {
    what: 'a class of a function called as the namespace',
    source: `namespace NS { export ${ERROR_BASE} }\nfunction make() { class NS { static Base = class {}; } class Local extends NS.Base {} }`,
  },
  {
    what: 'a var of a function, below the base, called as the namespace',
    source: `namespace NS { export ${ERROR_BASE} }\nfunction make() { class Local extends NS.Base {} var NS = { Base: class {} }; }`,
  },
  {
    what: 'a catch variable called as the namespace',
    source: `namespace NS { export ${ERROR_BASE} }\ntry {} catch (NS) { class Local extends NS.Base {} }`,
  },
  {
    what: 'a constant, with no namespace of the name',
    source: `const NS = { Base: class extends Error {} };\nclass Local extends NS.Base {}`,
  },
  {
    what: 'a class with no namespace of the name',
    source: `class NS { static Base = class extends Error {}; }\nclass Local extends NS.Base {}`,
  },
  {
    what: 'an imported namespace',
    source: `import * as NS from './elsewhere';\nclass Local extends NS.Base {}`,
  },
  {
    what: 'a member the namespace does not have',
    source: `namespace NS { export class Other {} }\nclass Local extends NS.Base {}`,
  },
  {
    what: 'a member the namespace does not export',
    source: `namespace NS { ${ERROR_BASE} }\nclass Local extends NS.Base {}`,
  },
  {
    what: 'a member that is an interface',
    source: `namespace NS { export interface Base {} }\nclass Local extends NS.Base {}`,
  },
  {
    what: 'a member that is a constant',
    source: `namespace NS { export const Base = class extends Error {}; }\nclass Local extends NS.Base {}`,
  },
] as const;

const GLOBALS = [
  {
    what: 'a global namespace member (a pin)',
    source: 'class Local extends Intl.DateTimeFormat {}',
    builtin: 'Intl.DateTimeFormat',
  },
  {
    what: 'a global object member (a pin)',
    source: 'class Local extends globalThis.Error {}',
    builtin: 'Error',
  },
] as const;

const GATE = [
  {
    what: 'a class whose qualified base holds a type query',
    source:
      'declare const data: Error;\nnamespace NS { export class Base { q!: typeof data; } }\nclass Local extends NS.Base {}\ntype Selected = Local;',
    closed: false,
  },
  {
    what: 'a class whose base, two namespaces down, holds a type query',
    source:
      'declare const data: Error;\nnamespace A { export namespace B { export class Base { q!: typeof data; } } }\nclass Local extends A.B.Base {}\ntype Selected = Local;',
    closed: false,
  },
  {
    what: 'a class whose base, in a namespace merged with a class, holds a type query',
    source:
      'declare const data: Error;\nclass NS {}\nnamespace NS { export class Base { q!: typeof data; } }\nclass Local extends NS.Base {}\ntype Selected = Local;',
    closed: false,
  },
  {
    what: 'a class whose qualified generic base is given a type query',
    source:
      'declare const data: Error;\nnamespace NS { export class Base<T> { v!: T; } }\nclass Local extends NS.Base<typeof data> {}\ntype Selected = Local;',
    closed: false,
  },
  {
    what: 'a class whose unqualified base holds a type query (a pin)',
    source:
      'declare const data: Error;\nclass Base { q!: typeof data; }\nclass Local extends Base {}\ntype Selected = Local;',
    closed: false,
  },
  {
    what: 'a class whose qualified base is written out whole (a pin)',
    source:
      'namespace NS { export class Base { q!: string; } }\nclass Local extends NS.Base {}\ntype Selected = Local;',
    closed: true,
  },
  {
    what: 'a class whose base is a constant called as a namespace (a pin)',
    source:
      'declare const data: Error;\nconst NS = { Base: class { q!: typeof data; } };\nclass Local extends NS.Base {}\ntype Selected = Local;',
    closed: true,
  },
  {
    what: 'a class whose base is a global member (a pin)',
    source: 'class Local extends Intl.DateTimeFormat {}\ntype Selected = Local;',
    closed: true,
  },
] as const;

/** The first class `Local` of the source, wherever it is written. */
function localClass(root: Node): ClassDeclaration | undefined {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isClassDeclaration(node) && node.name?.text === 'Local') return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return undefined;
}

describe('a class base written through namespaces', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `heritageReference` reads of the `extends` clause of `Local`: the class's text, or a path. */
  function baseOf(source: string): {
    readonly binding: string | null | undefined;
    builtin?: string;
  } {
    using parsed = api.createSourceFile('class-bases.ts', source);
    const { sourceFile } = parsed;
    const declaration = localClass(sourceFile);
    const base = declaration?.heritageClauses?.find(
      (clause) => clause.token === SyntaxKind.ExtendsKeyword,
    )?.types[0];
    if (base === undefined || !isExpressionWithTypeArguments(base)) {
      throw new Error('the class had no base');
    }
    const { binding, builtin } = heritageReference(base.expression);
    return {
      binding:
        binding === undefined || binding === null
          ? binding
          : source.slice(binding.getStart(sourceFile), binding.end),
      ...(builtin !== undefined && { builtin }),
    };
  }

  function closedOf(source: string): boolean {
    using parsed = api.createSourceFile('class-bases.ts', source);
    const declaration = parsed.sourceFile.statements.find(
      (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'Selected',
    );
    if (declaration === undefined || !isTypeAliasDeclaration(declaration)) {
      throw new Error('the argument was not parsed');
    }
    return actualQueryArgument(initialTypeReading(declaration.type));
  }

  it.each(RESOLVED)('reads $what as its class', ({ source, base }) => {
    expect(baseOf(source)).toStrictEqual({ binding: base });
  });

  it.each(OPAQUE)('leaves $what as a value the code does not show', ({ source }) => {
    expect(baseOf(source)).toStrictEqual({ binding: null });
  });

  it.each(GLOBALS)('reads $what as its path', ({ source, builtin }) => {
    expect(baseOf(source)).toStrictEqual({ binding: null, builtin });
  });

  it.each(GATE)('counts $what as a query argument', ({ source, closed }) => {
    expect(closedOf(source)).toBe(closed);
  });
});
