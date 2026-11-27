import {
  type ComponentProgram,
  type Json,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../../../src/program.ts';

/**
 * The test application's build, how its programs are written of it, and how often an authority of
 * it reads the log of its tables: what serves Node and workerd alike.
 */

export const BUILD = 'b_test';

/** Long enough that only `poke()`, and an operation's own read, read the log in a test. */
export const IDLE_POLL_MS = 60_000;

/** The states of a component without any: none it writes, and no update. */
const STATELESS: Pick<ComponentProgram, 'updaters' | 'writable'> = { updaters: {}, writable: [] };

/** A program of the test build, with no state unless given. */
export function program(
  component: string,
  evaluate: (props: Readonly<Record<string, Json>>, $: RenderScope) => unknown,
  states?: Pick<ComponentProgram, 'updaters' | 'writable'>,
): ComponentProgram {
  return {
    buildId: BUILD,
    component,
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    ...(states ?? STATELESS),
  };
}

/** A prop a component is rendered with, as the text it is. */
export function textOf(props: Readonly<Record<string, Json>>, name: string): string {
  const value = props[name];
  if (typeof value !== 'string') {
    throw new TypeError(`\`${name}\` is text.`);
  }
  return value;
}
