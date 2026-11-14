import { builtinModules } from 'node:module';

import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import type { Linter } from 'eslint';
import prettierConfig from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import noSecrets from 'eslint-plugin-no-secrets';
import perfectionist from 'eslint-plugin-perfectionist';
import promisePlugin from 'eslint-plugin-promise';
import redos from 'eslint-plugin-redos';
import regexp from 'eslint-plugin-regexp';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Root ESLint configuration for the whole workspace.
 *
 * Layers are applied in order; later layers override earlier ones.
 */

const RUNTIME_NEUTRAL_FILES = [
  // The authority as a Durable Object, the clients an application reaches either authority with,
  // the delivery both hosts share, and what an application's own modules read inside either
  // authority (`/server`, which may reach `node:async_hooks` alone: see below): workerd's, or
  // Next.js's server code.
  'packages/reactive-state/src/{client,cloudflare,delivery,server}/**/*.ts',
  // What an application's server runs to render its reactive components and reach the authority:
  // a deployment's Function, on Web APIs alone (`withReactiveState` is the build's, below).
  'packages/reactive-state/src/next/{authority,chain,deliver,index,operate,render,route,shared-root,site}.ts',
];
const NODE_ONLY_FILES = [
  'tools/**/*.ts',
  'tools/**/*.mts',
  'tools/**/*.cts',
  '*.config.ts',
  '**/*.config.ts',
  '**/*.config.mts',
  // The compiler, the authority and the bridge from the authority's change log; and the scripts
  // that build and serve the examples that use them. The browser's half of the package
  // (`src/runtime`, `src/react`) and what it shares with it (`src/program.ts`) are not Node's.
  'packages/reactive-state/src/{authority,bridge,compiler}/**/*.ts',
  'packages/reactive-state/src/next/{adapter,compile-on-build,config}.ts',
  'examples/*/scripts/**/*.mts',
];
const TEST_FILES = ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'];
const NEXT_CONVENTION_FILES = [
  'examples/*/{app,src/app}/**/{page,layout,route,not-found,error}.{ts,tsx}',
  // Every file under `pages/` is a Next.js convention file: the page, its API route, `_app`,
  // `_document` and the error documents are all named by their default export.
  'examples/*/pages/**/*.{ts,tsx}',
  'examples/*/proxy.ts',
  'examples/*/instrumentation.ts',
  // A reactive component is the compiler's input, which names it by its default export; React
  // never imports one.
  '**/*.reactive.tsx',
  '**/*.config.{ts,mts}',
  'tools/*/src/main.ts',
];

/**
 * Plugin `configs` maps are index signatures typed as unions of legacy and flat shapes; resolve one
 * flat-config entry or fail loudly at load time. The cast is the single typed boundary to plugins.
 */
function configOf(configs: Record<string, unknown> | undefined, name: string): Linter.Config {
  const config = configs?.[name];
  if (config === undefined) {
    throw new Error(`ESLint plugin config "${name}" is missing.`);
  }
  return config as Linter.Config;
}

/** Node built-in module names in both bare and `node:` forms. */
const NODE_BUILTINS = builtinModules.flatMap((name) =>
  name.startsWith('_') ? [] : [name, `node:${name}`],
);

/** Syntax no TypeScript here is written in. */
const RESTRICTED_SYNTAX = [
  { selector: 'TSEnumDeclaration', message: 'Use string literal unions instead of enums.' },
  {
    selector: 'TSParameterProperty',
    message: 'Parameter properties are not erasable syntax; declare fields explicitly.',
  },
  {
    selector: 'ExportDefaultDeclaration > ArrowFunctionExpression',
    message: 'Default-export a named function declaration, not an arrow function.',
  },
];

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/.next/**',
    // Where `next build` writes a static export: build output, not source.
    '**/out/**',
    '**/.wrangler/**',
    '**/dist/**',
    '**/coverage/**',
    '**/next-env.d.ts',
    // Drizzle Kit's migrations, as it writes them.
    'examples/*/drizzle/**',
    // What the compiler writes from an application's components, and the route it writes into the
    // application; their type check still reads them.
    'examples/*/.reactive/**',
    'examples/*/{app,src/app}/api/reactive-state/**',
    // The application the package's tests compile, kept byte for byte, since that it compiles as
    // written is the point.
    'fixtures/next-project-todo/**',
    // An application as a developer writes it with Drizzle, which is what the example shows: its
    // frame — pages, scripts — is linted as usual.
    'examples/drizzle/src/{actions,reactive}/**',
    'examples/drizzle/src/{db,permissions,schema}.ts',
  ]),

  // 1. Base JavaScript rules: everything on, then a short, justified opt-out list.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    ...js.configs.all,
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      camelcase: 'off', // `@typescript-eslint/naming-convention` owns naming; external field names stay as-is
      'capitalized-comments': 'off', // comments quote identifiers and URLs
      'class-methods-use-this': 'off', // Worker/Durable Object handlers are shape-driven
      'consistent-return': 'off', // TypeScript `noImplicitReturns` covers this precisely
      'default-case': 'off', // `@typescript-eslint/switch-exhaustiveness-check` is stricter
      'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
      'id-length': 'off', // short names are fine for indices and callbacks
      'init-declarations': 'off', // `let` without initializer is idiomatic for streaming state
      'max-classes-per-file': ['error', 3], // Worker entry files export several classes
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': 'off', // sonarjs cognitive complexity is the better signal
      'max-params': ['error', 4],
      'max-statements': 'off', // sonarjs cognitive complexity is the better signal
      'no-await-in-loop': 'off', // sequential awaits are intentional where order matters
      'no-console': 'error',
      'no-continue': 'off',
      'no-duplicate-imports': 'off', // import-x/no-duplicates handles type-only imports correctly
      'require-atomic-updates': 'off', // false positives on sequential awaits in stream loops
      'no-inline-comments': 'off',
      'no-magic-numbers': 'off', // replaced by the TypeScript-aware variant below
      'no-negated-condition': 'off', // stylistic; unicorn owns the useful cases
      'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
      'no-shadow': 'off', // replaced by the TypeScript-aware variant below
      'no-ternary': 'off',
      'no-undefined': 'off', // `undefined` is the idiomatic "absent" value with exactOptionalPropertyTypes
      'no-underscore-dangle': 'off', // Next.js internals (`__next_f`, `_rsc`) appear in string constants
      'no-use-before-define': 'off', // replaced by the TypeScript-aware variant below
      'no-void': ['error', { allowAsStatement: true }],
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
      'one-var': 'off',
      'prefer-destructuring': 'off',
      'prefer-named-capture-group': 'off', // regexp plugin governs regex quality
      'arrow-body-style': 'off', // unicorn/consistent-arrow-return-style is the single source of truth
      'sort-imports': 'off', // oxfmt sorts imports
      'sort-keys': 'off', // perfectionist sorts objects where it matters
    },
  },

  // 2. TypeScript: strict + stylistic, type-aware, with extra rigor.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    // Plain JavaScript config files (e.g. postcss.config.mjs) get no type-aware rules.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', prefer: 'type-imports' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'] },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'parameter', format: ['camelCase', 'PascalCase'], leadingUnderscore: 'allow' },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        { selector: ['objectLiteralProperty', 'typeProperty', 'classProperty'], format: null },
      ],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: {
            '{}': { message: 'Use a precise object type or `Record<string, never>`.' },
            object: { message: 'Use a precise object type or `Record<string, unknown>`.' },
          },
        },
      ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, typedefs: false, ignoreTypeReferences: true },
      ],
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
    },
  },

  // 3. Cross-plugin quality layers.
  configOf(unicorn.configs, 'all'),
  configOf(sonarjs.configs, 'recommended'),
  configOf(security.configs, 'recommended'),
  configOf(regexp.configs, 'flat/recommended'),
  configOf(promisePlugin.configs, 'flat/recommended'),
  // What a regular expression costs in the worst case, decided by `recheck` rather than guessed at
  // from the pattern's shape. This is the half the `regexp` rules above do not have: they look for
  // one match attempt that backtracks, and a pattern whose attempt is linear but is attempted from
  // every position in the subject is quadratic all the same — which is what CodeQL reports as
  // `js/polynomial-redos`, and what neither `no-super-linear-backtracking` nor
  // `no-super-linear-move` says a word about. The compiler reads an application's sources, and the
  // authority and the routes read what a request says, so the subject is somebody else's to choose.
  // The suites are held to it as well: what they read is as often a build's output or a response as
  // a string they wrote, and a pattern they carry is one somebody copies.
  //
  // `ignoreErrors` off because the rule's own default is to say nothing when it could not decide,
  // and a check that has quietly stopped checking is the one outcome worth less than no check at
  // all: it would read as a clean run. A pattern it cannot answer for is reported as that.
  //
  // `timeout` at 30 seconds, not the rule's 10: the automaton checker spends seconds on a long
  // alternation of literals, and on a slower CPU it ran past 10 — a timeout reported as an error,
  // though the pattern is linear.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: { redos },
    rules: { 'redos/no-vulnerable': ['error', { ignoreErrors: false, timeout: 30_000 }] },
  },
  configOf(perfectionist.configs, 'recommended-natural'),
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: { 'no-secrets': noSecrets },
    rules: {
      'no-secrets/no-secrets': ['error', { tolerance: 4.5 }],
      // Alphabetical ordering of declarations, object literals and type members destroys
      // semantic grouping; perfectionist is kept for collections where order carries no meaning.
      'perfectionist/sort-classes': 'off',
      'perfectionist/sort-exports': 'off', // oxfmt owns import/export order
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-interfaces': 'off',
      'perfectionist/sort-jsx-props': 'off',
      'perfectionist/sort-modules': 'off',
      'perfectionist/sort-named-exports': 'off',
      'perfectionist/sort-named-imports': 'off',
      'perfectionist/sort-object-types': 'off',
      'perfectionist/sort-objects': 'off',
      'perfectionist/sort-union-types': 'off',
      'promise/no-multiple-resolved': 'error',
      'promise/no-nesting': 'error',
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-duplicate-string': 'error',
      'sonarjs/no-identical-functions': 'error',
      'unicorn/filename-case': [
        'error',
        { case: 'kebabCase', ignore: [/^\[.*\]/u, /^_/u, /\.d\.ts$/u] },
      ],
      'perfectionist/sort-switch-case': 'off', // case order follows the protocol, not the alphabet
      'security/detect-object-injection': 'off', // flags every computed access; TypeScript covers it
      'security/detect-unsafe-regex': 'off', // star height is not a cost; `redos/no-vulnerable` decides the worst case
      'unicorn/comment-content': 'off', // prose casing in comments is not a code-quality signal
      'unicorn/no-break-in-nested-loop': 'off', // `switch` inside parser loops is idiomatic
      'unicorn/no-non-function-verb-prefix': 'off', // schema names such as `createSiteRequestSchema` are nouns
      'unicorn/prefer-iterator-to-array': 'off', // `Iterator#toArray` is not in the ES2024 lib the tsconfigs name
      'unicorn/prefer-array-from-async': 'off', // `Array.fromAsync` is not in the ES2024 lib the tsconfigs name
      'unicorn/prefer-number-coercion': 'off', // `parseInt` with an explicit radix is intentional for tolerant header parsing
      'unicorn/consistent-boolean-name': 'off', // rejects idiomatic predicates (`startsWith`, `equals`)
      'unicorn/import-style': 'off',
      'unicorn/name-replacements': 'off', // dictionary renames conflict with Next.js/Workers conventions (ctx, params)
      'unicorn/no-array-front-mutation': 'off', // queues are FIFO by definition
      'unicorn/no-asterisk-prefix-in-documentation-comments': 'off', // standard JSDoc style
      'unicorn/no-await-expression-member': 'off',
      'unicorn/no-barrel-files': 'off', // package subpath entry points are barrels by design
      'unicorn/no-null': 'off', // React and Next.js APIs return `null`
      'unicorn/no-unreadable-new-expression': 'off', // `new URL(x).host` is idiomatic
      'unicorn/prefer-error-is-error': 'off', // `Error.isError` is not in the ES2024 lib the tsconfigs name
      'unicorn/prefer-uint8array-base64': 'off', // `Uint8Array#toBase64` is not in the ES2024 lib the tsconfigs name
      'unicorn/prefer-uint8array-hex': 'off', // `Uint8Array#toHex` is not in the ES2024 lib the tsconfigs name
      'unicorn/single-line-block-comment-style': 'off', // single-line JSDoc is idiomatic
      'unicorn/try-complexity': 'off', // a complexity budget of 1 per try block is unworkable for stream pumps
      'unicorn/prefer-top-level-await': 'off', // not valid in Next.js modules
      'unicorn/prevent-abbreviations': 'off', // Next.js conventions (`props`, `params`, `env`, `ref`)
      // The rules that want a function's shape changed are settled one at a time.
      //
      // A guard that wraps up to three statements is a positive case — "when this applies, do
      // these" — and not a function body pushed sideways. At the default of one, `prefer-continue`
      // and `prefer-early-return` ask for such guards to be turned inside out, and at two for the
      // last `if` of a loop to become a `continue` that falls off the end of the loop anyway. At
      // four the wrapping has become the function.
      'unicorn/prefer-continue': ['error', { maximumStatements: 3 }],
      'unicorn/prefer-early-return': ['error', { maximumStatements: 3 }],
      // These two have no setting that fits. `prefer-ternary` wants `if (c) { return a; } return b;`
      // written as one ternary — nearly always a chain of guards, one `if` per reason in the order a
      // reader meets them, ahead of the answer itself. `prefer-combined-guards` wants
      // separately-reasoned guards merged with `||`, which costs each the reason it is there for.
      // Ternaries that do get written are still governed: `no-nested-ternary`,
      // `prefer-minimal-ternary` and `prefer-logical-operator-over-ternary` stay on.
      'unicorn/prefer-combined-guards': 'off',
      'unicorn/prefer-ternary': 'off',
      // Neither of these two has a setting.
      //
      // `no-manually-wrapped-comments` wants a comment's sentence on one line, for an editor to
      // wrap. Comments here are wrapped near the 100 columns oxfmt keeps the code to, and its fix
      // would join thousands of them into lines far past it. It does not read a line with a
      // backtick or a bracket in it as prose, so the comments that kept their wrapping would be the
      // ones that name code — two styles where there is one now.
      'unicorn/no-manually-wrapped-comments': 'off',
      // `no-unnecessary-array-flat-map` wants `cond ? [x] : []` written `cond ? x : []`, and every
      // `flatMap` here that it reports is that one-or-none. The brackets are what say so: both
      // branches are lists, and `x` stays one item if its type becomes a list later, where the
      // unwrapped form would quietly flatten it.
      'unicorn/no-unnecessary-array-flat-map': 'off',
      // Explicit comparisons short-circuit without allocating membership arrays on request paths.
      'unicorn/prefer-includes-over-repeated-comparisons': 'off',
      // Call sites retain explicit protocol defaults and choose how their results are formatted.
      'unicorn/no-unnecessary-default-arguments': 'off',
      'unicorn/no-repeated-call-wrappers': 'off',
    },
  },

  // 3b. Import hygiene (import-x is ESLint 10 compatible; eslint-plugin-import is not).
  //
  // The first three settings are what import-x parses a dependency with and which files it counts as
  // modules (`importX.flatConfigs.typescript`'s values). Without them it reads no `.ts` file an
  // import leads to, so `no-cycle` follows nothing and reports nothing, cycles included.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/extensions': ['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx', '.cjs', '.mjs'],
      'import-x/external-module-folders': ['node_modules', 'node_modules/@types'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.cts', '.mts'] },
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: {
      'import-x/no-anonymous-default-export': 'error',
      'import-x/no-cycle': 'error',
      'import-x/no-default-export': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'import-x/no-self-import': 'error',
      // Without `noUselessIndex`: an import names its file, `index.ts` included, since Node runs the
      // scripts here with no directory imports.
      'import-x/no-useless-path-segments': 'error',
    },
  },

  {
    files: NEXT_CONVENTION_FILES,
    rules: { 'import-x/no-default-export': 'off' },
  },

  // 4. Boundaries.
  {
    files: RUNTIME_NEUTRAL_FILES,
    languageOptions: { globals: { ...globals.serviceworker } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => {
            return {
              name,
              message: 'This package must stay runtime-neutral: no Node.js built-in modules.',
            };
          }),
        },
      ],
    },
  },
  {
    // What an application's own modules read inside the authority, wherever it runs: a replay's
    // reads go through an `AsyncLocalStorage`, which a Durable Object has under `nodejs_compat`. No
    // other built-in may be reached.
    files: ['packages/reactive-state/src/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.filter(
            (name) => name !== 'async_hooks' && name !== 'node:async_hooks',
          ).map((name) => {
            return {
              name,
              message:
                'What a scope reads runs in a Durable Object too, where `node:async_hooks` is the one built-in it may use.',
            };
          }),
        },
      ],
    },
  },
  {
    // The browser's half of the package: what the authority keeps, and what an application's
    // modules read inside it, never reach a page.
    files: ['packages/reactive-state/src/{react,runtime}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../server/*',
                '../authority/*',
                '../cloudflare/*',
                '../bridge/*',
                '../next/*',
              ],
              message:
                "The browser's half of the package imports nothing of the authority's, nor of the application server's.",
            },
          ],
        },
      ],
    },
  },
  {
    // The authority's engine, which a Durable Object runs as well as Node does: the Object has
    // `nodejs_compat`, so `node:crypto` is there, and no other built-in may be reached.
    files: [
      'packages/reactive-state/src/authority/{assemble,bindings,canonical,database,dependencies,engine,errors,evaluation,fields,frames,gate-answers,guards,materialize,memo,model,operations,programs,public,query,records,render,replay,requests,route-guards,route-registry,rows,schema,seed,shared-entry,shared-events,shared-generate,shared-jobs,shared-render,shared-requests,shared-store,shared-views,skeleton,sql,tables,transaction,tree,view-tokens,views}.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.filter((name) => name !== 'crypto' && name !== 'node:crypto').map(
            (name) => {
              return {
                name,
                message:
                  'The engine runs in a Durable Object too, where `node:crypto` is the one built-in it may use.',
              };
            },
          ),
        },
      ],
    },
  },
  {
    files: ['**/logger.ts', '**/logger/*.ts', 'tools/**/*.ts', 'tools/**/*.mts'],
    rules: { 'no-console': 'off' },
  },
  {
    // CLI tools read and write files whose paths come from flags, on a Node version without
    // Temporal. The compiler reads the component it is named and writes beside it; the authority
    // keeps its database where it is told; the adapter compiles an application where its build
    // says; the examples' scripts do all three with what a build left.
    files: [
      'tools/**/*.ts',
      'tools/**/*.mts',
      'packages/reactive-state/src/{authority,compiler}/**/*.ts',
      'packages/reactive-state/src/next/{adapter,compile-on-build,config}.ts',
      'packages/reactive-state/test/**/*.{ts,tsx}',
      'examples/*/scripts/**/*.mts',
    ],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'unicorn/prefer-temporal': 'off',
    },
  },
  {
    files: ['*.config.ts', '**/*.config.{ts,mts}', 'eslint.config.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      'max-lines': 'off',
      'sonarjs/no-duplicate-string': 'off',
      // A config file is loaded for its default export, which is the call that builds it.
      'unicorn/no-top-level-side-effects': 'off',
    },
  },
  {
    files: ['**/*.d.{ts,mts,cts}'],
    rules: { 'import-x/no-default-export': 'off' },
  },
  {
    // A reactive component is the compiler's input: no code calls it, and what it returns is JSX
    // the compiler moves into the Client Component it writes, so its signature is the compiler's
    // to decide.
    files: ['**/*.reactive.tsx'],
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'off' },
  },

  // 5. Node-only files (tooling, config, build-time code).
  {
    files: NODE_ONLY_FILES,
    ...configOf(nodePlugin.configs, 'flat/recommended-module'),
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: NODE_ONLY_FILES,
    rules: {
      'n/no-missing-import': 'off', // TypeScript resolves these
      'n/no-process-env': 'off',
      'n/no-unpublished-import': 'off',
    },
  },

  // 6. Tests.
  {
    files: TEST_FILES,
    ...configOf(vitest.configs, 'all'),
  },
  {
    files: TEST_FILES,
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'max-lines': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/no-clear-text-protocols': 'off', // `http://` literals are test data
      'unicorn/prefer-https': 'off', // `http://` literals are test data
      'sonarjs/no-hardcoded-ip': 'off', // IP literals are test data
      // `expectTypeOf` asserts at typecheck rather than at runtime; a test that makes one is not
      // a test without assertions.
      'vitest/expect-expect': [
        'error',
        { assertFunctionNames: ['expect', 'expectTypeOf', 'assert'] },
      ],
      'vitest/max-expects': ['error', { max: 8 }],
      'vitest/no-hooks': 'off',
      'vitest/prefer-describe-function-title': 'off', // describe titles name behaviours, not only functions
      'vitest/prefer-expect-assertions': 'off',
      'vitest/require-mock-type-parameters': 'off',
    },
  },

  // While the compiler's sources arrive: `answers.ts` type-imports a module a later pull request
  // brings (`exported-values.ts`), and type-aware rules read the type it names as `any` until then.
  // That pull request removes this, with `tools/typecheck-expecting.mts`.
  {
    files: ['packages/reactive-state/src/compiler/answers.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  // 7. Formatting is owned by oxfmt; disable every stylistic rule that conflicts with it.
  prettierConfig,
]);
