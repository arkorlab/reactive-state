import type { OperationCallable } from './operation-callables.ts';

/** Each written operation overload keeps its own inferred parameters and promised result. */
export function operationCallableType(
  original: string,
  callable: OperationCallable,
  result: string,
): string {
  if (callable.written !== undefined)
    return [
      '{',
      ...callable.written.map(
        (signature) => `  ${signature.head}: ${result}<${signature.answer}>;`,
      ),
      '}',
    ].join('\n');
  const matches: string[] = [];
  const transported: string[] = [];
  for (let index = 0; index < callable.count; index += 1) {
    matches.push(`  (...args: infer Inputs$${index}): infer Answer$${index};`);
    transported.push(`  (...args: Inputs$${index}): Promise<Awaited<Answer$${index}>>;`);
  }
  return [`${original} extends {`, ...matches, '} ? {', ...transported, '} : never'].join('\n');
}
