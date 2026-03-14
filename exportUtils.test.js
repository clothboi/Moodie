import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXPORT_BACKGROUND_HEX,
  getExportRenderMetrics,
  normalizeExportBackgroundHex,
  paintExportBackground,
  resolveExportBackgroundFill,
} from './exportUtils.js';

describe('getExportRenderMetrics', () => {
  it('keeps the selected longest edge inclusive of a border derived from tile spacing for landscape exports', () => {
    expect(
      getExportRenderMetrics(
        { width: 1200, height: 600 },
        1024,
        { borderSourcePx: 4 },
      ),
    ).toEqual({
      width: 1024,
      height: 515,
      contentWidth: 1017,
      contentHeight: 508,
      scale: 0.847682119205298,
      borderPx: 3.390728476821192,
      borderSourcePx: 4,
      targetEdge: 1024,
      contentTargetEdge: 1017.2185430463577,
    });
  });

  it('keeps the selected longest edge inclusive of the derived border for portrait exports', () => {
    const metrics = getExportRenderMetrics({ width: 600, height: 1200 }, 2048, { borderSourcePx: 8 });

    expect(metrics.width).toBe(1038);
    expect(metrics.height).toBe(2048);
    expect(metrics.contentWidth).toBe(1012);
    expect(metrics.contentHeight).toBe(2023);
    expect(metrics.scale).toBeCloseTo(1.6858552631);
    expect(metrics.borderPx).toBeCloseTo(13.4868421053);
  });

  it('adds no border when tile spacing is zero', () => {
    const metrics = getExportRenderMetrics({ width: 800, height: 800 }, 3072, { borderSourcePx: 0 });

    expect(metrics.width).toBe(3072);
    expect(metrics.height).toBe(3072);
    expect(metrics.contentWidth).toBe(3072);
    expect(metrics.contentHeight).toBe(3072);
  });
});

describe('normalizeExportBackgroundHex', () => {
  it('normalizes valid HEX values to uppercase', () => {
    expect(normalizeExportBackgroundHex('#1b1d20')).toBe('#1B1D20');
    expect(normalizeExportBackgroundHex('ffffff')).toBe('#FFFFFF');
  });

  it('preserves the last valid color when the next HEX is invalid', () => {
    expect(normalizeExportBackgroundHex('#12', '#ABCDEF')).toBe('#ABCDEF');
  });
});

describe('export background rendering helpers', () => {
  it('returns null for transparent export mode', () => {
    expect(resolveExportBackgroundFill({ includeBackground: false, backgroundHex: '#FFFFFF' })).toBeNull();
  });

  it('paints the full export background for opaque exports', () => {
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '',
    };

    const fill = paintExportBackground(context, {
      width: 640,
      height: 480,
      includeBackground: true,
      backgroundHex: '#ffffff',
    });

    expect(fill).toBe('#FFFFFF');
    expect(context.fillStyle).toBe('#FFFFFF');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 640, 480);
  });

  it('uses the same normalized background color that preview and export share', () => {
    expect(
      resolveExportBackgroundFill({
        includeBackground: true,
        backgroundHex: '#1b1d20',
        fallbackHex: DEFAULT_EXPORT_BACKGROUND_HEX,
      }),
    ).toBe(DEFAULT_EXPORT_BACKGROUND_HEX);
  });
});
