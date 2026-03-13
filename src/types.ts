export interface GridSpec {
  rowPx: number;
  columnPx: number;
  maxColumns: number;
  minRows: number;
}

export interface BoardItem {
  id: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  colStart: number;
  rowStart: number;
  colSpan: 1 | 2;
  rowSpan: number;
  zIndex: number;
}

export interface ImageMeta {
  id?: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

export interface PlacementResult {
  items: BoardItem[];
  movedItemIds: string[];
}

export interface Point {
  x: number;
  y: number;
}

export interface BoardStateV1 {
  version: 1;
  items: BoardItem[];
}
