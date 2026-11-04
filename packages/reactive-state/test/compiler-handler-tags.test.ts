import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** JSX component identifiers keep their handler semantics beyond ASCII capital letters. */
describe('component handler tag names', () => {
  const { apps, compile } = compilerApplications();

  const handlers = [
    { handler: 'setSelected', kind: 'direct setter' },
    { handler: '() => setSelected(true)', kind: 'inline handler' },
    { handler: 'change', kind: 'constant writer' },
  ];

  it.each(
    ['_Widget', '$Widget', 'ÉWidget'].flatMap((tag) =>
      handlers.map((handler) => ({ ...handler, tag })),
    ),
  )('takes a $kind on component alias $tag', async ({ handler, tag }) => {
    const app = await fixture(tag, 'onCheckedChange', handler);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each(handlers)('keeps an ASCII component’s $kind', async ({ handler }) => {
    const app = await fixture('Widget', 'onCheckedChange', handler);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    { event: 'onChange', tag: 'input' },
    { event: 'onClick', tag: 'custom-widget' },
  ])('keeps a person’s $event on $tag', async ({ event, tag }) => {
    const app = await fixture(tag, event, '() => setSelected(true)');
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    { event: 'onChange', handler: 'setSelected', tag: 'input' },
    { event: 'onCheckedChange', handler: 'change', tag: 'widget' },
    { event: 'onCheckedChange', handler: 'change', tag: 'custom-widget' },
    { event: 'onLoad', handler: 'change', tag: '_Widget' },
    { event: 'ref', handler: 'change', tag: '$Widget' },
  ])(
    'refuses a writer on $tag $event outside a person’s action',
    async ({ event, handler, tag }) => {
      const app = await fixture(tag, event, handler);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('handler of an event');
    },
  );
});

/** Each alias is an ordinary imported UI component given a database-bound state's writer. */
async function fixture(tag: string, event: string, handler: string): Promise<Application> {
  const imported =
    tag === 'input' || tag === 'widget' || tag.includes('-')
      ? ''
      : `import { Checkbox as ${tag} } from '@/ui';`;
  return application({
    'components/handler-tags.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import { requireUser } from '@/auth';",
      "import { db } from '@/db';",
      "import { assertCanEditTodo } from '@/permissions';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      imported,
      'export default async function HandlerTags({ projectId, id }: {projectId: string; id: string}) {',
      '  const user = await requireUser();',
      '  await assertCanEditTodo(user, projectId, id);',
      '  const ref = db.todos.ref(id);',
      '  const [selected, setSelected] = useReactiveState(ref.completed);',
      '  const change = () => { setSelected(true); };',
      `  return <section><${tag}`,
      '    checked={selected}',
      `    ${event}={${handler}}`,
      '  /><TodoCommands projectId={projectId} id={id} /></section>;',
      '}',
    ].join('\n'),
  });
}
