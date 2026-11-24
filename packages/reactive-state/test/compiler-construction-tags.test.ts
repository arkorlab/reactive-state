import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source tags execute with their native strings array and actual substitution arguments. */
describe('construction tagged template effects', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "function tag() { items[0]='changed'; } class Fresh { constructor() { try { tag`x`; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));",
    `function tag(_strings: TemplateStringsArray,value: string[]) { value[0]='changed'; } const alias=tag; class Fresh { constructor() { try { alias\`\${items}\`; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));`,
    `class Fresh { constructor() { const tags={run(_strings: TemplateStringsArray,value: string[]) { value[0]='changed'; }}; try { tags.run\`\${items}\`; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));`,
    "function tag(_strings: TemplateStringsArray,value=(items[0]='changed',0)) { return value; } class Fresh { constructor() { try { tag`x`; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));",
    "function* tag(_strings: TemplateStringsArray,value=(items[0]='changed',0)) { yield value; } class Fresh { constructor() { try { tag`x`; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));",
    'class Fresh { constructor() { try { externalTag`x`; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));',
  ])('refuses source tag writes and unknown tag effects: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    `function tag(_strings: TemplateStringsArray,value: string[]) { return value.length; } class Fresh { constructor() { tag\`\${items}\`; Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));`,
    "function tag(strings=(items[0]='changed',[])) { return strings.length; } class Fresh { constructor() { tag`x`; Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    "function* tag() { items[0]='changed'; } class Fresh { constructor() { tag`x`; Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    "function tag() { items[0]='changed'; } class Fresh { constructor() { Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    'function tag() { const local=[0]; local[0]=1; } class Fresh { constructor() { tag`x`; Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));',
    `function tag(_strings: TemplateStringsArray,value: number) { return ++value; } class Fresh { constructor() { tag\`\${items.length}\`; Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));`,
  ])('keeps pure tags, present strings and deferred generator bodies: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** Shared callers are checked independently of the particular external tag passed by one caller. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/construction-tags.ts': `export function label(items: string[], externalTag: (strings: TemplateStringsArray) => void = () => {}): string { ${body} }`,
    'components/construction-tags.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/construction-tags';",
      'export default function ConstructionTags({projectId, first}: {projectId: string; first: string[]}) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
