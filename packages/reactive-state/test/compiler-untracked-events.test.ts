import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import { untrackedIn } from '../src/compiler/reach.ts';
import { parseModule } from '../src/compiler/typescript.ts';
import type { RouteRegistration } from '../src/routing.ts';
import {
  application,
  type Application,
  compiledApp,
  output,
  removed,
} from './fixtures/application.ts';

const LAYOUT = 'app/boards/layout.tsx';

/** A layout that renders its helper's result alongside the route's reactive root. */
function layoutOf(code: string): string {
  return [
    "import type { ReactNode } from 'react';",
    code,
    'export default function Layout({ children }: { children: ReactNode }) {',
    '  return <section data-stamp={shown()}>{children}</section>;',
    '}',
  ].join('\n');
}

describe('event timestamps in shared route admission', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps) await removed(app);
  });

  /** The board's route admission after changing the source that renders around it. */
  async function boardWith(
    files: Readonly<Record<string, string>>,
  ): Promise<RouteRegistration | undefined> {
    const app = await application(files);
    apps.push(app);
    const compiled = compiledApp(app, api);

    expect(compiled.refusals).toStrictEqual([]);

    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      readonly routes: readonly RouteRegistration[];
    };
    return manifest.routes.find((route) => route.route === '/boards/[projectId]');
  }

  it.each([
    "const shown = () => String(new Event('banner').timeStamp);",
    "const shown = () => String(new Event('banner')['timeStamp']);",
    "function shown() { const { timeStamp: stamp } = new Event('banner'); return String(stamp); }",
    "const event = new Event('banner'); const alias = event; const shown = () => String(alias.timeStamp);",
  ])('shares no layout reading a source-made event timestamp: %s', async (code) => {
    await expect(boardWith({ [LAYOUT]: layoutOf(code) })).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `Event.timeStamp`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no layout whose reached helper reads an event timestamp', async () => {
    await expect(
      boardWith({
        [LAYOUT]: layoutOf("import { shown } from '@/event-banner';"),
        'event-banner.ts':
          "export function shown() { const event = new Event('banner'); return String(event.timeStamp); }",
      }),
    ).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `Event.timeStamp`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no layout rendering an ordinary client component with an event timestamp', async () => {
    const layout = [
      "import type { ReactNode } from 'react';",
      "import Banner from '@/event-banner';",
      'export default function Layout({ children }: { children: ReactNode }) {',
      '  return <section><Banner />{children}</section>;',
      '}',
    ].join('\n');
    const banner = [
      "'use client';",
      'export default function Banner() {',
      "  return <span>{new Event('banner').timeStamp}</span>;",
      '}',
    ].join('\n');

    await expect(
      boardWith({ [LAYOUT]: layout, 'event-banner.tsx': banner }),
    ).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `Event.timeStamp`, an input nothing tracks',
      shared: false,
    });
  });

  it.each([
    "const shown = () => { new Event('banner'); return 'banner'; };",
    "const shown = () => new Event('banner').type;",
    'const shown = () => String({ timeStamp: 0 }.timeStamp);',
    'class Event { timeStamp = 0; } const shown = () => String(new Event().timeStamp);',
  ])('shares event construction, deterministic members and application data: %s', async (code) => {
    await expect(boardWith({ [LAYOUT]: layoutOf(code) })).resolves.toMatchObject({ shared: true });
  });

  it.each([
    "new Event('x').timeStamp;",
    "new Event('x')['timeStamp'];",
    "const { timeStamp: stamp } = new Event('x');",
    "const event = new Event('x'); const alias = event; alias.timeStamp;",
    "(new Event('x') as Event).timeStamp;",
  ])('recognizes only the timestamp read from a source-made event: %s', (code) => {
    using parsed = parseModule(api, 'event-clock.ts', code);

    expect(untrackedIn([parsed.sourceFile])).toBe('Event.timeStamp');
  });

  it.each([
    "new Event('x');",
    "new Event('x').type;",
    'const event = { timeStamp: 0 }; const { timeStamp } = event;',
    'class Event { timeStamp = 0; } new Event().timeStamp;',
    'function read(Event: new () => { timeStamp: number }) { return new Event().timeStamp; }',
    'type Data = { timeStamp: number }; function read(data: Data) { return data.timeStamp; }',
    "new File([], 'x', { ...{}, lastModified: 0 }).lastModified;",
  ])(
    'keeps deterministic fields and explicitly dated Files outside the event check: %s',
    (code) => {
      using parsed = parseModule(api, 'event-data.ts', code);

      expect(untrackedIn([parsed.sourceFile])).toBeUndefined();
    },
  );
});
