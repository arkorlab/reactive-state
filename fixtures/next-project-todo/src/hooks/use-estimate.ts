import { useReactiveState } from 'framework/react';
import type { FieldRef } from '@arkorlab/reactive-state/program';
import { addEstimate } from '@/domain/estimate';

// No authentication or transport declarations here: the caller's scope is retained.
export function useEstimate(ref: FieldRef<number>, step: number) {
  const [estimate, setEstimate] = useReactiveState(ref);
  const increase = () => {
    setEstimate(current => addEstimate(current, step));
  };
  return [estimate, increase] as const;
}
