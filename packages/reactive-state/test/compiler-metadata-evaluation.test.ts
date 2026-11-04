import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Constructor arguments distinguish ignored primitive prototypes and unevaluated class bodies. */
describe('metadata constructor argument evaluation', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } return String(Object.isFrozen(new Fresh({__proto__: 1} as {value?: string[]})));',
    'class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } return String(Object.isFrozen(new Fresh({__proto__: undefined} as {value?: string[]})));',
    "class Fresh { constructor(_ignored: unknown) {} } return String(Object.isFrozen(new Fresh(class { constructor() { items[0] = 'changed'; } })));",
    "class Fresh { constructor(_ignored: unknown) {} } return String(Object.isFrozen(new Fresh(class { value = (items[0] = 'changed'); })));",
  ])(
    'keeps a proven fresh result despite a non-executed write or ignored prototype: %s',
    async (body) => {
      const app = await fixture(body);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );

  it.each([
    'class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } return String(Object.isFrozen(new Fresh({__proto__: null} as {value?: string[]})));',
    'class Fresh { constructor(_ignored: unknown) {} } return String(Object.isFrozen(new Fresh(class { value = 1; })));',
    'class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } return String(Object.isFrozen(new Fresh({__proto__: void 0} as {value?: string[]})));',
    'class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } const marker = void 0; return String(Object.isFrozen(new Fresh({__proto__: marker} as {value?: string[]})));',
    'class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } const marker = undefined; return String(Object.isFrozen(new Fresh({__proto__: marker} as {value?: string[]})));',
  ])('keeps nearby fresh constructor arguments: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "class Fresh { constructor(_ignored: unknown) {} } return String(Object.isFrozen(new Fresh(class { static value = (items[0] = 'changed'); })));",
    "class Fresh { constructor(_ignored: unknown) {} } return String(Object.isFrozen(new Fresh(class { [(items[0] = 'changed')]() {} })));",
    "class Fresh { constructor(_ignored: unknown) {} } return String(Object.isFrozen(new Fresh(class { static { items[0] = 'changed'; } })));",
    "class Fresh { constructor(_ignored: unknown) {} } return String(Object.isFrozen(new Fresh(new (class { constructor() { items[0] = 'changed'; } })())));",
    "class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } function change() { items[0] = 'changed'; } try { return String(Object.isFrozen(new Fresh({__proto__: void change()} as {value?: string[]}))); } catch { return 'threw'; }",
    "class Fresh { constructor({value = []}: {value?: string[]}) { return value; } } function change() { items[0] = 'changed'; } try { const marker = void change(); return String(Object.isFrozen(new Fresh({__proto__: marker} as {value?: string[]}))); } catch { return 'threw'; }",
  ])('refuses constructor arguments whose evaluation writes to an input: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });
});

/** A dynamic site whose shared helper reads metadata of a constructed result. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/metadata-evaluation.ts': `export function label(items: string[]): string { ${body} }\n`,
    'components/metadata-evaluation.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/metadata-evaluation';",
      'export default function MetadataEvaluation({ projectId, first }: { projectId: string; first: string[] }) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
