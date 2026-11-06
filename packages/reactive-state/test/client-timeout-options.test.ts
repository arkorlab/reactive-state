import { describe, expect, it } from 'vitest';

import { type AuthorityNamespace, bindingClient, httpClient } from '../src/client/index.ts';

/** A namespace no test reaches: a client is only made. */
const NAMESPACE: AuthorityNamespace = {
  getByName: () => {
    throw new Error('No call is made.');
  },
};

/** The authority's address, which no test reaches either. */
const URL = 'http://127.0.0.1:1';

describe('how long a client’s calls wait', () => {
  it.each([NaN, 0, -1, 1.5, 2 ** 31, Infinity])(
    'refuses %s as either client is made, rather than each call',
    (timeoutMs) => {
      expect(() => httpClient({ timeoutMs, token: 'token', url: URL })).toThrow(TypeError);
      expect(() => bindingClient(NAMESPACE, { timeoutMs })).toThrow(TypeError);
    },
  );

  it.each([undefined, 1, 2 ** 31 - 1])('takes %s', (timeoutMs) => {
    expect(() => httpClient({ timeoutMs, token: 'token', url: URL })).not.toThrow();
    expect(() => bindingClient(NAMESPACE, { timeoutMs })).not.toThrow();
  });
});
