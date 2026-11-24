import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Pointer capture is an event name itself, independently of React's capture-phase suffix. */
describe('pointer capture writing handlers', () => {
  const { apps, compile } = compilerApplications();

  const events = ['onGotPointerCapture', 'onLostPointerCapture'];
  const writers = [
    { handler: 'setSelected', kind: 'setter' },
    { handler: '() => setSelected(true)', kind: 'inline handler' },
    { handler: 'change', kind: 'constant writer' },
  ];

  it.each(events.flatMap((event) => writers.map((writer) => ({ ...writer, event }))))(
    'refuses a component’s $event $kind',
    async ({ event, handler }) => {
      const app = await fixture('Widget', event, handler);
      apps.push(app);

      expect(refusalOf(compile(app)).reason).toContain('handler of an event');
    },
  );

  it.each(
    events.flatMap((event) => {
      return [
        { event, tag: 'button' },
        { event: `${event}Capture`, tag: 'Widget' },
      ];
    }),
  )('keeps the refusal of $tag $event', async ({ event, tag }) => {
    const app = await fixture(tag, event, 'change');
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('handler of an event');
  });

  it.each([
    { event: 'onClickCapture', handler: '() => setSelected(true)', tag: 'button' },
    { event: 'onClickCapture', handler: 'change', tag: 'button' },
    { event: 'onChangeCapture', handler: 'setSelected', tag: 'Widget' },
    { event: 'onCheckedChange', handler: 'setSelected', tag: 'Widget' },
    { event: 'onOwnCapture', handler: 'change', tag: 'Widget' },
  ])('keeps a person’s $tag $event handler', async ({ event, handler, tag }) => {
    const app = await fixture(tag, event, handler);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each(['button', 'Widget'])('keeps the refusal of %s onLoadCapture', async (tag) => {
    const app = await fixture(tag, 'onLoadCapture', 'change');
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('handler of an event');
  });
});

/** Imported UI components receive the same writer as DOM controls, bound to one database field. */
async function fixture(tag: string, event: string, handler: string): Promise<Application> {
  return application({
    'components/pointer-capture.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import { requireUser } from '@/auth';",
      "import { db } from '@/db';",
      "import { assertCanEditTodo } from '@/permissions';",
      "import { Checkbox as Widget } from '@/ui';",
      'export default async function PointerCapture({projectId, id}: {projectId: string; id: string}) {',
      '  const user = await requireUser();',
      '  await assertCanEditTodo(user, projectId, id);',
      '  const ref = db.todos.ref(id);',
      '  const [selected, setSelected] = useReactiveState(ref.completed);',
      '  const change = () => { setSelected(true); };',
      `  return <${tag} checked=`,
      '    {selected}',
      `    ${event}={${handler}} />;`,
      '}',
    ].join('\n'),
  });
}
