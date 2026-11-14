import { describe, expect, it } from 'vitest';

import { entryOf } from '../src/authority/query.ts';
import { boolean, defaultOf, type Select, type Selected, text } from '../src/server/schema.ts';

const fields = { done: boolean(), title: text({ default: 'あとで' }) };

/** A record of `fields` that holds each one's default. */
const FOUND = {
  id: 't1',
  values: { done: defaultOf(fields.done), title: defaultOf(fields.title) },
};

/** The record of `fields` as `findMany` answers it for `select` (`findIn`): what `select` names. */
function selected<const S extends Select<typeof fields>>(select: S): Selected<typeof fields, S> {
  return entryOf(FOUND, Object.keys(select)) as Selected<typeof fields, S>;
}

describe('the record a selection answers', () => {
  it('holds each field a selection names, as the answer holds it', () => {
    const record = selected({ id: true, title: true });
    const title: string = record.title;

    expect(record).toStrictEqual({ id: 't1', title: 'あとで' });
    expect(title).toBe('あとで');
  });

  it('leaves optional each field a selection of `Select`’s type may leave out, as the answer leaves it out', () => {
    const select: Select<typeof fields> = {};
    const record = selected(select);
    // @ts-expect-error -- a field the selection may leave out is no field every record holds
    const title: string = record.title;

    expect(record).toStrictEqual({});
    expect(title).toBeUndefined();
  });
});
