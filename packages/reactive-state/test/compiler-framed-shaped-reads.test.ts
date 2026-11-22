import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

describe('shared helpers with written error observations', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      source: 'function frames({ stack }: Error): string { return stack ?? ""; }',
      invocation: "new Error('x')",
      reason: 'reads `stack` of an error',
    },
    {
      source: 'function frames(box: { error: Error }): string { return box.error.stack ?? ""; }',
      invocation: "{ error: new Error('x') }",
      reason: 'reads `stack` of an error',
    },
    {
      source:
        'const field = "stack"; function frames(error: Error): string { return error[field] ?? ""; }',
      invocation: "new Error('x')",
      reason: 'reads `stack` of an error',
    },
    {
      source: 'function frames(error: Error): string { return [error].join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const values = [error]; values.join = () => "fixed"; Object.assign(values, { join: Array.prototype.join }); return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const values = [error]; values.join = () => "fixed"; Object.defineProperty(values, "join", { value: Array.prototype.join }); return values.toString(); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const nativeJoin = Array.prototype.join; const values = [error]; values.join = nativeJoin; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error, join: typeof Array.prototype.join): string { const values = [error]; values.join = join; return values.join(","); }',
      invocation: "new Error('x'), Array.prototype.join",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const values = [error]; values.join = false ? () => "fixed" : Array.prototype.join; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const methods = { join() { return "fixed"; } }; methods.join = Array.prototype.join; const values = [error]; values.join = methods.join; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { function own() { return "fixed"; } restore(); const values = [error]; values.join = own; return values.join(","); function restore() { own = Array.prototype.join; } }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const methods = { join() { return "fixed"; } }; restore(); const values = [error]; values.join = methods.join; return values.join(","); function restore() { methods.join = Array.prototype.join; } }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const values = [error]; values.join = () => "fixed"; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const values = [error]; Object.assign(values, { join: () => "fixed" }); return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const values = [error]; Object.assign(values, { toString: () => "fixed" }); return values.toString(); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const values = [error]; Object.defineProperty(values, "join", { value: () => "fixed" }); return values.toString(); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const own = () => "fixed"; const values = [error]; values.join = own; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { function own() { return "fixed"; } const values = [error]; values.join = own; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const methods = { join() { return "fixed"; } }; const own = methods.join; const values = [error]; values.join = own; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { function own() { return "fixed"; } own(); own(); const values = [error]; values.join = own; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const methods = { join() { return "fixed"; } }; methods.join(); methods.join(); const values = [error]; values.join = methods.join; return values.join(","); }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { function own() { return "fixed"; } const captured = own; restore(); const values = [error]; values.join = captured; return values.join(","); function restore() { own = Array.prototype.join; } }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
    {
      source:
        'function frames(error: Error): string { const methods = { join() { return "fixed"; } }; const captured = methods.join; restore(); const values = [error]; values.join = captured; return values.join(","); function restore() { methods.join = Array.prototype.join; } }',
      invocation: "new Error('x')",
      reason: 'writes an error it did not make as text',
    },
  ])('refuses the selected engine observation: $source', async (test) => {
    const app = await fixture(test.source, test.invocation);
    apps.push(app);

    const compiled = compile(app);

    expect(compiled.refusals).toHaveLength(1);
    expect(compiled.refusals[0]?.reason).toContain(test.reason);
  });

  it.each([
    {
      source: 'function frames({ stack }: { stack: string }): string { return stack; }',
      invocation: '{ stack: "data" }',
    },
    {
      source:
        'type Error = { stack: string }; function frames(box: { error: Error }): string { return box.error.stack; }',
      invocation: '{ error: { stack: "data" } }',
    },
    {
      source:
        'const field = "stack"; function frames(error: { stack: string }): string { return error[field]; }',
      invocation: '{ stack: "data" }',
    },
  ])('preserves data, shadowing and an own array override: $source', async (test) => {
    const app = await fixture(test.source, test.invocation);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A reached shared module whose helper is used by the application's ordinary normalizer. */
async function fixture(source: string, invocation: string) {
  return application({
    'domain/todo-filter.ts': [
      "import type { TodoFilter } from '@/navigation';",
      source,
      `export function normalizeFilter(value: string): TodoFilter { return frames(${invocation}).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }`,
    ].join('\n'),
  });
}
