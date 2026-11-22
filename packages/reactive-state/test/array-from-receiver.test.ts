import { describe, expect, it } from 'vitest';

import { writtenBy } from './support/server-part.ts';

/**
 * `Array.from(items, mapping, receiver)` and `Array.fromAsync` call the mapping with `receiver` as its
 * `this`, as the methods of arrays call theirs: a mapping the compile does not see — one of another
 * module — may change it, so the server part writes it.
 */

describe('what Array.from and Array.fromAsync hand a function the compile does not see', () => {
  it.each([
    {
      id: 'Array.from, the mapper of an application module',
      body: 'const options = { value: first };\nArray.from([1], fill, options);',
    },
    {
      id: 'Array.fromAsync',
      body: 'const options = { value: first };\nawait Array.fromAsync([1], fill, options);',
    },
  ])('writes the receiver of the call: $id', ({ body }) => {
    expect(writtenBy(body)).toContain('options');
  });

  it.each([
    {
      id: 'no receiver is given',
      body: 'const options = { value: first };\nArray.from([1], fill);',
    },
    {
      id: 'the mapper is a function written there',
      body: 'const options = { value: first };\nArray.from([1], (element) => element, options);',
    },
    {
      id: 'the mapper is a function of the server part’s',
      body: 'const options = { value: first };\nconst twice = (element: number) => element * 2;\nArray.from([1], twice, options);',
    },
    {
      id: 'JSON.stringify takes its third argument as spacing',
      body: 'const space = { value: first };\nJSON.stringify([1], fill, space);',
    },
  ])('writes nothing of the receiver: $id', ({ body }) => {
    const written = writtenBy(body);

    expect(written).not.toContain('options');
    expect(written).not.toContain('space');
  });

  it.each([
    {
      id: 'the input of Array.from',
      body: 'const options = { value: first };\nArray.from(options as never, fill);',
    },
    {
      id: 'the receiver of an array method',
      body: 'const options = { value: first };\n[1].map(fill, options);',
    },
    {
      id: 'the receiver of forEach',
      body: 'const options = { value: first };\n[1].forEach(fill, options);',
    },
  ])('still writes what it did: $id', ({ body }) => {
    expect(writtenBy(body)).toContain('options');
  });
});
