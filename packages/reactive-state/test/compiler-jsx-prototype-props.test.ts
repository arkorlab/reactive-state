import { isJsxElement, isJsxSelfClosingElement, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { failIn, ReactiveCompileError } from '../src/compiler/errors.ts';
import { type Jsx, rendered, typeOfTag } from '../src/compiler/jsx.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An attribute named `__proto__` is written, as React's transforms write it, into an object literal
 * where it sets the props' prototype rather than a prop. Given text, or nothing, it sets none, and
 * the prop is dropped in the browser and by the authority alike. Given a value — in braces, or an
 * element — it may set one: React's `jsx` hands the component what the props inherit, and what the
 * authority renders reads their own fields alone, so the compile refuses it. A spread of an object
 * written with such a `__proto__` is refused too: Next.js's SWC writes that object's fields into the
 * props' literal, `__proto__` among them, where the authority spreads it, which copies none. A computed
 * or shorthand `__proto__` is an own field, which both copy, and SWC writes a spread in parentheses as
 * a spread.
 */

const CASES = [
  {
    element: '<Child __proto__={{ shown: true }} />',
    rendered: 'refused',
    what: 'an object in braces',
  },
  { element: '<Child __proto__={inherited} />', rendered: 'refused', what: 'a name in braces' },
  { element: '<Child __proto__=<b>x</b> />', rendered: 'refused', what: 'an element' },
  {
    element: "<div __proto__={{ id: 'x' }} />",
    rendered: 'refused',
    what: "an object, on the browser's element",
  },
  {
    element: '<Child __proto__="value" />',
    rendered: '$.h(Child, { __proto__: "value" })',
    what: 'text',
  },
  { element: '<Child __proto__ />', rendered: '$.h(Child, { __proto__: true })', what: 'nothing' },
  {
    element: '<Child proto={{ shown: true }} />',
    rendered: '$.h(Child, { proto: { shown: true } })',
    what: 'an object, under another name',
  },
  {
    element: '<Child {...{ __proto__: inherited }} />',
    rendered: 'refused',
    what: 'a spread object of a written __proto__',
  },
  {
    element: '<Child {...{ "__proto__": inherited }} />',
    rendered: 'refused',
    what: 'a spread object of a quoted __proto__',
  },
  {
    element: '<Child shown={1} {...{ __proto__: inherited }} />',
    rendered: 'refused',
    what: 'a spread object of a written __proto__ after a prop',
  },
  {
    element: "<Child {...{ ['__proto__']: inherited }} />",
    rendered: "$.h(Child, { ...{ ['__proto__']: inherited } })",
    what: 'a spread object of a computed __proto__',
  },
  {
    element: '<Child {...{ __proto__ }} />',
    rendered: '$.h(Child, { ...{ __proto__ } })',
    what: 'a spread object of a shorthand __proto__',
  },
  {
    element: '<Child {...({ __proto__: inherited })} />',
    rendered: '$.h(Child, { ...({ __proto__: inherited }) })',
    what: 'a spread of a parenthesized object',
  },
] as const;

/** Words of the compile's refusal, which `renderedOf` answers as `refused`. */
const REFUSED = 'sets what the props inherit';

describe('an attribute named __proto__ of what the authority renders', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The element `rendered` writes of `element`; `refused` where the compile refuses it so. */
  function renderedOf(element: string): string {
    const source = `declare const inherited: object;\ndeclare const __proto__: object;\nexport const element = ${element};\n`;
    using parsed = parseModule(api, 'element.tsx', source);
    const { sourceFile } = parsed;
    let found: Jsx | undefined;
    const visit = (node: Node): void => {
      if (found === undefined && (isJsxElement(node) || isJsxSelfClosingElement(node))) {
        found = node;
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    if (found === undefined) {
      throw new Error('The source holds no element.');
    }
    const fail = failIn(sourceFile, 'element.tsx');
    try {
      return rendered(found, {
        expression: (node) => node.getText(sourceFile),
        fail,
        sourceFile,
        type: (tag) => typeOfTag(tag, fail),
      });
    } catch (error) {
      if (error instanceof ReactiveCompileError) {
        return error.reason.includes(REFUSED) ? 'refused' : `refused otherwise: ${error.reason}`;
      }
      throw error;
    }
  }

  it.each(CASES)('given $what', ({ element, rendered: written }) => {
    expect(renderedOf(element)).toBe(written);
  });
});
