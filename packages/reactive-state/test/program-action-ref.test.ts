import { describe, expect, it } from 'vitest';

import { actionRef, type Json } from '../src/program.ts';

describe('actionRef', () => {
  it('binds later arguments after the arguments it was made with, though the caller’s array changes since', () => {
    const given: Json[] = ['project-1'];
    const reference = actionRef('actions/todos', 'deleteTodo', given);
    given[0] = 'project-2';
    given.push('extra');

    const bound = reference.bind(null, 'todo-1');

    expect(reference.bound).toStrictEqual(['project-1']);
    expect(bound.bound).toStrictEqual(['project-1', 'todo-1']);
    expect(bound.bind(null, 'todo-2').bound).toStrictEqual(['project-1', 'todo-1', 'todo-2']);
  });

  it('keeps `bind` read-only in its type, as the frozen reference keeps it at run time', () => {
    const reference = actionRef('actions/todos', 'deleteTodo');

    expect(() => {
      // @ts-expect-error -- `bind` is read-only, as every other member of a reference is.
      reference.bind = () => reference;
    }).toThrow("Cannot assign to read only property 'bind'");
  });
});
