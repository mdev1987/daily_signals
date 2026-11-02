import { mkdir, rename } from "node:fs/promises";
import type { Signal } from "./parser";

const STATE_FILE = "./data/state.json";
const TEMP_FILE = "./data/state.tmp.json";

interface State {
  initializedTimeframes: string[];
  signals: Record<string, string>;
}

const emptyState: State = {
  initializedTimeframes: [],
  signals: {},
};

export async function loadState(): Promise<State> {
  try {
    const file = Bun.file(STATE_FILE);

    if (!(await file.exists())) {
      return structuredClone(emptyState);
    }

    return await file.json();
  } catch (error) {
    throw new Error(`Could not load state file: ${String(error)}`);
  }
}

export async function saveState(state: State): Promise<void> {
  await mkdir("./data", { recursive: true });

  await Bun.write(TEMP_FILE, JSON.stringify(state, null, 2));

  await rename(TEMP_FILE, STATE_FILE);
}

export function updateState(state: State, signals: Signal[]): Signal[] {
  const timeframe = signals[0]?.timeframe;

  if (!timeframe) return [];

  // اولین دریافت هر تایم‌فریم فقط baseline می‌سازد.
  if (!state.initializedTimeframes.includes(timeframe)) {
    for (const item of signals) {
      state.signals[`${timeframe}:${item.symbol}`] = item.signal;
    }

    state.initializedTimeframes.push(timeframe);
    return [];
  }

  const changes: Signal[] = [];

  for (const item of signals) {
    const key = `${timeframe}:${item.symbol}`;
    const previous = state.signals[key];

    if (previous !== item.signal) {
      changes.push(item);
      state.signals[key] = item.signal;
    }
  }

  return changes;
}
