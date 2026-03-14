import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXPORT_BACKGROUND_HEX,
  EXPORT_BORDER_PX,
  getExportRenderMetrics,
  normalizeExportBackgroundHex,
  paintExportBackground,
  resolveExportBackgroundFill,
} from './exportUtils.js';

describe('getExportRenderMetrics', () => {
  it('keeps the selected longest edge inclusive of the 20px border for landscape exports', () => {
    expect(
      getExportRenderMetrics(
        { width: 1200, height: 600 },
        1024,
      ),
    ).toEqual({
      width: 1024,
      height: 532,
      contentWidth: 984,
      contentHeight: 492,
      scale: 0.82,
      borderPx: EXPORT_BORDER_PX,
      targetEdge: 1024,
      contentTargetEdge: 984,
    });
  });

  it('keeps the selected longest edge inclusive of the 20px border for portrait exports', () => {
    const metrics = getExportRenderMetrics({ width: 600, height: 1200 }, 2048);

    expect(metrics.width).toBe(1044);
    expect(metrics.height).toBe(2048);
    expect(metrics.contentWidth).toBe(1004);
    expect(metrics.contentHeight).toBe(2008);
    expect(metrics.scale).toBeCloseTo(1.6733333333);
  });

  it('adds the 20px border to square exports without changing the final target edge', () => {
    const metrics = getExportRenderMetrics({ width: 800, height: 800 }, 3072);

    expect(metrics.width).toBe(3072);
    expect(metrics.height).toBe(3072);
    expect(metrics.contentWidth).toBe(3032);
    expect(metrics.contentHeight).toBe(3032);
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
