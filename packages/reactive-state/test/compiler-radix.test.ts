import { describe, expect, it } from 'vitest';

import { application, output, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A state the authority starts from a prop, retaining the ordinary production compiler checks. */
function component(expression: string): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    "import TodoCommands from '@/components/todo-commands.reactive';",
    'export default function Radix({ projectId, first }: { projectId: string; first: string }) {',
    `  const [selected, setSelected] = useReactiveState<string>(first === '' ? ${expression} : first);`,
    '  return <section><button type="button" onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected} /></section>;',
    '}',
    '',
  ].join('\n');
}

describe('radix checks of a state initializer', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "Buffer.from(first).toString('hex')",
    "Buffer.from(first).toString('base64url')",
    "Buffer.from(first).toString('base64')",
    "Object.assign(Buffer.from(first), {}).toString('hex')",
    "first.toString('hex' as never)",
  ])('takes an encoding argument on a receiver not shown numeric: %s', async (expression) => {
    const app = await application({ 'components/radix.reactive.tsx': component(expression) });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'components/radix.authority.mts')).toContain(expression);
  });

  it.each([
    '(1).toString(1)',
    "(1).toString('hex' as never)",
    "Number(first).toString('hex' as never)",
    "new Number(first).toString('hex' as never)",
    "BigInt(first).toString('hex' as never)",
    "(1n).toString('hex' as never)",
    "(-1n).toString('hex' as never)",
    "Number.prototype.toString.call(Number(first), 'hex' as never)",
    "(1).toString('1' as never)",
  ])('refuses a known numeric conversion with an invalid radix: %s', async (expression) => {
    const app = await application({ 'components/radix.reactive.tsx': component(expression) });
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    '(255).toString(16)',
    "(255).toString('16' as never)",
    "'a'.toString('hex' as never)",
    "first.toString('10' as never)",
    "(String.prototype.toString.call(first, 'hex' as never), 'ok')",
    "(Object.prototype.toString.call(first, 'hex' as never), 'ok')",
  ])('keeps valid numeric radices and text conversions: %s', async (expression) => {
    const app = await application({ 'components/radix.reactive.tsx': component(expression) });
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
