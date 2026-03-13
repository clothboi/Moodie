import type { BoardItem, GridSpec, ImageMeta, PlacementResult, Point } from './types';

interface Rect {
  colStart: number;
  rowStart: number;
  colSpan: number;
  rowSpan: number;
}

interface ReservedRegion {
  columnIndex: number;
  rowStart: number;
  rowSpan: number;
  reservedItemId: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function createItemId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getItemRect(item: Pick<BoardItem, 'colStart' | 'rowStart' | 'colSpan' | 'rowSpan'>): Rect {
  return {
    colStart: item.colStart,
    rowStart: item.rowStart,
    colSpan: item.colSpan,
    rowSpan: item.rowSpan,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  const aColEnd = a.colStart + a.colSpan;
  const bColEnd = b.colStart + b.colSpan;
  const aRowEnd = a.rowStart + a.rowSpan;
  const bRowEnd = b.rowStart + b.rowSpan;

  return a.colStart < bColEnd && aColEnd > b.colStart && a.rowStart < bRowEnd && aRowEnd > b.rowStart;
}

function touchesColumn(item: BoardItem, columnIndex: number): boolean {
  return item.colStart <= columnIndex && item.colStart + item.colSpan - 1 >= columnIndex;
}

function getRowEnd(item: Pick<BoardItem, 'rowStart' | 'rowSpan'>): number {
  return item.rowStart + item.rowSpan;
}

function itemMidpoint(item: Pick<BoardItem, 'rowStart' | 'rowSpan'>): number {
  return item.rowStart + item.rowSpan / 2;
}

function clampColStart(colStart: number, colSpan: number, gridSpec: GridSpec): number {
  return clamp(colStart, 0, gridSpec.maxColumns - colSpan);
}

function maxOccupiedRow(items: BoardItem[]): number {
  return items.reduce((maxRow, item) => Math.max(maxRow, getRowEnd(item)), 0);
}

function sortByVisualOrder(items: BoardItem[]): BoardItem[] {
  return [...items].sort((left, right) => {
    if (left.rowStart !== right.rowStart) {
      return left.rowStart - right.rowStart;
    }

    if (left.colStart !== right.colStart) {
      return left.colStart - right.colStart;
    }

    return left.zIndex - right.zIndex;
  });
}

function rectFits(
  rect: Rect,
  items: BoardItem[],
  gridSpec: GridSpec,
  ignoreId?: string,
): boolean {
  if (rect.colStart < 0 || rect.rowStart < 0 || rect.colStart + rect.colSpan > gridSpec.maxColumns) {
    return false;
  }

  return items.every((item) => item.id === ignoreId || !overlaps(rect, getItemRect(item)));
}

function findNearestOpenSlot(
  targetCol: number,
  targetRow: number,
  colSpan: number,
  rowSpan: number,
  items: BoardItem[],
  gridSpec: GridSpec,
  ignoreId?: string,
): { colStart: number; rowStart: number } {
  const candidates: Array<{ colStart: number; rowStart: number; score: number }> = [];
  const maxRow = Math.max(targetRow + 48, maxOccupiedRow(items) + rowSpan + 24, gridSpec.minRows);

  for (let rowStart = 0; rowStart <= maxRow; rowStart += 1) {
    for (let colStart = 0; colStart <= gridSpec.maxColumns - colSpan; colStart += 1) {
      const rect = { colStart, rowStart, colSpan, rowSpan };

      if (!rectFits(rect, items, gridSpec, ignoreId)) {
        continue;
      }

      const score = Math.abs(colStart - targetCol) + Math.abs(rowStart - targetRow);
      candidates.push({ colStart, rowStart, score });
    }
  }

  candidates.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }

    if (left.rowStart !== right.rowStart) {
      return left.rowStart - right.rowStart;
    }

    return left.colStart - right.colStart;
  });

  return candidates[0] ?? { colStart: 0, rowStart: maxRow + 1 };
}

function findFirstOpenSlot(
  colSpan: number,
  rowSpan: number,
  items: BoardItem[],
  gridSpec: GridSpec,
  ignoreId?: string,
): { colStart: number; rowStart: number } {
  const maxRow = Math.max(maxOccupiedRow(items) + rowSpan + 24, gridSpec.minRows);

  for (let rowStart = 0; rowStart <= maxRow; rowStart += 1) {
    for (let colStart = 0; colStart <= gridSpec.maxColumns - colSpan; colStart += 1) {
      if (rectFits({ colStart, rowStart, colSpan, rowSpan }, items, gridSpec, ignoreId)) {
        return { colStart, rowStart };
      }
    }
  }

  return { colStart: 0, rowStart: maxRow + 1 };
}

function findEarliestRowAtOrAfter(
  item: BoardItem,
  minRow: number,
  items: BoardItem[],
  gridSpec: GridSpec,
): number {
  let rowStart = Math.max(0, minRow);

  while (
    !rectFits(
      {
        colStart: item.colStart,
        rowStart,
        colSpan: item.colSpan,
        rowSpan: item.rowSpan,
      },
      items,
      gridSpec,
      item.id,
    )
  ) {
    rowStart += 1;
  }

  return rowStart;
}

function findLatestRowBefore(
  item: BoardItem,
  maxRowExclusive: number,
  items: BoardItem[],
  gridSpec: GridSpec,
): number | null {
  const start = Math.min(item.rowStart, maxRowExclusive - item.rowSpan);

  for (let rowStart = start; rowStart >= 0; rowStart -= 1) {
    if (
      rectFits(
        {
          colStart: item.colStart,
          rowStart,
          colSpan: item.colSpan,
          rowSpan: item.rowSpan,
        },
        items,
        gridSpec,
        item.id,
      )
    ) {
      return rowStart;
    }
  }

  return null;
}

function withItemReplaced(items: BoardItem[], nextItem: BoardItem): BoardItem[] {
  return items.map((item) => (item.id === nextItem.id ? nextItem : item));
}

function reflowColumnFrom(items: BoardItem[], anchor: BoardItem, gridSpec: GridSpec): BoardItem[] {
  const touching = sortByVisualOrder(items).filter(
    (item) => item.id !== anchor.id && touchesColumn(item, anchor.colStart),
  );
  const placed = items.filter((item) => item.id === anchor.id || !touchesColumn(item, anchor.colStart));

  placed.push(anchor);

  for (const item of touching) {
    if (!overlaps(getItemRect(item), getItemRect(anchor)) && rectFits(getItemRect(item), placed, gridSpec, item.id)) {
      placed.push(item);
      continue;
    }

    const nextRow = findEarliestRowAtOrAfter(item, getRowEnd(anchor), placed, gridSpec);
    placed.push({ ...item, rowStart: nextRow });
  }

  return sortByVisualOrder(placed);
}

export function compactColumn(columnIndex: number, items: BoardItem[], gridSpec: GridSpec): BoardItem[] {
  const movable = sortByVisualOrder(items).filter(
    (item) => item.colStart === columnIndex && item.colSpan === 1,
  );
  const locked = items.filter((item) => !(item.colStart === columnIndex && item.colSpan === 1));
  const nextItems = [...locked];

  for (const item of movable) {
    const nextRow = findEarliestRowAtOrAfter(item, 0, nextItems, gridSpec);
    nextItems.push({ ...item, rowStart: nextRow });
  }

  return sortByVisualOrder(nextItems);
}

export function resolveColumnConflicts(
  items: BoardItem[],
  reservedRegion: ReservedRegion,
  gridSpec: GridSpec,
): BoardItem[] {
  const reservedEnd = reservedRegion.rowStart + reservedRegion.rowSpan;
  const overlapping = items.filter(
    (item) =>
      item.id !== reservedRegion.reservedItemId &&
      touchesColumn(item, reservedRegion.columnIndex) &&
      item.rowStart < reservedEnd &&
      getRowEnd(item) > reservedRegion.rowStart,
  );

  if (overlapping.length === 0) {
    return items;
  }

  const stationary = items.filter((item) => !overlapping.some((candidate) => candidate.id === item.id));
  const anchorMidpoint = reservedRegion.rowStart + reservedRegion.rowSpan / 2;
  const above = overlapping
    .filter((item) => itemMidpoint(item) < anchorMidpoint)
    .sort((left, right) => right.rowStart - left.rowStart);
  const below = overlapping
    .filter((item) => itemMidpoint(item) >= anchorMidpoint)
    .sort((left, right) => left.rowStart - right.rowStart);
  const overflow: BoardItem[] = [];
  const nextItems = [...stationary];

  for (const item of above) {
    const nextRow = findLatestRowBefore(item, reservedRegion.rowStart, nextItems, gridSpec);

    if (nextRow === null) {
      overflow.push(item);
      continue;
    }

    nextItems.push({ ...item, rowStart: nextRow });
  }

  for (const item of [...below, ...overflow]) {
    const nextRow = findEarliestRowAtOrAfter(item, reservedEnd, nextItems, gridSpec);
    nextItems.push({ ...item, rowStart: nextRow });
  }

  return sortByVisualOrder(nextItems);
}

export function computeRowSpan(
  image: Pick<ImageMeta, 'naturalWidth' | 'naturalHeight'>,
  colSpan: number,
  gridSpec: GridSpec,
): number {
  const renderedWidth = gridSpec.columnPx * colSpan;
  const renderedHeight = renderedWidth * (image.naturalHeight / image.naturalWidth);
  return Math.max(1, Math.round(renderedHeight / gridSpec.rowPx));
}

export function placeNewItem(
  imageMeta: ImageMeta,
  targetPoint: Point | null,
  items: BoardItem[],
  gridSpec: GridSpec,
): PlacementResult {
  const rowSpan = computeRowSpan(imageMeta, 1, gridSpec);
  const nextZIndex = items.reduce((maxZIndex, item) => Math.max(maxZIndex, item.zIndex), 0) + 1;
  const targetCol = targetPoint ? clampColStart(Math.round(targetPoint.x / gridSpec.columnPx), 1, gridSpec) : 0;
  const targetRow = targetPoint ? Math.max(0, Math.round(targetPoint.y / gridSpec.rowPx)) : 0;
  const slot = targetPoint
    ? findNearestOpenSlot(targetCol, targetRow, 1, rowSpan, items, gridSpec)
    : findFirstOpenSlot(1, rowSpan, items, gridSpec);

  const nextItem: BoardItem = {
    id: imageMeta.id ?? createItemId(),
    src: imageMeta.src,
    naturalWidth: imageMeta.naturalWidth,
    naturalHeight: imageMeta.naturalHeight,
    colStart: slot.colStart,
    rowStart: slot.rowStart,
    colSpan: 1,
    rowSpan,
    zIndex: nextZIndex,
  };

  return {
    items: sortByVisualOrder([...items, nextItem]),
    movedItemIds: [nextItem.id],
  };
}

export function moveItem(
  itemId: string,
  targetPoint: Point,
  items: BoardItem[],
  gridSpec: GridSpec,
): PlacementResult {
  const currentItem = items.find((item) => item.id === itemId);

  if (!currentItem) {
    return { items, movedItemIds: [] };
  }

  const targetCol = clampColStart(Math.round(targetPoint.x / gridSpec.columnPx), currentItem.colSpan, gridSpec);
  const targetRow = Math.max(0, Math.round(targetPoint.y / gridSpec.rowPx));
  const slot = findNearestOpenSlot(
    targetCol,
    targetRow,
    currentItem.colSpan,
    currentItem.rowSpan,
    items,
    gridSpec,
    itemId,
  );

  const nextItem: BoardItem = {
    ...currentItem,
    colStart: slot.colStart,
    rowStart: slot.rowStart,
    zIndex: items.reduce((maxZIndex, item) => Math.max(maxZIndex, item.zIndex), 0) + 1,
  };

  return {
    items: sortByVisualOrder(withItemReplaced(items, nextItem)),
    movedItemIds: [itemId],
  };
}

export function resizeItem(
  itemId: string,
  nextColSpan: 1 | 2,
  items: BoardItem[],
  gridSpec: GridSpec,
): PlacementResult {
  const currentItem = items.find((item) => item.id === itemId);

  if (!currentItem) {
    return { items, movedItemIds: [] };
  }

  if (currentItem.colSpan === nextColSpan) {
    return { items, movedItemIds: [] };
  }

  if (nextColSpan === 2 && currentItem.colStart >= gridSpec.maxColumns - 1) {
    return { items, movedItemIds: [] };
  }

  const resizedItem: BoardItem = {
    ...currentItem,
    colSpan: nextColSpan,
    rowSpan: computeRowSpan(currentItem, nextColSpan, gridSpec),
    zIndex: items.reduce((maxZIndex, item) => Math.max(maxZIndex, item.zIndex), 0) + 1,
  };

  let nextItems = sortByVisualOrder(withItemReplaced(items, resizedItem));
  nextItems = reflowColumnFrom(nextItems, resizedItem, gridSpec);

  if (nextColSpan === 2) {
    nextItems = resolveColumnConflicts(
      nextItems,
      {
        columnIndex: resizedItem.colStart + 1,
        rowStart: resizedItem.rowStart,
        rowSpan: resizedItem.rowSpan,
        reservedItemId: resizedItem.id,
      },
      gridSpec,
    );
  } else {
    nextItems = compactColumn(resizedItem.colStart + 1, nextItems, gridSpec);
  }

  return {
    items: sortByVisualOrder(nextItems),
    movedItemIds: [itemId],
  };
}
