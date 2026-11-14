import type { KnipConfig } from 'knip';

/**
 * Dead-code detection.
 *
 * While the package's sources arrive in pull requests of their own, a file one of them adds is
 * often used only by a file a later one adds, so only what is wrong at every stage is reported: an
 * import of a package the workspace does not declare (`unlisted`), an import that resolves to
 * nothing (`unresolved`), and a binary a script runs that nothing installs (`binaries`). Unused
 * files and dependencies are reported again once the package's sources have all arrived, and
 * unused exports once its tests have.
 */
const config: KnipConfig = {
  include: ['unlisted', 'unresolved', 'binaries'],
  workspaces: {
    '.': {
      // The vocabulary tool's file-safety test makes a FIFO with the host's own utility.
      ignoreBinaries: ['mkfifo'],
    },
    // The Workers suite's own Worker, which its Vitest configuration names by path; and the
    // application's server operations the tests' authority calls by name, as a compile's registry
    // hands it a `'use server'` module.
    'packages/reactive-state': {
      entry: ['test/cloudflare/worker.ts'],
      ignore: ['test/support/app/actions/**'],
      ignoreDependencies: ['cloudflare'],
      // The one module `src/compiler/answers.ts` imports that a later pull request brings, which
      // `typecheck-expected.txt` allows `tsc` to miss in the same way; both go with that pull
      // request.
      ignoreUnresolved: ['./exported-values.ts'],
    },
  },
};

export default config;
