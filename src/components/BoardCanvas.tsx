import { useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent } from 'react';
import type { BoardItem, GridSpec, Point } from '../types';
import { computeRowSpan } from '../layout';
import { GridOverlay } from './GridOverlay';

interface DragState {
  itemId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  previewX: number;
  previewY: number;
}

interface ResizeState {
  itemId: string;
  pointerId: number;
  startY: number;
  currentY: number;
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

const RESIZE_THRESHOLD = 30;
const GHOST_GAP = 10;

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
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
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

  const handleResizePointerDown = (event: PointerEvent<HTMLSpanElement>, item: BoardItem) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectItem(item.id);
    setResizeState({
      itemId: item.id,
      pointerId: event.pointerId,
      startY: event.clientY,
      currentY: event.clientY,
    });
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    setResizeState((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      return { ...current, currentY: event.clientY };
    });
  };

  const handleResizePointerUp = (event: PointerEvent<HTMLSpanElement>, item: BoardItem) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;

    const deltaY = event.clientY - resizeState.startY;

    if (deltaY > RESIZE_THRESHOLD && item.colSpan < 2) {
      onToggleSpan(item.id, 2);
    } else if (deltaY < -RESIZE_THRESHOLD && item.colSpan > 1) {
      onToggleSpan(item.id, 1);
    }

    setResizeState(null);
  };

  const handleTileKeyDown = (event: KeyboardEvent<HTMLDivElement>, itemId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectItem(itemId);
    }
  };

  const resizingItem = resizeState ? items.find((item) => item.id === resizeState.itemId) ?? null : null;
  const resizeDeltaY = resizeState ? resizeState.currentY - resizeState.startY : 0;

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
              <span
                className="board-tile__resize-handle"
                onPointerDown={(event) => handleResizePointerDown(event, item)}
                onPointerMove={handleResizePointerMove}
                onPointerUp={(event) => handleResizePointerUp(event, item)}
                onPointerCancel={() => setResizeState(null)}
              />
            </div>
          );
        })}
        {resizingItem ? (
          <>
            {resizingItem.colSpan < 2 ? (
              <div
                className={`board-tile-ghost${resizeDeltaY > RESIZE_THRESHOLD ? ' board-tile-ghost--active' : ''}`}
                style={{
                  left: `${resizingItem.colStart * gridSpec.columnPx}px`,
                  top: `${(resizingItem.rowStart + resizingItem.rowSpan) * gridSpec.rowPx + GHOST_GAP}px`,
                  width: `${2 * gridSpec.columnPx}px`,
                  height: `${computeRowSpan(resizingItem, 2, gridSpec) * gridSpec.rowPx}px`,
                }}
              >
                <img src={resizingItem.src} alt="" draggable={false} />
              </div>
            ) : null}
            {resizingItem.colSpan > 1 ? (() => {
              const ghostRowSpan = computeRowSpan(resizingItem, 1, gridSpec);
              const ghostHeight = ghostRowSpan * gridSpec.rowPx;
              return (
                <div
                  className={`board-tile-ghost${resizeDeltaY < -RESIZE_THRESHOLD ? ' board-tile-ghost--active' : ''}`}
                  style={{
                    left: `${resizingItem.colStart * gridSpec.columnPx}px`,
                    top: `${resizingItem.rowStart * gridSpec.rowPx - ghostHeight - GHOST_GAP}px`,
                    width: `${1 * gridSpec.columnPx}px`,
                    height: `${ghostHeight}px`,
                  }}
                >
                  <img src={resizingItem.src} alt="" draggable={false} />
                </div>
              );
            })() : null}
          </>
        ) : null}
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
