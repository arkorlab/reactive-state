import { describe, expect, it } from 'vitest';

import { isPage, sourceOf } from './support/server-part.ts';

/**
 * A state the authority starts of a name the server part writes is no local state — a field may have
 * reached the name. An export of an application's `shared` module is such a name as a constant is:
 * written by `defaults.value = …`, or given to a function of the application's that may write it.
 */

describe('a state started of an export of a shared module the server part writes', () => {
  it.each([
    { id: 'an assignment to a member', body: 'defaults.value = first;' },
    { id: 'a compound assignment', body: 'defaults.value += first;' },
    { id: 'an increment', body: 'defaults.value++;' },
    { id: 'a delete', body: 'delete defaults.value;' },
    { id: 'a native mutator of a member', body: 'defaults.items.push(first);' },
    { id: 'Object.assign onto it', body: 'Object.assign(defaults, { value: first });' },
    {
      id: 'a call of an application function that is given it',
      body: 'await loadInto(defaults, id);',
    },
    {
      id: 'a call of an application function that is given its member',
      body: 'fill(defaults.items);',
    },
  ])('is no value of the page’s: $id', ({ body }) => {
    expect(isPage(sourceOf(body, 'defaults.value ?? first'))).toBe(false);
  });

  it.each([
    { id: 'nothing writes it', body: '' },
    {
      id: 'a function of the module is called with the props',
      body: 'const shown = helper(first);',
    },
    {
      id: 'the server part writes a constant of its own',
      body: 'const mine = { value: first };\nmine.value = 2;',
    },
    { id: 'it is read, as a whole', body: 'const copy = JSON.stringify(defaults);' },
  ])('stays a value of the page’s where $id', ({ body }) => {
    expect(isPage(sourceOf(body, 'defaults.value ?? first'))).toBe(true);
  });

  it('reads a constant the server part writes as it always did', () => {
    expect(isPage(sourceOf('const mine = { value: first };\nmine.value = 2;', 'mine.value'))).toBe(
      false,
    );
  });
});
