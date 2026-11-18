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
  The checks are a diagnostic for honest mistakes, not a sandbox: see "Scope of the checks".
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

## Scope of the checks

The compiler tells an application's honest mistakes from what the language gives each side. It is a
diagnostic for them, not a sandbox against code written to defeat it. A finding is fixed when:

- a program an application plausibly writes reaches it: a type a generic component writes, a cast,
  a class the application extends, a helper that assigns; or
- the analysis hangs, or takes time that grows faster than the program does, on a program of that
  kind; or
- it is a security finding.

A finding that needs code made to get past the checks is a known limit, not a defect: a getter, a
hook or a prototype that rewrites what the program reads, a type that refers to itself through
several steps, thousands of members, a cycle of modules whose cleanup code writes. It goes under
"Known limits" below, or into the pull request's Standing decisions, and the checks do not grow to
follow it. Where a form cannot be followed cheaply, refuse it rather than add machinery to follow
it: a refusal is a message the developer can act on.

## Known limits

Each entry names a family of forms, with an example. The instances that review settled are in the
Standing decisions of the pull requests that settled them.

- **Types that go in circles or grow.** A value query that a path of indexes enters again more than
  four times, or a tuple reached through more than 32 aliases, is read as unreadable
  (`type ErrorTree = Error | ErrorTree[]` does not name its elements' `Error`, nor does `Rows[number]`
  for `type Rows = (Rows | Error)[]`). Unfilled type parameters that each constrain another through an
  index (`T0 extends { a: T1['a'] | … }`) cost work that grows faster than their count.
  `{ [key: string]: Error }[string]`, and `ReturnType<T>` for a `T` constrained to `() => Error`, are
  not read as naming an `Error`.
- **Names the code assembles or keeps under another name.** A name that reaches a prototype is read
  where the code writes it whole: one assembled from joined texts (`'__pro' + 'to__'`) or made at run
  time is not. A key reader of the language (`Reflect.get`) kept under a name of its own
  (`const get = Reflect.get`) or taken apart by a pattern is not followed, and a key variable gotten by
  destructuring or iterating a constant text (`[k] = 'ab'`) reads its names from the whole constant. An
  angle-bracket assertion `<T>expr` is not peeled.
- **Aliases and the rest of a pattern.** A list's entry reached through an alias (the name it is taken
  into, a loop variable, a reference a call returns: `list[1].at(0).push(e)`) and a key's tuple written
  through another binding (`const other = tuple; other[0] = …`) are not followed. The rest of an array
  pattern after its first position is read by type only: an index read of it is moved by the places
  before the rest (`rest[0]` of `[first, ...rest]` is slot one), a value the pattern takes apart is not
  followed into it, and `rest.at(0)` reads the type of the whole at that index.
- **Methods the program replaces.** An own method that `Object.assign` writes onto an array literal is
  taken for the own method of a rest copy of it, and a spread inside an object given to a native
  mutator is not read for a method it defines. A `call`, `apply` or `bind` the program writes onto a
  function (`assign.call = …`) is read as the language's where the function is called through a
  constant alias of it. A method that reaches the array through `super`, whose prototype's setter then
  writes `this[0]`, is read as one that names no `this`. A parameter, or a name no declaration of the
  file gives, handed to `Object.assign` as its source is read by the type the code declares for it.
- **Code that runs where the analysis does not look.** A getter that rewrites a method of its object or
  a later property of its own object (`get trigger() { this.join = … }`), a `using` disposer that runs
  the analysed function again or rewrites a tuple's entry, a `this` in the computed name of a method of
  an object literal (`{ [this.slot = 'x']() {} }`), a native mutator that writes the `length` of an
  entry's tuple while `Object.fromEntries` evaluates its arguments, and an argument after the predicate
  of `filter` that mutates the filtered array are not followed.
- **Callbacks and promises.** A callback that mutates the array it is called on during the same call
  (`[1,,].map((value, index, array) => { array[1] = error; return value; })`, or a write through a name
  it closes over) is not followed: a mapper's result is read as the first parameter's source slot and
  the callback's returns. `async () => false` kept under a name and read elsewhere is read as selecting
  nothing, where the Promise is truthy. A value declared `Error`, or a primitive, is read as
  immediately fulfilled even where it has a `then` member (a subclass).

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
