import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Synchronous exception boundaries of callbacks and immediately invoked state initializers. */
describe('callback exception boundaries', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "[first].filter(async () => { throw new Error('later'); })",
    "[first].filter(async () => decodeURIComponent('%'))",
    "[first].filter(function* () { throw new Error('later'); })",
    "[first].filter(async function* () { throw new Error('later'); })",
    "[first].forEach(async function () { throw new Error('later'); })",
    "[first].forEach(function* () { throw new Error('later'); })",
    "[first, first].sort((async () => { throw new Error('later'); }) as never)",
    "[first, first].sort((function* () { throw new Error('later'); }) as never)",
    "(() => { try { [first].filter(() => { throw new Error('caught'); }); } catch {} return first; })()",
    "(() => { try { Object.values({ get value() { throw new Error('caught'); } }); } catch {} return first; })()",
    "(() => { try { new Response(null, { get status() { throw new Error('caught'); } }); } catch {} return first; })()",
    "(() => { try { decodeURIComponent('%'); } catch {} return first; })()",
    "(() => { try { [first].filter(() => { throw new Error('caught'); }); } catch {} finally { first.trim(); } return first; })()",
    "(() => { try { [first].filter(() => { throw new Error('caught'); }); } catch { throw new Error('overridden'); } finally { return first; } })()",
    "(() => { try { [first].map(() => { throw new Error('caught'); }); } catch {} return first; })()",
    "(() => { try { [first].map(() => { throw new Error('caught'); }); } finally { const value = first; return value; } })()",
    "(() => { try { [first].reduce(() => { throw new Error('caught'); }, first); } finally { ; return first; } })()",
    "(() => { return first; [first].map(() => { throw new Error('uncalled'); }); })()",
    "(() => { try {} catch { throw new Error('uncalled'); } return first; })()",
  ])(
    'keeps callbacks that defer their body and handled IIFE exceptions: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );

  it.each([
    "[first].filter(() => { throw new Error('sync'); })",
    "[first].forEach(function () { throw new Error('sync'); })",
    "[first, first].sort(() => { throw new Error('sync'); })",
    "(() => { try { [first].filter(() => { throw new Error('sync'); }); } finally {} return first; })()",
    "(() => { try { throw new Error('caught'); } catch { [first].filter(() => { throw new Error('sync'); }); } return first; })()",
    "(() => { try {} finally { [first].filter(() => { throw new Error('sync'); }); } return first; })()",
    "(() => { try { [first].filter(() => { throw new Error('caught'); }); } catch { throw new Error('escaping'); } return first; })()",
    "(() => { try { [first].filter(() => { throw new Error('escaping'); }); } finally { if (false) { return first; } } return first; })()",
    "(() => { try { [first].filter(() => { throw new Error('caught'); }); } catch {} finally { decodeURIComponent('%'); } return first; })()",
    "(() => { return decodeURIComponent('%'); [first].map(() => { throw new Error('uncalled'); }); })()",
    "(() => { throw new Error('escaping'); [first].map(() => { throw new Error('uncalled'); }); })()",
  ])('continues refusing synchronous escaping callback exceptions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "[first].map(() => { throw new Error('sync'); })",
    "[first].flatMap(() => { throw new Error('sync'); })",
    "[first, first].reduce(() => { throw new Error('sync'); })",
    "[first, first].reduceRight(() => { throw new Error('sync'); })",
    "[first].reduce(() => { throw new Error('sync'); }, first)",
    "[first].reduceRight(() => { throw new Error('sync'); }, undefined)",
    "[, , first].reduce(() => { throw new Error('sync'); }, first)",
    "[first, ,].reduceRight(() => { throw new Error('sync'); }, first)",
    "[, first].map(() => decodeURIComponent('%'))",
    "[first, ,].flatMap(() => { throw new Error('sync'); })",
  ])(
    'refuses throwing result-producing callbacks even when their result is discarded: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
    },
  );

  it.each([
    "[].map(() => { throw new Error('uncalled'); })",
    "[].flatMap(() => { throw new Error('uncalled'); })",
    "[,].map(() => { throw new Error('uncalled'); })",
    "[, ,].flatMap(() => { throw new Error('uncalled'); })",
    "[first].reduce(() => { throw new Error('uncalled'); })",
    "[, first, ,].reduceRight(() => { throw new Error('uncalled'); })",
    "[].reduce(() => { throw new Error('uncalled'); }, first)",
    "[, ,].reduceRight(() => { throw new Error('uncalled'); }, first)",
    "[first].map(async () => { throw new Error('later'); })",
    "[first].flatMap(function* () { throw new Error('later'); })",
    "[first, first].reduce((async () => { throw new Error('later'); }) as never)",
    "[first].reduceRight((function* () { throw new Error('later'); }) as never, first)",
  ])('keeps skipped or deferred result-producing callback bodies: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A prop-dependent state, which the authority evaluates and checks before it reaches a site. */
async function fixture(expression: string): Promise<Application> {
  return application({
    'components/callbacks.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function Callbacks({ projectId, first }: { projectId: string; first: string }) {',
      `  const [selected, setSelected] = useReactiveState<string>(first === '' ? (${expression}, first) : first);`,
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
      '}',
    ].join('\n'),
  });
}
