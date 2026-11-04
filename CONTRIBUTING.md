# Contributing to reactive-state

Thanks for looking. reactive-state is server-owned React state for Next.js: a compiler that splits
a `.reactive.tsx` component into the authorization it replays, the updates it registers and a Client
Component; the optimistic store that component reads; and the authority that runs the
application's own code for every render and every write. Everything here is before `1.0`: the
compiled subset and the protocol between a page and its authority are expected to change shape
before they settle, and no release carries a compatibility shim for the one before it.

The repository is being assembled in small, reviewed pull requests, in the order its modules depend
on each other. Until that is done, much of what this file describes arrives with the code it
describes. Issues, questions and pull requests are all welcome meanwhile.

## Ways to help

| Effort           | What's most useful                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5 min**        | [Open an issue](https://github.com/arkorlab/reactive-state/issues/new) about anything a document says that was wrong, missing, or not true of your application.                          |
| **An afternoon** | Send a small PR — a clearer error message, a comment that names the failure it exists for, a doc fix.                                                                                    |
| **Ongoing**      | Tell us what you wrote that the compiler refused and should not have, or took and should have refused. A component we have never seen is the most useful thing you have, refused or not. |

Two kinds of change are contracts with readers outside this repository: what the compiler accepts
and refuses, and the protocol between a page, its server and the authority. Please open an issue
before writing one of those, so the shape can be agreed first.

## Repo layout

```
reactive-state/
├── packages/
│   └── reactive-state/      # @arkorlab/reactive-state — the compiler, the authority, the runtime
│                            #   a page reads, and the Next.js integration
├── examples/                # applications written the way a developer writes one
├── fixtures/
│   └── next-project-todo/   # the application the package's tests compile, kept as written
└── tools/                   # what the repository's own checks run
```

## Development setup

Node 26 — the repository names `26.13.0` — and pnpm 12. You do not install pnpm yourself:
`packageManager` names the exact version, and Corepack fetches it. Node 26 requires installing
Corepack separately and enabling it once per machine.

```bash
npm install -g corepack@latest
corepack enable          # once per machine; `pnpm` does not exist until this runs
git clone https://github.com/arkorlab/reactive-state.git
cd reactive-state
pnpm install

pnpm format              # oxfmt --check; `pnpm format:write` writes
```

CI runs the same checks on every pull request, and audits the lockfile beside them
(`pnpm audit --audit-level low`). The rest of the checks — type checking, lint, the unused-code
check and the tests — join this list as the code they check arrives.

## Style

- **oxfmt formats everything.** 100 columns for code. Comments and markdown run past it where the
  prose reads better; the formatter does not reflow them, and neither should you just to fit.
- **Comments say why, not what.** A line naming the failure a check exists for, or the case a
  refusal guards against, outlives the code it sits above.
- **Doc comments are declarative**: "What …", "Whether …". Each module opens with a comment saying
  what it answers.
- **Refuse rather than guess.** Where the compiler cannot show that code is safe to take, it refuses
  it, with a message that says what it read and why. A refusal is a feature; taking code it cannot
  check is the bug.
- [`AGENTS.md`](AGENTS.md) lists what the linters here refuse and where a change to the compiler
  belongs.

## Pull request guidelines

We would rather read a rough PR than not see it. Tiny ones — a typo, a smoother sentence, a clearer
error — are genuinely welcome.

- **Commits must be signed.** The ruleset on `main` refuses unsigned commits. GitHub's own merge
  commits are signed, so this concerns the commits on your branch: see GitHub's guide to
  [signing commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits).
- **Size doesn't matter.** A large diff is fine. We would rather split it up on our side than have
  you sit on it.
- **A sparse description is OK.** We will ask follow-ups in review rather than bounce the patch.
- **A test that fails without your change says it best.** For the compiler, that is usually a row
  of what must be refused, or a case of what must still be taken.
- **Breaking changes are fine** before `1.0`. Say so in the description.

## Reporting bugs and security issues

- **Bugs**: [GitHub Issues](https://github.com/arkorlab/reactive-state/issues/new). Your Next.js
  version, the component, and what the compiler or the page did instead of what you expected go a
  long way; a one-line "this is broken" still beats not reporting it.
- **Security**: please do not file a public issue. Use GitHub's private vulnerability reporting
  (**Security** → **Report a vulnerability**), or email security@arkor.ai. We will acknowledge
  within 48 hours. See [`SECURITY.md`](SECURITY.md).

## Code of conduct

Be kind, assume good faith, and keep technical disagreement technical. Anything else — harassment,
personal attacks, exclusionary behaviour — is grounds for being asked to leave. The maintainers'
call is final.

## License

By contributing, you agree that your contributions will be published under this repository's terms:
[MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at the recipient's option, with the
[NOTICE](NOTICE) that Apache 2.0 asks be passed along. Opening a pull request is deemed to
constitute this agreement.

What a later release is licensed under may change. This file does not ask you to agree to that in
advance: what you grant by opening a pull request is the two licenses above, and nothing beyond
them.
