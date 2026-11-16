import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { platformOtherwise } from '../src/compiler/platform-otherwise.ts';
import { unsettledIn } from '../src/compiler/settled.ts';
import { timedMaking } from '../src/compiler/timed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const TIMED_FILE_REFUSAL = 'makes a `File` of no `lastModified`, which it takes of the time';
const BLOB_ENDINGS_REFUSAL =
  'makes a `Blob` or `File` of line endings the code shows no `transparent` one, which may follow the host platform';
const REQUEST_URL_REFUSAL =
  "makes `Request` of a URL the code shows no absolute one, which a page reads against its document's and the authority refuses";

const CHAIN = {
  depth: 25,
  maxElapsedMs: 100,
  midLink: 12,
} as const;

/** Builds a `depth`-level alias chain `a0 -> a1 -> ... -> a{depth}` before `tail`. */
function buildAliasChain(
  seed: string,
  tail: (last: string) => string,
  overrideLink?: { readonly at: number; readonly code: (prev: string, cur: string) => string },
): string {
  const lines = [seed];
  for (let index = 1; index <= CHAIN.depth; index++) {
    const prev = `a${index - 1}`;
    const cur = `a${index}`;
    lines.push(
      overrideLink?.at === index ? overrideLink.code(prev, cur) : `const ${cur} = ${prev};`,
    );
  }
  lines.push(tail(`a${CHAIN.depth}`));
  return lines.join('\n');
}

const CASES = [
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'self-cyclic-var-file-timestamp',
    source:
      "export function make() { var a: number | undefined = a; return new File([], 'x', { lastModified: a }).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'mutual-cyclic-var-file-timestamp',
    source:
      "export function make() { var a: number | undefined = b, b: number | undefined = a; return new File([], 'x', { lastModified: b }).size; }",
  },
  {
    expected: BLOB_ENDINGS_REFUSAL,
    id: 'three-way-cyclic-var-blob-options',
    source:
      "export function make() { var a: BlobPropertyBag | undefined = b, b: BlobPropertyBag | undefined = c, c: BlobPropertyBag | undefined = a; return new Blob(['x'], c).size; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'self-cyclic-var-request-url',
    source:
      'export function make() { var url: string | URL = url; return new Request(url).method; }',
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'hoisted-var-read-before-initializer',
    source:
      "export function make() { var a: number | undefined = b; var b: number | undefined = 0; return new File([], 'x', { lastModified: a }).size; }",
  },
  {
    expected: undefined,
    id: 'twenty-five-level-const-timestamp-chain',
    source: buildAliasChain(
      'const a0 = 0;',
      (last) =>
        `export function make() { return new File([], 'x', { lastModified: ${last} }).size; }`,
    ),
  },
  {
    expected: undefined,
    id: 'twenty-five-level-blob-endings-chain',
    source: buildAliasChain(
      "const a0: EndingType = 'transparent';",
      (last) => `export function make() { return new Blob(['x'], { endings: ${last} }).size; }`,
    ),
  },
  {
    expected: undefined,
    id: 'twenty-five-level-copied-timestamp-reassigned-after-copy',
    source: `export function make() {\n${buildAliasChain(
      'const a0 = 0;',
      (last) =>
        `a${CHAIN.midLink} = undefined;\nreturn new File([], 'x', { lastModified: ${last} }).size;`,
      {
        at: CHAIN.midLink,
        code: (prev, cur) => `let ${cur}: number | undefined = ${prev};`,
      },
    )}\n}`,
  },
  {
    expected: undefined,
    id: 'twenty-five-level-diamond-timestamp-branches',
    source: buildAliasChain(
      'const a0 = 0;',
      (last) =>
        `const left = ${last};\nconst right = ${last};\nexport function make(flag: boolean) { return new File([], 'x', { lastModified: flag ? left : right }).size; }`,
    ),
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'twenty-five-level-timestamp-reassigned-before-copy',
    source: buildAliasChain(
      'const a0 = 0;',
      (last) =>
        `export function make() { return new File([], 'x', { lastModified: ${last} }).size; }`,
      {
        at: CHAIN.midLink,
        code: (prev, cur) => `let ${cur}: number | undefined = ${prev};\n${cur} = undefined;`,
      },
    ),
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'mutated-options-chain-member-deleted-pin',
    source:
      "export function make() { const o0: FilePropertyBag = { lastModified: 0 }; const o1 = o0; const o2 = o1; delete o0.lastModified; return new File([], 'x', o2).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'reassigned-short-chain-before-copy-pin',
    source:
      "export function make() { let a0: number | undefined = 0; a0 = undefined; const a1 = a0; const a2 = a1; return new File([], 'x', { lastModified: a2 }).size; }",
  },
  {
    expected: undefined,
    id: 'deferred-helper-reads-later-const-pin',
    source:
      "function build() { return new File([], 'x', { lastModified: stamp }).size; } const stamp = 0; export function make() { return build(); }",
  },
] as const;

describe('memoized and cycle-safe platform initializer and mutability checks', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
    using warmup = parseModule(
      api,
      'warmup.ts',
      "const a0 = 0; const a1 = a0; export function warm() { return new File([], 'x', { endings: 'transparent', lastModified: a1 }).size + new Blob(['x']).size + new Request('https://example.com').method.length; }",
    );
    unsettledIn(warmup.sourceFile);
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Finds the first `timedMaking` or `platformOtherwise` refusal in `root`. */
  function firstPlatformRefusal(root: Node): string | undefined {
    let found: string | undefined;
    const visit = (node: Node): void => {
      if (found !== undefined) {
        return;
      }
      found = timedMaking(node) ?? platformOtherwise(node);
      if (found === undefined) {
        node.forEachChild(visit);
      }
    };
    root.forEachChild(visit);
    return found;
  }

  /** Measures cold-cache platform analysis time and verifies `unsettledIn` end-to-end. */
  function measureRefusal(source: string): {
    readonly elapsedMs: number;
    readonly platformRefusal: string | undefined;
    readonly settledRefusal: string | undefined;
  } {
    using parsed = parseModule(api, 'platform-alias-chains.ts', source);
    const startedAt = performance.now();
    const platformRefusal = firstPlatformRefusal(parsed.sourceFile);
    const elapsedMs = performance.now() - startedAt;
    return {
      elapsedMs,
      platformRefusal,
      settledRefusal: unsettledIn(parsed.sourceFile),
    };
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    const measured = measureRefusal(source);
    expect(measured.platformRefusal).toBe(expected);
    expect(measured.settledRefusal).toBe(expected);
    expect(measured.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });
});
