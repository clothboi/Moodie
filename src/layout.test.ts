import { describe, expect, it } from 'vitest';
import { compactColumn, computeRowSpan, placeNewItem, resizeItem } from './layout';
import type { BoardItem, GridSpec, ImageMeta } from './types';

const gridSpec: GridSpec = {
  rowPx: 10,
  columnPx: 30,
  maxColumns: 4,
  minRows: 8,
};

function makeImage(overrides: Partial<ImageMeta> = {}): ImageMeta {
  return {
    id: overrides.id ?? 'image',
    src: overrides.src ?? 'data:image/png;base64,abc',
    naturalWidth: overrides.naturalWidth ?? 100,
    naturalHeight: overrides.naturalHeight ?? 100,
  };
}

function makeItem(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: overrides.id ?? 'item',
    src: overrides.src ?? 'data:image/png;base64,abc',
    naturalWidth: overrides.naturalWidth ?? 100,
    naturalHeight: overrides.naturalHeight ?? 100,
    colStart: overrides.colStart ?? 0,
    rowStart: overrides.rowStart ?? 0,
    colSpan: overrides.colSpan ?? 1,
    rowSpan: overrides.rowSpan ?? 3,
    zIndex: overrides.zIndex ?? 1,
  };
}

describe('computeRowSpan', () => {
  it('rounds based on the rendered width and grid row height', () => {
    expect(computeRowSpan(makeImage(), 1, gridSpec)).toBe(3);
    expect(computeRowSpan(makeImage(), 2, gridSpec)).toBe(6);
  });
});

describe('placeNewItem', () => {
  it('finds the nearest open slot to the drop point', () => {
    const existing = [makeItem({ id: 'existing', colStart: 0, rowStart: 0 })];
    const result = placeNewItem(makeImage({ id: 'next' }), { x: 8, y: 2 }, existing, gridSpec);
    const inserted = result.items.find((item) => item.id === 'next');

    expect(inserted).toMatchObject({
      colStart: 1,
      rowStart: 0,
      colSpan: 1,
      rowSpan: 3,
    });
  });
});

describe('resizeItem', () => {
  it('splits conflicting adjacent-column items above and below an expanded item', () => {
    const items = [
      makeItem({ id: 'hero', colStart: 0, rowStart: 4, naturalWidth: 100, naturalHeight: 100 }),
      makeItem({ id: 'above', colStart: 1, rowStart: 3, rowSpan: 2 }),
      makeItem({ id: 'below', colStart: 1, rowStart: 8, rowSpan: 2 }),
    ];

    const result = resizeItem('hero', 2, items, gridSpec);
    const hero = result.items.find((item) => item.id === 'hero');
    const above = result.items.find((item) => item.id === 'above');
    const below = result.items.find((item) => item.id === 'below');

    expect(hero).toMatchObject({ colSpan: 2, rowSpan: 6 });
    expect(above?.rowStart).toBeLessThan(4);
    expect((below?.rowStart ?? 0) >= 10).toBe(true);
  });

  it('compacts the freed adjacent column after collapsing', () => {
    const items = [
      makeItem({ id: 'hero', colStart: 0, rowStart: 0, colSpan: 2, rowSpan: 6 }),
      makeItem({ id: 'adjacent-a', colStart: 1, rowStart: 8, rowSpan: 2 }),
      makeItem({ id: 'adjacent-b', colStart: 1, rowStart: 12, rowSpan: 2 }),
    ];

    const result = resizeItem('hero', 1, items, gridSpec);
    const compacted = compactColumn(1, result.items, gridSpec);
    const adjacentA = compacted.find((item) => item.id === 'adjacent-a');
    const adjacentB = compacted.find((item) => item.id === 'adjacent-b');

    expect(result.items.find((item) => item.id === 'hero')).toMatchObject({ colSpan: 1, rowSpan: 3 });
    expect(adjacentA?.rowStart).toBe(0);
    expect(adjacentB?.rowStart).toBe(2);
  });
});
