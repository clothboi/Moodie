export const EXPORT_BORDER_PX = 20;
export const DEFAULT_EXPORT_BACKGROUND_HEX = '#1B1D20';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function isValidExportBackgroundHex(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(candidate);
}

export function normalizeExportBackgroundHex(value, fallback = DEFAULT_EXPORT_BACKGROUND_HEX) {
  if (!isValidExportBackgroundHex(value)) {
    return fallback;
  }

  const trimmed = value.trim();
  const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return candidate.toUpperCase();
}

export function resolveExportBackgroundFill({
  includeBackground = true,
  backgroundHex = DEFAULT_EXPORT_BACKGROUND_HEX,
  fallbackHex = DEFAULT_EXPORT_BACKGROUND_HEX,
} = {}) {
  if (!includeBackground) {
    return null;
  }

  return normalizeExportBackgroundHex(backgroundHex, fallbackHex);
}

export function paintExportBackground(
  context,
  {
    width = 0,
    height = 0,
    includeBackground = true,
    backgroundHex = DEFAULT_EXPORT_BACKGROUND_HEX,
    fallbackHex = DEFAULT_EXPORT_BACKGROUND_HEX,
  } = {},
) {
  const fill = resolveExportBackgroundFill({
    includeBackground,
    backgroundHex,
    fallbackHex,
  });

  if (!context || !fill || width <= 0 || height <= 0) {
    return null;
  }

  context.save?.();
  context.fillStyle = fill;
  context.fillRect(0, 0, width, height);
  context.restore?.();
  return fill;
}

export function getExportRenderMetrics(
  bounds,
  targetEdge,
  {
    borderPx = EXPORT_BORDER_PX,
    minTargetEdge = EXPORT_BORDER_PX * 2 + 1,
    maxTargetEdge = Number.POSITIVE_INFINITY,
  } = {},
) {
  if (!bounds) {
    return {
      width: 0,
      height: 0,
      contentWidth: 0,
      contentHeight: 0,
      scale: 1,
      borderPx,
      targetEdge: 0,
      contentTargetEdge: 0,
    };
  }

  const longestEdge = Math.max(bounds.width, bounds.height) || 1;
  const safeTargetEdge = clamp(Math.round(targetEdge || 0), minTargetEdge, maxTargetEdge);
  const contentTargetEdge = Math.max(1, safeTargetEdge - borderPx * 2);
  const scale = contentTargetEdge / longestEdge;
  const contentWidth = Math.max(1, Math.round(bounds.width * scale));
  const contentHeight = Math.max(1, Math.round(bounds.height * scale));

  return {
    width: contentWidth + borderPx * 2,
    height: contentHeight + borderPx * 2,
    contentWidth,
    contentHeight,
    scale,
    borderPx,
    targetEdge: safeTargetEdge,
    contentTargetEdge,
  };
}
