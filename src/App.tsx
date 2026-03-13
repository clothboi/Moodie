import { useEffect, useRef, useState } from 'react';
import { BoardCanvas } from './components/BoardCanvas';
import { moveItem, placeNewItem, resizeItem } from './layout';
import { loadBoardState, saveBoardState } from './storage';
import type { BoardItem, GridSpec, ImageMeta, Point } from './types';

const GRID_SPEC: GridSpec = {
  rowPx: 44,
  columnPx: 132,
  maxColumns: 12,
  minRows: 18,
};

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fileToDataUrl(file: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function imageMetaFromBlob(blob: Blob): Promise<ImageMeta> {
  const src = await fileToDataUrl(blob);

  return await new Promise<ImageMeta>((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        id: generateId(),
        src,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      });
    image.onerror = () => reject(new Error('Failed to load image'));
    image.src = src;
  });
}

function getBoardRows(items: BoardItem[]): number {
  const occupiedRows = items.reduce((maxRows, item) => Math.max(maxRows, item.rowStart + item.rowSpan), 0);
  return Math.max(GRID_SPEC.minRows, occupiedRows + 4);
}

export default function App() {
  const [items, setItems] = useState<BoardItem[]>(() => loadBoardState().items);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const insertFiles = async (files: File[], point: Point | null) => {
    setIsImporting(true);

    try {
      const metas = await Promise.all(files.map((file) => imageMetaFromBlob(file)));

      setItems((currentItems) => {
        let nextItems = currentItems;

        for (const imageMeta of metas) {
          nextItems = placeNewItem(imageMeta, point, nextItems, GRID_SPEC).items;
        }

        return nextItems;
      });
    } finally {
      setIsImporting(false);
    }
  };

  const insertFilesRef = useRef(insertFiles);
  insertFilesRef.current = insertFiles;

  useEffect(() => {
    saveBoardState(items);
  }, [items]);

  useEffect(() => {
    const handlePaste = async (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file) && file.type.startsWith('image/'));

      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      await insertFilesRef.current(files, null);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  const rows = getBoardRows(items);

  return (
    <main className="app">
      <section className="app__hero">
        <div>
          <p className="eyebrow">Moodboard Grid</p>
          <h1>Paste or drop images into a snapping editorial grid.</h1>
        </div>
        <p className="app__copy">
          Every image lands on the nearest column and row marker, crops to fit the cell, and can stretch across two columns without breaking the layout rhythm.
        </p>
      </section>

      <section className="app__status-bar" aria-live="polite">
        <span>{items.length} image{items.length === 1 ? '' : 's'}</span>
        <span>{GRID_SPEC.maxColumns} columns</span>
        <span>{isImporting ? 'Importing images...' : 'Drop files or paste from clipboard'}</span>
      </section>

      <BoardCanvas
        gridSpec={GRID_SPEC}
        items={items}
        rows={rows}
        selectedItemId={selectedItemId}
        onSelectItem={setSelectedItemId}
        onMoveItem={(itemId, point) => {
          setItems((currentItems) => moveItem(itemId, point, currentItems, GRID_SPEC).items);
          setSelectedItemId(itemId);
        }}
        onToggleSpan={(itemId, nextColSpan) => {
          setItems((currentItems) => resizeItem(itemId, nextColSpan, currentItems, GRID_SPEC).items);
          setSelectedItemId(itemId);
        }}
        onInsertFiles={insertFiles}
      />
    </main>
  );
}
