import type { CSSProperties } from 'react';
import type { GridSpec } from '../types';

interface GridOverlayProps {
  gridSpec: GridSpec;
  rows: number;
}

export function GridOverlay({ gridSpec, rows }: GridOverlayProps) {
  return (
    <div
      aria-hidden="true"
      className="grid-overlay"
      style={
        {
          '--grid-row-size': `${gridSpec.rowPx}px`,
          '--grid-column-size': `${gridSpec.columnPx}px`,
          '--grid-height': `${rows * gridSpec.rowPx}px`,
        } as CSSProperties
      }
    />
  );
}
