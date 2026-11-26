import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Reached shared helpers keep the same switch and hoisted value bindings as their source. */
describe('shared helper value binding scopes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      name: 'switch declared error',
      source:
        'function frames(flag: boolean): string { switch (flag) { case true: const error: Error = new Error(); return error.stack ?? ""; default: return ""; } }',
      invocation: 'true',
    },
    {
      name: 'switch declared error member',
      source:
        'function frames(): string { switch (true) { default: const box: { error: Error } = { error: new Error() }; return box.error.stack ?? ""; } }',
      invocation: '',
    },
    {
      name: 'switch constant stack key',
      source:
        'const field = "data"; function frames(error: Error & { data: string }): string { switch (true) { default: const field = "stack"; return error[field] ?? ""; } }',
      invocation: 'Object.assign(new Error(), { data: "fixed" })',
    },
    {
      name: 'switch fallthrough lexical key',
      source:
        'const field = "data"; function frames(error: Error & { data: string }, flag: number): string { switch (flag) { case 0: const field = "stack"; case 1: return error[field] ?? ""; default: return ""; } }',
      invocation: 'Object.assign(new Error(), { data: "fixed" }), 0',
    },
    {
      name: 'hoisted annotated object',
      source:
        'function frames(): string { { var box: { error: Error } = { error: new Error() }; } return box.error.stack ?? ""; }',
      invocation: '',
    },
    {
      name: 'hoisted loop annotated object',
      source:
        'function frames(): string { for (var box: { error: Error } = { error: new Error() }; false;) {} return box.error.stack ?? ""; }',
      invocation: '',
    },
    {
      name: 'nested function var boundary',
      source:
        'const field = "stack"; function frames(error: Error): string { function inner() { { var field = "data"; } } return error[field] ?? ""; }',
      invocation: 'new Error()',
    },
    {
      name: 'class static var boundary',
      source:
        'const field = "stack"; function frames(error: Error): string { class Inner { static { var field = "data"; } } return error[field] ?? ""; }',
      invocation: 'new Error()',
    },
  ])('refuses the actual stack observation: $name', async ({ source, invocation }) => {
    const app = await fixture(source, invocation);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('reads `stack` of an error'),
    ]);
  });

  it.each([
    {
      name: 'switch ordinary data',
      source:
        'function frames(): string { switch (true) { default: const box: { error: { stack: string } } = { error: { stack: "fixed" } }; return box.error.stack; } }',
      invocation: '',
    },
    {
      name: 'switch constant data key shadows stack',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }): string { switch (true) { default: const field = "data"; return error[field]; } }',
      invocation: 'Object.assign(new Error(), { data: "fixed" })',
    },
    {
      name: 'hoisted var data key shadows stack',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }): string { { var field: "data" = "data"; } return error[field]; }',
      invocation: 'Object.assign(new Error(), { data: "fixed" })',
    },
    {
      name: 'ordinary block constant shadow',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }): string { { const field = "data"; return error[field]; } }',
      invocation: 'Object.assign(new Error(), { data: "fixed" })',
    },
    {
      name: 'parameter key shadow',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }, field: "data"): string { return error[field]; }',
      invocation: 'Object.assign(new Error(), { data: "fixed" }), "data"',
    },
    {
      name: 'loop constant key shadow',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }): string { for (const field of ["data"] as const) return error[field]; return ""; }',
      invocation: 'Object.assign(new Error(), { data: "fixed" })',
    },
  ])('accepts the actual data read: $name', async ({ source, invocation }) => {
    const app = await fixture(source, invocation);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A reached shared normalizer, with each helper called using its concrete source arguments. */
async function fixture(source: string, invocation: string) {
  return application({
    'domain/todo-filter.ts': [
      "import type { TodoFilter } from '@/navigation';",
      source,
      `export function normalizeFilter(value: string): TodoFilter { return frames(${invocation}).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }`,
    ].join('\n'),
  });
}
