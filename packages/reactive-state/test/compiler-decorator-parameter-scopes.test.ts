import { isIdentifier, isParameterDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parameterOf } from '../src/compiler/framed-type-queries.ts';
import { readsBinding } from '../src/compiler/scope.ts';

/**
 * A method's parameters are in scope in its body and its own parameter list, not in its decorators,
 * which run where the class is defined: in `class C { @decorate(value) method(value: string) {} }`
 * the `value` of the decorator is the one around the class, and the `value` of the body is the
 * parameter's. A parameter's decorator is outside the parameters as well, its own among them.
 */

const OUTER = ['declare function decorate(key: unknown): MethodDecorator;'];
const PARAMETER = ['declare function decorate(key: unknown): ParameterDecorator;'];

const CASES = [
  {
    lines: [
      ...OUTER,
      'function outer(value: number) {',
      '  class C {',
      '    @decorate(value) method(value: string) {',
      '      return value;',
      '    }',
      '  }',
      '  return C;',
      '}',
    ],
    reads: ['4:number', '5:string'],
    what: "a method's decorator, beside the body",
  },
  {
    lines: [
      ...OUTER,
      'class C {',
      '  @decorate(value) method(value: string) {',
      '    return value;',
      '  }',
      '}',
    ],
    reads: ['3:none', '4:string'],
    what: "a method's decorator of a class that no function holds",
  },
  {
    lines: [
      ...OUTER,
      'function outer(value: number) {',
      '  class C {',
      '    @decorate(value) static method(value: string) {',
      '      return value;',
      '    }',
      '  }',
      '  return C;',
      '}',
    ],
    reads: ['4:number', '5:string'],
    what: "a static method's decorator",
  },
  {
    lines: [
      ...OUTER,
      'function outer(value: number) {',
      '  class C {',
      '    @decorate(value) set x(value: string) {}',
      '  }',
      '  return C;',
      '}',
    ],
    reads: ['4:number'],
    what: "a setter's decorator",
  },
  {
    lines: [
      ...OUTER,
      'function outer(value: number) {',
      '  const made = {',
      '    method(value: string) {',
      '      return value;',
      '    },',
      '  };',
      '  return made;',
      '}',
    ],
    reads: ['5:string'],
    what: "an object's method body",
  },
  {
    lines: [
      ...PARAMETER,
      'function outer(value: number) {',
      '  class C {',
      '    method(@decorate(value) value: string) {}',
      '  }',
      '  return C;',
      '}',
    ],
    reads: ['4:number'],
    what: "a parameter's decorator of a method",
  },
  {
    lines: [
      ...PARAMETER,
      'function outer(token: number) {',
      '  class C {',
      '    constructor(@decorate(token) token: string) {}',
      '  }',
      '  return C;',
      '}',
    ],
    reads: ['4:number'],
    what: "a parameter's decorator of a constructor",
  },
  {
    lines: [
      ...PARAMETER,
      'function outer(value: number) {',
      '  class C {',
      '    method(first: string, @decorate(first) second = first) {}',
      '  }',
      '  return C;',
      '}',
    ],
    reads: ['4:none', '4:string'],
    what: "a parameter's decorator, beside a default of the parameter list",
  },
  {
    lines: [
      ...OUTER,
      'function outer(value: number) {',
      '  class C {',
      '    @decorate((value: string) => value) method(value: boolean) {}',
      '  }',
      '  return C;',
      '}',
    ],
    reads: ['4:string'],
    what: "a function within a method's decorator",
  },
] as const;

describe("a parameter read in a method's decorator", () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /**
   * The reads of the names `first`, `token` and `value` in `lines` that are no parameter's own name,
   * `line:type` of the parameter `parameterOf` finds, else `line:none`.
   */
  function readsOf(lines: readonly string[]): readonly string[] {
    using parsed = api.createSourceFile('decorators.ts', `${lines.join('\n')}\n`);
    const { sourceFile } = parsed;
    const found: string[] = [];
    const visit = (node: Node): void => {
      if (
        isIdentifier(node) &&
        ['first', 'token', 'value'].includes(node.text) &&
        readsBinding(node) &&
        !(isParameterDeclaration(node.parent) && node.parent.name === node)
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const parameter = parameterOf(node);
        const type = parameter?.type?.getText(sourceFile) ?? 'untyped';
        found.push(`${String(line + 1)}:${parameter === undefined ? 'none' : type}`);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return found;
  }

  it.each(CASES)('finds the parameter of $what', ({ lines, reads }) => {
    expect(readsOf(lines)).toStrictEqual(reads);
  });
});
