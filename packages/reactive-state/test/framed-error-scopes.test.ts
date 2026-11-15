import {
  type Identifier,
  isClassDeclaration,
  isClassExpression,
  isExpressionWithTypeArguments,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { localClassBinding } from '../src/compiler/local-type-aliases.ts';
import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DECORATOR = 'function dec(_value: unknown) { return (..._args: unknown[]) => {}; }';

describe('the type scopes of error reads in class decorators', () => {
  it.each([
    `const Data = @dec(((error: Error) => error.stack)({ stack: 'data' })) class Error { stack = 'data'; };`,
    `@dec(((error: Error) => error.stack)({ stack: 'data' })) class Error { stack = 'data'; }`,
    `const Data = class Error { @dec(((error: Error) => error.stack)({ stack: 'data' })) method() {} stack = 'data'; };`,
    `const Data = class Error { method(@dec(((error: Error) => error.stack)({ stack: 'data' })) arg: unknown) {} stack = 'data'; };`,
    `const Data = class Error { [((error: Error) => error.stack)({ stack: 'data' })]() {} stack = 'data'; };`,
    `class C { method<Error extends { stack: string }>(error: Error) { return error.stack; } }`,
    `class C { method<Error extends { stack: string }>(arg = ((error: Error) => error.stack)({ stack: 'data' })) {} }`,
    `class C { method<Error extends { stack: string }>(@dec('data') arg: Error) { return arg.stack; } }`,
    `class C { method<Error>(@dec((<Error extends { stack: string }>(error: Error) => error.stack)({ stack: 'data' })) arg: unknown) {} }`,
    `class Base { stack = 'data'; } class Error<Base> extends Base {} function read(error: Error<string>) { return error.stack; }`,
  ])('keeps application data and the scopes a decorator encloses: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'data-error-decorators.ts', `${DECORATOR}\n${source}`);

    expect(unsettledIn(parsed.sourceFile)).toBeUndefined();
  });

  it.each([
    'class C { method<Error>(@dec(((error: Error) => error.stack)(new globalThis.Error())) arg: unknown) {} }',
    'class C { static method<Error>(@dec(((error: Error) => error.stack)(new globalThis.Error())) arg: unknown) {} }',
    'const C = class { method<Error>(@dec(((error: Error) => error.stack)(new globalThis.Error())) arg: unknown) {} };',
    'class C { @dec(((error: Error) => error.stack)(new globalThis.Error())) method<Error>() {} }',
    'class C { [((error: Error) => error.stack)(new globalThis.Error())]<Error>() {} }',
    'const C = @dec(((error: Error) => error.stack)(new globalThis.Error())) class {};',
    'const C = @dec(((error: Error) => error.stack)(new globalThis.Error())) class Other {};',
    'type Frames = Error; const Data = @dec(((error: Frames) => error.stack)(new globalThis.Error())) class Error { stack = "data"; };',
    'class Base extends globalThis.Error {} class Error<Base> extends Base {} function read(error: Error<string>) { return error.stack; }',
  ])('reads built-in errors outside the decorated member type parameters: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'builtin-error-decorators.ts', `${DECORATOR}\n${source}`);

    expect(unsettledIn(parsed.sourceFile)).toContain('reads `stack` of an error');
  });
});

describe('the value a local class extends', () => {
  it.each([
    'class Base {} class Child<Base> extends Base {}',
    'class Base {} function make() { type Base = string; return class Child extends Base {}; }',
    'class Base {} function make() { interface Base { stack: string } return class Child extends Base {}; }',
    'class Base {} function make<Base>() { return class Child extends Base {}; }',
    'const Data = class Base { method() { return class Child extends Base {}; } };',
    'class Base {} function make(arg = class Child extends Base {}) { var Base = unknownClass; }',
  ])('follows a class past bindings that exist only as types: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'class-base.ts', source);
    const binding = localClassBinding(baseOf(parsed.sourceFile));

    expect(
      binding !== undefined &&
        binding !== null &&
        (isClassDeclaration(binding) || isClassExpression(binding)),
    ).toBe(true);
  });

  it.each([
    'const Base = unknownClass; class Child extends Base {}',
    'const { Base } = unknownClasses; class Child extends Base {}',
    'const [Base] = unknownClasses; class Child extends Base {}',
    'import Base from "application"; class Child extends Base {}',
    'import { Base } from "application"; class Child extends Base {}',
    'import * as Base from "application"; class Child extends Base {}',
    'function Base() {} class Child extends Base {}',
    'function make(Base: unknown) { return class Child extends Base {}; }',
    'const make = function Base() { return class Child extends Base {}; };',
    'try {} catch (Base) { const Data = class Child extends Base {}; }',
    'for (const Base of classes) { const Data = class Child extends Base {}; }',
    'enum Base {} class Child extends Base {}',
    'namespace Base { export const value = 1; } class Child extends Base {}',
    'class Base {} function make() { if (true) { var Base = unknownClass; } return class Child extends Base {}; }',
  ])('stops at a local value that cannot be followed as a class: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'opaque-class-base.ts', source);

    expect(localClassBinding(baseOf(parsed.sourceFile))).toBeNull();
  });

  it.each([
    'class Child extends Base {}',
    'type Base = string; class Child extends Base {}',
    'interface Base { stack: string } class Child extends Base {}',
    'function make<Base>() { return class Child extends Base {}; }',
    'class Child<Base> extends Base {}',
    'declare module "Base" {} class Child extends Base {}',
  ])('does not turn a type-only binding into a runtime class: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'unbound-class-base.ts', source);

    expect(localClassBinding(baseOf(parsed.sourceFile))).toBeUndefined();
  });
});

/** The identifier a class named `Child` reads as its base constructor. */
function baseOf(root: Node): Identifier {
  const pending = [root];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if ((isClassDeclaration(at) || isClassExpression(at)) && at.name?.text === 'Child') {
      const base = at.heritageClauses?.[0]?.types[0];
      const expression =
        base !== undefined && isExpressionWithTypeArguments(base) ? base.expression : undefined;
      if (expression !== undefined && isIdentifier(expression)) {
        return expression;
      }
    }
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('The test source declares Child with an identifier as its base.');
}
