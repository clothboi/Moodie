import type { BoardItem, BoardStateV1 } from './types';

const STORAGE_KEY = 'moodboard-grid.board';
const CURRENT_VERSION = 1;

function isBoardItem(value: unknown): value is BoardItem {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Record<string, unknown>;

  return (
    typeof item.id === 'string' &&
    typeof item.src === 'string' &&
    typeof item.naturalWidth === 'number' &&
    typeof item.naturalHeight === 'number' &&
    typeof item.colStart === 'number' &&
    typeof item.rowStart === 'number' &&
    (item.colSpan === 1 || item.colSpan === 2) &&
    typeof item.rowSpan === 'number' &&
    typeof item.zIndex === 'number'
  );
}

export function loadBoardState(): BoardStateV1 {
  if (typeof window === 'undefined') {
    return { version: CURRENT_VERSION, items: [] };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return { version: CURRENT_VERSION, items: [] };
    }

    const parsed = JSON.parse(raw) as Partial<BoardStateV1>;

    if (parsed.version !== CURRENT_VERSION || !Array.isArray(parsed.items)) {
      return { version: CURRENT_VERSION, items: [] };
    }

    return {
      version: CURRENT_VERSION,
      items: parsed.items.filter(isBoardItem),
    };
  } catch {
    return { version: CURRENT_VERSION, items: [] };
  }
}

export function saveBoardState(items: BoardItem[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  const payload: BoardStateV1 = {
    version: CURRENT_VERSION,
    items,
  };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore persistence failures so the editor remains usable.
  }
}
