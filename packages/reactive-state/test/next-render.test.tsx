import {
  type ComponentType,
  isValidElement,
  type ReactElement,
  type ReactNode,
  Suspense,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { type Elements, renderTree } from '../src/next/render.ts';
import type { ClientPart, Json, Rendered, RenderedElement } from '../src/program.ts';
import { type ClientPartProps, slotOf } from '../src/react/state.ts';
import { BUILD, rowOf } from './support/page.ts';

/**
 * The generic renderer `renderRoot` turns the authority's tree into React elements with: the
 * elements a compile's import map names, keys where the authority kept them, actions bound to the
 * arguments a component bound them to, client parts with their slots.
 */

function Link({
  children,
  href,
}: {
  readonly href: string;
  readonly children?: ReactNode;
}): ReactNode {
  return <a href={href}>{children}</a>;
}

function Row({ part }: ClientPartProps): ReactNode {
  const { id } = part.props as { readonly id: string };
  return <li>{`row ${id}`}</li>;
}

function Editor({ part }: ClientPartProps): ReactNode {
  return <section>{slotOf(part, 's0')}</section>;
}

/** A Client Component the authority renders as a module element, handed an action as a prop. */
function Remover({ remove }: { readonly remove: (id: string) => unknown }): ReactNode {
  return (
    <button
      type="button"
      onClick={() => {
        remove('t1');
      }}
    >
      remove
    </button>
  );
}

const deleteTodo = vi.fn<(...args: unknown[]) => unknown>();
const completeProject = vi.fn<(...args: unknown[]) => unknown>();

const ELEMENTS: Elements = {
  actions: {
    'actions/todos#deleteTodo': deleteTodo,
    'actions/todos#completeProject': completeProject,
  },
  build: BUILD,
  clients: { 'components/todo-editor': Editor, 'components/todo-row': Row },
  modules: {
    '@/ui/remover#Remover': Remover,
    'next/link#default': Link,
    'react#Suspense': Suspense,
  },
};

function element(
  type: string,
  props: RenderedElement['props'],
  children: readonly Rendered[] = [],
): RenderedElement {
  return { children, key: null, kind: 'element', props, type };
}

/** The props React was handed for `node`. */
function propsOf(node: ReactNode): Readonly<Record<string, unknown>> {
  if (!isValidElement(node)) {
    throw new Error('Not an element.');
  }
  return node.props as Readonly<Record<string, unknown>>;
}

/** The action `name` of `actions/todos` bound to `bound`, as the authority sends it. */
function actionOf(name: string, bound: readonly string[]): Json {
  return { bound, kind: 'action', module: 'actions/todos', name };
}

const removing = (bound: readonly string[] = []): Json => actionOf('deleteTodo', bound);

const completing = (bound: readonly string[] = []): Json => actionOf('completeProject', bound);

/** The prop `commands` React was handed of a module element given `commands`. */
function commandsOf(commands: Json): unknown {
  const node = renderTree(
    {
      children: [],
      key: null,
      kind: 'module',
      module: '@/ui/remover',
      name: 'Remover',
      nested: ['commands'],
      props: { commands },
    },
    ELEMENTS,
  );
  return propsOf(node)['commands'];
}

describe('the generic renderer', () => {
  it('renders elements, module exports, fragments and text, and nothing for null and booleans', () => {
    const tree = element('main', { 'data-testid': 'project', id: 'project' }, [
      element('h2', {}, ['開発']),
      {
        children: [
          {
            children: ['すべて'],
            key: null,
            kind: 'module',
            module: 'next/link',
            name: 'default',
            props: { href: '/projects/p1?filter=all' },
          },
        ],
        key: null,
        kind: 'element',
        props: { 'aria-label': '絞り込み' },
        type: 'nav',
      },
      { children: ['未完了 ', 2, ' 件'], key: 'totals', kind: 'fragment' },
      null,
      false,
      true,
    ]);

    expect(renderToStaticMarkup(renderTree(tree, ELEMENTS))).toBe(
      '<main data-testid="project" id="project"><h2>開発</h2><nav aria-label="絞り込み"><a href="/projects/p1?filter=all">すべて</a></nav>未完了 2 件</main>',
    );
  });

  it('keeps a list a list, each element under the key the authority kept', () => {
    const tree = element('ul', {}, [[rowOf('t2'), rowOf('t1')]]);

    const list = renderTree(tree, ELEMENTS);
    // One child, the list itself: React keeps it as the element's children, keyed row by row.
    const rows = propsOf(list)['children'] as readonly ReactElement[];

    expect(rows.map((row) => row.key)).toStrictEqual(['t2', 't1']);
    expect(renderToStaticMarkup(list)).toBe('<ul><li>row t2</li><li>row t1</li></ul>');
  });

  it('binds an action’s Server Function to the arguments the component bound it to', () => {
    deleteTodo.mockClear();
    const form = renderTree(
      element('form', {
        action: {
          bound: ['p1', 't1'],
          kind: 'action',
          module: 'actions/todos',
          name: 'deleteTodo',
        },
      }),
      ELEMENTS,
    );
    const action = propsOf(form)['action'] as (form: string) => unknown;

    action('form data');

    expect(deleteTodo).toHaveBeenCalledExactlyOnceWith('p1', 't1', 'form data');
  });

  it('hands a module element an action prop as its Server Function, bound', () => {
    deleteTodo.mockClear();
    const remover = renderTree(
      {
        children: [],
        key: null,
        kind: 'module',
        module: '@/ui/remover',
        name: 'Remover',
        props: {
          remove: { bound: ['p1'], kind: 'action', module: 'actions/todos', name: 'deleteTodo' },
        },
      },
      ELEMENTS,
    );
    const remove = propsOf(remover)['remove'] as (id: string) => unknown;

    remove('t1');

    expect(deleteTodo).toHaveBeenCalledExactlyOnceWith('p1', 't1');
  });

  describe('an action nested in a prop', () => {
    it('is handed as its Server Function, bound, inside an object', () => {
      deleteTodo.mockClear();
      const commands = commandsOf({ label: 'x', remove: removing(['p1']) }) as {
        readonly label: string;
        readonly remove: (id: string) => unknown;
      };

      commands.remove('t1');

      expect(commands.label).toBe('x');
      expect(deleteTodo).toHaveBeenCalledExactlyOnceWith('p1', 't1');
    });

    it('is handed as its Server Function inside an array, and an array of an object', () => {
      deleteTodo.mockClear();
      const list = commandsOf([removing(), 3, { again: removing(['p1', 't1']) }]) as readonly [
        unknown,
        number,
        { readonly again: () => unknown },
      ];

      expect(list[0]).toBe(deleteTodo);
      expect(list[1]).toBe(3);

      list[2].again();

      expect(deleteTodo).toHaveBeenCalledExactlyOnceWith('p1', 't1');
    });

    it('is handed as its Server Function two levels down', () => {
      completeProject.mockClear();
      const deep = commandsOf({ rows: [{ cells: { go: [completing(['p2'])] } }] }) as {
        readonly rows: readonly { readonly cells: { readonly go: readonly (() => unknown)[] } }[];
      };

      deep.rows[0]?.cells.go[0]?.();

      expect(completeProject).toHaveBeenCalledExactlyOnceWith('p2');
    });

    it('is handed as its own Server Function for each of several, the same one at two places too', () => {
      deleteTodo.mockClear();
      completeProject.mockClear();
      const commands = commandsOf({
        a: removing(['p1']),
        b: completing(),
        c: removing(['p1']),
        d: removing(),
      }) as Record<string, () => unknown>;

      expect(commands['b']).toBe(completeProject);
      expect(commands['d']).toBe(deleteTodo);

      commands['a']?.();
      commands['c']?.();

      expect(deleteTodo).toHaveBeenCalledTimes(2);
      expect(deleteTodo).toHaveBeenNthCalledWith(1, 'p1');
      expect(deleteTodo).toHaveBeenNthCalledWith(2, 'p1');
      expect(completeProject).not.toHaveBeenCalled();
    });

    it('keeps the data around it, a key named `__proto__` among it, as its own', () => {
      const data = JSON.parse('{"__proto__": {"x": 1}, "n": [1, "a", null]}') as Json;

      const kept = commandsOf(data) as Record<string, unknown>;

      expect(Object.keys(kept)).toStrictEqual(['__proto__', 'n']);
      expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
      expect(kept['n']).toStrictEqual([1, 'a', null]);
    });
  });

  it('hands a prop no action is nested in on as it is, a plain one beside one that is walked', () => {
    const data = JSON.parse('{"rows": [{"id": "r1", "tags": ["a"]}]}') as Json;
    const node = renderTree(
      {
        children: [],
        key: null,
        kind: 'module',
        module: '@/ui/remover',
        name: 'Remover',
        nested: ['commands'],
        props: { commands: { go: removing() }, data },
      },
      ELEMENTS,
    );
    const props = propsOf(node);

    expect(props['data']).toBe(data);
    expect((props['commands'] as { readonly go: unknown }).go).toBe(deleteTodo);
  });

  it('keeps an array of a nested prop that holds no action as it is', () => {
    const rows: Json = [{ id: 'r1' }];
    const node = renderTree(
      {
        children: [],
        key: null,
        kind: 'module',
        module: '@/ui/remover',
        name: 'Remover',
        nested: ['commands'],
        props: { commands: { go: removing(), rows } },
      },
      ELEMENTS,
    );

    expect((propsOf(node)['commands'] as { readonly rows: unknown }).rows).toBe(rows);
  });

  it('hands an action bound to nothing as its Server Function', () => {
    const button = renderTree(
      element('button', {
        formAction: { bound: [], kind: 'action', module: 'actions/todos', name: 'deleteTodo' },
      }),
      ELEMENTS,
    );

    expect(propsOf(button)['formAction']).toBe(deleteTodo);
  });

  it('renders a client part with its slots rendered', () => {
    const editor = renderTree(
      {
        component: 'components/todo-editor',
        key: 't1',
        kind: 'client',
        part: {
          props: { id: 't1', projectId: 'p1' },
          slots: { s0: element('p', {}, ['commands']) },
          states: { title: { binding: 'b', field: 'todos:t1:title', set: 'u_set' } },
        },
      },
      ELEMENTS,
    );
    const part = propsOf(editor)['part'] as ClientPart<ReactNode>;

    expect(isValidElement(editor) && editor.key).toBe('t1');
    expect(Object.keys(part)).toStrictEqual(['props', 'slots', 'states']);
    expect(part.states).toStrictEqual({
      title: { binding: 'b', field: 'todos:t1:title', set: 'u_set' },
    });
    expect(isValidElement(part.slots['s0'])).toBe(true);
    expect(renderToStaticMarkup(editor)).toBe('<section><p>commands</p></section>');
  });

  it('hands a part with dynamic sites its instance, and each site’s content rendered beside its inputs', () => {
    const workspace = renderTree(
      {
        component: 'components/todo-editor',
        key: null,
        kind: 'client',
        part: {
          instance: 'instance:workspace',
          props: {},
          sites: {
            d0: { content: [rowOf('t2'), rowOf('t1')], inputs: { filter: 'active' } },
            d1: { content: element('p', {}, ['t1']), inputs: { selectedId: 't1' } },
          },
          slots: { s0: element('p', {}, ['commands']) },
          states: { filter: { value: 'active' } },
        },
      },
      ELEMENTS,
    );
    const part = propsOf(workspace)['part'] as ClientPart<ReactNode>;
    const { d0, d1 } = part.sites ?? {};

    expect(Object.keys(part)).toStrictEqual(['instance', 'props', 'sites', 'slots', 'states']);
    expect(part.instance).toBe('instance:workspace');
    expect(d0?.inputs).toStrictEqual({ filter: 'active' });
    expect(d1?.inputs).toStrictEqual({ selectedId: 't1' });
    expect(renderToStaticMarkup(d0?.content)).toBe('<li>row t2</li><li>row t1</li>');
    expect(isValidElement(d1?.content)).toBe(true);
    expect(renderToStaticMarkup(d1?.content)).toBe('<p>t1</p>');
  });

  it('hands a part each item of a list site rendered, beside its key and the item', () => {
    const panels = [
      { panelId: 'A', todoId: 't1' },
      { panelId: 'B', todoId: 't1' },
    ];
    const workspace = renderTree(
      {
        component: 'components/todo-editor',
        key: null,
        kind: 'client',
        part: {
          instance: 'instance:workspace',
          props: {},
          sites: {
            d1: {
              inputs: { panels },
              items: [
                { content: element('p', {}, ['A: t1']), item: panels[0] ?? null, key: 'A' },
                { content: element('p', {}, ['B: t1']), item: panels[1] ?? null, key: 'B' },
              ],
            },
          },
          slots: {},
          states: { panels: { value: panels } },
        },
      },
      ELEMENTS,
    );
    const part = propsOf(workspace)['part'] as ClientPart<ReactNode>;
    const items = part.sites?.['d1']?.items ?? [];

    expect(part.sites?.['d1']?.inputs).toStrictEqual({ panels });
    expect(items.map(({ item, key }) => ({ item, key }))).toStrictEqual([
      { item: { panelId: 'A', todoId: 't1' }, key: 'A' },
      { item: { panelId: 'B', todoId: 't1' }, key: 'B' },
    ]);
    expect(items.map(({ content }) => renderToStaticMarkup(content))).toStrictEqual([
      '<p>A: t1</p>',
      '<p>B: t1</p>',
    ]);
  });

  it('renders a prop that is a rendered element as one, and JSON props as they are', () => {
    const tree = {
      children: [element('p', {}, ['loaded'])],
      key: null,
      kind: 'module',
      module: 'react',
      name: 'Suspense',
      props: { fallback: element('p', {}, ['loading']) },
    } as const;
    const styled = renderTree(
      element('div', { children: 'ignored', key: 'ignored', style: { color: 'red' } }),
      ELEMENTS,
    );

    const suspense = renderTree(tree, ELEMENTS);

    expect(isValidElement(propsOf(suspense)['fallback'])).toBe(true);
    expect(renderToStaticMarkup(suspense)).toBe('<p>loaded</p>');
    expect(propsOf(styled)).toStrictEqual({ style: { color: 'red' } });
    expect(isValidElement(styled) && styled.key).toBeNull();
  });

  it('hands an element the props the authority rendered, a `__proto__` among them as its own', () => {
    // As JSON gives it: an own property, which an assignment would make the prototype instead.
    const props = JSON.parse('{"href":"/projects/p1","__proto__":{"admin":true}}') as Readonly<
      Record<string, string>
    >;
    const tree = {
      children: ['開発'],
      key: 'p1',
      kind: 'module',
      module: 'next/link',
      name: 'default',
      props,
    } as const;

    const link = propsOf(renderTree(tree, ELEMENTS));

    expect(Object.hasOwn(link, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(link)).toBe(Object.prototype);
    expect(link['admin']).toBeUndefined();
    expect(link).toMatchObject({ children: '開発', href: '/projects/p1' });
  });

  it.each([
    [
      'client component',
      {
        component: 'components/missing',
        key: null,
        kind: 'client',
        part: { props: {}, slots: {}, states: {} },
      },
    ],
    [
      'module',
      { children: [], key: null, kind: 'module', module: 'next/image', name: 'default', props: {} },
    ],
    [
      'action',
      element('form', {
        action: { bound: [], kind: 'action', module: 'actions/todos', name: 'moveTodo' },
      }),
    ],
  ] as const)('refuses a %s the compile’s elements do not name', (what, tree) => {
    expect(() => renderTree(tree, ELEMENTS)).toThrow(`no ${what} `);
  });

  it('refuses a node of a kind no host renders', () => {
    expect(() => renderTree({ kind: 'instance' } as unknown as Rendered, ELEMENTS)).toThrow(
      /kind instance/u,
    );
  });

  it('takes the components a compile’s import map names', () => {
    const clients: Readonly<Record<string, ComponentType<ClientPartProps>>> = ELEMENTS.clients;

    expect(Object.keys(clients)).toStrictEqual(['components/todo-editor', 'components/todo-row']);
  });
});
