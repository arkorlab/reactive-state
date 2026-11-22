import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { readSelectsError } from './support/held-member-reads.ts';

/**
 * A write into a member of a fresh literal's own member replaces what the literal wrote there only
 * where nothing the literal writes after it, a spread or a computed name the compile cannot read,
 * may give that member another object: a computed name may be the member's.
 */
const GETTER = '{ get x() { return error; } }';
const HEAD = 'function frames(error: Error, key: string) {';

const CASES = [
  {
    id: 'computed-key-after-the-member',
    source: `${HEAD} const box = { nested: { x: error }, [key]: ${GETTER} }; box.nested.x = 0; return box.nested.x; }`,
    selects: true,
  },
  {
    id: 'computed-key-between-members',
    source: `${HEAD} const box = { nested: { x: error }, [key]: ${GETTER}, other: 1 }; box.nested.x = 0; return box.nested.x; }`,
    selects: true,
  },
  {
    id: 'spread-after-the-member',
    source: `${HEAD} const box = { nested: { x: error }, ...{ nested: ${GETTER} } }; box.nested.x = 0; return box.nested.x; }`,
    selects: true,
  },
  {
    id: 'computed-key-before-the-member',
    source: `${HEAD} const box = { [key]: ${GETTER}, nested: { x: error } }; box.nested.x = 0; return box.nested.x; }`,
    selects: false,
  },
  {
    id: 'read-computed-key-of-another-name',
    source: `${HEAD} const box = { nested: { x: error }, ['other']: ${GETTER} }; box.nested.x = 0; return box.nested.x; }`,
    selects: false,
  },
  {
    id: 'named-constant-computed-key-is-not-read',
    source: `${HEAD} const name = 'other'; const box = { nested: { x: error }, [name]: ${GETTER} }; box.nested.x = 0; return box.nested.x; }`,
    selects: true,
  },
  {
    id: 'literal-members-only',
    source: `${HEAD} const box = { nested: { x: error }, other: 1 }; box.nested.x = 0; return box.nested.x; }`,
    selects: false,
  },
] as const;

describe('a write into the member of a literal that a computed name may replace', () => {
  it.each(CASES)('$id', ({ source, selects }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'held-literal-members.ts', source);

    expect(readSelectsError(parsed.sourceFile)).toBe(selects);
  });
});
