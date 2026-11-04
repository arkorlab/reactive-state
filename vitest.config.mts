import path from 'node:path';

import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * How many test files run at once, and so how many `workerd` processes exist at once: the Workers
 * pool starts one per concurrently running file. Left unset — which is how CI runs it, where each
 * test job has a runner to itself — Vitest uses `availableParallelism() - 1`. Set it on a machine
 * that shares its cores with other work.
 *
 * It belongs here rather than on each project: Vitest refuses two projects that set different
 * `maxWorkers` under the same `sequence.groupOrder`, and runs differing groups one after another
 * instead of together, which would cost more time than the cap saves.
 */
const testJobs = Number.parseInt(process.env['TEST_JOBS'] ?? '', 10);
const workerLimit = Number.isSafeInteger(testJobs) && testJobs > 0 ? { maxWorkers: testJobs } : {};

/**
 * Whether an unhandled error is Vitest's own teardown race, and nothing a test did wrong: a worker
 * that closes its channel while a console line is still on its way to be printed rejects it, and
 * the run fails with every test passed, naming whichever file happened to be running
 * (vitest-dev/vitest#11153, open on 4.x and 5.0). Only that error is let go; any other still fails
 * the run. It is judged here and not on each project because only the root runner reports
 * unhandled errors.
 */
function isTeardownConsoleRace(error: {
  readonly name?: string;
  readonly message?: string;
}): boolean {
  return (
    error.name === 'EnvironmentTeardownError' &&
    (error.message ?? '').includes('Closing rpc while "onUserConsoleLog" was pending')
  );
}

/**
 * Which files a `--shard` runs: each project's files in path order, dealt to the shards in turn,
 * the deal carrying on from one project into the next.
 *
 * Vitest's own split sorts the files by a hash of their path and cuts equal counts, which is even
 * in files but not in time. Files that compile whole applications run far longer than most, and a
 * hash can put twice as many of them in one shard as in another. Dealt out, a shard holds its share
 * of every project instead.
 *
 * The deal depends on nothing but the list of files, so every shard computes the same one and each
 * file runs in exactly one of them. Only the split is changed; the order a shard runs its files in
 * is still Vitest's.
 */
class ProjectDealSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { shard } = this.ctx.config;
    if (shard === undefined) {
      return Promise.resolve(files);
    }
    const root = this.ctx.config.root;
    const key = (spec: TestSpecification): string =>
      `${spec.project.name}\0${path.relative(root, spec.moduleId)}`;
    const dealt = files.toSorted((a, b) => {
      const left = key(a);
      const right = key(b);
      return Number(left > right) - Number(left < right);
    });
    return Promise.resolve(
      dealt.filter((_, position) => position % shard.count === shard.index - 1),
    );
  }
}

// One root runner; each project keeps its own environment and pool.
export default defineConfig({
  test: {
    ...workerLimit,
    // While the package's tests arrive in pull requests of their own, a shard can be dealt no
    // file. Taken out once the package's tests have all arrived.
    passWithNoTests: true,
    onUnhandledError: (error) => !isTeardownConsoleRace(error),
    sequence: { sequencer: ProjectDealSequencer },
    projects: [
      'packages/*/vitest.config.mts',
      'packages/*/vitest.workers.config.mts',
      'tools/*/vitest.config.mts',
    ],
  },
});
