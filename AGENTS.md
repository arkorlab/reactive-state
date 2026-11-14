# Notes for agents and contributors

For an agent or a person changing this repository — most often the compiler in
`packages/reactive-state/src/compiler/`, which decides what a `.reactive.tsx` component may be.
[`CONTRIBUTING.md`](CONTRIBUTING.md) is the general guide; this file is the part that is particular
to the code.

## Constraints

- **Time to first byte comes first.** A page's first render stays one call to the authority, however
  deep its component tree; nothing here may add work before it — no extra round trip, no await on
  the way to the first byte.
- **Refuse rather than guess.** What the compiler cannot show safe to take, it refuses, with a
  message that says what it read. A refusal is a feature; taking code it cannot check is the bug.
- **No new application-facing API** without an issue agreeing its shape first.
- Commits are signed; `main` refuses unsigned ones. A pushed branch is never rebased or
  force-pushed: when `main` moves, merge it in.
- The word "todo" in a code comment fails lint (`no-warning-comments`), even inside a path.

## Changing the compiler

1. Write the test first and watch it fail on the unchanged sources: a row in
   `packages/reactive-state/test/compiler-refusals.test.ts` for what must be refused, a test in
   `packages/reactive-state/test/compiler-features.test.ts` for what must stay taken. A row that
   passes before the change proves nothing about it — keep it only as a pin, and say so.
2. Change the module that owns the question (see "Where a change lands"), as narrowly as the case.
   Then add tests of the nearby forms the change must not refuse.
3. Run oxfmt and oxlint on the files you changed. CI runs the rest.

## What the linters here refuse

- `max-lines`: 500 lines of code a file. Split by concern, as `written.ts` came out of `settled.ts`.
- Complexity 20 and sonarjs's cognitive complexity 15 a function; no nested conditional
  expressions; the simple condition first.
- `no-magic-numbers` allows 0, 1 and 2: name others in an `as const` object (`READS = { three: 3 }`).
- `import-x/no-cycle`: a helper two modules share goes in a leaf module (`iterators.ts`). Imports of
  types alone are not counted.
- No recursion where a loop does (`no-useless-recursion`), no `.filter()` in a `for…of` header, no
  bitwise operators.
- `no-restricted-types` refuses `object`: narrow with `typeof`. `different-types-comparison`: type
  parameters precisely.
- `prefer-set-methods`, but the TypeScript lib here types no `Set#union` and no iterator helpers:
  write loops (`unionOf`).
- `no-array-callback-reference`: `items.some((each) => isX(each))`, not `items.some(isX)`.
- `prefer-split-limit`: `path.split('.', 2)`. `prefer-string-raw` for backslashes.
  `no-template-curly-in-string`: in a test's source text, write `\${` inside a template literal.
- unicorn's class member order: private members before public ones; getters count as public.
- Vitest cuts a `$what` test name near 40 characters; `-t` must match its start.

## The compiler's syntax trees

The compiler reads TypeScript 7.1's syntax trees (`typescript/ast`, through `typescript.ts`), and no
types but those the code writes. In that API every node has a getter for every child, so
`'parameters' in node` or `'name' in node` is true of any node and tells no kind apart: test the
kind (`isSignatureDeclaration`, `isBlock`). A signature's `parameters` is a list, an empty one too,
so it needs no `?? []`. A `BindingElement`'s `name` may be `undefined`, and a
`ShorthandPropertyAssignment`'s `name` needs `isIdentifier` before `.text`.

## Where a change lands

In `packages/reactive-state/src/compiler/` unless named otherwise:

- A `shared` module that answers otherwise each time, or on each side: `settled.ts`
  (`unsettledIn`), with `written.ts` (what code writes into: assignments, changing methods,
  `call`/`apply`/`bind`), `kept.ts` (what a module keeps between calls), `held-methods.ts`,
  `handed-globals.ts`, `framed.ts` (errors' frames and words), `function-reads.ts`,
  `local-reads.ts` (time zone, locale), `timed.ts`, `platform-otherwise.ts`, `code-globals.ts`
  (`eval`, `Function`, loaders), `alike.ts`, `built-ins.ts`.
- What a state the authority starts may be — JSON, and nothing that throws: `json-values.ts`
  (`checkJson`), `throws.ts` (`throwsWithin` → `throwsOfWritten`, `throwsOfShape`,
  `constructsThrowing`), `throws-always.ts` (a helper that always throws), `throw-shapes.ts`,
  `throw-kinds.ts`, `throw-brands.ts`, `throw-platform.ts`, `throw-locales.ts`, `throw-symbols.ts`,
  `json-calls.ts`, `json-reading.ts`, `retained.ts`, `member-reads.ts`, `local-writes.ts`,
  `numbers.ts`.
- What the server part writes, and which states are local: `writes.ts` (`writtenIn`, `heldIn`),
  `frozen.ts`, `locality.ts`, `site-states.ts`, `sides.ts`.
- Dynamic sites and lists: `sites.ts`, `derive.ts`, `computed.ts`, `following.ts`, `frames.ts`,
  `bounded.ts`, `counting.ts`, `key-types.ts`, `kinds.ts`.
- The authority at run time: `packages/reactive-state/src/authority/` (`sites.ts`, `items.ts`,
  `replay.ts`, `canonical.ts`); the protocol, `packages/reactive-state/src/program.ts`.

## How the checks read code

- The checks of what an initializer throws refuse what the code shows: literals, constants followed
  to them, constructions of the language's and the platform's classes. What they cannot tell — a
  prop's value, what an unknown call answers — they do not refuse.
- A method named as text's, a number's, a pattern's or an array's, called on what the code does not
  show, is read as the language's, unless the code shows that what it is called on has methods of
  that name of its own (`ownsMethods`, `ownsCallers`).
- The checks of `shared` modules and of the server part's writes lean the other way: in doubt, they
  take the worst — a global they do not know makes a `shared` module unsettled, and what the server
  part hands to a call the compile cannot follow is taken for written.
- `throw-platform.ts` tries constructions in the compile's runtime, Node. Where workerd differs, a
  table says so (`COMPRESSION_FORMATS`).
- Only states the authority evaluates are checked for JSON: a test's state must read a prop
  (`first`), or the check never runs.

## Settled decisions

Questions already answered. A change that would reverse one of these needs an issue first:

- `localOf` and `LocalStateInput` are deliberate compiler and runtime entry points. Do not replace
  them with a boolean `stateOf` mode.
- A `shared` function's own work before it answers (`'x'.repeat(count)`, a loop `Number(filter)`
  times) is the application's code; the compile neither bounds nor rewrites it.
- A `shared` function's Unicode data and numeric approximations are the application's to keep
  alike on both sides. The stricter checks of `toUpperCase`, `normalize` or `Math.sin` that inline
  expressions get are not imposed inside those helpers.
- Arithmetic, conversions and `Math`'s functions of a page's values (`1 / count`,
  `Number(initial)`, `Math.sqrt(initial)`): the compile refuses what the code shows
  (`Number('bad')`); the authority and the page refuse a number that is not finite where they meet
  it.
- A recursive state type, a function typed as an object: no type keeps them out; a site that reads
  one fails where it stands (`Unsent`).
- In a reactive component or custom hook, a read is a global only where nothing in the file
  declares the name (`scope.ts`), and no nested declaration may give a top-level name again — which
  `writtenIn` and `heldIn` rely on. A `shared` module permits local shadowing; its constant and
  kept-state checks resolve writes in the declaration's lexical scope.
- `heldIn` reads a name two functions declare as one: that adds what a write reaches, never takes any
  away.
- A local state the authority started follows each value the authority renders of it until the page
  sets it; once set, it is kept across two roots of one session, and the application resets it by
  its key. Any call of its setter sets it, one that writes what it holds too. A view request leaves
  out of a site's inputs the states the page still follows, which the authority renders of its own
  values.
- `crypto.randomUUID()` in `fixtures/next-project-todo`: that application runs in secure contexts
  only.
- Code made of text by a key the compile cannot read is held as the module took it; by a name it can
  read, it is refused (`code-globals.ts`).
- A root's props reach the program through `frozenJson`, which writes them as JSON does.
