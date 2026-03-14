function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function snapToStep(value, step) {
  if (!step) {
    return value;
  }

  return Math.round(value / step) * step;
}

function normalizeBounds(bounds) {
  if (!bounds) {
    return null;
  }

  const left = Number.isFinite(bounds.left) ? bounds.left : 0;
  const top = Number.isFinite(bounds.top) ? bounds.top : 0;
  const width = Number.isFinite(bounds.width) ? Math.max(1, bounds.width) : 1;
  const height = Number.isFinite(bounds.height) ? Math.max(1, bounds.height) : 1;

  return {
    left,
    top,
    width,
    height,
  };
}

export function detectMobileMode({
  maxTouchPoints = 0,
  coarsePointer = false,
  viewportWidth = 0,
  viewportHeight = 0,
} = {}) {
  const largestViewportDimension = Math.max(viewportWidth || 0, viewportHeight || 0);

  if (maxTouchPoints > 1) {
    return largestViewportDimension <= 1366;
  }

  if (coarsePointer) {
    return largestViewportDimension <= 1024;
  }

  return false;
}

export function getMobileViewportTransform({
  viewportWidth,
  viewportHeight,
  hudHeight = 0,
  safeAreaInsets = {},
  focusBounds = null,
  fallbackBounds = null,
  minZoom = 0.2,
  maxZoom = 1.5,
  zoomStep = 0.05,
  zoomOutSteps = 0,
  sidePadding = 16,
  bottomPadding = 16,
  topGap = 12,
} = {}) {
  const safeTop = Number.isFinite(safeAreaInsets.top) ? safeAreaInsets.top : 0;
  const safeRight = Number.isFinite(safeAreaInsets.right) ? safeAreaInsets.right : 0;
  const safeBottom = Number.isFinite(safeAreaInsets.bottom) ? safeAreaInsets.bottom : 0;
  const safeLeft = Number.isFinite(safeAreaInsets.left) ? safeAreaInsets.left : 0;
  const contentLeft = safeLeft + sidePadding;
  const contentTop = safeTop + hudHeight + topGap;
  const contentRight = Math.max(contentLeft + 1, viewportWidth - safeRight - sidePadding);
  const contentBottom = Math.max(contentTop + 1, viewportHeight - safeBottom - bottomPadding);
  const availableWidth = Math.max(1, contentRight - contentLeft);
  const availableHeight = Math.max(1, contentBottom - contentTop);
  const targetBounds = normalizeBounds(focusBounds) ?? normalizeBounds(fallbackBounds) ?? {
    left: 0,
    top: 0,
    width: availableWidth,
    height: availableHeight,
  };
  const fitZoom = clamp(
    snapToStep(
      Math.min(
        availableWidth / Math.max(1, targetBounds.width),
        availableHeight / Math.max(1, targetBounds.height),
      ),
      zoomStep,
    ),
    minZoom,
    maxZoom,
  );
  const zoom = clamp(fitZoom - zoomOutSteps * zoomStep, minZoom, maxZoom);
  const offsetX = contentLeft + (availableWidth - targetBounds.width * zoom) / 2 - targetBounds.left * zoom;
  const offsetY = contentTop + (availableHeight - targetBounds.height * zoom) / 2 - targetBounds.top * zoom;

  return {
    zoom,
    offsetX,
    offsetY,
    availableWidth,
    availableHeight,
    contentLeft,
    contentTop,
    contentRight,
    contentBottom,
    bounds: targetBounds,
  };
}

export function getViewportFrameRect(frame, viewportTransform) {
  return {
    left: viewportTransform.offsetX + frame.left * viewportTransform.zoom,
    top: viewportTransform.offsetY + frame.top * viewportTransform.zoom,
    width: frame.width * viewportTransform.zoom,
    height: frame.height * viewportTransform.zoom,
  };
}

export function isFrameNearViewportEdge({
  frame,
  viewportTransform,
  edgeInsetX = 0,
  edgeInsetY = 0,
} = {}) {
  if (!frame || !viewportTransform) {
    return false;
  }

  const viewportFrame = getViewportFrameRect(frame, viewportTransform);
  const horizontalInset = edgeInsetX * viewportTransform.zoom;
  const verticalInset = edgeInsetY * viewportTransform.zoom;
  const right = viewportFrame.left + viewportFrame.width;
  const bottom = viewportFrame.top + viewportFrame.height;

  return (
    viewportFrame.left <= viewportTransform.contentLeft + horizontalInset ||
    right >= viewportTransform.contentRight - horizontalInset ||
    viewportFrame.top <= viewportTransform.contentTop + verticalInset ||
    bottom >= viewportTransform.contentBottom - verticalInset
  );
}

export function getNextEdgeSnapState({
  hasBreachedEdge,
  isLocked,
  zoomOutSteps,
  maxZoomOutSteps = 1,
} = {}) {
  if (hasBreachedEdge) {
    if (isLocked) {
      return {
        zoomOutSteps,
        isLocked: true,
        didSnap: false,
      };
    }

    return {
      zoomOutSteps: Math.min(maxZoomOutSteps, zoomOutSteps + 1),
      isLocked: true,
      didSnap: zoomOutSteps < maxZoomOutSteps,
    };
  }

  return {
    zoomOutSteps,
    isLocked: false,
    didSnap: false,
  };
}
