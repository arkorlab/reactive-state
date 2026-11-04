export type TodoPanel = {
  readonly panelId: string;
  readonly todoId: string;
};

export type TodoChoice = {
  readonly id: string;
  readonly title: string;
};

// Application policy, not a framework-wide limit and not an authorization rule.
export const MAX_PANELS = 4;

// SSR and the browser start from the same deterministic value.
export function initialPanelsFor(selectedId: string): readonly TodoPanel[] {
  return selectedId === ''
    ? []
    : [{ panelId: `initial:${selectedId}`, todoId: selectedId }];
}

// Only the newly constructed array is modified; the current state is never mutated.
// Repeated todoId values are intentional. Repeated panelId values are not.
export function appendPanels(
  current: readonly TodoPanel[],
  candidates: readonly TodoPanel[],
): readonly TodoPanel[] {
  const next = [...current];
  const known = new Set(current.map(panel => panel.panelId));
  for (const candidate of candidates) {
    if (next.length >= MAX_PANELS) break;
    if (
      candidate.panelId === '' ||
      candidate.todoId === '' ||
      known.has(candidate.panelId)
    ) continue;
    known.add(candidate.panelId);
    next.push({ panelId: candidate.panelId, todoId: candidate.todoId });
  }
  return next.length === current.length ? current : next;
}

export function removePanel(
  current: readonly TodoPanel[],
  panelId: string,
): readonly TodoPanel[] {
  return current.some(panel => panel.panelId === panelId)
    ? current.filter(panel => panel.panelId !== panelId)
    : current;
}

export function movePanelBy(
  current: readonly TodoPanel[],
  panelId: string,
  direction: -1 | 1,
): readonly TodoPanel[] {
  const from = current.findIndex(panel => panel.panelId === panelId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= current.length) return current;
  const next = [...current];
  const moving = next.splice(from, 1)[0];
  if (moving === undefined) return current;
  next.splice(to, 0, moving);
  return next;
}

export function replacePanelTodo(
  current: readonly TodoPanel[],
  panelId: string,
  todoId: string,
): readonly TodoPanel[] {
  if (todoId === '') return current;
  const existing = current.find(panel => panel.panelId === panelId);
  if (existing === undefined || existing.todoId === todoId) return current;
  return current.map(panel =>
    panel.panelId === panelId ? { ...panel, todoId } : panel,
  );
}
