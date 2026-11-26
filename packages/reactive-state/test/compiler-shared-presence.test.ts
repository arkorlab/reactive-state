import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A shared buffer's browser availability depends on cross-origin isolation. */
describe('shared module global presence probes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'typeof SharedArrayBuffer',
    'typeof globalThis.SharedArrayBuffer',
    'typeof globalThis["SharedArrayBuffer"]',
    '"SharedArrayBuffer" in globalThis',
  ])('refuses environment-dependent shared buffer availability: %s', async (expression) => {
    const app = await fixture(
      `export function helper(text:string){return text+String(${expression});}`,
    );
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('where it runs'),
    ]);
  });

  it.each([
    'typeof document',
    '"document" in globalThis',
    'globalThis.hasOwnProperty("SharedArrayBuffer")',
  ])('continues refusing platform presence probes: %s', async (expression) => {
    const app = await fixture(
      `export function helper(text:string){return text+String(${expression});}`,
    );
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('where it runs'),
    ]);
  });

  it.each([
    'export function helper(text:string){return text+typeof Date;}',
    'export function helper(text:string){return text+typeof Map;}',
    'export function helper(text:string){return text+String("Date" in globalThis);}',
    'export function helper(text:string){return text+String("Map" in globalThis);}',
    'export function helper(text:string){const own={Date:text};return text+String(own.hasOwnProperty("Date"));}',
    'export function helper(text:string){return text+typeof Proxy.revocable;}',
    'export function helper(text:string){const SharedArrayBuffer=text;return text+typeof SharedArrayBuffer;}',
    'export function helper(text:string){const own={SharedArrayBuffer:text};return text+String("SharedArrayBuffer" in own);}',
  ])('keeps stable built-ins and lexical or ordinary own properties: %s', async (domain) => {
    const app = await fixture(domain);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** Shared helpers recompute a site's text on the authority and in the browser. */
async function fixture(domain: string): Promise<Application> {
  return application({
    'domain/presence.ts': domain,
    'components/presence.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import {helper} from '@/domain/presence';",
      'export default function Presence({projectId,first}:{projectId:string;first:string}){',
      'const [text,setText]=useReactiveState<string>(first);',
      'return<section><button onClick={()=>setText("next")}>next</button><TodoCommands projectId={projectId} id={helper(text)}/></section>;}',
    ].join('\n'),
  });
}
