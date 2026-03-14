import { describe, expect, it } from 'vitest';
import {
  detectMobileMode,
  getMobileViewportTransform,
  getNextEdgeSnapState,
  isFrameNearViewportEdge,
} from './mobileViewport.js';

describe('detectMobileMode', () => {
  it('uses touch-point detection for tablets and phones', () => {
    expect(
      detectMobileMode({
        maxTouchPoints: 5,
        viewportWidth: 1024,
        viewportHeight: 768,
      }),
    ).toBe(true);

    expect(
      detectMobileMode({
        maxTouchPoints: 5,
        viewportWidth: 1440,
        viewportHeight: 900,
      }),
    ).toBe(false);
  });

  it('falls back to coarse pointer detection when touch points are unavailable', () => {
    expect(
      detectMobileMode({
        maxTouchPoints: 0,
        coarsePointer: true,
        viewportWidth: 900,
        viewportHeight: 700,
      }),
    ).toBe(true);

    expect(
      detectMobileMode({
        maxTouchPoints: 0,
        coarsePointer: true,
        viewportWidth: 1280,
        viewportHeight: 800,
      }),
    ).toBe(false);
  });
});

describe('getMobileViewportTransform', () => {
  it('fits the cluster bounds into the available viewport below the HUD', () => {
    const transform = getMobileViewportTransform({
      viewportWidth: 1024,
      viewportHeight: 768,
      hudHeight: 96,
      safeAreaInsets: { top: 20, right: 0, bottom: 10, left: 0 },
      focusBounds: { left: 100, top: 200, width: 400, height: 300 },
      minZoom: 0.2,
      maxZoom: 1.5,
      zoomStep: 0.05,
    });

    expect(transform.zoom).toBe(1.5);
    expect(transform.contentTop).toBe(128);
    expect(transform.availableWidth).toBe(992);
    expect(transform.availableHeight).toBe(614);
    expect(transform.offsetX).toBe(62);
    expect(transform.offsetY).toBe(-90);
  });
});

describe('isFrameNearViewportEdge', () => {
  it('detects when the transformed frame breaches the mobile edge inset', () => {
    const viewportTransform = getMobileViewportTransform({
      viewportWidth: 1024,
      viewportHeight: 768,
      hudHeight: 96,
      focusBounds: { left: 0, top: 0, width: 1000, height: 500 },
      minZoom: 0.2,
      maxZoom: 1.5,
      zoomStep: 0.05,
    });

    expect(
      isFrameNearViewportEdge({
        frame: { left: 10, top: 10, width: 100, height: 100 },
        viewportTransform,
        edgeInsetX: 50,
        edgeInsetY: 75,
      }),
    ).toBe(true);

    expect(
      isFrameNearViewportEdge({
        frame: { left: 350, top: 180, width: 100, height: 100 },
        viewportTransform,
        edgeInsetX: 50,
        edgeInsetY: 75,
      }),
    ).toBe(false);
  });
});

describe('getNextEdgeSnapState', () => {
  it('snaps out once per breach until the preview leaves the inset', () => {
    expect(
      getNextEdgeSnapState({
        hasBreachedEdge: true,
        isLocked: false,
        zoomOutSteps: 0,
      }),
    ).toEqual({
      zoomOutSteps: 1,
      isLocked: true,
      didSnap: true,
    });

    expect(
      getNextEdgeSnapState({
        hasBreachedEdge: true,
        isLocked: true,
        zoomOutSteps: 1,
      }),
    ).toEqual({
      zoomOutSteps: 1,
      isLocked: true,
      didSnap: false,
    });

    expect(
      getNextEdgeSnapState({
        hasBreachedEdge: false,
        isLocked: true,
        zoomOutSteps: 1,
      }),
    ).toEqual({
      zoomOutSteps: 1,
      isLocked: false,
      didSnap: false,
    });
  });
});
