export interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
}

let stack: UndoEntry[] = [];
let listener: ((depth: number) => void) | null = null;

export function pushUndo(entry: UndoEntry): void {
  stack.push(entry);
  if (listener) listener(stack.length);
}

export function popUndo(): UndoEntry | undefined {
  const entry = stack.pop();
  if (entry && listener) listener(stack.length);
  return entry;
}

export function clearUndo(): void {
  if (stack.length === 0) return;
  stack = [];
  if (listener) listener(0);
}

export function getUndoDepth(): number {
  return stack.length;
}

export function setUndoListener(fn: ((depth: number) => void) | null): void {
  listener = fn;
  if (fn) fn(stack.length);
}
