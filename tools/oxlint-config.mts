import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import migrate from '@oxlint/migrate';
import type { Linter } from 'eslint';

import eslintConfig from '../eslint.config.ts';

/**
 * `.oxlintrc.json`, derived from `eslint.config.ts`: `pnpm oxlint-config:generate` writes it, and
 * `pnpm oxlint-config:check` fails when it no longer says what the ESLint config makes of it.
 *
 * oxlint runs the rules it implements natively over the whole repository in under a second, where
 * ESLint takes minutes a share; `pnpm lint:fast` and CI's `lint-fast` job use it for a first answer.
 * It is a subset and never the verdict — ESLint still runs every rule — so it has to report nothing
 * ESLint would not: a first answer that cries wolf teaches people to ignore it. Each rule cut to
 * keep it that way is in `DIVERGENT`, with what oxlint reported on a tree ESLint passes.
 *
 * No JavaScript plugins: oxlint's are an alpha that cannot give a plugin's rule the type information
 * several of this config's (`sonarjs`) ask for. The type-aware rules of typescript-eslint are in,
 * and run with `--type-aware` (`pnpm lint:fast --type-aware`), through tsgolint: typescript-go, the
 * compiler TypeScript 7 is, where the workspace's tools check with TypeScript 6. Without the flag
 * they are skipped, which keeps `pnpm lint:fast` under a second.
 *
 * tsgolint gives a file the program of the tsconfig whose root files include it. TypeScript drops a
 * `.tsx` from those when a `.ts` of the same name is beside it (`--showConfig` lists the one), and
 * the file is then checked in a program without that tsconfig's `paths`: every type through an
 * alias is an error, and the `no-unsafe-*` rules report each use of one. That is not a divergence
 * of the rules; keep the two names apart.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_FILE = path.join(REPO_ROOT, '.oxlintrc.json');

/**
 * Rules oxlint implements, but not as ESLint does here: on the package's sources and suites, which
 * ESLint passes (2026-11-04, oxlint 1.90.0 and tsgolint 7.0.2005, `--type-aware`), oxlint reported
 * each of them, as many times as the reason says. When `lint (oxlint)` reports something ESLint
 * does not, the rule belongs here, with its count.
 */
const DIVERGENT: Readonly<Record<string, string>> = {
  'vitest/no-conditional-in-test': '1128: counts `??` in a test as a conditional; ESLint does not',
  'unicorn/no-useless-undefined': '109: takes `resolve(undefined)` and the like as useless',
  'unicorn/no-array-callback-reference':
    '20: a function reference handed to an iterator method, which ESLint passes',
  'unicorn/prefer-number-properties':
    '15: asks for `Number.NaN`, which unicorn does not by default',
  'unicorn/no-array-method-this-argument':
    "14: reads a store's own `find(table, query)` as `Array#find` with a this-argument",
  'unicorn/consistent-function-scoping': '7: wants helpers inside callbacks hoisted',
  'no-unsafe-optional-chaining': '3, in one test file',
  // oxlint has no `n` plugin, and takes a directive naming one of its rules for one naming none.
  'unicorn/no-abusive-eslint-disable': '2: an `eslint-disable` naming an `n/` rule',
};

/**
 * An ESLint option oxlint's version of the rule does not have. Dropping it narrows what the rule
 * checks, which keeps it a subset; the rule is cut instead where dropping one would widen it.
 */
const UNSUPPORTED_OPTIONS: Readonly<Record<string, readonly string[]>> = {};

type RuleEntry = Linter.RuleEntry;
type Rules = Record<string, RuleEntry>;

interface OxlintConfig {
  rules?: Rules | undefined;
  overrides?: { rules?: Rules | undefined }[] | undefined;
  [key: string]: unknown;
}

/**
 * A regular expression in a rule's options, as oxlint takes one: a string, which oxlint 1.86.0
 * compiles with Rust's `regex` crate as it stands (`deserialize_regex_vec`). The migration hands
 * it over as the `RegExp` the ESLint config holds, which JSON would make `{}`.
 *
 * The flags go into the string: `i`, `m` and `s` as the same inline flags, and `u` as nothing,
 * since that engine is Unicode-aware throughout. A flag it has no equivalent for is refused, not
 * dropped: dropping one changes what the pattern matches, and an ignore pattern that lost its `i`
 * would have oxlint report the files ESLint leaves alone. The pattern itself is read by the other
 * engine, whose `\w`, `\d` and `\b` are Unicode's rather than ASCII's; where that has oxlint report
 * a file ESLint passes, it is a divergence like those above.
 */
function pattern(regex: RegExp): string {
  const unknown = regex.flags.replaceAll(/[imsu]/gu, '');
  if (unknown !== '') {
    throw new Error(`${String(regex)}: oxlint has no equivalent of the flags \`${unknown}\``);
  }
  const inline = regex.flags.replace('u', '');
  return inline === '' ? regex.source : `(?${inline})${regex.source}`;
}

/**
 * A value of the config as it is written out: a regular expression as its `pattern()`, and an
 * object with its keys sorted. The migration orders keys by how the ESLint config is cut into
 * blocks (one that only adds settings moved an override's `plugins` from after its `globals` to
 * before them), and the check compares bytes: two changes that each passed it would fail together.
 * Arrays keep their order, which is meaning: later overrides win, and an ignore pattern can negate.
 */
function written(value: unknown): unknown {
  if (value instanceof RegExp) {
    return pattern(value);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      // By code unit, not `localeCompare`: the file has to come out the same on every machine.
      .toSorted((a, b) => Number(a > b) - Number(a < b))
      .map((key) => [key, record[key]]),
  );
}

/** A rules table with the divergent rules left out and the unsupported options dropped. */
function curated(rules: Rules | undefined): Rules | undefined {
  if (rules === undefined) {
    return undefined;
  }
  const kept = Object.entries(rules).filter(([name]) => !Object.hasOwn(DIVERGENT, name));
  return Object.fromEntries(
    kept.map(([name, entry]) => {
      const dropped = UNSUPPORTED_OPTIONS[name];
      if (dropped === undefined || !Array.isArray(entry)) {
        return [name, entry];
      }
      const options = entry.map((option: unknown) => {
        if (option === null || typeof option !== 'object' || Array.isArray(option)) {
          return option;
        }
        return Object.fromEntries(Object.entries(option).filter(([key]) => !dropped.includes(key)));
      });
      return [name, options as RuleEntry];
    }),
  );
}

type Override = NonNullable<OxlintConfig['overrides']>[number];

function curatedOverride(override: Override): Override {
  return { ...override, rules: curated(override.rules) };
}

async function generated(): Promise<string> {
  const config = (await migrate(eslintConfig, undefined, {
    jsPlugins: false,
    typeAware: true,
  })) as OxlintConfig;
  const result: OxlintConfig = {
    ...config,
    // The migration sets `options.typeAware`, which would make every run type-aware; the flag is
    // left to the command, so a run without it needs neither the declarations nor the time.
    options: undefined,
    rules: curated(config.rules),
    overrides: config.overrides?.map((override) => curatedOverride(override)),
  };
  return `${JSON.stringify(result, (_key, value: unknown) => written(value), 2)}\n`;
}

async function main(mode: string): Promise<number> {
  const text = await generated();
  if (mode === 'generate') {
    writeFileSync(CONFIG_FILE, text);
    return 0;
  }
  if (mode === 'check') {
    if (readFileSync(CONFIG_FILE, 'utf8') === text) {
      return 0;
    }
    console.error(
      '.oxlintrc.json is not what eslint.config.ts makes of it; run `pnpm oxlint-config:generate`.',
    );
    return 1;
  }
  console.error('usage: oxlint-config.mts generate|check');
  return 2;
}

process.exitCode = await main(process.argv[2] ?? '');
