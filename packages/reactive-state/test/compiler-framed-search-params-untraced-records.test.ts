import { isIdentifier, isNewExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedSearchParamsText } from '../src/compiler/framed-search-params-text.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A record handed to `new URLSearchParams` or `new Headers` that a native call builds or copies
 * (`Object.assign({}, defaults, { x: error })`, `Object.fromEntries`, `Object.entries`, a `Map`,
 * `structuredClone`, a conditional, a nullish default) holds what the values it is made of may: the
 * Error one of them may be is converted by the constructor, as the same record written as a literal
 * or a spread is. A form made of texts only converts nothing. A variable of such a form keeps what is
 * written into it and assigned to it.
 */
const HEAD = "const defaults: Record<string, string> = { a: 'b' };";
const RECORD = 'Record<string, string>';

const COPIES = [
  {
    id: 'assign-into-a-fresh-literal',
    body: `const params: ${RECORD} = Object.assign({}, { x: error as never }); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'headers-assign-into-a-fresh-literal',
    body: `const params: ${RECORD} = Object.assign({}, { x: error as never }); return new Headers(params);`,
    converts: true,
  },
  {
    id: 'assign-defaults-and-the-error-into-a-replacement',
    body: `${HEAD} let params: ${RECORD} = {}; params = Object.assign({}, defaults, { x: error as never }); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'headers-assign-defaults-and-the-error-into-a-replacement',
    body: `${HEAD} let params: ${RECORD} = {}; params = Object.assign({}, defaults, { x: error as never }); return new Headers(params);`,
    converts: true,
  },
  {
    id: 'assign-defaults-and-the-error-into-a-constant',
    body: `${HEAD} const params: ${RECORD} = Object.assign({}, defaults, { x: error as never }); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assign-written-as-the-argument',
    body: `${HEAD} return new URLSearchParams(Object.assign({}, defaults, { x: error as never }));`,
    converts: true,
  },
  {
    id: 'headers-assign-written-as-the-argument',
    body: `${HEAD} return new Headers(Object.assign({}, defaults, { x: error as never }));`,
    converts: true,
  },
  {
    id: 'assign-into-an-object-with-no-prototype',
    body: `const params: ${RECORD} = Object.assign(Object.create(null), { x: error as never }); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assign-the-error-after-the-variable-itself',
    body: `${HEAD} let params: ${RECORD} = defaults; params = Object.assign({}, params, { x: error as never }); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assign-copies-a-record-holding-the-error',
    body: `const base: ${RECORD} = { x: error as never }; const copy: ${RECORD} = Object.assign({}, base); return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'assign-copies-a-record-written-before',
    body: `const base: ${RECORD} = {}; base.x = error as never; const copy: ${RECORD} = Object.assign({}, base); return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'assign-copies-through-another-assign',
    body: `const params: ${RECORD} = Object.assign({}, Object.assign({}, { x: error as never })); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assign-copies-a-spread-list-of-sources',
    body: `const params: ${RECORD} = Object.assign({}, ...[{ x: error as never }]); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assign-the-error-after-a-write-to-the-answer',
    body: `const params: ${RECORD} = Object.assign({}, { y: 'ok' }); params.x = error as never; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assign-nested-in-a-literal-spread',
    body: `const params: ${RECORD} = { ...Object.assign({}, { x: error as never }) }; return new URLSearchParams(params);`,
    converts: true,
  },
] as const;

const ENTRIES = [
  {
    id: 'from-entries-held-in-a-constant',
    body: `const params: ${RECORD} = Object.fromEntries([['x', error as never]]); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'from-entries-written-as-the-argument',
    body: `return new URLSearchParams(Object.fromEntries([['x', error as never]]));`,
    converts: true,
  },
  {
    id: 'headers-from-entries',
    body: `return new Headers(Object.fromEntries([['x', error as never]]));`,
    converts: true,
  },
  {
    id: 'from-entries-of-a-held-list',
    body: `const rows = [['x', error as never]]; return new URLSearchParams(Object.fromEntries(rows));`,
    converts: true,
  },
  {
    id: 'from-entries-of-a-mapped-list',
    body: `const keys = ['x', 'y']; return new URLSearchParams(Object.fromEntries(keys.map((name) => [name, error as never])));`,
    converts: true,
  },
  {
    id: 'from-entries-of-the-entries-of-a-record-holding-the-error',
    body: `const base: ${RECORD} = { x: error as never }; return new URLSearchParams(Object.fromEntries(Object.entries(base).filter(([name]) => name !== 'y')));`,
    converts: true,
  },
  {
    id: 'entries-of-a-literal',
    body: `return new URLSearchParams(Object.entries({ x: error as never }));`,
    converts: true,
  },
  {
    id: 'entries-of-a-record-holding-the-error',
    body: `const base: ${RECORD} = { x: error as never }; return new URLSearchParams(Object.entries(base));`,
    converts: true,
  },
  {
    id: 'entries-of-a-record-written-before',
    body: `const base: ${RECORD} = {}; base.x = error as never; return new URLSearchParams(Object.entries(base));`,
    converts: true,
  },
  {
    id: 'map-of-entries',
    body: `return new URLSearchParams(new Map([['x', error as never]]));`,
    converts: true,
  },
  {
    id: 'set-of-entries',
    body: `return new URLSearchParams(new Set([['x', error as never]]));`,
    converts: true,
  },
  {
    id: 'array-from-entries',
    body: `return new URLSearchParams(Array.from([['x', error as never]]));`,
    converts: true,
  },
] as const;

const BRANCHES = [
  {
    id: 'conditional-record-in-a-constant',
    body: `const params: ${RECORD} = flag ? { x: error as never } : {}; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'conditional-record-written-as-the-argument',
    body: `return new URLSearchParams(flag ? { x: error as never } : {});`,
    converts: true,
  },
  {
    id: 'conditional-record-inside-a-spread',
    body: `const params: ${RECORD} = { ...(flag ? { x: error as never } : {}) }; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'conditional-record-with-a-spread-branch',
    body: `${HEAD} const params: ${RECORD} = flag ? defaults : { ...defaults, x: error as never }; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'nullish-default-record',
    body: `const params: ${RECORD} = options ?? { x: error as never }; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'logical-or-default-record',
    body: `return new URLSearchParams(options || { x: error as never });`,
    converts: true,
  },
  {
    id: 'structured-clone-of-a-record-holding-the-error',
    body: `const params: ${RECORD} = structuredClone({ x: error as never }); return new URLSearchParams(params);`,
    converts: true,
  },
] as const;

/**
 * A source of `Object.assign` that may or may not define a field replaces an earlier value of it
 * only where every way it is chosen defines it: the Error written before stays in the record
 * otherwise, as it does under the spread of the same source.
 */
const OVERRIDES = [
  {
    id: 'assign-over-a-conditional-held-in-a-constant',
    body: `const tail: ${RECORD} = flag ? { x: 'ok' } : {}; return new URLSearchParams(Object.assign({}, { x: error as never }, tail));`,
    converts: true,
  },
  {
    id: 'assign-over-a-conditional-written-as-the-argument',
    body: `return new URLSearchParams(Object.assign({}, { x: error as never }, flag ? { x: 'ok' } : {}));`,
    converts: true,
  },
  {
    id: 'assign-over-a-nullish-default-held-in-a-constant',
    body: `const tail: ${RECORD} = options ?? { x: 'ok' }; return new URLSearchParams(Object.assign({}, { x: error as never }, tail));`,
    converts: true,
  },
  {
    id: 'assign-over-a-logical-or-default-held-in-a-constant',
    body: `const tail: ${RECORD} = options || { x: 'ok' }; return new URLSearchParams(Object.assign({}, { x: error as never }, tail));`,
    converts: true,
  },
  {
    id: 'assign-over-a-nullish-default-written-as-the-argument',
    body: `return new URLSearchParams(Object.assign({}, { x: error as never }, options ?? { x: 'ok' }));`,
    converts: true,
  },
  {
    id: 'assign-over-a-short-circuited-source',
    body: `return new URLSearchParams(Object.assign({}, { x: error as never }, flag && { x: 'ok' }));`,
    converts: true,
  },
  {
    id: 'assign-over-a-conditional-list-spread-into-the-call',
    body: `return new URLSearchParams(Object.assign({}, { x: error as never }, ...(flag ? [{ x: 'ok' }] : [])));`,
    converts: true,
  },
  {
    id: 'assign-over-a-conditional-list-held-in-a-constant',
    body: `const tails = flag ? [{ x: 'ok' }] : []; return new URLSearchParams(Object.assign({}, { x: error as never }, ...tails));`,
    converts: true,
  },
  {
    id: 'assign-over-a-variable-set-on-one-path',
    body: `let tail: ${RECORD} = {}; if (flag) { tail = { x: 'ok' }; } return new URLSearchParams(Object.assign({}, { x: error as never }, tail));`,
    converts: true,
  },
  {
    id: 'spread-of-a-conditional-held-in-a-constant',
    body: `const tail: ${RECORD} = flag ? { x: 'ok' } : {}; return new URLSearchParams({ x: error as never, ...tail });`,
    converts: true,
  },
  {
    id: 'spread-of-a-conditional-written-in-the-literal',
    body: `return new URLSearchParams({ x: error as never, ...(flag ? { x: 'ok' } : {}) });`,
    converts: true,
  },
  {
    id: 'assign-over-a-conditional-defining-the-field-on-both-branches',
    body: `return new URLSearchParams(Object.assign({}, { x: error as never }, flag ? { x: 'a' } : { x: 'b' }));`,
    converts: false,
  },
  {
    id: 'assign-over-a-constant-conditional-defining-the-field-on-both-branches',
    body: `const tail: ${RECORD} = flag ? { x: 'a' } : { x: 'b' }; return new URLSearchParams(Object.assign({}, { x: error as never }, tail));`,
    converts: false,
  },
  {
    id: 'assign-over-a-conditional-defining-another-field',
    body: `return new URLSearchParams(Object.assign({}, { x: error as never }, flag ? { y: 'a' } : { y: 'b' }));`,
    converts: true,
  },
  {
    id: 'assign-over-a-source-that-defines-the-field',
    body: `const tail: ${RECORD} = { x: 'ok' }; return new URLSearchParams(Object.assign({}, { x: error as never }, tail));`,
    converts: false,
  },
] as const;

/**
 * The methods that copy a list answer the list they are called on: only `concat` adds what it is
 * given to it, and `map` and `flatMap` what their callback answers. Another argument (a `this`, an
 * index, a depth) is not an entry.
 */
const LISTS = [
  {
    id: 'concat-reads-the-list-it-adds',
    body: `return new URLSearchParams([['x', 'y']].concat([['z', error as never]]));`,
    converts: true,
  },
  {
    id: 'concat-reads-every-list-it-adds',
    body: `const first = [['x', 'y']]; const second = [['z', error as never]]; return new URLSearchParams(([] as string[][]).concat(first, second));`,
    converts: true,
  },
  {
    id: 'concat-of-texts',
    body: `return new URLSearchParams([['x', 'y']].concat([['z', 'w']]));`,
    converts: false,
  },
  {
    id: 'filter-reads-the-list',
    body: `return new URLSearchParams([['x', error as never]].filter(() => true));`,
    converts: true,
  },
  {
    id: 'filter-does-not-read-its-this-argument',
    body: `const rows = [['x', 'y']]; return new URLSearchParams(rows.filter(() => true, error as never));`,
    converts: false,
  },
  {
    id: 'slice-reads-the-list',
    body: `return new URLSearchParams([['x', error as never]].slice(0));`,
    converts: true,
  },
  {
    id: 'slice-does-not-read-an-error-given-as-an-index',
    body: `return new URLSearchParams([['x', 'y']].slice(0, error as never));`,
    converts: false,
  },
  {
    id: 'flat-does-not-read-an-error-given-as-the-depth',
    body: `return new URLSearchParams([['x', 'y']].flat(error as never));`,
    converts: false,
  },
  {
    id: 'sort-reads-the-list',
    body: `return new URLSearchParams([['x', error as never]].sort());`,
    converts: true,
  },
  {
    id: 'map-reads-what-its-callback-answers',
    body: `return new URLSearchParams(['x'].map((name) => [name, error as never]));`,
    converts: true,
  },
  {
    id: 'map-does-not-read-its-this-argument',
    body: `return new URLSearchParams(['x'].map((name) => [name, 'y'], error as never));`,
    converts: false,
  },
] as const;

/**
 * What `Object.assign` copies is what its source holds where the call runs: a write to the source
 * afterwards leaves the copy as it was, and one before it is in the copy. A source that is read as
 * it is at the construction instead keeps everything it held, so that an overwrite after the copy
 * removes nothing from it.
 */
const COPIED = [
  {
    id: 'assign-copies-before-the-source-is-overwritten',
    body: `const base: ${RECORD} = Object.assign({}, { x: error as never }); const copy: ${RECORD} = Object.assign({}, base); base.x = 'fixed'; return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'assign-copies-a-literal-before-it-is-overwritten',
    body: `const base: ${RECORD} = { x: error as never }; const copy: ${RECORD} = Object.assign({}, base); base.x = 'fixed'; return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'assign-copies-before-an-overwrite-on-one-branch',
    body: `const base: ${RECORD} = { x: error as never }; const copy: ${RECORD} = Object.assign({}, base); if (flag) { base.x = 'fixed'; } return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'assign-copies-before-an-overwrite-in-a-loop',
    body: `const base: ${RECORD} = { x: error as never }; const copy: ${RECORD} = Object.assign({}, base); for (const name of ['x']) { base[name] = 'fixed'; } return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'assign-copies-before-an-assign-overwrites-the-source',
    body: `const base: ${RECORD} = { x: error as never }; const copy: ${RECORD} = Object.assign({}, base); Object.assign(base, { x: 'fixed' }); return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'spread-copies-before-the-source-is-overwritten',
    body: `const base: ${RECORD} = { x: error as never }; const copy: ${RECORD} = { ...base }; base.x = 'fixed'; return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'assign-copies-a-literal-after-it-is-overwritten',
    body: `const base: ${RECORD} = { x: error as never }; base.x = 'fixed'; const copy: ${RECORD} = Object.assign({}, base); return new URLSearchParams(copy);`,
    converts: false,
  },
  {
    id: 'assign-copies-a-literal-after-an-assign-overwrites-it',
    body: `const base: ${RECORD} = { x: error as never }; Object.assign(base, { x: 'fixed' }); const copy: ${RECORD} = Object.assign({}, base); return new URLSearchParams(copy);`,
    converts: false,
  },
] as const;

/** Two names a pattern takes apart are two values, each read on its own. */
const PATTERNS = [
  {
    id: 'destructured-names-read-apart',
    body: `{ const [safe, error] = [{ k: 'ok' } as ${RECORD}, {} as ${RECORD}]; return new URLSearchParams(Object.assign({}, safe, error)); }`,
    converts: true,
  },
  {
    id: 'destructured-names-read-apart-the-other-way-round',
    body: `{ const [safe, error] = [{ k: 'ok' } as ${RECORD}, {} as ${RECORD}]; return new URLSearchParams(Object.assign({}, error, safe)); }`,
    converts: true,
  },
  {
    id: 'destructured-names-of-an-object-pattern-read-apart',
    body: `{ const { safe, error } = { safe: { k: 'ok' } as ${RECORD}, error: {} as ${RECORD} }; return new URLSearchParams(Object.assign({}, safe, error)); }`,
    converts: true,
  },
  {
    id: 'destructured-names-of-texts',
    body: `const [safe, other] = [{ k: 'ok' } as ${RECORD}, {} as ${RECORD}]; other.x = 'fixed'; return new URLSearchParams(Object.assign({}, safe, other));`,
    converts: false,
  },
] as const;

const WRITTEN = [
  {
    id: 'write-into-an-object-with-no-prototype',
    body: `const params = Object.create(null) as ${RECORD}; params.x = error as never; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'write-into-the-answer-of-a-function',
    body: `const build = (): ${RECORD} => ({}); const params = build(); params.x = error as never; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assigned-after-a-form',
    body: `${HEAD} let params: ${RECORD} = Object.assign({}, defaults); params = { ...params, x: error as never }; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'write-into-a-copy',
    body: `${HEAD} const params: ${RECORD} = Object.assign({}, defaults); params.x = error as never; return new URLSearchParams(params);`,
    converts: true,
  },
] as const;

const TEXTS = [
  {
    id: 'assign-defaults',
    body: `${HEAD} return new URLSearchParams(Object.assign({}, defaults));`,
    converts: false,
  },
  {
    id: 'assign-defaults-and-a-text',
    body: `${HEAD} const params: ${RECORD} = Object.assign({}, defaults, { x: 'fixed' }); return new URLSearchParams(params);`,
    converts: false,
  },
  {
    id: 'headers-assign-defaults-and-a-text-into-a-replacement',
    body: `${HEAD} let params: ${RECORD} = {}; params = Object.assign({}, defaults, { x: 'fixed' }); return new Headers(params);`,
    converts: false,
  },
  {
    id: 'assign-a-later-text-over-the-error',
    body: `const params: ${RECORD} = Object.assign({}, { x: error as never }, { x: 'fixed' }); return new URLSearchParams(params);`,
    converts: false,
  },
  {
    id: 'spread-a-later-text-over-the-error',
    body: `const params: ${RECORD} = { ...{ x: error as never }, ...{ x: 'fixed' } }; return new URLSearchParams(params);`,
    converts: false,
  },
  {
    id: 'assign-a-record-of-texts-written-before',
    body: `const base: ${RECORD} = {}; base.x = 'fixed'; const copy: ${RECORD} = Object.assign({}, base); return new URLSearchParams(copy);`,
    converts: false,
  },
  {
    id: 'from-entries-of-texts',
    body: `const params: ${RECORD} = Object.fromEntries([['x', 'fixed']]); return new URLSearchParams(params);`,
    converts: false,
  },
  {
    id: 'from-entries-of-mapped-texts',
    body: `${HEAD} return new URLSearchParams(Object.fromEntries(Object.entries(defaults).map(([name, text]) => [name, text.trim()])));`,
    converts: false,
  },
  {
    id: 'entries-of-texts',
    body: `${HEAD} return new URLSearchParams(Object.entries(defaults));`,
    converts: false,
  },
  {
    id: 'map-of-texts',
    body: `return new URLSearchParams(new Map([['x', 'fixed']]));`,
    converts: false,
  },
  {
    id: 'conditional-record-of-texts',
    body: `const params: ${RECORD} = flag ? { x: 'a' } : {}; return new URLSearchParams(params);`,
    converts: false,
  },
  {
    id: 'nullish-default-of-texts',
    body: `${HEAD} return new URLSearchParams(options ?? defaults);`,
    converts: false,
  },
  {
    id: 'structured-clone-of-texts',
    body: `${HEAD} return new URLSearchParams(structuredClone(defaults));`,
    converts: false,
  },
  {
    id: 'write-a-text-into-an-object-with-no-prototype',
    body: `const params = Object.create(null) as ${RECORD}; params.x = 'fixed'; return new URLSearchParams(params);`,
    converts: false,
  },
  {
    id: 'write-a-text-into-the-answer-of-a-function',
    body: `const build = (): ${RECORD} => ({}); const params = build(); params.x = 'fixed'; return new URLSearchParams(params);`,
    converts: false,
  },
  {
    id: 'the-answer-of-a-function-written-nowhere',
    body: `const build = (): ${RECORD} => ({}); const params = build(); return new URLSearchParams(params);`,
    converts: false,
  },
  {
    id: 'a-record-parameter-written-nowhere',
    body: `return new URLSearchParams(options);`,
    converts: false,
  },
] as const;

const PINNED = [
  {
    id: 'spread-of-a-constant-record',
    body: `${HEAD} const params: ${RECORD} = { ...defaults, x: error as never }; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'spread-written-as-the-argument',
    body: `${HEAD} return new URLSearchParams({ ...defaults, x: error as never });`,
    converts: true,
  },
  {
    id: 'spread-into-a-replacement',
    body: `${HEAD} let params: ${RECORD} = {}; params = { ...defaults, x: error as never }; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assign-onto-a-constant-record',
    body: `const params: ${RECORD} = {}; Object.assign(params, { x: error as never }); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'assign-defaults-and-the-error-onto-a-constant-record',
    body: `${HEAD} const params: ${RECORD} = {}; Object.assign(params, defaults, { x: error as never }); return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'plain-write-into-a-constant-record',
    body: `const params: ${RECORD} = {}; params.x = error as never; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'computed-write-into-a-constant-record',
    body: `const params: ${RECORD} = {}; params[key] = error as never; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'spread-copy-of-a-written-record',
    body: `const base: ${RECORD} = {}; base.x = error as never; const copy: ${RECORD} = { ...base }; return new URLSearchParams(copy);`,
    converts: true,
  },
  {
    id: 'array-of-entries',
    body: `return new URLSearchParams([['x', error as never]]);`,
    converts: true,
  },
  {
    id: 'literal-written-as-the-argument',
    body: `return new URLSearchParams({ x: error as never });`,
    converts: true,
  },
  {
    id: 'literal-held-in-a-constant',
    body: `const params: ${RECORD} = { x: error as never }; return new URLSearchParams(params);`,
    converts: true,
  },
  {
    id: 'literal-of-texts',
    body: `return new URLSearchParams({ x: 'fixed' });`,
    converts: false,
  },
] as const;

const CASES = [
  ...COPIES,
  ...ENTRIES,
  ...BRANCHES,
  ...OVERRIDES,
  ...LISTS,
  ...COPIED,
  ...PATTERNS,
  ...WRITTEN,
  ...TEXTS,
  ...PINNED,
];

describe('records a native call builds or copies, read by what they are made of', () => {
  it.each(CASES)('$id', ({ body, converts }) => {
    expect(convertsSuppliedError(body)).toBe(converts);
  });
});

function convertsSuppliedError(body: string): boolean {
  using api = openTypeScript();
  const source = `function frames(error: Error, key: string, flag: boolean, options: Record<string, string> | undefined) { ${body} }`;
  using parsed = parseModule(api, 'search-params-untraced-records.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isNewExpression(node) &&
      framedSearchParamsText(node, {
        error: (value) => {
          const unwrappedValue = unwrapped(value);
          return isIdentifier(unwrappedValue) && unwrappedValue.text === 'error';
        },
        typed: () => false,
      })
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
