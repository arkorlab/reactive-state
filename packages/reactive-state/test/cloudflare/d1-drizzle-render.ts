import { Dependencies } from '../../src/authority/dependencies.ts';
import { type Evaluation, evaluate, type TableRead } from '../../src/server/context.ts';

/**
 * The faults a render of `read` notes, whose code catches what it is answered: each refusal the
 * evaluation is told of, as a render's outcome, whatever the code does with it.
 */
export async function faultsOf(read: () => Promise<unknown>): Promise<readonly unknown[]> {
  const faults: unknown[] = [];
  const evaluation = {
    readTables: async (taken: () => Promise<readonly TableRead[]>) => {
      try {
        await taken();
      } catch (error) {
        faults.push(error);
        throw error;
      }
    },
  } as unknown as Evaluation;
  await evaluate(evaluation, async () => {
    try {
      await read();
    } catch {
      // The component's own catch, which keeps no fault from the render.
    }
  });
  return faults;
}

/** Each read a render of `read` notes, as an evaluation of a render takes it in. */
export async function notedBy(read: () => Promise<unknown>): Promise<readonly TableRead[]> {
  const reads: TableRead[] = [];
  const evaluation = {
    readTables: async (taken: () => Promise<readonly TableRead[]>) => {
      reads.push(...(await taken()));
    },
  } as unknown as Evaluation;
  // Awaited within the render, as a component awaits its queries: Drizzle runs one as it is awaited.
  await evaluate(evaluation, async () => {
    await read();
  });
  return reads;
}

/** What a render of `read` read, as its dependencies. */
export async function rendered(read: () => Promise<unknown>): Promise<Dependencies> {
  const reads = await notedBy(read);
  const dependencies = new Dependencies();
  for (const { table, where } of reads) dependencies.query(table, where);
  return dependencies;
}
