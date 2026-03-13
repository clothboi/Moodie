import { useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent } from 'react';
import type { BoardItem, GridSpec, Point } from '../types';
import { GridOverlay } from './GridOverlay';

interface DragState {
  itemId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  previewX: number;
  previewY: number;
}

interface BoardCanvasProps {
  gridSpec: GridSpec;
  items: BoardItem[];
  rows: number;
  selectedItemId: string | null;
  onSelectItem: (itemId: string | null) => void;
  onMoveItem: (itemId: string, point: Point) => void;
  onToggleSpan: (itemId: string, nextColSpan: 1 | 2) => void;
  onInsertFiles: (files: File[], point: Point | null) => Promise<void>;
}

function getPointWithinBoard(
  boardRect: DOMRect,
  clientX: number,
  clientY: number,
  offsetX = 0,
  offsetY = 0,
): Point {
  return {
    x: clientX - boardRect.left - offsetX,
    y: clientY - boardRect.top - offsetY,
  };
}

export function BoardCanvas({
  gridSpec,
  items,
  rows,
  selectedItemId,
  onInsertFiles,
  onMoveItem,
  onSelectItem,
  onToggleSpan,
}: BoardCanvasProps) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [isDropActive, setIsDropActive] = useState(false);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      setIsDropActive(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDropActive(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(false);

    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'));

    if (files.length === 0 || !boardRef.current) {
      return;
    }

    const boardRect = boardRef.current.getBoundingClientRect();
    const point = getPointWithinBoard(boardRect, event.clientX, event.clientY);
    await onInsertFiles(files, point);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>, item: BoardItem) => {
    if (!boardRef.current) {
      return;
    }

    const tileRect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectItem(item.id);
    setDragState({
      itemId: item.id,
      pointerId: event.pointerId,
      offsetX: event.clientX - tileRect.left,
      offsetY: event.clientY - tileRect.top,
      previewX: tileRect.left,
      previewY: tileRect.top,
    });
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    setDragState((current) => {
      if (!current || current.pointerId !== event.pointerId) {
        return current;
      }

      return {
        ...current,
        previewX: event.clientX - current.offsetX,
        previewY: event.clientY - current.offsetY,
      };
    });
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragState || dragState.pointerId !== event.pointerId || !boardRef.current) {
      return;
    }

    const boardRect = boardRef.current.getBoundingClientRect();
    const point = getPointWithinBoard(
      boardRect,
      event.clientX,
      event.clientY,
      dragState.offsetX,
      dragState.offsetY,
    );

    onMoveItem(dragState.itemId, point);
    setDragState(null);
  };

  const handleTileKeyDown = (event: KeyboardEvent<HTMLDivElement>, itemId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectItem(itemId);
    }
  };

  return (
    <div className="board-shell">
      <div
        ref={boardRef}
        className={`board-canvas${isDropActive ? ' board-canvas--drop' : ''}`}
        style={{
          width: `${gridSpec.maxColumns * gridSpec.columnPx}px`,
          height: `${rows * gridSpec.rowPx}px`,
        }}
        onClick={() => onSelectItem(null)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <GridOverlay gridSpec={gridSpec} rows={rows} />
        {items.map((item) => {
          const isSelected = selectedItemId === item.id;
          const isDragging = dragState?.itemId === item.id;
          const boardRect = boardRef.current?.getBoundingClientRect() ?? null;
          const liveLeft = isDragging && boardRect
            ? `${dragState.previewX - boardRect.left}px`
            : `${item.colStart * gridSpec.columnPx}px`;
          const liveTop = isDragging && boardRect
            ? `${dragState.previewY - boardRect.top}px`
            : `${item.rowStart * gridSpec.rowPx}px`;

          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              aria-label="Moodboard image tile"
              className={`board-tile${isSelected ? ' board-tile--selected' : ''}${isDragging ? ' board-tile--dragging' : ''}`}
              style={{
                left: liveLeft,
                top: liveTop,
                width: `${item.colSpan * gridSpec.columnPx}px`,
                height: `${item.rowSpan * gridSpec.rowPx}px`,
                zIndex: item.zIndex,
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectItem(item.id);
              }}
              onPointerDown={(event) => handlePointerDown(event, item)}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={() => setDragState(null)}
              onKeyDown={(event) => handleTileKeyDown(event, item.id)}
            >
              <img src={item.src} alt="" draggable={false} />
              <span className="board-tile__shadow" />
              <span className="board-tile__meta">
                <span>{item.colSpan === 1 ? '1 col' : '2 col'}</span>
                <span>{item.rowSpan} rows</span>
              </span>
              {isSelected ? (
                <span className="board-tile__actions">
                  <button
                    type="button"
                    className="board-tile__toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleSpan(item.id, item.colSpan === 1 ? 2 : 1);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {item.colSpan === 1 ? 'Expand to 2 cols' : 'Collapse to 1 col'}
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}
        {items.length === 0 ? (
          <div className="board-empty-state">
            <p>Drop images anywhere on the grid.</p>
            <p>Paste screenshots or reference images with Ctrl+V.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
