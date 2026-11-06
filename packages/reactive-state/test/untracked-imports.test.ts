import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import { PROTOCOL_VERSION } from '../src/program.ts';
import { database, table, text } from '../src/server/index.ts';

// The application imports these before the first authority is constructed.
const capturedNow = Date.now;
const capturedRandom = Math.random;
const capturedFetch = fetch;
const BUILD = 'b_captured';
const db = database({ notes: table({ body: text({ maxLength: 200 }) }) });
const CASES = [
  { id: 'captured-clock', read: () => capturedNow(), expected: 'session' },
  { id: 'current-clock', read: () => Date.now(), expected: 'session' },
  // eslint-disable-next-line sonarjs/pseudo-random -- exercises tracking, not a security value
  { id: 'captured-random', read: () => capturedRandom(), expected: 'session' },
  // eslint-disable-next-line sonarjs/pseudo-random -- exercises tracking, not a security value
  { id: 'current-random', read: () => Math.random(), expected: 'session' },
  {
    id: 'captured-fetch',
    read: async () => await (await capturedFetch('data:text/plain,library')).text(),
    expected: 'session',
  },
  {
    id: 'current-fetch',
    read: async () => await (await fetch('data:text/plain,library')).text(),
    expected: 'session',
  },
  { id: 'pure-data', read: () => 42, expected: 'shared' },
] as const;

describe('untracked reads captured before authority construction', () => {
  it.each(CASES)('$id', async ({ read, expected }) => {
    const engine = new Engine({
      buildId: BUILD,
      database: db,
      programs: [
        {
          buildId: BUILD,
          component: 'components/stamp',
          evaluate: async (_props, $) => $.h('p', null, String(await read())),
          protocolVersion: PROTOCOL_VERSION,
          updaters: {},
          writable: [],
        },
      ],
      routes: [
        {
          blocking: true,
          middleware: [],
          page: 'stamp/page.tsx',
          params: [],
          props: {},
          root: 'components/stamp',
          route: '/stamp',
          shared: true,
        },
      ],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const answer = await engine.renderShared(null, { build: BUILD, props: {}, route: '/stamp' });

    expect(answer.kind).toBe(expected);
  });
});
