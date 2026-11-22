import { isFunctionDeclaration, isIdentifier } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contextOf, middlewareNames, placeOf, readsOf } from '../src/compiler/middleware-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Where a statement of a route middleware reads a name of it, each place in the order the source
 * holds them, however many times it reads the name: `placeOf` is the first. The places of one name
 * in one statement are held in one array, which each read appends to.
 */

const fail = (reason: string): never => {
  throw new Error(reason);
};

describe('the places a statement of a route middleware reads a name of its context', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `readsOf` gives of the one statement `const list = [projectId, …]` of `count` reads. */
  function readsOfRepeated(count: number, name = 'projectId') {
    const statement = `const list = [${Array.from({ length: count }, () => name).join(', ')}];`;
    using file = parseModule(
      api,
      'middleware.ts',
      `export default function middleware({ params: { ${name} } }, next) {\n  ${statement}\n}\n`,
    );
    const declared = file.sourceFile.statements.find((each) => isFunctionDeclaration(each));
    if (declared === undefined || !isFunctionDeclaration(declared) || declared.body === undefined) {
      throw new Error('The middleware is not a function.');
    }
    const [context, next] = declared.parameters;
    if (context === undefined || next === undefined || !isIdentifier(next.name)) {
      throw new Error('The middleware has no context or no next.');
    }
    const statements = [...declared.body.statements];
    const names = middlewareNames({
      bindings: [],
      context: contextOf(context.name, fail),
      fail,
      next: next.name,
      sourceFile: file.sourceFile,
      statements,
    });
    const [only] = statements;
    if (only === undefined) {
      throw new Error('The middleware has no statement.');
    }
    const reads = readsOf(only, names);
    return {
      first: placeOf(reads, name)?.getStart(file.sourceFile),
      places: (reads.values.get(name) ?? []).map((place) => place.getStart(file.sourceFile)),
    };
  }

  it.each([1, 2, 10, 100, 1000, 10_000])(
    'holds each of %i reads of one name, in the order of the source',
    (count) => {
      const { first, places } = readsOfRepeated(count);

      expect(places).toHaveLength(count);
      expect(places).toStrictEqual(places.toSorted((a, b) => a - b));
      expect(new Set(places).size).toBe(count);
      expect(first).toBe(places[0]);
    },
  );

  it('holds the places of each name apart', () => {
    const { places } = readsOfRepeated(3, 'tenant');

    expect(places).toHaveLength(3);
  });
});
