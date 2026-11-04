import { describe, expect, it } from 'vitest';

import { queryOf } from '../src/authority/query.ts';
import { table, text, type Where } from '../src/server/schema.ts';

const todos = table({ owner: text(), title: text() });

/** A condition of the application's own, which a getter of its class answers: no entry of its own. */
class OwnedBy {
  readonly #owner: string;

  constructor(owner: string) {
    this.#owner = owner;
  }

  get owner(): string {
    return this.#owner;
  }
}

/** A query of the application's own, whose `where` a getter of its class answers. */
class Everything {
  get where(): Readonly<Record<string, string>> {
    return {};
  }
}

const WHERE = 'db.todos.findMany: `where` is an object of fields, each with the value it holds';

describe('a query of what is no plain object', () => {
  it('is refused for a `where` of a class, whose getters answer it, though TypeScript takes it', () => {
    const where: Where<typeof todos.fields> = new OwnedBy('alice');

    expect(() => queryOf('db.todos.findMany', todos, { where }, 'findMany')).toThrow(WHERE);
  });

  it.each([
    ['a date', new Date(0)],
    ['a map of its conditions', new Map([['owner', 'alice']])],
  ])('is refused for a `where` of %s, rather than read as asking nothing', (_, where) => {
    expect(() => queryOf('db.todos.findMany', todos, { where }, 'findMany')).toThrow(WHERE);
  });

  it('is refused for a selection, and for the query itself', () => {
    const select = new Map([['title', true]]);

    expect(() => queryOf('db.todos.findMany', todos, { select, where: {} }, 'findMany')).toThrow(
      'db.todos.findMany: `select` is an object of fields, each `true`',
    );
    expect(() => queryOf('db.todos.count', todos, new Everything(), 'count')).toThrow(
      'db.todos.count: the query is an object, `{ where }` at least',
    );
  });

  it('is refused for a key of `orderBy` of a class, though its own entry names one field', () => {
    /** An order of the application's own: its one own entry is the field and the direction. */
    class ByTitle {
      readonly title = 'asc';
    }

    expect(() =>
      queryOf('db.todos.findMany', todos, { orderBy: [new ByTitle()], where: {} }, 'findMany'),
    ).toThrow('db.todos.findMany: each key of `orderBy` names one field, `"asc"` or `"desc"`');
  });

  it('reads an object of no prototype as one of `Object`’s', () => {
    const where: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    where['owner'] = 'alice';

    expect(queryOf('db.todos.count', todos, { where }, 'count').where).toStrictEqual({
      owner: 'alice',
    });
  });
});
