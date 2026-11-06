// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ClientPart, FieldReceipt, Result } from '../src/program.ts';
import { type Live, LiveContext, stateOf, useReactiveState } from '../src/react/state.ts';
import { PageStore, type Send } from '../src/runtime/store.ts';
import { deferred, frameAt } from './support/page.ts';

/** The field the suite writes, and the session that writes it. */
const ESTIMATE = 'todos:t1:estimate';
const SESSION = 'session:alice';

const PART: ClientPart<ReactNode> = {
  instance: 'estimate',
  props: {},
  sites: {},
  slots: {},
  states: { estimate: { binding: 'binding:estimate', field: ESTIMATE, set: 'u_set_estimate' } },
};

/** An estimate as a compiled Client Component shows it, written from what is typed into a field. */
function Estimate(): ReactNode {
  const [estimate, setEstimate] = useReactiveState(stateOf<number>(PART, 'estimate'));
  return (
    <>
      <output data-testid="estimate">{estimate.toLocaleString('en')}</output>
      <input
        aria-label="estimate"
        type="number"
        onChange={(event) => {
          setEstimate(Number(event.currentTarget.value));
        }}
      />
    </>
  );
}

/**
 * The authority writes a number it is sent as JSON carries it, `-0` as `0`: what the page shows of
 * a value its setter writes, until a frame confirms it, is what the frame will hold.
 */
describe('a persistent setter written `-0`', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows and sends it as `0`, as the authority writes it', () => {
    const answer = deferred<Result<FieldReceipt>>();
    const send = vi.fn<Send>(async () => answer.promise);
    const store = new PageStore();
    onTestFinished(() => {
      store.dispose();
    });
    const live: Live = {
      frame: frameAt(1, { [ESTIMATE]: 3 }),
      send,
      session: SESSION,
      sites: null,
      store,
    };
    render(
      <LiveContext value={live}>
        <Estimate />
      </LiveContext>,
    );

    fireEvent.change(screen.getByRole('spinbutton', { name: 'estimate' }), {
      target: { value: '-0' },
    });

    expect(screen.getByTestId('estimate').textContent).toBe('0');
    expect(send.mock.calls.map(([operation]) => operation.value)).toStrictEqual([0]);
  });
});
