import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isFunctionDeclaration,
  isReturnStatement,
  type SourceFile,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { localsOf } from '../src/compiler/answers.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { reached } from '../src/compiler/json-reading.ts';
import { heldBy, ownsMethod } from '../src/compiler/retained.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Native global `RegExp` matches (`'aba'.match(/a/g)`, `re[Symbol.match]('aba')`) return
 * `string[] | null` without `.index`, `.input`, or `.groups`, which `canonical.ts` accepts as JSON,
 * whereas non-global, string-pattern, unproven-flag, or mutated matches return decorated match
 * arrays (`isJson === false`).
 */

interface LegacyCompile {
  compile: (pattern: string, flags?: string) => RegExp;
}

interface Case {
  readonly id: string;
  readonly body: string;
  readonly nonJson: boolean;
  readonly nothing?: boolean;
  readonly optional?: boolean;
  readonly ownedCustom?: boolean;
  readonly runtimeJson: boolean;
  readonly run: () => unknown;
}

function box<T>(value: T): T {
  return value;
}

function makePattern(source: RegExp | string, flags?: string): RegExp {
  const args: readonly [RegExp | string, string?] =
    flags === undefined ? [source] : [source, flags];
  return Reflect.construct<readonly [RegExp | string, string?], RegExp>(RegExp, args);
}

function callPatternFactory(source: RegExp | string, flags?: string): RegExp {
  const args: readonly [RegExp | string, string?] =
    flags === undefined ? [source] : [source, flags];
  return Reflect.apply<undefined, readonly [RegExp | string, string?], RegExp>(
    RegExp,
    undefined,
    args,
  );
}

function callStringMatch(text: string, ...args: readonly unknown[]): unknown {
  const matchFn = Reflect.get(String.prototype, 'match') as (
    this: string,
    ...items: readonly unknown[]
  ) => unknown;
  return Reflect.apply(matchFn, text, args);
}

function callSymbolMatch(pattern: RegExp): unknown {
  return Reflect.apply(pattern[Symbol.match], pattern, ['aba']);
}

const CASES: readonly Case[] = [
  {
    body: "return 'aba'.match(/a/g);",
    id: 'literal-global-match-hit',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "return 'bbb'.match(/a/g);",
    id: 'literal-global-match-miss-null',
    nonJson: false,
    run: () => callStringMatch('bbb', makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "return 'AbA'.match(/a/dgi);",
    id: 'literal-global-with-indices-and-ignorecase',
    nonJson: false,
    run: () => callStringMatch('AbA', makePattern('a', 'dgi')),
    runtimeJson: true,
  },
  {
    body: "return 'aba'.match(/a/gv);",
    id: 'literal-global-unicode-sets-flag',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern('a', 'gv')),
    runtimeJson: true,
  },
  {
    body: "return 'aba'.match(new RegExp('a', 'g'));",
    id: 'new-regexp-string-pattern-global-flag',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "return 'aba'.match(RegExp('a', 'gi'));",
    id: 'regexp-call-without-new-global-flags',
    nonJson: false,
    run: () => callStringMatch('aba', callPatternFactory('a', 'gi')),
    runtimeJson: true,
  },
  {
    body: "return 'aba'.match(new RegExp(/a/g));",
    id: 'new-regexp-copying-global-literal',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern(makePattern('a', 'g'))),
    runtimeJson: true,
  },
  {
    body: "return 'aba'.match(new RegExp(/a/g, undefined));",
    id: 'new-regexp-copying-global-with-undefined-flags',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern(makePattern('a', 'g'))),
    runtimeJson: true,
  },
  {
    body: "const re = /a/g; return 'aba'.match(re);",
    id: 'const-alias-global-regexp',
    nonJson: false,
    run: () => {
      const re = makePattern('a', 'g');
      return callStringMatch('aba', re);
    },
    runtimeJson: true,
  },
  {
    body: "const base = /a/g; const re = base; return 'aba'.match(re);",
    id: 'chained-const-alias-global-regexp',
    nonJson: false,
    run: () => {
      const base = makePattern('a', 'g');
      const re = base;
      return callStringMatch('aba', re);
    },
    runtimeJson: true,
  },
  {
    body: "const flags = 'g'; return 'aba'.match(new RegExp('a', flags));",
    id: 'folded-const-flags-in-new-regexp',
    nonJson: false,
    run: () => {
      const flags = 'g';
      return callStringMatch('aba', makePattern('a', flags));
    },
    runtimeJson: true,
  },
  {
    body: "return 'aba'.match(flag ? /a/g : /b/gi);",
    id: 'conditional-both-global-regexps',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "return /a/g[Symbol.match]('aba');",
    id: 'symbol-match-on-global-literal',
    nonJson: false,
    run: () => callSymbolMatch(makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "const re = /a/g; return re[globalThis.Symbol.match]('aba');",
    id: 'global-this-symbol-match-on-const-regexp',
    nonJson: false,
    run: () => {
      const re = makePattern('a', 'g');
      return callSymbolMatch(re);
    },
    runtimeJson: true,
  },
  {
    body: "const sym = Symbol.match; return /a/g[sym]('aba');",
    id: 'const-aliased-symbol-match-on-global-regexp',
    nonJson: false,
    run: () => {
      const re = makePattern('a', 'g');
      return callSymbolMatch(re);
    },
    runtimeJson: true,
  },
  {
    body: 'return maybeText?.match(/a/g);',
    id: 'optional-chain-global-match',
    nonJson: false,
    nothing: true,
    optional: true,
    run: () => {
      const maybeText = box<string | undefined>(undefined);
      return maybeText === undefined
        ? undefined
        : callStringMatch(maybeText, makePattern('a', 'g'));
    },
    runtimeJson: false,
  },
  {
    body: "const sym = Symbol.match; return /a/[sym]('aba');",
    id: 'const-aliased-symbol-match-non-global-refused',
    nonJson: true,
    run: () => callSymbolMatch(makePattern('a')),
    runtimeJson: false,
  },
  {
    body: "return 'aba'.match(/a/);",
    id: 'pin-non-global-literal-match',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern('a')),
    runtimeJson: false,
  },
  {
    body: "return 'aba'.match(/a/y);",
    id: 'pin-sticky-without-global-match',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern('a', 'y')),
    runtimeJson: false,
  },
  {
    body: "return 'aba'.match('a');",
    id: 'pin-string-argument-match',
    nonJson: true,
    run: () => callStringMatch('aba', 'a'),
    runtimeJson: false,
  },
  {
    body: "return 'aba'.match();",
    id: 'pin-zero-argument-match',
    nonJson: true,
    run: () => callStringMatch('aba'),
    runtimeJson: false,
  },
  {
    body: "return 'aba'.match(new RegExp(/a/g, 'i'));",
    id: 'pin-new-regexp-overriding-global-flags',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern(makePattern('a', 'g'), 'i')),
    runtimeJson: false,
  },
  {
    body: "return 'aba'.match(new RegExp('a', dynamicFlags));",
    id: 'pin-new-regexp-dynamic-flags',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern('a', box('i'))),
    runtimeJson: false,
  },
  {
    body: "return 'aba'.match(flag ? /a/g : /a/);",
    id: 'pin-conditional-mixed-global-and-non-global',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern('a')),
    runtimeJson: false,
  },
  {
    body: "return /a/g.exec('aba');",
    id: 'pin-global-regexp-exec-still-decorated',
    nonJson: true,
    run: () => makePattern('a', 'g').exec('aba'),
    runtimeJson: false,
  },
  {
    body: "return /a/[Symbol.match]('aba');",
    id: 'pin-non-global-symbol-match',
    nonJson: true,
    run: () => callSymbolMatch(makePattern('a')),
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; (re as unknown as { compile: (p: string) => void }).compile('a'); return 'aba'.match(re);",
    id: 'pin-compiled-away-global-flag',
    nonJson: true,
    run: () => {
      const re = makePattern('a', 'g');
      (re as unknown as LegacyCompile).compile('a');
      return callStringMatch('aba', re);
    },
    runtimeJson: false,
  },
  {
    body: "let re = /a/g; re = /a/; return 'aba'.match(re);",
    id: 'pin-reassigned-let-regexp',
    nonJson: true,
    run: () => {
      let re = box(makePattern('a', 'g'));
      if (re.global) {
        re = makePattern('a');
      }
      return callStringMatch('aba', re);
    },
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; Object.defineProperty(re, Symbol.match, { value: () => Object.assign(['a'], { index: 0 }) }); return 'aba'.match(re);",
    id: 'pin-overwritten-instance-symbol-match',
    nonJson: true,
    run: () => {
      const re = makePattern('a', 'g');
      Object.defineProperty(re, Symbol.match, {
        value: () => Object.assign(['a'], { index: 0 }),
      });
      return callStringMatch('aba', re);
    },
    runtimeJson: false,
  },
  {
    body: "String.prototype.match = (() => Object.assign(['a'], { index: 0 })) as unknown as typeof String.prototype.match; return 'aba'.match(/a/g);",
    id: 'pin-mutated-string-prototype-match',
    nonJson: true,
    run: () => Object.assign(['a'], { index: 0 }),
    runtimeJson: false,
  },
  {
    body: "const custom = { match(_re: RegExp) { return ['ok']; } }; return custom.match(/a/g);",
    id: 'pin-custom-object-own-match-retains-owned-by',
    nonJson: true,
    ownedCustom: true,
    run: () => ['ok'],
    runtimeJson: true,
  },
];

/** Extracts the returned `CallExpression` and local constant follower from `probe`. */
function returnedCall(file: SourceFile): {
  readonly call: CallExpression;
  readonly reach: (node: Expression) => Expression;
} {
  for (const fn of file.statements) {
    if (!isFunctionDeclaration(fn) || fn.name?.text !== 'probe' || fn.body === undefined) {
      continue;
    }
    const locals = localsOf(fn);
    const reading = {
      follow: (name: { readonly text: string }) => locals.constants.get(name.text),
    };
    const reach = (node: Expression): Expression => reached(node, reading).value;
    for (const statement of fn.body.statements) {
      if (isReturnStatement(statement) && statement.expression !== undefined) {
        const expr = unwrapped(statement.expression);
        if (isCallExpression(expr)) {
          return { call: expr, reach };
        }
      }
    }
  }
  throw new Error('expected returned call in probe');
}

describe('global RegExp matches versus decorated match arrays in retained', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)(
    '$id',
    ({
      body,
      nonJson,
      nothing = false,
      optional = false,
      ownedCustom = false,
      run,
      runtimeJson,
    }) => {
      using parsed = parseModule(
        api,
        'retained-global-matches.ts',
        `export function probe(flag: boolean, dynamicFlags: string, maybeText?: string) { ${body} }\n`,
      );
      const { call, reach } = returnedCall(parsed.sourceFile);
      const held = heldBy(call);
      const owns =
        held?.ownedBy !== undefined &&
        ownsMethod(reach(held.ownedBy.receiver), held.ownedBy.name, reach);

      expect(isJson(run())).toBe(runtimeJson);
      expect(held).toBeDefined();
      expect(held?.nonJson).toBe(nonJson);
      expect(held?.nothing).toBe(nothing);
      expect(Boolean(held?.optional)).toBe(optional);
      expect(owns).toBe(ownedCustom);
    },
  );
});
