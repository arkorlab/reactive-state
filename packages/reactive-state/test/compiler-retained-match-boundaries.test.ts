import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isFunctionDeclaration,
  isReturnStatement,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { isAnswering, localsOf } from '../src/compiler/answers.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { reached } from '../src/compiler/json-reading.ts';
import { heldBy, ownsMethod } from '../src/compiler/retained.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Boundary checks for `isGlobalMatch`: positive native-string receiver proof, aliased prototype
 * mutations and helper handoffs, application-owned methods receiving `RegExp` patterns, and loop /
 * `catch` bindings shadowing outer global `RegExp` constants.
 */

interface LegacyCompile {
  compile: (pattern: string, flags?: string) => RegExp;
}

interface Case {
  readonly id: string;
  readonly body: string;
  readonly nonJson: boolean;
  readonly ownedCustom?: boolean | undefined;
  readonly runtimeJson: boolean;
  readonly run: () => unknown;
}

const NUMERIC_INPUT = 101;
const SLICE_END = 3;

function box<T>(value: T): T {
  return value;
}

function makePattern(source: RegExp | string, flags?: string): RegExp {
  const args: readonly [RegExp | string, string?] =
    flags === undefined ? [source] : [source, flags];
  return Reflect.construct<readonly [RegExp | string, string?], RegExp>(RegExp, args);
}

function callStringMatch(text: string, ...args: readonly unknown[]): unknown {
  const matchFn = Reflect.get(String.prototype, 'match') as (
    this: string,
    ...items: readonly unknown[]
  ) => unknown;
  return Reflect.apply(matchFn, text, args);
}

const CASES: readonly Case[] = [
  {
    body: 'const holder = { matcher: { match(_re: RegExp) { return NaN; } } }; return holder.matcher.match(/a/g);',
    id: 'member-custom-matcher-receiver-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: 'const makeMatcher = () => ({ match(_re: RegExp) { return NaN; } }); return makeMatcher().match(/a/g);',
    id: 'call-returned-custom-matcher-receiver-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: 'return customInput.match(/a/g);',
    id: 'parameter-custom-matcher-interface-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "const boxed = new String('aba'); Object.defineProperty(boxed, 'match', { value: () => NaN }); return boxed.match(/a/g);",
    id: 'new-string-wrapper-object-receiver-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: 'const fake: string = ({ match(_re: RegExp) { return NaN; } } as unknown) as string; return fake.match(/a/g);',
    id: 'cast-custom-matcher-on-typed-const-string-refused',
    nonJson: true,
    ownedCustom: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "const holder: { text: unknown } = { text: 'aba' }; holder.text = { match(_re: RegExp) { return NaN; } }; return (holder.text as string).match(/a/g);",
    id: 'overwritten-member-string-field-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "const proto = String.prototype; Object.defineProperty(proto, 'match', { value: () => NaN }); return 'a'.match(/a/g);",
    id: 'const-aliased-string-prototype-define-property-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "let proto: unknown; proto = RegExp.prototype; Reflect.defineProperty(proto as object, Symbol.match, { value: () => NaN }); return 'a'.match(/a/g);",
    id: 'let-reassigned-regexp-prototype-define-property-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "const { prototype: proto } = String; Object.assign(proto, { match: () => NaN }); return 'a'.match(/a/g);",
    id: 'destructured-string-prototype-assign-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "const patch = (target: { match?: unknown }) => { target.match = () => NaN; }; patch(String.prototype); return 'a'.match(/a/g);",
    id: 'string-prototype-handed-to-local-helper-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "const patch = (target: Record<symbol, unknown>) => { target[Symbol.match] = () => NaN; }; const proto = RegExp.prototype; patch(proto as unknown as Record<symbol, unknown>); return 'a'.match(/a/g);",
    id: 'aliased-regexp-prototype-handed-to-helper-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "Object.defineProperty(Object.getPrototypeOf(''), 'match', { value: () => NaN }); return 'a'.match(/a/g);",
    id: 'get-prototype-of-string-mutated-refused',
    nonJson: true,
    run: () => NaN,
    runtimeJson: false,
  },
  {
    body: "const tools = { replace(r: RegExp) { (r as unknown as LegacyCompile).compile('a'); } }; const re = /a/g; tools.replace(re); return 'aba'.match(re);",
    id: 'application-owned-replace-mutating-regexp-refused',
    nonJson: true,
    run: () => {
      const re = makePattern('a', 'g');
      (re as unknown as LegacyCompile).compile('a');
      return callStringMatch('aba', re);
    },
    runtimeJson: false,
  },
  {
    body: "const tools = { search(r: RegExp) { Object.defineProperty(r, Symbol.match, { value: () => NaN }); } }; const re = /a/g; tools.search(re); return 'aba'.match(re);",
    id: 'application-owned-search-redefining-symbol-match-refused',
    nonJson: true,
    run: () => {
      const re = makePattern('a', 'g');
      Object.defineProperty(re, Symbol.match, { value: () => NaN });
      return callStringMatch('aba', re);
    },
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; 'aba'.replace(re, () => { (re as unknown as LegacyCompile).compile('a'); return 'x'; }); return 'aba'.match(re);",
    id: 'string-replace-callback-mutating-regexp-refused',
    nonJson: true,
    run: () => {
      const re = makePattern('a', 'g');
      'aba'.replace(re, () => {
        (re as unknown as LegacyCompile).compile('a');
        return 'x';
      });
      return callStringMatch('aba', re);
    },
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; 'aba'.replace(re, opaqueReplacer); return 'aba'.match(re);",
    id: 'string-replace-opaque-replacer-refused',
    nonJson: true,
    run: () => Object.assign(['a'], { index: 0 }),
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; for (const re of [/a/]) { return 'aba'.match(re); } return 'aba'.match(re);",
    id: 'for-of-loop-binding-shadowing-global-regexp-refused',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern('a')),
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; for (const re in { a: 1 }) { return 'aba'.match(re as unknown as RegExp); } return 'aba'.match(re);",
    id: 'for-in-loop-binding-shadowing-global-regexp-refused',
    nonJson: true,
    run: () => callStringMatch('aba', 'a'),
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; for (const re = /a/; re.source.length > 0; ) { return 'aba'.match(re); } return 'aba'.match(re);",
    id: 'for-const-loop-head-non-global-shadowing-refused',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern('a')),
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; for (let re = /a/g; re.source.length > 0; ) { re = /a/; return 'aba'.match(re); } return 'aba'.match(re);",
    id: 'for-let-loop-head-shadowing-global-regexp-refused',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern('a')),
    runtimeJson: false,
  },
  {
    body: "const re = /a/g; try { throw /a/; } catch (re) { return 'aba'.match(re as RegExp); }",
    id: 'catch-binding-shadowing-global-regexp-refused',
    nonJson: true,
    run: () => callStringMatch('aba', makePattern('a')),
    runtimeJson: false,
  },
  {
    body: ['return `a$', "{flag ? 'b' : 'c'}a`.match(/a/g);"].join(''),
    id: 'pin-template-literal-receiver-accepted',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: 'return String(101).match(/1/g);',
    id: 'pin-string-call-conversion-receiver-accepted',
    nonJson: false,
    run: () => callStringMatch(String(NUMERIC_INPUT), makePattern('1', 'g')),
    runtimeJson: true,
  },
  {
    body: "return ('a' + flag + 'a').match(/a/g);",
    id: 'pin-string-concatenation-receiver-accepted',
    nonJson: false,
    run: () => callStringMatch('atruea', makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "return '  aba  '.trim().slice(0, 3).match(/a/g);",
    id: 'pin-chained-native-string-methods-receiver-accepted',
    nonJson: false,
    run: () => callStringMatch('  aba  '.trim().slice(0, SLICE_END), makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "const holder = { text: 'aba' }; return holder.text.match(/a/g);",
    id: 'pin-unreplaced-object-literal-string-member-accepted',
    nonJson: false,
    run: () => callStringMatch(box({ text: 'aba' }).text, makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "let text = 'aba'; if (flag) { text = 'aca'; } return text.match(/a/g);",
    id: 'pin-mutable-let-string-only-assignments-accepted',
    nonJson: false,
    run: () => callStringMatch('aca', makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: 'return textParam.match(/a/g);',
    id: 'pin-typed-string-parameter-receiver-accepted',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern('a', 'g')),
    runtimeJson: true,
  },
  {
    body: "const mapped = [1, 2].map(String); void mapped; Reflect.get(String.prototype, 'trim'); return '12'.match(/[0-9]/g);",
    id: 'pin-array-map-string-and-reflect-get-keep-intrinsics-clean',
    nonJson: false,
    run: () => callStringMatch('12', makePattern('[0-9]', 'g')),
    runtimeJson: true,
  },
  {
    body: "const re = /a/g; const cleaned = 'aba'.replace(re, (m) => m.toUpperCase()); return cleaned.match(re);",
    id: 'pin-native-string-replace-with-pure-arrow-keeps-regexp-clean',
    nonJson: false,
    run: () => {
      const re = makePattern('a', 'g');
      const cleaned = 'aba'.replace(re, (m) => m.toUpperCase());
      return callStringMatch(cleaned, re);
    },
    runtimeJson: true,
  },
  {
    body: "const re = /a/; void re; for (const re = /a/g; re.global; ) { return 'aba'.match(re); } return 'aba'.match(/b/g);",
    id: 'pin-for-const-inner-global-regexp-shadows-outer-non-global',
    nonJson: false,
    run: () => callStringMatch('aba', makePattern('a', 'g')),
    runtimeJson: true,
  },
];

/** Extracts the first returned `CallExpression` inside `probe` without entering nested functions. */
function returnedCall(file: SourceFile): {
  readonly call: CallExpression;
  readonly reach: (node: Expression) => Expression;
} {
  for (const fn of file.statements) {
    if (!isFunctionDeclaration(fn) || fn.name?.text !== 'probe' || fn.body === undefined) continue;
    const locals = localsOf(fn);
    const reading = {
      follow: (name: { readonly text: string }) => locals.constants.get(name.text),
    };
    const reach = (node: Expression): Expression => reached(node, reading).value;
    let found: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (found !== undefined || (node !== fn && isAnswering(node))) return;
      if (isReturnStatement(node) && node.expression !== undefined) {
        const expr = unwrapped(node.expression);
        if (isCallExpression(expr)) {
          found = expr;
          return;
        }
      }
      node.forEachChild(visit);
    };
    fn.body.forEachChild(visit);
    if (found !== undefined) return { call: found, reach };
  }
  throw new Error('expected returned call in probe');
}

describe('global RegExp match receiver, intrinsic, consumer, and scope boundaries', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, nonJson, ownedCustom = false, run, runtimeJson }) => {
    using parsed = parseModule(
      api,
      'retained-match-boundaries.ts',
      [
        'interface LegacyCompile { compile: (pattern: string, flags?: string) => RegExp }',
        'interface CustomMatcher { match: (re: RegExp) => unknown }',
        'export function probe(',
        '  flag: boolean,',
        '  textParam: string,',
        '  customInput: CustomMatcher,',
        '  opaqueReplacer: (substring: string) => string,',
        `) { ${body} }`,
        '',
      ].join('\n'),
    );
    const { call, reach } = returnedCall(parsed.sourceFile);
    const held = heldBy(call);
    const owns =
      held?.ownedBy !== undefined &&
      ownsMethod(reach(held.ownedBy.receiver), held.ownedBy.name, reach);

    expect(isJson(run())).toBe(runtimeJson);
    expect(held).toBeDefined();
    expect(held?.nonJson).toBe(nonJson);
    expect(owns).toBe(ownedCustom);
  });
});
