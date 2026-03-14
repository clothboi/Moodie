import {
  detectMobileMode,
  getMobileViewportTransform,
  getNextEdgeSnapState,
  getViewportFrameRect,
  isFrameNearViewportEdge,
} from './mobileViewport.js';
import {
  DEFAULT_EXPORT_BACKGROUND_HEX,
  getExportRenderMetrics,
  isValidExportBackgroundHex,
  normalizeExportBackgroundHex,
  paintExportBackground,
} from './exportUtils.js';

const DEFAULT_STORAGE_KEY = 'moodboard-grid.board';
const DEFAULT_TITLE = 'Moodboard Grid';
const AUTO_INIT_SELECTOR = '[data-moodboard-grid]';
const widgetInstances = new WeakMap();
let nextWidgetId = 1;
let activeWidgetId = null;

function normalizeWidgetOptions(options = {}) {
  const title = typeof options.title === 'string' && options.title.trim() ? options.title.trim() : DEFAULT_TITLE;
  const storageKey =
    typeof options.storageKey === 'string' && options.storageKey.trim()
      ? options.storageKey.trim()
      : DEFAULT_STORAGE_KEY;

  return {
    title,
    storageKey,
  };
}

function getWidgetDatasetOptions(container) {
  return normalizeWidgetOptions({
    title: container.dataset.title,
    storageKey: container.dataset.storageKey,
  });
}

function createMoodboardGrid(container, initialOptions = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('MoodboardGrid.mount requires a valid HTMLElement container.');
  }

  const existingInstance = widgetInstances.get(container);

  if (existingInstance) {
    return existingInstance;
  }

  const settings = normalizeWidgetOptions({
    ...getWidgetDatasetOptions(container),
    ...initialOptions,
  });
  const widgetId = `moodboard-grid-${nextWidgetId++}`;
  let root = null;
  const managedListeners = [];

  const GRID_SPEC = {
    rowPx: 52.8,
    columnPx: 158.4,
    maxColumns: 15,
    minRows: 18,
  };

  const STORAGE_KEY = settings.storageKey;
  const CURRENT_VERSION = 3;
  const RESIZE_CHOICE_SIZE = 42;
  const DEFAULT_LAYOUT = {
    gapPx: 4,
    radiusPx: 4,
    exportBackgroundHex: DEFAULT_EXPORT_BACKGROUND_HEX,
  };
  const DEFAULT_CROP = {
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  };
  const LAYOUT_MIN_PX = 0;
  const LAYOUT_MAX_PX = 24;
  const LAYOUT_STEP_PX = 2;
  const CROP_ZOOM_MIN = 1;
  const CROP_ZOOM_MAX = 2;
  const CROP_ZOOM_STEP = 0.1;
  const ZOOM_MIN = 0.5;
  const MOBILE_ZOOM_MIN = 0.2;
  const ZOOM_MAX = 1.5;
  const ZOOM_STEP = 0.05;
  const EXPORT_MAX_EDGE = 4096;
  const EXPORT_STATUS_DURATION_MS = 2800;
  const EXPORT_EDGE_OPTIONS = [1024, 2048, 3072, 4096];
  const VIEWPORT_VERTICAL_BUFFER_FACTOR = 1;
  const MOBILE_EDGE_INSET_X = GRID_SPEC.columnPx;
  const MOBILE_EDGE_INSET_Y = GRID_SPEC.rowPx * 3;
  const MOBILE_VIEWPORT_SIDE_PADDING = 16;
  const MOBILE_VIEWPORT_BOTTOM_PADDING = 16;
  const MOBILE_VIEWPORT_TOP_GAP = 12;
  const LAYOUT_CONTROL_CONFIG = [
    { key: 'gapPx', role: 'gap', label: 'Space', ariaLabel: 'space' },
    { key: 'radiusPx', role: 'radius', label: 'Corners', ariaLabel: 'corners' },
  ];
  const DESKTOP_HUD_HINTS = [
    'Drop files, links, or paste images anywhere on the board.',
    'Middle mouse pans. Ctrl + scroll zooms around the tile cluster.',
    'Drag empty space to select multiple images. Shift + click adds or removes images.',
    'Hold Shift on a single tile to move the entire stack below it (Where possible).',
    'Use the Link button on a selected image to open its source.',
    'Use the side handles to resize a single image (The arrows move obstructing tiles).',
    'Use the bottom slider to zoom the image and drag the floating anchor above to reposition it.',
  ];
  const MOBILE_HUD_HINTS = [
    'Drop files, links, or paste images into the fullscreen board.',
    'The board auto-fits on touch devices and snaps out if a dragged tile gets too close to the edge.',
    'Use Multi-select in the HUD to tap tiles into a selection or drag a marquee.',
    'Drag a selected tile to move the current selection together.',
    'Use the floating Stack button while dragging a tile to enable the shift-stack move.',
    'Use the side handles to resize a single image and the bottom slider to zoom its crop.',
  ];
  const DEFAULT_VISIBLE_COLUMNS = 10;
  const GRID_WIDTH = GRID_SPEC.maxColumns * GRID_SPEC.columnPx;
  const persistedBoardState = loadBoardState();
  const exportImageCache = new Map();
  let exportPreviewRequestId = 0;

  const state = {
    items: persistedBoardState.items,
    layout: persistedBoardState.layout,
    zoom: 1,
    isLayoutPanelOpen: false,
    isHintsPanelOpen: false,
    isExportPanelOpen: false,
    exportTargetEdge: EXPORT_MAX_EDGE,
    exportIncludeBackground: true,
    exportBackgroundHex: persistedBoardState.layout.exportBackgroundHex,
    exportBackgroundHexDraft: persistedBoardState.layout.exportBackgroundHex,
    isMobileMode: false,
    isMultiSelectMode: false,
    selectedItemIds: [],
    selectionAnchorId: null,
    isImporting: false,
    viewportTransform: null,
    mobileZoomOutSteps: 0,
    isMobileEdgeZoomLocked: false,
    exportState: {
      isExporting: false,
      message: '',
      tone: 'idle',
      resetTimer: null,
    },
    dragSession: null,
    resizeSession: null,
    panSession: null,
    marqueeSession: null,
    cropAnchorSession: null,
    suppressNextClick: false,
  };

  const refs = {
    host: container,
    root: null,
  };

  function addManagedEventListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    managedListeners.push(() => {
      target.removeEventListener(type, listener, options);
    });
  }

  function setActiveWidget() {
    activeWidgetId = widgetId;
  }

  function isWidgetActive() {
    return activeWidgetId === widgetId;
  }

  function setWidgetInteractionState(className, isActive) {
    refs.root?.classList.toggle(className, isActive);
  }

  function clearWidgetInteractionStates() {
    for (const className of ['is-dragging', 'is-resizing', 'is-panning', 'is-marqueeing']) {
      setWidgetInteractionState(className, false);
    }
  }

  function isTargetInsideWidget(target) {
    return target instanceof Node && refs.root?.contains(target);
  }

  function createItemId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }

    return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function sanitizeSourceUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }

    try {
      const url = new URL(value.trim());

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }

      return url.toString();
    } catch {
      return null;
    }
  }

  function normalizeSourceMeta(sourceUrl, sourceKind = 'import') {
    const nextSourceUrl = sanitizeSourceUrl(sourceUrl);

    return {
      sourceUrl: nextSourceUrl,
      sourceKind: nextSourceUrl && sourceKind === 'web' ? 'web' : 'import',
    };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getViewportWidth() {
    return refs.shell?.clientWidth ?? refs.host?.clientWidth ?? window.innerWidth;
  }

  function getViewportHeight() {
    return refs.shell?.clientHeight ?? refs.host?.clientHeight ?? window.innerHeight;
  }

  function getSafeAreaInsets() {
    if (!refs.root) {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }

    const styles = window.getComputedStyle(refs.root);
    const parseInset = (name) => Number.parseFloat(styles.getPropertyValue(name)) || 0;

    return {
      top: parseInset('--safe-area-top'),
      right: parseInset('--safe-area-right'),
      bottom: parseInset('--safe-area-bottom'),
      left: parseInset('--safe-area-left'),
    };
  }

  function updateMobileMode() {
    const coarsePointer =
      typeof window.matchMedia === 'function' &&
      (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(any-pointer: coarse)').matches);
    const nextIsMobileMode = detectMobileMode({
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      coarsePointer,
      viewportWidth: getViewportWidth(),
      viewportHeight: getViewportHeight(),
    });

    if (state.isMobileMode === nextIsMobileMode) {
      return;
    }

    state.isMobileMode = nextIsMobileMode;
    state.isMultiSelectMode = nextIsMobileMode ? state.isMultiSelectMode : false;
    state.viewportTransform = null;
    state.mobileZoomOutSteps = 0;
    state.isMobileEdgeZoomLocked = false;
    state.dragSession = null;
    state.resizeSession = null;
    state.panSession = null;
    state.marqueeSession = null;
    state.cropAnchorSession = null;
    clearWidgetInteractionStates();
    refs.shell?.classList.remove('board-shell--panning');

    if (refs.shell) {
      refs.shell.scrollLeft = 0;
      refs.shell.scrollTop = 0;
    }
  }

  function getCurrentZoom() {
    return state.isMobileMode ? state.viewportTransform?.zoom ?? state.zoom : state.zoom;
  }

  function getCurrentViewportTransform() {
    return state.isMobileMode
      ? state.viewportTransform ?? {
          zoom: state.zoom,
          offsetX: 0,
          offsetY: 0,
          contentLeft: 0,
          contentTop: 0,
          contentRight: getViewportWidth(),
          contentBottom: getViewportHeight(),
        }
      : {
          zoom: state.zoom,
          offsetX: 0,
          offsetY: 0,
          contentLeft: 0,
          contentTop: 0,
          contentRight: getViewportWidth(),
          contentBottom: getViewportHeight(),
        };
  }

  function getHudHints() {
    return state.isMobileMode ? MOBILE_HUD_HINTS : DESKTOP_HUD_HINTS;
  }

  function isMobileMultiSelectActive() {
    return state.isMobileMode && state.isMultiSelectMode;
  }

  function canStartMobileMarquee() {
    return !state.isMobileMode || isMobileMultiSelectActive();
  }

  function syncDragShiftStackState(dragSession, shiftKey = false) {
    if (!dragSession) {
      return;
    }

    dragSession.keyboardShiftActive = dragSession.allowShiftStack && Boolean(shiftKey);
    dragSession.isShiftStack =
      dragSession.allowShiftStack && (dragSession.keyboardShiftActive || dragSession.mobileShiftThumbActive);
  }

  function getFallbackClusterBounds(logicalBoardHeight) {
    return {
      left: 0,
      top: 0,
      width: GRID_SPEC.columnPx * DEFAULT_VISIBLE_COLUMNS,
      height: Math.min(logicalBoardHeight, GRID_SPEC.rowPx * 8),
    };
  }

  function getMobileFocusBounds(focusBounds, logicalBoardHeight) {
    const fallbackBounds = getFallbackClusterBounds(logicalBoardHeight);
    const nextBounds = focusBounds ?? fallbackBounds;

    return {
      left: 0,
      top: nextBounds.top,
      width: Math.max(nextBounds.width, fallbackBounds.width),
      height: Math.max(nextBounds.height, fallbackBounds.height),
    };
  }

  function buildMobileViewportState(focusBounds, logicalBoardHeight) {
    const hudHeight = refs.hud?.getBoundingClientRect().height ?? 0;

    return getMobileViewportTransform({
      viewportWidth: getViewportWidth(),
      viewportHeight: getViewportHeight(),
      hudHeight,
      safeAreaInsets: getSafeAreaInsets(),
      focusBounds: getMobileFocusBounds(focusBounds, logicalBoardHeight),
      fallbackBounds: getFallbackClusterBounds(logicalBoardHeight),
      minZoom: MOBILE_ZOOM_MIN,
      maxZoom: ZOOM_MAX,
      zoomStep: ZOOM_STEP,
      zoomOutSteps: state.mobileZoomOutSteps,
      sidePadding: MOBILE_VIEWPORT_SIDE_PADDING,
      bottomPadding: MOBILE_VIEWPORT_BOTTOM_PADDING,
      topGap: MOBILE_VIEWPORT_TOP_GAP,
    });
  }

  function getMinZoom() {
    const viewportWidth = getViewportWidth();

    if (!viewportWidth || !GRID_WIDTH) {
      return ZOOM_MIN;
    }

    return Math.max(ZOOM_MIN, viewportWidth / GRID_WIDTH);
  }

  function snapLayoutValue(value) {
    const clamped = clamp(value, LAYOUT_MIN_PX, LAYOUT_MAX_PX);
    return Math.round(clamped / LAYOUT_STEP_PX) * LAYOUT_STEP_PX;
  }

  function normalizeLayout(layout) {
    return {
      gapPx: snapLayoutValue(layout?.gapPx ?? DEFAULT_LAYOUT.gapPx),
      radiusPx: snapLayoutValue(layout?.radiusPx ?? DEFAULT_LAYOUT.radiusPx),
      exportBackgroundHex: normalizeExportBackgroundHex(
        layout?.exportBackgroundHex ?? DEFAULT_LAYOUT.exportBackgroundHex,
        DEFAULT_LAYOUT.exportBackgroundHex,
      ),
    };
  }

  function snapCropZoom(value) {
    return clamp(Math.round(value / CROP_ZOOM_STEP) * CROP_ZOOM_STEP, CROP_ZOOM_MIN, CROP_ZOOM_MAX);
  }

  function normalizeCrop(crop) {
    return {
      zoom: snapCropZoom(typeof crop?.zoom === 'number' ? crop.zoom : DEFAULT_CROP.zoom),
      offsetX: clamp(typeof crop?.offsetX === 'number' ? crop.offsetX : DEFAULT_CROP.offsetX, -1, 1),
      offsetY: clamp(typeof crop?.offsetY === 'number' ? crop.offsetY : DEFAULT_CROP.offsetY, -1, 1),
    };
  }

  function clampZoom(value) {
    const minZoom = state.isMobileMode ? MOBILE_ZOOM_MIN : getMinZoom();
    return clamp(Math.round(value / ZOOM_STEP) * ZOOM_STEP, minZoom, ZOOM_MAX);
  }

  function getDefaultZoom() {
    const viewportWidth = getViewportWidth();
    const targetWidth = GRID_SPEC.columnPx * DEFAULT_VISIBLE_COLUMNS;

    if (!viewportWidth || !targetWidth) {
      return 1;
    }

    return clampZoom(viewportWidth / targetWidth);
  }

  function getGapPx() {
    return state.layout?.gapPx ?? DEFAULT_LAYOUT.gapPx;
  }

  function getRadiusPx() {
    return state.layout?.radiusPx ?? DEFAULT_LAYOUT.radiusPx;
  }

  function getItemCrop(item) {
    return normalizeCrop(item?.crop);
  }

  function normalizeBoardItem(item) {
    return {
      ...item,
      ...normalizeSourceMeta(item.sourceUrl, item.sourceKind),
      crop: normalizeCrop(item.crop),
    };
  }

  function createEmptyBoardState() {
    return {
      items: [],
      layout: { ...DEFAULT_LAYOUT },
    };
  }

  function getCropGeometry(item, frame, crop = getItemCrop(item)) {
    const coverScale = Math.max(frame.width / item.naturalWidth, frame.height / item.naturalHeight);
    const renderedWidth = item.naturalWidth * coverScale * crop.zoom;
    const renderedHeight = item.naturalHeight * coverScale * crop.zoom;
    const maxTranslateX = Math.max(0, (renderedWidth - frame.width) / 2);
    const maxTranslateY = Math.max(0, (renderedHeight - frame.height) / 2);
    const translateX = maxTranslateX * clamp(crop.offsetX, -1, 1);
    const translateY = maxTranslateY * clamp(crop.offsetY, -1, 1);

    return {
      width: renderedWidth,
      height: renderedHeight,
      left: (frame.width - renderedWidth) / 2 + translateX,
      top: (frame.height - renderedHeight) / 2 + translateY,
      maxTranslateX,
      maxTranslateY,
      crop,
    };
  }

  function applyCropPresentation(element, item, frame, crop = getItemCrop(item)) {
    const geometry = getCropGeometry(item, frame, crop);
    element.style.left = `${geometry.left}px`;
    element.style.top = `${geometry.top}px`;
    element.style.width = `${geometry.width}px`;
    element.style.height = `${geometry.height}px`;
    return geometry;
  }

  function updateItemCrop(itemId, nextCrop, { save = false } = {}) {
    state.items = state.items.map((item) => (item.id === itemId ? { ...item, crop: normalizeCrop(nextCrop) } : item));

    if (save) {
      saveBoardState();
    }
  }

  function openItemSource(item) {
    if (!item?.sourceUrl) {
      return;
    }

    window.open(item.sourceUrl, '_blank', 'noopener,noreferrer');
  }

  function isInteractiveTarget(target) {
    return target instanceof Element && Boolean(target.closest('button, input, textarea, select, a'));
  }

  function uniqueIds(itemIds) {
    return [...new Set(itemIds.filter(Boolean))];
  }

  function getSelectionIds() {
    return uniqueIds(state.selectedItemIds);
  }

  function isItemSelected(itemId) {
    return getSelectionIds().includes(itemId);
  }

  function getSelectionAnchorId() {
    const selectionIds = getSelectionIds();

    if (state.selectionAnchorId && selectionIds.includes(state.selectionAnchorId)) {
      return state.selectionAnchorId;
    }

    return selectionIds[selectionIds.length - 1] || null;
  }

  function setSelection(itemIds, anchorId = null) {
    const selectionIds = uniqueIds(itemIds);
    state.selectedItemIds = selectionIds;
    state.selectionAnchorId =
      anchorId && selectionIds.includes(anchorId)
        ? anchorId
        : selectionIds.length
          ? selectionIds[selectionIds.length - 1]
          : null;
  }

  function setSingleSelection(itemId) {
    setSelection(itemId ? [itemId] : [], itemId);
  }

  function clearSelection() {
    setSelection([]);
  }

  function toggleSelection(itemId) {
    const selectionIds = getSelectionIds();

    if (selectionIds.includes(itemId)) {
      setSelection(
        selectionIds.filter((candidateId) => candidateId !== itemId),
        state.selectionAnchorId === itemId ? selectionIds[selectionIds.length - 1] || null : state.selectionAnchorId,
      );
      return;
    }

    setSelection([...selectionIds, itemId], itemId);
  }

  function getSelectedItems(items = state.items) {
    const selectedIds = new Set(getSelectionIds());
    return items.filter((item) => selectedIds.has(item.id));
  }

  function sortByVisualOrder(items) {
    return [...items].sort((left, right) => {
      if (left.rowStart !== right.rowStart) {
        return left.rowStart - right.rowStart;
      }

      if (left.colStart !== right.colStart) {
        return left.colStart - right.colStart;
      }

      return left.zIndex - right.zIndex;
    });
  }

  function getTouchedColumns(item) {
    return Array.from({ length: item.colSpan }, (_, index) => item.colStart + index);
  }

  function getItemRect(item) {
    return {
      colStart: item.colStart,
      rowStart: item.rowStart,
      colSpan: item.colSpan,
      rowSpan: item.rowSpan,
    };
  }

  function getTileFrame(item, gridSpec = GRID_SPEC, gapPx = getGapPx()) {
    const inset = gapPx / 2;

    return {
      left: item.colStart * gridSpec.columnPx + inset,
      top: item.rowStart * gridSpec.rowPx + inset,
      width: item.colSpan * gridSpec.columnPx - gapPx,
      height: item.rowSpan * gridSpec.rowPx - gapPx,
    };
  }

  function syncItemCropPresentation(itemId) {
    const item = getItemById(state.items, itemId);

    if (!item) {
      return;
    }

    const frame = getTileFrame(item);
    const image = refs.stage?.querySelector(`.board-tile[data-item-id="${itemId}"] .board-media-image`);

    if (image) {
      applyCropPresentation(image, item, frame);
    }
  }

  function setItemCropZoom(itemId, zoom, { save = false } = {}) {
    const item = getItemById(state.items, itemId);

    if (!item) {
      return;
    }

    updateItemCrop(itemId, {
      ...getItemCrop(item),
      zoom,
    }, { save });
    syncItemCropPresentation(itemId);
  }

  function consumeSuppressedClick() {
    if (!state.suppressNextClick) {
      return false;
    }

    state.suppressNextClick = false;
    return true;
  }

  function clearSelectionAndRefresh() {
    clearSelection();
    closeFloatingPanels();
    renderBoard();
  }

  function isStageBackgroundTarget(target) {
    return target === refs.stage || (target instanceof Element && target.classList.contains('grid-overlay'));
  }

  function isFloatingUiTarget(target) {
    return (
      refs.hud?.contains(target) ||
      refs.layoutPanel?.contains(target) ||
      refs.exportPanel?.contains(target) ||
      refs.hintsPanel?.contains(target)
    );
  }

  function pointInRect(point, rect) {
    if (!point || !rect) {
      return false;
    }

    return (
      point.x >= rect.left &&
      point.x <= rect.left + rect.width &&
      point.y >= rect.top &&
      point.y <= rect.top + rect.height
    );
  }

  function getDragFrame(dragSession, item, gridSpec = GRID_SPEC, gapPx = getGapPx()) {
    if (!dragSession.pointerBoard) {
      return null;
    }

    const inset = gapPx / 2;
    const frameLeft = dragSession.pointerBoard.x - dragSession.offsetX;
    const frameTop = dragSession.pointerBoard.y - dragSession.offsetY;
    const gridLeft = frameLeft - inset;
    const gridTop = frameTop - inset;

    return {
      left: frameLeft,
      top: frameTop,
      width: item.colSpan * gridSpec.columnPx - gapPx,
      height: item.rowSpan * gridSpec.rowPx - gapPx,
      gridLeft,
      gridTop,
      midpointRow: gridTop / gridSpec.rowPx + item.rowSpan / 2,
    };
  }

  function overlaps(a, b) {
    const aColEnd = a.colStart + a.colSpan;
    const bColEnd = b.colStart + b.colSpan;
    const aRowEnd = a.rowStart + a.rowSpan;
    const bRowEnd = b.rowStart + b.rowSpan;

    return a.colStart < bColEnd && aColEnd > b.colStart && a.rowStart < bRowEnd && aRowEnd > b.rowStart;
  }

  function touchesColumn(item, columnIndex) {
    return item.colStart <= columnIndex && item.colStart + item.colSpan - 1 >= columnIndex;
  }

  function getRowEnd(item) {
    return item.rowStart + item.rowSpan;
  }

  function itemMidpoint(item) {
    return item.rowStart + item.rowSpan / 2;
  }

  function clampColStart(colStart, colSpan) {
    return clamp(colStart, 0, GRID_SPEC.maxColumns - colSpan);
  }

  function maxOccupiedRow(items) {
    return items.reduce((maxRow, item) => Math.max(maxRow, getRowEnd(item)), 0);
  }

  function rectFits(rect, items, ignoreId) {
    if (rect.colStart < 0 || rect.rowStart < 0 || rect.colStart + rect.colSpan > GRID_SPEC.maxColumns) {
      return false;
    }

    return items.every((item) => item.id === ignoreId || !overlaps(rect, getItemRect(item)));
  }

  function findNearestOpenSlot(targetCol, targetRow, colSpan, rowSpan, items, ignoreId) {
    const candidates = [];
    const maxRow = Math.max(targetRow + 48, maxOccupiedRow(items) + rowSpan + 24, GRID_SPEC.minRows);

    for (let rowStart = 0; rowStart <= maxRow; rowStart += 1) {
      for (let colStart = 0; colStart <= GRID_SPEC.maxColumns - colSpan; colStart += 1) {
        const rect = { colStart, rowStart, colSpan, rowSpan };

        if (!rectFits(rect, items, ignoreId)) {
          continue;
        }

        const score = Math.abs(colStart - targetCol) + Math.abs(rowStart - targetRow);
        candidates.push({ colStart, rowStart, score });
      }
    }

    candidates.sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.rowStart !== right.rowStart) {
        return left.rowStart - right.rowStart;
      }

      return left.colStart - right.colStart;
    });

    return candidates[0] || { colStart: 0, rowStart: maxRow + 1 };
  }

  function findFirstOpenSlot(colSpan, rowSpan, items, ignoreId) {
    const maxRow = Math.max(maxOccupiedRow(items) + rowSpan + 24, GRID_SPEC.minRows);

    for (let rowStart = 0; rowStart <= maxRow; rowStart += 1) {
      for (let colStart = 0; colStart <= GRID_SPEC.maxColumns - colSpan; colStart += 1) {
        if (rectFits({ colStart, rowStart, colSpan, rowSpan }, items, ignoreId)) {
          return { colStart, rowStart };
        }
      }
    }

    return { colStart: 0, rowStart: maxRow + 1 };
  }

  function findEarliestRowAtOrAfter(item, minRow, items) {
    let rowStart = Math.max(0, minRow);

    while (!rectFits({ colStart: item.colStart, rowStart, colSpan: item.colSpan, rowSpan: item.rowSpan }, items, item.id)) {
      rowStart += 1;
    }

    return rowStart;
  }

  function findLatestRowBefore(item, maxRowExclusive, items) {
    const start = Math.min(item.rowStart, maxRowExclusive - item.rowSpan);

    for (let rowStart = start; rowStart >= 0; rowStart -= 1) {
      if (rectFits({ colStart: item.colStart, rowStart, colSpan: item.colSpan, rowSpan: item.rowSpan }, items, item.id)) {
        return rowStart;
      }
    }

    return null;
  }

  function withItemReplaced(items, nextItem) {
    return items.map((item) => (item.id === nextItem.id ? nextItem : item));
  }

  function getItemById(items, itemId) {
    return items.find((item) => item.id === itemId) || null;
  }

  function buildColumnStacks(items, draggedItemId) {
    const stacks = Array.from({ length: GRID_SPEC.maxColumns }, () => ({
      movable: [],
      blockers: [],
    }));

    for (const item of items) {
      if (item.id === draggedItemId) {
        continue;
      }

      if (item.colSpan === 1) {
        stacks[item.colStart].movable.push(item);
        continue;
      }

      for (const columnIndex of getTouchedColumns(item)) {
        stacks[columnIndex].blockers.push(item);
      }
    }

    for (const stack of stacks) {
      stack.movable = sortByVisualOrder(stack.movable);
      stack.blockers = sortByVisualOrder(stack.blockers);
    }

    return stacks;
  }

  function packSequence(sequence, contextItems, draggedItemId, preferredRow, startRow = 0) {
    const placed = [];
    const occupancy = [...contextItems];
    let cursor = Math.max(0, startRow);

    for (const item of sequence) {
      const requestedRow = item.id === draggedItemId ? Math.max(cursor, preferredRow) : cursor;
      const rowStart = findEarliestRowAtOrAfter(item, requestedRow, occupancy);
      const nextItem = { ...item, rowStart };

      placed.push(nextItem);
      occupancy.push(nextItem);
      cursor = getRowEnd(nextItem);
    }

    return placed;
  }

  function compactColumn(columnIndex, items) {
    const movable = sortByVisualOrder(items).filter((item) => item.colSpan === 1 && item.colStart === columnIndex);
    const locked = items.filter((item) => !(item.colSpan === 1 && item.colStart === columnIndex));
    const nextItems = [...locked];

    for (const item of movable) {
      const rowStart = findEarliestRowAtOrAfter(item, 0, nextItems);
      nextItems.push({ ...item, rowStart });
    }

    return sortByVisualOrder(nextItems);
  }

  function getColumnMovableItems(items, columnIndex, ignoreId) {
    return sortByVisualOrder(
      items.filter(
        (item) => item.id !== ignoreId && item.colSpan === 1 && item.colStart === columnIndex,
      ),
    );
  }

  function getColumnDragItems(items, columnIndex, ignoreId) {
    return sortByVisualOrder(
      items.filter((item) => item.id !== ignoreId && touchesColumn(item, columnIndex)),
    );
  }

  function getColumnSlotStart(columnItems, insertionIndex) {
    if (columnItems.length === 0) {
      return 0;
    }

    if (insertionIndex >= columnItems.length) {
      return getRowEnd(columnItems[columnItems.length - 1]);
    }

    return columnItems[insertionIndex].rowStart;
  }

  function shiftColumnRange(items, columnIndex, rangeStart, rangeEnd, deltaRows, ignoreId) {
    const movable = getColumnMovableItems(items, columnIndex, ignoreId);
    const locked = items.filter(
      (item) => !(item.id !== ignoreId && item.colSpan === 1 && item.colStart === columnIndex),
    );
    const nextItems = [...locked];

    for (const item of movable) {
      let nextRow = item.rowStart;

      if (item.rowStart >= rangeStart && item.rowStart < rangeEnd) {
        nextRow = Math.max(0, item.rowStart + deltaRows);
      }

      const rowStart = findEarliestRowAtOrAfter({ ...item, rowStart: nextRow }, nextRow, nextItems);
      nextItems.push({ ...item, rowStart });
    }

    return sortByVisualOrder(nextItems);
  }

  function placeShiftedItems(movable, locked, getRequestedRow) {
    const nextItems = [...locked];
    const touchedColumns = [...new Set(movable.flatMap((item) => getTouchedColumns(item)))];
    const cursorByColumn = createColumnCursor(touchedColumns, 0);

    for (const item of movable) {
      const requestedRow = Math.max(
        getRequestedRow(item),
        getCursorRow(getTouchedColumns(item), cursorByColumn),
      );
      const rowStart = findEarliestRowAtOrAfter({ ...item, rowStart: requestedRow }, requestedRow, nextItems);
      const nextItem = { ...item, rowStart };

      nextItems.push(nextItem);
      updateColumnCursor(cursorByColumn, nextItem);
    }

    return sortByVisualOrder(nextItems);
  }

  function shiftDragItems(items, touchedColumns, rangeStart, rangeEnd, deltaRows, ignoreId) {
    const columnSet = new Set(touchedColumns);
    const movableIds = new Set();

    for (const columnIndex of columnSet) {
      for (const item of getColumnDragItems(items, columnIndex, ignoreId)) {
        movableIds.add(item.id);
      }
    }

    const movable = sortByVisualOrder(items.filter((item) => movableIds.has(item.id)));
    const locked = items.filter((item) => !movableIds.has(item.id));

    return placeShiftedItems(movable, locked, (item) => {
      if (item.rowStart >= rangeStart && item.rowStart < rangeEnd) {
        return Math.max(0, item.rowStart + deltaRows);
      }

      return item.rowStart;
    });
  }

  function shiftDragOverlapItems(items, touchedColumns, overlapStart, overlapEnd, deltaRows, ignoreId, excludedIds = []) {
    const columnSet = new Set(touchedColumns);
    const protectedIds = new Set(excludedIds);
    const movable = sortByVisualOrder(
      items.filter(
        (item) =>
          item.id !== ignoreId &&
          !protectedIds.has(item.id) &&
          getTouchedColumns(item).some((columnIndex) => columnSet.has(columnIndex)) &&
          item.rowStart < overlapEnd &&
          getRowEnd(item) > overlapStart,
      ),
    );
    const movableIds = new Set(movable.map((item) => item.id));
    const locked = items.filter((item) => !movableIds.has(item.id));

    return placeShiftedItems(movable, locked, (item) => Math.max(0, item.rowStart + deltaRows));
  }

  function getProtectedTopStackIds(items, touchedColumns, originRowStart) {
    const candidates = sortByVisualOrder(
      items.filter((item) => getTouchedColumns(item).some((columnIndex) => touchedColumns.includes(columnIndex))),
    );

    if (candidates.length === 0) {
      return [];
    }

    const topRow = candidates[0].rowStart;

    if (topRow < originRowStart) {
      return [];
    }

    return candidates.filter((item) => item.rowStart === topRow).map((item) => item.id);
  }

  function isTopOfTouchedStack(item, items) {
    const touchedColumns = getTouchedColumns(item);

    return !items.some(
      (candidate) =>
        candidate.id !== item.id &&
        getTouchedColumns(candidate).some((columnIndex) => touchedColumns.includes(columnIndex)) &&
        candidate.rowStart < item.rowStart,
    );
  }

  function getStackFollowers(originItem, items) {
    const touchedColumns = getTouchedColumns(originItem);

    return sortByVisualOrder(
      items.filter(
        (item) =>
          item.id !== originItem.id &&
          getTouchedColumns(item).some((columnIndex) => touchedColumns.includes(columnIndex)) &&
          item.rowStart > originItem.rowStart,
      ),
    );
  }

  function getDragFollowers(dragSession, items) {
    if (dragSession?.isShiftStack && dragSession.originItem) {
      return getStackFollowers(dragSession.originItem, items);
    }

    const followerIds = new Set(dragSession.followerIds || []);
    const followerById = new Map(items.map((item) => [item.id, item]));

    return (dragSession.followerIds || [])
      .map((itemId) => followerById.get(itemId))
      .filter((item) => item && followerIds.has(item.id));
  }

  function createColumnCursor(columns, initialRow) {
    return new Map(columns.map((columnIndex) => [columnIndex, Math.max(0, initialRow)]));
  }

  function getCursorRow(columns, cursorByColumn) {
    return columns.reduce((maxRow, columnIndex) => Math.max(maxRow, cursorByColumn.get(columnIndex) ?? 0), 0);
  }

  function updateColumnCursor(cursorByColumn, item) {
    const rowEnd = getRowEnd(item);

    for (const columnIndex of getTouchedColumns(item)) {
      if (cursorByColumn.has(columnIndex)) {
        cursorByColumn.set(columnIndex, rowEnd);
      }
    }
  }

  function placeFollowersByLane(followers, occupancy, cursorByColumn) {
    const placed = [];

    for (const follower of followers) {
      const requestedRow = getCursorRow(getTouchedColumns(follower), cursorByColumn);
      const rowStart = findEarliestRowAtOrAfter(follower, requestedRow, occupancy);
      const nextFollower = { ...follower, rowStart };

      placed.push(nextFollower);
      occupancy.push(nextFollower);
      updateColumnCursor(cursorByColumn, nextFollower);
    }

    return placed;
  }

  function previewWideTopStackMove(dragSession, targetRow, items) {
    const draggedItem = getItemById(items, dragSession.itemId);

    if (!draggedItem) {
      return null;
    }

    const followers = getDragFollowers(dragSession, items);
    const movingIds = new Set([draggedItem.id, ...followers.map((item) => item.id)]);
    const contextItems = items.filter((item) => !movingIds.has(item.id));
    const occupancy = [...contextItems];
    const previewDragged = {
      ...draggedItem,
      colStart: dragSession.originItem.colStart,
      rowStart: findEarliestRowAtOrAfter(
        { ...draggedItem, colStart: dragSession.originItem.colStart },
        targetRow,
        occupancy,
      ),
    };
    const touchedColumns = getTouchedColumns(previewDragged);
    const cursorByColumn = createColumnCursor(touchedColumns, getRowEnd(previewDragged));
    const placedFollowers = placeFollowersByLane(followers, occupancy, cursorByColumn);
    const nextItems = sortByVisualOrder([...contextItems, previewDragged, ...placedFollowers]);

    return {
      items: nextItems,
      previewItem: getItemById(nextItems, draggedItem.id),
    };
  }

  function previewTopStackMove(dragSession, targetRow, items) {
    const draggedItem = getItemById(items, dragSession.itemId);

    if (!draggedItem) {
      return null;
    }

    const followers = getDragFollowers(dragSession, items);
    const movingIds = new Set([draggedItem.id, ...followers.map((item) => item.id)]);
    const contextItems = items.filter((item) => !movingIds.has(item.id));
    const sequence = [{ ...draggedItem, colStart: dragSession.originItem.colStart }, ...followers];
    const placed = packSequence(sequence, contextItems, draggedItem.id, targetRow, targetRow);
    let nextItems = sortByVisualOrder([...contextItems, ...placed]);
    const previewDragged = getItemById(nextItems, draggedItem.id);

    if (previewDragged?.colSpan === 2) {
      nextItems = resolveColumnConflicts(nextItems, {
        columnIndex: previewDragged.colStart + 1,
        rowStart: previewDragged.rowStart,
        rowSpan: previewDragged.rowSpan,
        reservedItemId: previewDragged.id,
      });
    }

    return {
      items: nextItems,
      previewItem: nextItems.find((item) => item.id === draggedItem.id),
    };
  }

  function resolveColumnConflicts(items, reservedRegion) {
    const reservedStart = reservedRegion.rowStart;
    const reservedEnd = reservedRegion.rowStart + reservedRegion.rowSpan;
    const movable = items
      .filter(
        (item) =>
          item.id !== reservedRegion.reservedItemId &&
          item.colSpan === 1 &&
          item.colStart === reservedRegion.columnIndex,
      )
      .sort((left, right) => left.rowStart - right.rowStart);
    const locked = items.filter(
      (item) =>
        item.id === reservedRegion.reservedItemId ||
        item.colSpan !== 1 ||
        item.colStart !== reservedRegion.columnIndex,
    );
    const anchorMidpoint = reservedStart + reservedRegion.rowSpan / 2;
    const above = [];
    const below = [];
    const overflow = [];
    const nextItems = [...locked];
    let cursor = 0;

    for (const item of movable) {
      if (itemMidpoint(item) < anchorMidpoint) {
        above.push(item);
      } else {
        below.push(item);
      }
    }

    for (const item of above) {
      const preferredRow = Math.max(cursor, Math.min(item.rowStart, reservedStart - item.rowSpan));
      const rowStart = findEarliestRowAtOrAfter(item, preferredRow, nextItems);

      if (rowStart + item.rowSpan <= reservedStart) {
        nextItems.push({ ...item, rowStart });
        cursor = getRowEnd({ ...item, rowStart });
      } else {
        overflow.push(item);
      }
    }

    for (const item of [...below, ...overflow]) {
      const minRow = item.rowStart < reservedEnd ? reservedEnd : item.rowStart;
      const rowStart = findEarliestRowAtOrAfter(item, minRow, nextItems);
      nextItems.push({ ...item, rowStart });
    }

    return sortByVisualOrder(nextItems);
  }

  function pushResizeOverlapsDown(items, resizedItem) {
    const overlapping = sortByVisualOrder(
      items.filter(
        (item) =>
          item.id !== resizedItem.id &&
          getTouchedColumns(item).some((columnIndex) => touchesColumn(resizedItem, columnIndex)) &&
          item.rowStart < getRowEnd(resizedItem) &&
          getRowEnd(item) > resizedItem.rowStart,
      ),
    );

    if (overlapping.length === 0) {
      return items;
    }

    const overlappingIds = new Set(overlapping.map((item) => item.id));
    const locked = items.filter((item) => !overlappingIds.has(item.id));
    const nextItems = [...locked];

    for (const item of overlapping) {
      const minRow = Math.max(item.rowStart, getRowEnd(resizedItem));
      const rowStart = findEarliestRowAtOrAfter(item, minRow, nextItems);
      nextItems.push({ ...item, rowStart });
    }

    return sortByVisualOrder(nextItems);
  }

  function closeColumnGap(columnIndex, gapStart, gapSpan, items) {
    const movable = getColumnMovableItems(items, columnIndex);
    const locked = items.filter((item) => !(item.colSpan === 1 && item.colStart === columnIndex));
    const nextItems = [...locked];

    for (const item of movable) {
      const minRow = item.rowStart >= gapStart ? Math.max(0, item.rowStart - gapSpan) : item.rowStart;
      const rowStart = findEarliestRowAtOrAfter(item, minRow, nextItems);
      nextItems.push({ ...item, rowStart });
    }

    return sortByVisualOrder(nextItems);
  }

  function collapseColumns(columnIndexes, items) {
    let nextItems = items;

    for (const columnIndex of [...new Set(columnIndexes)].sort((left, right) => left - right)) {
      nextItems = compactColumn(columnIndex, nextItems);
    }

    return sortByVisualOrder(nextItems);
  }

  function computeRowSpan(image, colSpan) {
    const renderedWidth = GRID_SPEC.columnPx * colSpan;
    const renderedHeight = renderedWidth * (image.naturalHeight / image.naturalWidth);
    return Math.max(1, Math.round(renderedHeight / GRID_SPEC.rowPx));
  }

  function placeNewItem(imageMeta, targetPoint, items) {
    const rowSpan = computeRowSpan(imageMeta, 1);
    const nextZIndex = items.reduce((maxZIndex, item) => Math.max(maxZIndex, item.zIndex), 0) + 1;
    const targetCol = targetPoint ? clampColStart(Math.round(targetPoint.x / GRID_SPEC.columnPx), 1) : 0;
    const targetRow = targetPoint ? Math.max(0, Math.round(targetPoint.y / GRID_SPEC.rowPx)) : 0;
    const slot = targetPoint
      ? findNearestOpenSlot(targetCol, targetRow, 1, rowSpan, items)
      : findFirstOpenSlot(1, rowSpan, items);

    const nextItem = {
      id: imageMeta.id || createItemId(),
      src: imageMeta.src,
      naturalWidth: imageMeta.naturalWidth,
      naturalHeight: imageMeta.naturalHeight,
      ...normalizeSourceMeta(imageMeta.sourceUrl, imageMeta.sourceKind),
      crop: normalizeCrop(imageMeta.crop),
      colStart: slot.colStart,
      rowStart: slot.rowStart,
      colSpan: 1,
      rowSpan,
      zIndex: nextZIndex,
    };

    return {
      items: sortByVisualOrder([...items, nextItem]),
      movedItemIds: [nextItem.id],
    };
  }

  function resizeItem(itemId, nextColSpan, items) {
    return resizeItemWithAnchor(itemId, nextColSpan, 'left', items);
  }

  function getExpansionAnchorEdge(edge) {
    return edge === 'left' ? 'right' : 'left';
  }

  function buildResizedItem(currentItem, nextColSpan, anchorEdge, items) {
    const baseItem = currentItem || null;

    if (!baseItem) {
      return null;
    }

    let nextColStart = baseItem.colStart;

    if (nextColSpan === 2) {
      nextColStart = anchorEdge === 'right' ? baseItem.colStart - 1 : baseItem.colStart;
    } else if (baseItem.colSpan === 2) {
      nextColStart = anchorEdge === 'right' ? baseItem.colStart + 1 : baseItem.colStart;
    }

    if (nextColStart < 0 || nextColStart + nextColSpan > GRID_SPEC.maxColumns) {
      return null;
    }

    return {
      ...baseItem,
      colStart: nextColStart,
      colSpan: nextColSpan,
      rowSpan: computeRowSpan(baseItem, nextColSpan),
      zIndex: items.reduce((maxZIndex, item) => Math.max(maxZIndex, item.zIndex), 0) + 1,
    };
  }

  function resizeItemWithAnchor(itemId, nextColSpan, anchorEdge, items) {
    const currentItem = items.find((item) => item.id === itemId);

    if (!currentItem || currentItem.colSpan === nextColSpan) {
      return { items, movedItemIds: [] };
    }

    const oldColumns = getTouchedColumns(currentItem);
    const resizedItem = buildResizedItem(currentItem, nextColSpan, anchorEdge, items);

    if (!resizedItem) {
      return { items, movedItemIds: [] };
    }
    const newColumns = getTouchedColumns(resizedItem);
    const freedColumns = oldColumns.filter((columnIndex) => !newColumns.includes(columnIndex));

    let nextItems = sortByVisualOrder(withItemReplaced(items, resizedItem));

    for (const columnIndex of newColumns) {
      nextItems = resolveColumnConflicts(nextItems, {
        columnIndex,
        rowStart: resizedItem.rowStart,
        rowSpan: resizedItem.rowSpan,
        reservedItemId: resizedItem.id,
      });
    }

    if (nextColSpan > currentItem.colSpan) {
      nextItems = pushResizeOverlapsDown(nextItems, resizedItem);
    }

    if (resizedItem.rowSpan < currentItem.rowSpan) {
      const releasedSpan = currentItem.rowSpan - resizedItem.rowSpan;

      for (const columnIndex of newColumns) {
        nextItems = closeColumnGap(
          columnIndex,
          resizedItem.rowStart + resizedItem.rowSpan,
          releasedSpan,
          nextItems,
        );
      }
    }

    for (const columnIndex of freedColumns) {
      nextItems = closeColumnGap(columnIndex, currentItem.rowStart, currentItem.rowSpan, nextItems);
    }

    return {
      items: nextItems,
      movedItemIds: [itemId],
    };
  }

  function previewExpandDown(itemId, edge, items) {
    const anchorEdge = getExpansionAnchorEdge(edge);
    const result = resizeItemWithAnchor(itemId, 2, anchorEdge, items);
    const previewItem = getItemById(result.items, itemId);

    if (!previewItem || previewItem.colSpan !== 2) {
      return null;
    }

    return {
      ...result,
      previewItem,
    };
  }

  function previewExpandAcross(itemId, edge, items) {
    const currentItem = getItemById(items, itemId);

    if (!currentItem || currentItem.colSpan !== 1) {
      return null;
    }

    const resizedItem = buildResizedItem(currentItem, 2, getExpansionAnchorEdge(edge), items);

    if (!resizedItem) {
      return null;
    }

    const oldColumns = getTouchedColumns(currentItem);
    const newColumns = getTouchedColumns(resizedItem);
    const addedColumn = newColumns.find((columnIndex) => !oldColumns.includes(columnIndex));
    const direction = edge === 'right' ? 1 : -1;

    if (typeof addedColumn !== 'number') {
      return null;
    }

    const displaced = sortByVisualOrder(
      items.filter(
        (item) =>
          item.id !== itemId &&
          touchesColumn(item, addedColumn) &&
          item.rowStart < getRowEnd(resizedItem) &&
          getRowEnd(item) > resizedItem.rowStart,
      ),
    );
    const displacedIds = new Set(displaced.map((item) => item.id));
    let nextItems = sortByVisualOrder(withItemReplaced(items, resizedItem));
    const locked = nextItems.filter((item) => !displacedIds.has(item.id));
    const shifted = [];

    for (const item of displaced) {
      const shiftedItem = {
        ...item,
        colStart: item.colStart + direction,
      };

      if (shiftedItem.colStart < 0 || shiftedItem.colStart + shiftedItem.colSpan > GRID_SPEC.maxColumns) {
        return null;
      }

      if (!rectFits(getItemRect(shiftedItem), [...locked, ...shifted], shiftedItem.id)) {
        return null;
      }

      shifted.push(shiftedItem);
    }

    nextItems = sortByVisualOrder([...locked, ...shifted]);

    for (const columnIndex of oldColumns) {
      nextItems = resolveColumnConflicts(nextItems, {
        columnIndex,
        rowStart: resizedItem.rowStart,
        rowSpan: resizedItem.rowSpan,
        reservedItemId: resizedItem.id,
      });
    }

    return {
      items: nextItems,
      movedItemIds: [itemId, ...displaced.map((item) => item.id)],
      previewItem: getItemById(nextItems, itemId),
    };
  }

  function deleteItem(itemId, items) {
    const currentItem = getItemById(items, itemId);

    if (!currentItem) {
      return items;
    }

    let nextItems = items.filter((item) => item.id !== itemId);

    for (const columnIndex of getTouchedColumns(currentItem)) {
      nextItems = closeColumnGap(columnIndex, currentItem.rowStart, currentItem.rowSpan, nextItems);
    }

    return sortByVisualOrder(nextItems);
  }

  function deleteItems(itemIds, items) {
    const deleteIds = new Set(itemIds);
    const removedItems = sortByVisualOrder(items.filter((item) => deleteIds.has(item.id)));

    if (removedItems.length === 0) {
      return items;
    }

    return closeGapsForRemovedItems(removedItems, items.filter((item) => !deleteIds.has(item.id)));
  }

  function getResizeIntent(resizeSession) {
    if (!resizeSession.pointerBoard) {
      return null;
    }

    const deltaX = resizeSession.pointerBoard.x - resizeSession.startPointerBoard.x;
    const threshold = GRID_SPEC.columnPx * 0.35;
    const { edge, originItem } = resizeSession;

    if (originItem.colSpan === 2) {
      if (edge === 'left' && deltaX >= threshold) {
        return { nextColSpan: 1, anchorEdge: 'right' };
      }

      if (edge === 'right' && deltaX <= -threshold) {
        return { nextColSpan: 1, anchorEdge: 'left' };
      }
    }

    return {
      nextColSpan: originItem.colSpan,
      anchorEdge: originItem.colSpan === 2 ? (edge === 'left' ? 'right' : 'left') : 'left',
    };
  }

  function buildResizeChoiceButtons(anchorItem, edge, previews) {
    const frame = getTileFrame(anchorItem);
    const adjacentColumn =
      edge === 'right'
        ? anchorItem.colStart + anchorItem.colSpan
        : anchorItem.colStart - 1;
    const buttonLeft = adjacentColumn * GRID_SPEC.columnPx + GRID_SPEC.columnPx / 2 - RESIZE_CHOICE_SIZE / 2;
    const stackGap = 10;
    const stackTop = frame.top + frame.height / 2 - RESIZE_CHOICE_SIZE - stackGap / 2;
    const stackBottom = frame.top + frame.height / 2 + stackGap / 2;

    return [
      {
        id: 'across',
        label: edge === 'right' ? '>' : '<',
        title: 'Move adjacent tiles across one column',
        rect: {
          left: buttonLeft,
          top: stackTop,
          width: RESIZE_CHOICE_SIZE,
          height: RESIZE_CHOICE_SIZE,
        },
        available: Boolean(previews.across?.previewItem),
        preview: previews.across,
      },
      {
        id: 'down',
        label: 'v',
        title: 'Push adjacent tiles down',
        rect: {
          left: buttonLeft,
          top: stackBottom,
          width: RESIZE_CHOICE_SIZE,
          height: RESIZE_CHOICE_SIZE,
        },
        available: Boolean(previews.down?.previewItem),
        preview: previews.down,
      },
    ];
  }

  function syncResizeSessionState(resizeSession, items) {
    if (!resizeSession) {
      return;
    }

    resizeSession.mode = 'direct';
    resizeSession.candidateColStart = null;
    resizeSession.candidateItem = null;
    resizeSession.choices = [];

    if (!resizeSession.pointerBoard || resizeSession.originItem.colSpan !== 1) {
      resizeSession.activeChoice = null;
      return;
    }

    const deltaX = resizeSession.pointerBoard.x - resizeSession.startPointerBoard.x;
    const threshold = GRID_SPEC.columnPx * 0.35;
    const crossedThreshold =
      (resizeSession.edge === 'left' && deltaX <= -threshold) ||
      (resizeSession.edge === 'right' && deltaX >= threshold);

    if (!crossedThreshold) {
      resizeSession.activeChoice = null;
      return;
    }

    const downPreview = previewExpandDown(resizeSession.itemId, resizeSession.edge, items);

    if (!downPreview?.previewItem) {
      resizeSession.activeChoice = null;
      return;
    }

    const acrossPreview = previewExpandAcross(resizeSession.itemId, resizeSession.edge, items);
    const choices = buildResizeChoiceButtons(resizeSession.originItem, resizeSession.edge, {
      across: acrossPreview,
      down: downPreview,
    });
    const hoveredChoice = choices.find(
      (choice) => choice.available && pointInRect(resizeSession.pointerBoard, choice.rect),
    );

    resizeSession.mode = 'expand-choice';
    resizeSession.candidateColStart = downPreview.previewItem.colStart;
    resizeSession.candidateItem = downPreview.previewItem;
    resizeSession.choices = choices;

    if (hoveredChoice) {
      resizeSession.activeChoice = hoveredChoice.id;
      return;
    }

    if (!choices.some((choice) => choice.id === resizeSession.activeChoice && choice.available)) {
      resizeSession.activeChoice = null;
    }
  }

  function previewResize(resizeSession, items) {
    if (resizeSession.mode === 'expand-choice') {
      const activeChoice = resizeSession.choices.find(
        (choice) => choice.id === resizeSession.activeChoice && choice.available,
      );

      return {
        items: activeChoice?.preview?.items ?? items,
        previewItem: activeChoice?.preview?.previewItem ?? resizeSession.originItem,
        intent: activeChoice ? { nextColSpan: 2, anchorEdge: getExpansionAnchorEdge(resizeSession.edge) } : null,
        mode: 'expand-choice',
        activeChoice: resizeSession.activeChoice,
        choices: resizeSession.choices,
        candidateItem: resizeSession.candidateItem,
      };
    }

    const intent = getResizeIntent(resizeSession);

    if (!intent) {
      return null;
    }

    const result = resizeItemWithAnchor(
      resizeSession.itemId,
      intent.nextColSpan,
      intent.anchorEdge,
      items,
    );

    return {
      ...result,
      previewItem: getItemById(result.items, resizeSession.itemId),
      intent,
      mode: 'direct',
      activeChoice: null,
      choices: [],
      candidateItem: null,
    };
  }

  function previewDragMove(dragSession, items) {
    if (!dragSession.isShiftStack && dragSession.groupItemIds?.length > 1) {
      const groupPreview = previewGroupDragMove(dragSession, items);

      if (groupPreview?.previewItem) {
        return groupPreview;
      }
    }

    const draggedItem = items.find((item) => item.id === dragSession.itemId);

    if (!draggedItem) {
      return null;
    }

    const dragFrame = getDragFrame(dragSession, draggedItem);

    if (!dragFrame) {
      return null;
    }

    const originItem = dragSession.originItem;
    const pointerCol = dragSession.isShiftStack
      ? originItem.colStart
      : clampColStart(Math.round(dragFrame.gridLeft / GRID_SPEC.columnPx), draggedItem.colSpan);
    const targetRow = Math.max(0, Math.round(dragFrame.gridTop / GRID_SPEC.rowPx));

    if (dragSession.isShiftStack) {
      const stackPreview =
        targetRow < originItem.rowStart
          ? originItem.colSpan === 2
            ? previewWideTopStackMove(dragSession, targetRow, items)
            : previewTopStackMove(dragSession, targetRow, items)
          : targetRow > originItem.rowStart
            ? originItem.colSpan === 2
              ? previewWideTopStackMove(dragSession, targetRow, items)
              : previewTopStackMove(dragSession, targetRow, items)
            : {
                items,
                previewItem: originItem,
              };

      if (stackPreview?.previewItem) {
        return {
          items: stackPreview.items,
          pointerCol,
          pointerRow: Math.max(0, dragFrame.midpointRow),
          previewItem: stackPreview.previewItem,
        };
      }
    }

    const targetColumns = getTouchedColumns({ ...draggedItem, colStart: pointerCol });
    let nextItems = items.filter((item) => item.id !== draggedItem.id);
    const previewRow = targetRow;
    const overlapStart = targetRow;
    const overlapEnd = targetRow + draggedItem.rowSpan;

    if (pointerCol !== originItem.colStart) {
      nextItems = shiftDragOverlapItems(
        nextItems,
        targetColumns,
        overlapStart,
        overlapEnd,
        draggedItem.rowSpan,
        draggedItem.id,
      );
    } else if (targetRow > originItem.rowStart) {
      const protectedIds = isTopOfTouchedStack(originItem, items)
        ? []
        : getProtectedTopStackIds(nextItems, targetColumns, originItem.rowStart);
      nextItems = shiftDragOverlapItems(
        nextItems,
        targetColumns,
        overlapStart,
        overlapEnd,
        -draggedItem.rowSpan,
        draggedItem.id,
        protectedIds,
      );
    } else if (targetRow < originItem.rowStart) {
      nextItems = shiftDragOverlapItems(
        nextItems,
        targetColumns,
        overlapStart,
        overlapEnd,
        draggedItem.rowSpan,
        draggedItem.id,
      );
    }

    const movingItem = {
      ...draggedItem,
      colStart: pointerCol,
      rowStart: findEarliestRowAtOrAfter({ ...draggedItem, colStart: pointerCol }, previewRow, nextItems),
      zIndex: items.reduce((maxZIndex, item) => Math.max(maxZIndex, item.zIndex), 0) + 1,
    };

    nextItems = sortByVisualOrder([...nextItems, movingItem]);

    const previewDragged = nextItems.find((item) => item.id === draggedItem.id);

    if (!previewDragged) {
      return null;
    }

    if (previewDragged.colSpan === 2) {
      nextItems = resolveColumnConflicts(nextItems, {
        columnIndex: previewDragged.colStart + 1,
        rowStart: previewDragged.rowStart,
        rowSpan: previewDragged.rowSpan,
        reservedItemId: previewDragged.id,
      });
    }

    return {
      items: nextItems,
      pointerCol,
      pointerRow: Math.max(0, dragFrame.midpointRow),
      previewItem: nextItems.find((item) => item.id === draggedItem.id),
    };
  }

  function commitDragMove(dragSession, items) {
    const preview = previewDragMove(dragSession, items);

    if (!preview || !preview.previewItem) {
      return items;
    }

    const originItem = dragSession.originItem;
    const previewItem = preview.previewItem;
    const sameSlot =
      previewItem.colStart === originItem.colStart &&
      previewItem.rowStart === originItem.rowStart &&
      previewItem.colSpan === originItem.colSpan;

    if (sameSlot) {
      return items;
    }

    if ((dragSession.groupItemIds?.length ?? 0) > 1) {
      return sortByVisualOrder(preview.items);
    }

    let nextItems = preview.items;
    const movedAcrossColumns = originItem.colStart !== previewItem.colStart;

    if (movedAcrossColumns && !isTopOfTouchedStack(originItem, items)) {
      nextItems = shiftDragItems(
        nextItems,
        getTouchedColumns(originItem),
        originItem.rowStart + originItem.rowSpan,
        Number.POSITIVE_INFINITY,
        -originItem.rowSpan,
        originItem.id,
      );
    }

    return sortByVisualOrder(nextItems);
  }

  function isBoardItem(item) {
    return (
      item &&
      typeof item.id === 'string' &&
      typeof item.src === 'string' &&
      typeof item.naturalWidth === 'number' &&
      typeof item.naturalHeight === 'number' &&
      typeof item.colStart === 'number' &&
      typeof item.rowStart === 'number' &&
      (item.colSpan === 1 || item.colSpan === 2) &&
      typeof item.rowSpan === 'number' &&
      typeof item.zIndex === 'number'
    );
  }

  function loadBoardState() {
    const emptyBoardState = createEmptyBoardState();

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);

      if (!raw) {
        return emptyBoardState;
      }

      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed.items)) {
        return emptyBoardState;
      }

      const items = parsed.items.filter(isBoardItem).map(normalizeBoardItem);

      if (parsed.version === 1) {
        return {
          items,
          layout: { ...DEFAULT_LAYOUT },
        };
      }

      if (parsed.version === 2 || parsed.version === CURRENT_VERSION) {
        return {
          items,
          layout: normalizeLayout(parsed.layout),
        };
      }

      return emptyBoardState;
    } catch {
      return emptyBoardState;
    }
  }

  function saveBoardState() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: CURRENT_VERSION,
          items: state.items.map(normalizeBoardItem),
          layout: normalizeLayout(state.layout),
        }),
      );
    } catch {
      // Ignore storage failures.
    }
  }

  function getBoardRows(items) {
    const occupiedRows = items.reduce((maxRows, item) => Math.max(maxRows, item.rowStart + item.rowSpan), 0);
    return Math.max(GRID_SPEC.minRows, occupiedRows + 4);
  }

  function getClusterBounds(items = state.items) {
    if (!items.length) {
      return null;
    }

    let minLeft = Number.POSITIVE_INFINITY;
    let minTop = Number.POSITIVE_INFINITY;
    let maxRight = Number.NEGATIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;

    for (const item of items) {
      const frame = getTileFrame(item);
      minLeft = Math.min(minLeft, frame.left);
      minTop = Math.min(minTop, frame.top);
      maxRight = Math.max(maxRight, frame.left + frame.width);
      maxBottom = Math.max(maxBottom, frame.top + frame.height);
    }

    return {
      left: minLeft,
      top: minTop,
      right: maxRight,
      bottom: maxBottom,
      width: maxRight - minLeft,
      height: maxBottom - minTop,
    };
  }

  function getStageRect() {
    return refs.stage.getBoundingClientRect();
  }

  function getPointWithinBoard(boardRect, clientX, clientY, offsetX = 0, offsetY = 0) {
    const zoom = getCurrentZoom();

    return {
      x: (clientX - boardRect.left) / zoom - offsetX,
      y: (clientY - boardRect.top) / zoom - offsetY,
    };
  }

  function getImportTargetPoint() {
    if (!refs.shell || !refs.stage) {
      return null;
    }

    const shellRect = refs.shell.getBoundingClientRect();
    const boardRect = getStageRect();
    const hudBottom = refs.hud?.getBoundingClientRect().bottom ?? shellRect.top;
    const clientX = shellRect.left + refs.shell.clientWidth / 2;
    const preferredClientY = shellRect.top + refs.shell.clientHeight / 2;
    const safeClientY = Math.min(
      shellRect.bottom - 24,
      Math.max(hudBottom + 24, preferredClientY),
    );

    return getPointWithinBoard(boardRect, clientX, safeClientY);
  }

  function setImporting(isImporting) {
    state.isImporting = isImporting;
    renderHud();
  }

  function setExportStatus(message = '', tone = 'idle', { isExporting = false, resetAfter = 0 } = {}) {
    if (state.exportState.resetTimer) {
      window.clearTimeout(state.exportState.resetTimer);
      state.exportState.resetTimer = null;
    }

    state.exportState = {
      isExporting,
      message,
      tone,
      resetTimer: null,
    };

    if (resetAfter > 0) {
      state.exportState.resetTimer = window.setTimeout(() => {
        state.exportState = {
          isExporting: false,
          message: '',
          tone: 'idle',
          resetTimer: null,
        };
        renderHud();
      }, resetAfter);
    }

    renderHud();
  }

  function getExportSettings(overrides = {}) {
    return {
      targetEdge: state.exportTargetEdge,
      includeBackground: state.exportIncludeBackground,
      backgroundHex: state.exportBackgroundHex,
      ...overrides,
    };
  }

  function resetExportBackgroundHexDraft() {
    state.exportBackgroundHexDraft = state.exportBackgroundHex;
  }

  function setExportBackgroundHex(nextHex, { syncDraft = true, rerender = true } = {}) {
    state.exportBackgroundHex = normalizeExportBackgroundHex(nextHex, DEFAULT_EXPORT_BACKGROUND_HEX);
    state.layout = {
      ...state.layout,
      exportBackgroundHex: state.exportBackgroundHex,
    };
    saveBoardState();

    if (syncDraft) {
      resetExportBackgroundHexDraft();
    }

    if (rerender) {
      render();
    }
  }

  function commitExportBackgroundHexDraft() {
    if (isValidExportBackgroundHex(state.exportBackgroundHexDraft)) {
      setExportBackgroundHex(state.exportBackgroundHexDraft);
      return;
    }

    resetExportBackgroundHexDraft();
    renderHud();
  }

  function getExportOutputSize(bounds, targetEdge = state.exportTargetEdge) {
    return getExportRenderMetrics(bounds, targetEdge, {
      borderSourcePx: getGapPx(),
      maxTargetEdge: EXPORT_MAX_EDGE,
    });
  }

  function setExportPreviewMessage(message = '') {
    if (!refs.exportPreviewCanvas || !refs.exportPreviewMessage || !refs.exportPreviewFrame) {
      return;
    }

    refs.exportPreviewFrame.dataset.empty = String(Boolean(message));
    refs.exportPreviewCanvas.hidden = Boolean(message);
    refs.exportPreviewMessage.hidden = !message;
    refs.exportPreviewMessage.textContent = message;
  }

  function drawExportPreview(sourceCanvas) {
    if (!refs.exportPreviewCanvas || !refs.exportPreviewFrame) {
      return;
    }

    const availableWidth = Math.max(1, refs.exportPreviewFrame.clientWidth - 24);
    const availableHeight = Math.max(1, refs.exportPreviewFrame.clientHeight - 24);
    const scale = Math.min(availableWidth / sourceCanvas.width, availableHeight / sourceCanvas.height, 1);
    const displayWidth = Math.max(1, Math.round(sourceCanvas.width * scale));
    const displayHeight = Math.max(1, Math.round(sourceCanvas.height * scale));
    const devicePixelRatio = window.devicePixelRatio || 1;
    const previewContext = refs.exportPreviewCanvas.getContext('2d');

    if (!previewContext) {
      setExportPreviewMessage('Preview unavailable.');
      return;
    }

    refs.exportPreviewCanvas.width = Math.max(1, Math.round(displayWidth * devicePixelRatio));
    refs.exportPreviewCanvas.height = Math.max(1, Math.round(displayHeight * devicePixelRatio));
    refs.exportPreviewCanvas.style.width = `${displayWidth}px`;
    refs.exportPreviewCanvas.style.height = `${displayHeight}px`;
    previewContext.setTransform(1, 0, 0, 1, 0, 0);
    previewContext.clearRect(0, 0, refs.exportPreviewCanvas.width, refs.exportPreviewCanvas.height);
    previewContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    previewContext.drawImage(sourceCanvas, 0, 0, displayWidth, displayHeight);
    setExportPreviewMessage('');
  }

  async function createExportRenderSurface({
    items = state.items,
    bounds = getClusterBounds(items),
    targetEdge = state.exportTargetEdge,
    includeBackground = state.exportIncludeBackground,
    backgroundHex = state.exportBackgroundHex,
  } = {}) {
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error('Nothing to export');
    }

    const metrics = getExportOutputSize(bounds, targetEdge);
    const canvas = document.createElement('canvas');
    canvas.width = metrics.width;
    canvas.height = metrics.height;

    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('PNG export is not available in this browser');
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    paintExportBackground(context, {
      width: canvas.width,
      height: canvas.height,
      includeBackground,
      backgroundHex,
      fallbackHex: DEFAULT_EXPORT_BACKGROUND_HEX,
    });
    context.setTransform(metrics.scale, 0, 0, metrics.scale, metrics.borderPx, metrics.borderPx);

    const loadedImages = await Promise.all(
      items.map(async (item) => ({
        item,
        image: await loadImageForExport(item.src),
      })),
    );
    const imageById = new Map(loadedImages.map(({ item, image }) => [item.id, image]));

    for (const item of sortByVisualOrder(items)) {
      const image = imageById.get(item.id);

      if (!image) {
        continue;
      }

      const frame = getTileFrame(item);
      const exportFrame = {
        left: frame.left - bounds.left,
        top: frame.top - bounds.top,
        width: frame.width,
        height: frame.height,
      };
      const geometry = getCropGeometry(item, frame);

      context.save();
      buildRoundedRectPath(context, exportFrame.left, exportFrame.top, exportFrame.width, exportFrame.height, getRadiusPx());
      context.clip();
      context.drawImage(
        image,
        exportFrame.left + geometry.left,
        exportFrame.top + geometry.top,
        geometry.width,
        geometry.height,
      );
      context.restore();
    }

    context.setTransform(1, 0, 0, 1, 0, 0);

    return {
      canvas,
      bounds,
      metrics,
    };
  }

  async function renderExportPreview() {
    if (!state.isExportPanelOpen || !refs.exportPreviewFrame || !refs.exportPreviewCanvas) {
      return;
    }

    const bounds = getClusterBounds();

    if (!bounds) {
      exportPreviewRequestId += 1;
      setExportPreviewMessage('No images to preview.');
      return;
    }

    const requestId = ++exportPreviewRequestId;
    refs.exportPreviewFrame.dataset.loading = 'true';

    try {
      const { canvas } = await createExportRenderSurface(getExportSettings({ bounds }));

      if (requestId !== exportPreviewRequestId || !state.isExportPanelOpen) {
        return;
      }

      drawExportPreview(canvas);
    } catch (error) {
      if (requestId !== exportPreviewRequestId || !state.isExportPanelOpen) {
        return;
      }

      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Preview unavailable.';
      setExportPreviewMessage(message);
    } finally {
      if (requestId === exportPreviewRequestId && refs.exportPreviewFrame) {
        refs.exportPreviewFrame.dataset.loading = 'false';
      }
    }
  }

  function renderExportPanel() {
    if (!refs.exportPanel) {
      return;
    }

    refs.exportPanel.hidden = !state.isExportPanelOpen;

    if (!state.isExportPanelOpen) {
      exportPreviewRequestId += 1;
      setExportPreviewMessage('');
      return;
    }

    positionFloatingPanel(refs.exportPanel);

    const bounds = getClusterBounds();
    const currentWidth = bounds ? Math.max(1, Math.round(bounds.width)) : 0;
    const currentHeight = bounds ? Math.max(1, Math.round(bounds.height)) : 0;
    const output = getExportOutputSize(bounds, state.exportTargetEdge);
    const controlsDisabled = !bounds || state.exportState.isExporting;

    refs.exportCurrentSize.textContent = bounds ? `${currentWidth} x ${currentHeight}px` : 'No images';
    refs.exportOutputSize.textContent = bounds ? `${output.width} x ${output.height}px PNG` : 'No export available';
    refs.exportPreviewFrame.dataset.transparent = String(!state.exportIncludeBackground);

    refs.exportBackgroundModes.querySelectorAll('[data-export-background-mode]').forEach((button) => {
      const shouldIncludeBackground = button.dataset.exportBackgroundMode === 'filled';
      const selected = shouldIncludeBackground === state.exportIncludeBackground;
      button.classList.toggle('board-export-panel__size-button--active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = controlsDisabled;
    });

    for (const button of refs.exportSizeOptions.querySelectorAll('[data-export-edge]')) {
      const edge = Number(button.dataset.exportEdge);
      const selected = edge === state.exportTargetEdge;
      button.classList.toggle('board-export-panel__size-button--active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = controlsDisabled;
    }

    refs.exportConfirm.disabled = controlsDisabled;
    renderExportPreview();
  }

  function renderStatus() {
    refs.title.textContent = settings.title.toUpperCase();
    refs.imageCount.textContent = `${state.items.length} image${state.items.length === 1 ? '' : 's'}`;
    if (state.exportState.isExporting || state.exportState.message) {
      refs.importStatus.textContent = state.exportState.message;
      refs.importStatus.dataset.tone = state.exportState.tone;
      return;
    }

    refs.importStatus.dataset.tone = 'idle';
    if (state.isImporting) {
      refs.importStatus.textContent = 'Importing images...';
      return;
    }

    refs.importStatus.textContent = state.isMobileMode ? 'Fullscreen touch mode' : 'Drop files, links, or paste';
  }

  function renderHintsPanel() {
    if (!refs.hintsList) {
      return;
    }

    refs.hintsList.replaceChildren(
      ...getHudHints().map((hint) => {
        const item = document.createElement('li');
        item.textContent = hint;
        return item;
      }),
    );
  }

  function syncLayoutControls() {
    if (!refs.layoutPanel || !refs.layoutControls) {
      return;
    }

    for (const { key } of LAYOUT_CONTROL_CONFIG) {
      const control = refs.layoutControls[key];
      const value = state.layout?.[key] ?? DEFAULT_LAYOUT[key];

      control.value.textContent = `${value} px`;
      control.range.value = String(value);
    }

    if (refs.layoutBackgroundColor) {
      refs.layoutBackgroundColor.value = state.exportBackgroundHex;
    }

    if (refs.layoutBackgroundHex) {
      refs.layoutBackgroundHex.value = state.exportBackgroundHexDraft;
    }
  }

  function positionFloatingPanel(panel) {
    if (!panel || panel.hidden || !refs.hud || !refs.root) {
      return;
    }

    const hudRect = refs.hud.getBoundingClientRect();
    const rootRect = refs.root.getBoundingClientRect();
    panel.style.left = `${hudRect.left - rootRect.left}px`;
    panel.style.top = `${hudRect.bottom - rootRect.top + 10}px`;
  }

  function renderHud() {
    renderStatus();
    syncLayoutControls();
    renderHintsPanel();
    refs.root?.classList.toggle('is-mobile-mode', state.isMobileMode);

    if (refs.layoutToggle) {
      refs.layoutToggle.setAttribute('aria-expanded', String(state.isLayoutPanelOpen));
      refs.layoutToggle.classList.toggle('board-hud__button--active', state.isLayoutPanelOpen);
    }

    if (refs.hintsToggle) {
      refs.hintsToggle.setAttribute('aria-expanded', String(state.isHintsPanelOpen));
      refs.hintsToggle.classList.toggle('board-hud__button--active', state.isHintsPanelOpen);
    }

    if (refs.exportPng) {
      refs.exportPng.setAttribute('aria-expanded', String(state.isExportPanelOpen));
      refs.exportPng.classList.toggle('board-hud__button--active', state.isExportPanelOpen);
      refs.exportPng.disabled = state.exportState.isExporting || state.items.length === 0;
    }

    if (refs.multiSelectToggle) {
      refs.multiSelectToggle.hidden = !state.isMobileMode;
      refs.multiSelectToggle.setAttribute('aria-pressed', String(isMobileMultiSelectActive()));
      refs.multiSelectToggle.classList.toggle('board-hud__button--active', isMobileMultiSelectActive());
      refs.multiSelectToggle.textContent = isMobileMultiSelectActive() ? 'Done selecting' : 'Multi-select';
    }

    if (refs.layoutPanel) {
      refs.layoutPanel.hidden = !state.isLayoutPanelOpen;
      positionFloatingPanel(refs.layoutPanel);
    }

    if (refs.hintsPanel) {
      refs.hintsPanel.hidden = !state.isHintsPanelOpen;
      positionFloatingPanel(refs.hintsPanel);
    }

    renderExportPanel();
  }

  function renderPlaceholder(previewResult) {
    if (!state.dragSession || (state.dragSession.groupItemIds?.length ?? 0) > 1) {
      return;
    }

    const originItem = state.dragSession.originItem;
    const previewItem = previewResult?.previewItem ?? originItem;
    const sameColumn = previewItem.colStart === originItem.colStart;
    const placeholderItem = sameColumn ? previewItem : originItem;
    const frame = getTileFrame(placeholderItem);
    const placeholder = document.createElement('div');

    placeholder.className = 'board-placeholder';
    placeholder.style.left = `${frame.left}px`;
    placeholder.style.top = `${frame.top}px`;
    placeholder.style.width = `${frame.width}px`;
    placeholder.style.height = `${frame.height}px`;
    refs.stage.appendChild(placeholder);
  }

  function renderAffectedPlaceholders(previewItems) {
    if (!state.dragSession && !state.resizeSession) {
      return;
    }

    const previewById = new Map(previewItems.map((item) => [item.id, item]));
    const activeItemIds = new Set(
      state.dragSession?.groupItemIds?.length
        ? state.dragSession.groupItemIds
        : [state.dragSession?.itemId ?? state.resizeSession?.itemId].filter(Boolean),
    );

    for (const item of state.items) {
      if (activeItemIds.has(item.id)) {
        continue;
      }

      const previewItem = previewById.get(item.id);

      if (!previewItem) {
        continue;
      }

      const changed =
        previewItem.colStart !== item.colStart ||
        previewItem.rowStart !== item.rowStart ||
        previewItem.colSpan !== item.colSpan ||
        previewItem.rowSpan !== item.rowSpan;

      if (!changed) {
        continue;
      }

      const frame = getTileFrame(item);
      const placeholder = document.createElement('div');
      const useAccent = Boolean(state.dragSession?.isShiftStack);

      placeholder.className = `board-placeholder board-placeholder--affected${
        useAccent ? ' board-placeholder--accent' : ''
      }`;
      placeholder.style.left = `${frame.left}px`;
      placeholder.style.top = `${frame.top}px`;
      placeholder.style.width = `${frame.width}px`;
      placeholder.style.height = `${frame.height}px`;
      refs.stage.appendChild(placeholder);
    }
  }

  function renderOverlayControls(selectedItem, frame, previewResult) {
    if (!refs.cropAnchorLayer) {
      return;
    }

    refs.cropAnchorLayer.replaceChildren();

    const viewportTransform = getCurrentViewportTransform();
    const zoom = viewportTransform.zoom;

    if (selectedItem && !state.dragSession && !state.resizeSession && !state.marqueeSession) {
      const session = state.cropAnchorSession?.itemId === selectedItem.id ? state.cropAnchorSession : null;
      const anchorSize = clamp(30 * zoom, 16, 30);
      const anchorDotSize = clamp(anchorSize * 0.27, 5, 8);
      const anchorLogicalSize = anchorSize / zoom;
      const anchorPoint = getViewportFrameRect(
        {
          left: frame.left + frame.width / 2,
          top: frame.top + frame.height - 36 - anchorLogicalSize / 2,
          width: 0,
          height: 0,
        },
        viewportTransform,
      );
      const anchorButton = document.createElement('button');

      anchorButton.type = 'button';
      anchorButton.className = `board-crop-anchor${session ? ' board-crop-anchor--dragging' : ''}`;
      anchorButton.setAttribute('aria-label', 'Adjust crop position');
      anchorButton.innerHTML = '<span class="board-crop-anchor__dot" aria-hidden="true"></span>';
      anchorButton.style.setProperty('--crop-anchor-size', `${anchorSize}px`);
      anchorButton.style.setProperty('--crop-anchor-dot-size', `${anchorDotSize}px`);
      anchorButton.style.left = `${anchorPoint.left + (session?.visualDx ?? 0) * zoom}px`;
      anchorButton.style.top = `${anchorPoint.top + (session?.visualDy ?? 0) * zoom}px`;
      anchorButton.onpointerdown = (event) => startCropAnchorDrag(event, selectedItem.id);
      refs.cropAnchorLayer.appendChild(anchorButton);
    }

    if (state.isMobileMode && state.dragSession?.allowShiftStack) {
      const safeAreaInsets = getSafeAreaInsets();
      const buttonSize = 72;
      const draggedItem = getItemById(state.items, state.dragSession.itemId);
      const previewItem =
        previewResult?.previewItem && previewResult.previewItem.id === state.dragSession.itemId
          ? previewResult.previewItem
          : draggedItem;
      const thumbFrame = previewItem
        ? getViewportFrameRect(getTileFrame(previewItem), viewportTransform)
        : null;
      const thumbButton = document.createElement('button');
      const thumbLeft = thumbFrame
        ? clamp(
            thumbFrame.left + thumbFrame.width / 2 - buttonSize / 2,
            safeAreaInsets.left + 8,
            getViewportWidth() - safeAreaInsets.right - buttonSize - 8,
          )
        : getViewportWidth() - safeAreaInsets.right - buttonSize - 18;
      const thumbTop = thumbFrame
        ? clamp(
            thumbFrame.top + thumbFrame.height - buttonSize / 2,
            safeAreaInsets.top + 8,
            getViewportHeight() - safeAreaInsets.bottom - buttonSize - 8,
          )
        : getViewportHeight() - safeAreaInsets.bottom - buttonSize - 18;

      thumbButton.type = 'button';
      thumbButton.className = `board-mobile-shift-thumb${
        state.dragSession.mobileShiftThumbActive ? ' board-mobile-shift-thumb--active' : ''
      }`;
      thumbButton.textContent = 'Stack';
      thumbButton.setAttribute('aria-pressed', String(Boolean(state.dragSession.mobileShiftThumbActive)));
      thumbButton.style.left = `${thumbLeft}px`;
      thumbButton.style.top = `${thumbTop}px`;
      thumbButton.addEventListener('pointerdown', (event) => {
        if (!state.dragSession) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        state.dragSession.mobileShiftThumbActive = !state.dragSession.mobileShiftThumbActive;
        syncDragShiftStackState(state.dragSession, state.dragSession.keyboardShiftActive);
        renderBoard();
      });
      thumbButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      refs.cropAnchorLayer.appendChild(thumbButton);
    }
  }

  function renderDragPreview(previewResult) {
    if (
      !state.dragSession ||
      !state.dragSession.pointerBoard ||
      (state.dragSession.groupItemIds?.length ?? 0) > 1
    ) {
      return;
    }

    const draggedItem = state.items.find((item) => item.id === state.dragSession.itemId);

    if (!draggedItem) {
      return;
    }

    const previewItem =
      previewResult?.previewItem && previewResult.previewItem.id === draggedItem.id
        ? previewResult.previewItem
        : null;
    const frame = previewItem ? getTileFrame(previewItem) : getDragFrame(state.dragSession, draggedItem);

    if (!frame) {
      return;
    }

    const preview = document.createElement('div');
    preview.className = 'board-drag-preview';
    preview.style.left = `${frame.left}px`;
    preview.style.top = `${frame.top}px`;
    preview.style.width = `${frame.width}px`;
    preview.style.height = `${frame.height}px`;

    const image = document.createElement('img');
    image.className = 'board-media-image';
    image.src = draggedItem.src;
    image.alt = '';
    image.draggable = false;
    applyCropPresentation(image, draggedItem, frame);
    preview.appendChild(image);

    refs.stage.appendChild(preview);
  }

  function renderResizeChoices(previewResult) {
    if (!state.resizeSession || previewResult?.mode !== 'expand-choice') {
      return;
    }

    for (const choice of previewResult.choices || []) {
      const button = document.createElement('div');
      button.className = `board-resize-choice${
        choice.available ? '' : ' board-resize-choice--disabled'
      }${previewResult.activeChoice === choice.id ? ' board-resize-choice--active' : ''}`;
      button.setAttribute('role', 'presentation');
      button.setAttribute('aria-hidden', 'true');
      button.title = choice.title;
      button.style.left = `${choice.rect.left}px`;
      button.style.top = `${choice.rect.top}px`;
      button.style.width = `${choice.rect.width}px`;
      button.style.height = `${choice.rect.height}px`;

      const icon = document.createElement('span');
      icon.className = 'board-resize-choice__icon';
      icon.textContent = choice.label;
      button.appendChild(icon);

      refs.stage.appendChild(button);
    }
  }

  function renderBoard() {
    const dragPreviewResult = state.dragSession ? previewDragMove(state.dragSession, state.items) : null;
    const resizePreviewResult = !state.dragSession && state.resizeSession ? previewResize(state.resizeSession, state.items) : null;
    const previewResult = dragPreviewResult ?? resizePreviewResult;
    const previewItems = previewResult?.items ?? state.items;
    const rows = getBoardRows(previewItems);
    const visibleHeight = getViewportHeight();
    const visibleWidth = getViewportWidth();
    const minScrollableHeight = visibleHeight / Math.max(getCurrentZoom(), ZOOM_MIN) * (1 + VIEWPORT_VERTICAL_BUFFER_FACTOR);
    const logicalBoardHeight = state.isMobileMode
      ? Math.max(rows * GRID_SPEC.rowPx, GRID_SPEC.minRows * GRID_SPEC.rowPx)
      : Math.max(minScrollableHeight, rows * GRID_SPEC.rowPx);
    const currentItemsById = new Map(state.items.map((item) => [item.id, item]));
    const focusBounds = getClusterBounds(previewItems) ?? getFallbackClusterBounds(logicalBoardHeight);
    let viewportTransform = state.isMobileMode
      ? buildMobileViewportState(focusBounds, logicalBoardHeight)
      : {
          zoom: state.zoom,
          offsetX: 0,
          offsetY: 0,
        };

    if (state.isMobileMode && state.dragSession && dragPreviewResult?.previewItem) {
      const previewFrame = getTileFrame(dragPreviewResult.previewItem);
      const nextEdgeState = getNextEdgeSnapState({
        hasBreachedEdge: isFrameNearViewportEdge({
          frame: previewFrame,
          viewportTransform,
          edgeInsetX: MOBILE_EDGE_INSET_X,
          edgeInsetY: MOBILE_EDGE_INSET_Y,
        }),
        isLocked: state.isMobileEdgeZoomLocked,
        zoomOutSteps: state.mobileZoomOutSteps,
      });

      state.isMobileEdgeZoomLocked = nextEdgeState.isLocked;
      if (nextEdgeState.zoomOutSteps !== state.mobileZoomOutSteps) {
        state.mobileZoomOutSteps = nextEdgeState.zoomOutSteps;
        viewportTransform = buildMobileViewportState(focusBounds, logicalBoardHeight);
      }
    } else {
      state.mobileZoomOutSteps = 0;
      state.isMobileEdgeZoomLocked = false;
    }

    state.viewportTransform = state.isMobileMode ? viewportTransform : null;
    state.zoom = viewportTransform.zoom;

    refs.board.style.width = state.isMobileMode
      ? `${visibleWidth}px`
      : `${Math.max(visibleWidth, GRID_WIDTH * state.zoom)}px`;
    refs.board.style.height = state.isMobileMode
      ? `${visibleHeight}px`
      : `${logicalBoardHeight * state.zoom}px`;
    refs.board.style.setProperty('--board-radius', `${getRadiusPx()}px`);
    refs.board.style.setProperty('--board-backdrop-color', state.exportBackgroundHex);
    refs.stage.style.width = `${GRID_WIDTH}px`;
    refs.stage.style.height = `${logicalBoardHeight}px`;
    refs.stage.style.transform = state.isMobileMode
      ? `translate(${viewportTransform.offsetX}px, ${viewportTransform.offsetY}px) scale(${viewportTransform.zoom})`
      : `scale(${state.zoom})`;
    refs.stage.style.setProperty('--board-radius', `${getRadiusPx()}px`);
    refs.stage.style.setProperty('--board-backdrop-color', state.exportBackgroundHex);
    refs.stage.replaceChildren();

    const grid = document.createElement('div');
    grid.className = 'grid-overlay';
    grid.style.setProperty('--grid-row-size', `${GRID_SPEC.rowPx}px`);
    grid.style.setProperty('--grid-column-size', `${GRID_SPEC.columnPx}px`);
    grid.style.setProperty('--grid-height', `${logicalBoardHeight}px`);
    refs.stage.appendChild(grid);

    const selectedIdSet = new Set(getSelectionIds());
    const selectionAnchorId = getSelectionAnchorId();
    const hasMultiSelection = selectedIdSet.size > 1;
    let cropAnchorTarget = null;
    const movingItemIds = new Set(state.dragSession?.groupItemIds || []);
    const isGroupDrag = movingItemIds.size > 1 && !state.dragSession?.isShiftStack;

    for (const item of previewItems) {
      if (state.dragSession && !isGroupDrag && item.id === state.dragSession.itemId) {
        continue;
      }

      const frame = getTileFrame(item);
      const currentItem = currentItemsById.get(item.id);
      const isAffectedPreviewItem =
        Boolean(state.dragSession?.isShiftStack) &&
        Boolean(currentItem) &&
        (item.colStart !== currentItem.colStart ||
          item.rowStart !== currentItem.rowStart ||
          item.colSpan !== currentItem.colSpan ||
          item.rowSpan !== currentItem.rowSpan);
      const isSelected = selectedIdSet.has(item.id);
      const isPrimarySelected = selectionAnchorId === item.id;
      const tile = document.createElement('div');
      tile.className = `board-tile${isSelected ? ' board-tile--selected' : ''}${
        isSelected && hasMultiSelection ? ' board-tile--multi-selected' : ''
      }${isAffectedPreviewItem ? ' board-tile--affected' : ''}`;
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', 'Moodboard image tile');
      tile.dataset.itemId = item.id;
      tile.style.left = `${frame.left}px`;
      tile.style.top = `${frame.top}px`;
      tile.style.width = `${frame.width}px`;
      tile.style.height = `${frame.height}px`;
      tile.style.zIndex = String(item.zIndex);

      const image = document.createElement('img');
      image.className = 'board-media-image';
      image.src = item.src;
      image.alt = '';
      image.draggable = false;
      applyCropPresentation(image, item, frame);
      tile.appendChild(image);

      const shadow = document.createElement('span');
      shadow.className = 'board-tile__shadow';
      tile.appendChild(shadow);

      if (isPrimarySelected && !state.dragSession && !state.resizeSession && !state.marqueeSession) {
        const actions = document.createElement('span');
        actions.className = 'board-tile__actions';
        const selectedCount = selectedIdSet.size;
        const deleteIds = selectedCount > 1 ? [...selectedIdSet] : [item.id];

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'board-tile__delete';
        removeButton.textContent = selectedCount > 1 ? `Delete ${selectedCount}` : 'Delete';
        removeButton.addEventListener('click', (event) => {
          event.stopPropagation();
          state.items = deleteIds.length > 1 ? deleteItems(deleteIds, state.items) : deleteItem(item.id, state.items);
          clearSelection();
          saveBoardState();
          render();
        });
        removeButton.addEventListener('pointerdown', (event) => event.stopPropagation());

        actions.appendChild(removeButton);

        if (selectedCount === 1) {
          cropAnchorTarget = { item, frame };
          const linkButton = document.createElement('button');
          const canOpenLink = item.sourceKind === 'web' && Boolean(item.sourceUrl);
          linkButton.type = 'button';
          linkButton.className = `board-tile__link${
            canOpenLink ? ' board-tile__link--active' : ' board-tile__link--disabled'
          }`;
          linkButton.textContent = 'Link';
          linkButton.disabled = !canOpenLink;
          linkButton.setAttribute(
            'aria-label',
            canOpenLink ? 'Open source link in a new tab' : 'No source link available',
          );
          linkButton.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
          });
          linkButton.addEventListener('click', (event) => {
            event.stopPropagation();
            openItemSource(item);
          });

          const leftHandle = document.createElement('button');
          leftHandle.type = 'button';
          leftHandle.className = 'board-tile__handle board-tile__handle--left';
          leftHandle.setAttribute('aria-label', 'Resize from left edge');
          leftHandle.addEventListener('pointerdown', (event) => startResize(event, item, 'left'));

          const rightHandle = document.createElement('button');
          rightHandle.type = 'button';
          rightHandle.className = 'board-tile__handle board-tile__handle--right';
          rightHandle.setAttribute('aria-label', 'Resize from right edge');
          rightHandle.addEventListener('pointerdown', (event) => startResize(event, item, 'right'));

          const cropSlider = document.createElement('input');
          cropSlider.type = 'range';
          cropSlider.className = 'board-tile__crop-slider';
          cropSlider.min = String(CROP_ZOOM_MIN);
          cropSlider.max = String(CROP_ZOOM_MAX);
          cropSlider.step = String(CROP_ZOOM_STEP);
          cropSlider.value = String(getItemCrop(item).zoom);
          cropSlider.setAttribute('aria-label', 'Crop zoom');
          cropSlider.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
          });
          cropSlider.addEventListener('input', (event) => {
            event.stopPropagation();
            setItemCropZoom(item.id, Number(event.currentTarget.value));
          });
          cropSlider.addEventListener('change', (event) => {
            event.stopPropagation();
            setItemCropZoom(item.id, Number(event.currentTarget.value), { save: true });
          });

          actions.appendChild(leftHandle);
          actions.appendChild(rightHandle);
          actions.appendChild(linkButton);
          actions.appendChild(cropSlider);
        }

        tile.appendChild(actions);
      }

      tile.addEventListener('click', (event) => {
        if (consumeSuppressedClick()) {
          return;
        }

        if (event.target.closest('.board-tile__actions')) {
          return;
        }

        event.stopPropagation();
        if (isMobileMultiSelectActive()) {
          toggleSelection(item.id);
        } else if (event.shiftKey) {
          toggleSelection(item.id);
        } else {
          setSingleSelection(item.id);
        }
        closeFloatingPanels();
        renderBoard();
      });

      tile.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (isMobileMultiSelectActive()) {
            toggleSelection(item.id);
          } else {
            setSingleSelection(item.id);
          }
          closeFloatingPanels();
          renderBoard();
        }
      });

      tile.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('.board-tile__actions')) {
          return;
        }

        if (isMobileMultiSelectActive() && !isItemSelected(item.id)) {
          return;
        }

        startTileDrag(event, item);
      });

      refs.stage.appendChild(tile);
    }

    renderPlaceholder(previewResult);
    renderAffectedPlaceholders(previewItems);
    renderDragPreview(previewResult);
    renderResizeChoices(previewResult);
    renderMarqueeSelection();
    renderOverlayControls(cropAnchorTarget?.item ?? null, cropAnchorTarget?.frame ?? null, previewResult);

    if (previewItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'board-empty-state';
      empty.innerHTML = '<p>Drop images anywhere on the grid.</p><p>Paste screenshots or reference images with Ctrl+V.</p>';
      refs.stage.appendChild(empty);
    }
  }

  function render() {
    renderHud();
    renderBoard();
  }

  function cancelDrag() {
    state.mobileZoomOutSteps = 0;
    state.isMobileEdgeZoomLocked = false;
    state.dragSession = null;
    setWidgetInteractionState('is-dragging', false);
    renderBoard();
  }

  function cancelResize() {
    state.resizeSession = null;
    setWidgetInteractionState('is-resizing', false);
    renderBoard();
  }

  function cancelPan() {
    state.panSession = null;
    setWidgetInteractionState('is-panning', false);
    refs.shell?.classList.remove('board-shell--panning');
  }

  function setLayoutValue(key, nextValue) {
    const snappedValue = snapLayoutValue(nextValue);

    if (state.layout[key] === snappedValue) {
      return;
    }

    state.layout = {
      ...state.layout,
      [key]: snappedValue,
    };
    saveBoardState();
    render();
  }

  function adjustLayoutValue(key, delta) {
    setLayoutValue(key, (state.layout[key] ?? DEFAULT_LAYOUT[key]) + delta);
  }

  function hasOpenFloatingPanel() {
    return state.isLayoutPanelOpen || state.isHintsPanelOpen || state.isExportPanelOpen;
  }

  function setFloatingPanels(layoutOpen, hintsOpen, exportOpen) {
    state.isLayoutPanelOpen = layoutOpen;
    state.isHintsPanelOpen = hintsOpen;
    state.isExportPanelOpen = exportOpen;
  }

  function closeFloatingPanels() {
    if (!hasOpenFloatingPanel()) {
      return;
    }

    exportPreviewRequestId += 1;
    resetExportBackgroundHexDraft();
    setFloatingPanels(false, false, false);
    renderHud();
  }

  function toggleLayoutPanel() {
    const nextOpen = !state.isLayoutPanelOpen;
    setFloatingPanels(nextOpen, false, false);
    renderHud();
  }

  function toggleHintsPanel() {
    const nextOpen = !state.isHintsPanelOpen;
    setFloatingPanels(false, nextOpen, false);
    renderHud();
  }

  function toggleExportPanel() {
    if (!state.items.length || state.exportState.isExporting) {
      return;
    }

    const nextOpen = !state.isExportPanelOpen;
    exportPreviewRequestId += 1;
    resetExportBackgroundHexDraft();
    setFloatingPanels(false, false, nextOpen);
    renderHud();
  }

  function toggleMultiSelectMode() {
    if (!state.isMobileMode) {
      return;
    }

    state.isMultiSelectMode = !state.isMultiSelectMode;
    renderHud();
    renderBoard();
  }

  function getClusterAnchorClientPoint() {
    const shellRect = refs.shell.getBoundingClientRect();
    const bounds = getClusterBounds();
    const viewportTransform = getCurrentViewportTransform();

    if (!bounds) {
      return {
        clientX: shellRect.left + refs.shell.clientWidth / 2,
        clientY: shellRect.top + refs.shell.clientHeight / 2,
      };
    }
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;

    return {
      clientX: shellRect.left + centerX * viewportTransform.zoom + viewportTransform.offsetX - refs.shell.scrollLeft,
      clientY: shellRect.top + centerY * viewportTransform.zoom + viewportTransform.offsetY - refs.shell.scrollTop,
    };
  }

  function buildRoundedRectPath(context, x, y, width, height, radius) {
    const nextRadius = Math.min(radius, width / 2, height / 2);

    context.beginPath();
    context.moveTo(x + nextRadius, y);
    context.arcTo(x + width, y, x + width, y + height, nextRadius);
    context.arcTo(x + width, y + height, x, y + height, nextRadius);
    context.arcTo(x, y + height, x, y, nextRadius);
    context.arcTo(x, y, x + width, y, nextRadius);
    context.closePath();
  }

  function loadImageForExport(src) {
    const cachedImage = exportImageCache.get(src);

    if (cachedImage) {
      return cachedImage;
    }

    const imagePromise = new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('PNG export failed. A remote image may block browser export.'));
      image.src = src;
    });

    exportImageCache.set(src, imagePromise);
    imagePromise.catch(() => {
      if (exportImageCache.get(src) === imagePromise) {
        exportImageCache.delete(src);
      }
    });

    return imagePromise;
  }

  async function exportClusterAsPng({
    targetEdge = state.exportTargetEdge,
    includeBackground = state.exportIncludeBackground,
    backgroundHex = state.exportBackgroundHex,
  } = {}) {
    if (!state.items.length || state.exportState.isExporting) {
      return;
    }

    setExportStatus('Exporting PNG...', 'working', { isExporting: true });

    try {
      const bounds = getClusterBounds();

      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        throw new Error('Nothing to export');
      }

      const { canvas } = await createExportRenderSurface({
        bounds,
        targetEdge,
        includeBackground,
        backgroundHex,
      });

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((nextBlob) => {
          if (!nextBlob) {
            reject(new Error('Browser blocked PNG export. Remote images may not allow export.'));
            return;
          }

          resolve(nextBlob);
        }, 'image/png');
      });

      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = 'moodboard-grid-export.png';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

      setExportStatus('PNG exported.', 'success', { resetAfter: EXPORT_STATUS_DURATION_MS });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'PNG export failed. Remote images may block browser export.';
      setExportStatus(message, 'error', { resetAfter: EXPORT_STATUS_DURATION_MS });
    }
  }

  function setZoom(nextZoom, anchorClientX, anchorClientY) {
    if (!refs.shell || state.isMobileMode) {
      return;
    }

    const normalizedZoom = clampZoom(nextZoom);

    if (normalizedZoom === state.zoom) {
      return;
    }

    const shellRect = refs.shell.getBoundingClientRect();
    const offsetX = anchorClientX - shellRect.left;
    const offsetY = anchorClientY - shellRect.top;
    const logicalX = (refs.shell.scrollLeft + offsetX) / state.zoom;
    const logicalY = (refs.shell.scrollTop + offsetY) / state.zoom;

    state.zoom = normalizedZoom;
    renderBoard();

    refs.shell.scrollLeft = Math.max(0, logicalX * state.zoom - offsetX);
    refs.shell.scrollTop = Math.max(0, logicalY * state.zoom - offsetY);
  }

  function getNormalizedRect(startPoint, endPoint) {
    return {
      left: Math.min(startPoint.x, endPoint.x),
      top: Math.min(startPoint.y, endPoint.y),
      right: Math.max(startPoint.x, endPoint.x),
      bottom: Math.max(startPoint.y, endPoint.y),
    };
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function getMarqueeSelectionIds(startPoint, endPoint, items = state.items) {
    const selectionRect = getNormalizedRect(startPoint, endPoint);

    return items
      .filter((item) => {
        const frame = getTileFrame(item);
        return rectsOverlap(selectionRect, {
          left: frame.left,
          top: frame.top,
          right: frame.left + frame.width,
          bottom: frame.top + frame.height,
        });
      })
      .map((item) => item.id);
  }

  function startMarqueeSelection(event) {
    if (
      event.button !== 0 ||
      state.dragSession ||
      state.resizeSession ||
      state.marqueeSession ||
      !canStartMobileMarquee()
    ) {
      return;
    }

    event.preventDefault();
    const boardRect = getStageRect();
    const startPoint = getPointWithinBoard(boardRect, event.clientX, event.clientY);

    state.marqueeSession = {
      startPoint,
      currentPoint: startPoint,
    };
    setWidgetInteractionState('is-marqueeing', true);
    renderBoard();

    const onPointerMove = (moveEvent) => {
      if (!state.marqueeSession) {
        return;
      }

      const nextBoardRect = getStageRect();
      state.marqueeSession.currentPoint = getPointWithinBoard(nextBoardRect, moveEvent.clientX, moveEvent.clientY);
      setSelection(getMarqueeSelectionIds(state.marqueeSession.startPoint, state.marqueeSession.currentPoint));
      renderBoard();
    };

    const finishSelection = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);

      if (!state.marqueeSession) {
        return;
      }

      setSelection(getMarqueeSelectionIds(state.marqueeSession.startPoint, state.marqueeSession.currentPoint));
      state.marqueeSession = null;
      state.suppressNextClick = true;
      setWidgetInteractionState('is-marqueeing', false);
      renderBoard();
    };

    const onPointerUp = () => {
      finishSelection();
    };

    const onPointerCancel = () => {
      finishSelection();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function renderMarqueeSelection() {
    if (!state.marqueeSession) {
      return;
    }

    const rect = getNormalizedRect(state.marqueeSession.startPoint, state.marqueeSession.currentPoint);
    const marquee = document.createElement('div');
    marquee.className = 'board-marquee';
    marquee.style.left = `${rect.left}px`;
    marquee.style.top = `${rect.top}px`;
    marquee.style.width = `${rect.right - rect.left}px`;
    marquee.style.height = `${rect.bottom - rect.top}px`;
    refs.stage.appendChild(marquee);
  }

  function closeGapsForRemovedItems(removedItems, items) {
    let nextItems = items;

    for (const removedItem of sortByVisualOrder(removedItems)) {
      for (const columnIndex of getTouchedColumns(removedItem)) {
        nextItems = closeColumnGap(columnIndex, removedItem.rowStart, removedItem.rowSpan, nextItems);
      }
    }

    return nextItems;
  }

  function previewGroupDragMove(dragSession, items) {
    const groupItems = dragSession.originGroupItems || [];

    if (groupItems.length < 2) {
      return null;
    }

    const draggedItem = getItemById(items, dragSession.itemId);

    if (!draggedItem) {
      return null;
    }

    const dragFrame = getDragFrame(dragSession, draggedItem);

    if (!dragFrame) {
      return null;
    }

    const minColStart = Math.min(...groupItems.map((item) => item.colStart));
    const maxColEnd = Math.max(...groupItems.map((item) => item.colStart + item.colSpan));
    const minRowStart = Math.min(...groupItems.map((item) => item.rowStart));
    const desiredCol = clampColStart(Math.round(dragFrame.gridLeft / GRID_SPEC.columnPx), draggedItem.colSpan);
    const desiredRow = Math.max(0, Math.round(dragFrame.gridTop / GRID_SPEC.rowPx));
    const deltaCol = clamp(
      desiredCol - dragSession.originItem.colStart,
      -minColStart,
      GRID_SPEC.maxColumns - maxColEnd,
    );
    const deltaRow = Math.max(-minRowStart, desiredRow - dragSession.originItem.rowStart);
    const groupIds = new Set(groupItems.map((item) => item.id));
    const contextItems = items.filter((item) => !groupIds.has(item.id));

    const previewGroupItems = groupItems.map((item) => ({
      ...item,
      colStart: item.colStart + deltaCol,
      rowStart: item.rowStart + deltaRow,
    }));
    const nextItems = sortByVisualOrder([...contextItems, ...previewGroupItems]);

    return {
      items: nextItems,
      pointerCol: previewGroupItems[0]?.colStart ?? dragSession.originItem.colStart,
      pointerRow: Math.max(0, dragFrame.midpointRow),
      previewItem: nextItems.find((item) => item.id === dragSession.itemId),
    };
  }

  function startCropAnchorDrag(event, itemId) {
    if (event.button !== 0 || state.dragSession || state.resizeSession || state.marqueeSession) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeFloatingPanels();

    const item = getItemById(state.items, itemId);

    if (!item) {
      return;
    }

    const frame = getTileFrame(item);

    const startCrop = getItemCrop(item);
    const geometry = getCropGeometry(item, frame, startCrop);

    state.cropAnchorSession = {
      itemId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop,
      maxTranslateX: geometry.maxTranslateX,
      maxTranslateY: geometry.maxTranslateY,
      visualDx: 0,
      visualDy: 0,
    };
    renderBoard();

    const onPointerMove = (moveEvent) => {
      if (!state.cropAnchorSession || state.cropAnchorSession.itemId !== item.id) {
        return;
      }

      const zoom = getCurrentZoom();
      const deltaX = (moveEvent.clientX - state.cropAnchorSession.startClientX) / zoom;
      const deltaY = (moveEvent.clientY - state.cropAnchorSession.startClientY) / zoom;
      state.cropAnchorSession.visualDx = deltaX;
      state.cropAnchorSession.visualDy = deltaY;

      updateItemCrop(item.id, {
        zoom: state.cropAnchorSession.startCrop.zoom,
        offsetX: state.cropAnchorSession.maxTranslateX
          ? state.cropAnchorSession.startCrop.offsetX + deltaX / state.cropAnchorSession.maxTranslateX
          : 0,
        offsetY: state.cropAnchorSession.maxTranslateY
          ? state.cropAnchorSession.startCrop.offsetY + deltaY / state.cropAnchorSession.maxTranslateY
          : 0,
      });
      renderBoard();
    };

    const finishDrag = (shouldSave) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);

      if (!state.cropAnchorSession || state.cropAnchorSession.itemId !== item.id) {
        return;
      }

      if (!shouldSave) {
        updateItemCrop(item.id, state.cropAnchorSession.startCrop);
      }

      state.cropAnchorSession = null;

      if (shouldSave) {
        saveBoardState();
      }

      renderBoard();
    };

    const onPointerUp = (upEvent) => {
      upEvent.preventDefault();
      finishDrag(true);
    };

    const onPointerCancel = () => {
      finishDrag(false);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function startMiddlePan(event) {
    if (
      state.isMobileMode ||
      event.button !== 1 ||
      state.dragSession ||
      state.resizeSession ||
      state.panSession ||
      !refs.shell ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }

    event.preventDefault();
    closeFloatingPanels();

    state.panSession = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: refs.shell.scrollLeft,
      startScrollTop: refs.shell.scrollTop,
    };
    setWidgetInteractionState('is-panning', true);
    refs.shell.classList.add('board-shell--panning');

    const onPointerMove = (moveEvent) => {
      if (!state.panSession || moveEvent.pointerId !== state.panSession.pointerId || !refs.shell) {
        return;
      }

      moveEvent.preventDefault();
      const deltaX = moveEvent.clientX - state.panSession.startClientX;
      const deltaY = moveEvent.clientY - state.panSession.startClientY;

      refs.shell.scrollLeft = state.panSession.startScrollLeft - deltaX;
      refs.shell.scrollTop = state.panSession.startScrollTop - deltaY;
    };

    const stopPan = (pointerId) => {
      if (!state.panSession || state.panSession.pointerId !== pointerId) {
        return;
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      cancelPan();
    };

    const onPointerUp = (upEvent) => {
      upEvent.preventDefault();
      stopPan(upEvent.pointerId);
    };

    const onPointerCancel = (cancelEvent) => {
      stopPan(cancelEvent.pointerId);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function startTileDrag(event, item) {
    const tile = event.currentTarget;
    const tileRect = tile.getBoundingClientRect();
    const boardRect = getStageRect();
    const selectionIds = getSelectionIds();
    const isMultiSelectedDrag = isItemSelected(item.id) && selectionIds.length > 1;
    const shouldGroupDrag = isMultiSelectedDrag;
    const selectedGroupItems = shouldGroupDrag
      ? sortByVisualOrder(getSelectedItems(state.items))
      : [{ ...item }];

    if (!event.shiftKey && (!isItemSelected(item.id) || !shouldGroupDrag)) {
      setSingleSelection(item.id);
    }

    closeFloatingPanels();

    state.dragSession = {
      itemId: item.id,
      pointerId: event.pointerId,
      offsetX: (event.clientX - tileRect.left) / getCurrentZoom(),
      offsetY: (event.clientY - tileRect.top) / getCurrentZoom(),
      originItem: { ...item },
      allowShiftStack: !isMultiSelectedDrag,
      isShiftStack: false,
      keyboardShiftActive: false,
      mobileShiftThumbActive: false,
      followerIds: getStackFollowers(item, state.items).map((candidate) => candidate.id),
      pointerBoard: getPointWithinBoard(boardRect, event.clientX, event.clientY),
      startPointerBoard: getPointWithinBoard(boardRect, event.clientX, event.clientY),
      didMove: false,
      groupItemIds: selectedGroupItems.map((groupItem) => groupItem.id),
      originGroupItems: selectedGroupItems.map((groupItem) => ({ ...groupItem })),
    };
    syncDragShiftStackState(state.dragSession, event.shiftKey);
    setWidgetInteractionState('is-dragging', true);
    renderBoard();

    const onPointerMove = (moveEvent) => {
      if (!state.dragSession || moveEvent.pointerId !== state.dragSession.pointerId) {
        return;
      }

      const nextBoardRect = getStageRect();
      syncDragShiftStackState(state.dragSession, moveEvent.shiftKey);
      state.dragSession.pointerBoard = getPointWithinBoard(nextBoardRect, moveEvent.clientX, moveEvent.clientY);
      const deltaX = state.dragSession.pointerBoard.x - state.dragSession.startPointerBoard.x;
      const deltaY = state.dragSession.pointerBoard.y - state.dragSession.startPointerBoard.y;
      if (!state.dragSession.didMove && Math.hypot(deltaX, deltaY) >= 4 / getCurrentZoom()) {
        state.dragSession.didMove = true;
      }
      renderBoard();
    };

    const onPointerUp = (upEvent) => {
      if (!state.dragSession || upEvent.pointerId !== state.dragSession.pointerId) {
        return;
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);

      if (!state.dragSession) {
        return;
      }

      const nextBoardRect = getStageRect();
      const visibleBoardRect = refs.board.getBoundingClientRect();
      const isInsideBoard =
        upEvent.clientX >= visibleBoardRect.left &&
        upEvent.clientX <= visibleBoardRect.right &&
        upEvent.clientY >= visibleBoardRect.top &&
        upEvent.clientY <= visibleBoardRect.bottom;

      if (!isInsideBoard) {
        cancelDrag();
        return;
      }

      syncDragShiftStackState(state.dragSession, upEvent.shiftKey);
      state.dragSession.pointerBoard = getPointWithinBoard(nextBoardRect, upEvent.clientX, upEvent.clientY);
      const didMove = state.dragSession.didMove;
      const itemId = state.dragSession.itemId;
      const shouldToggleSelection = !didMove && upEvent.shiftKey;

      if (shouldToggleSelection) {
        toggleSelection(itemId);
      } else {
        state.items = commitDragMove(state.dragSession, state.items);
        setSelection(state.dragSession.groupItemIds || [state.dragSession.itemId], state.dragSession.itemId);
      }
      state.suppressNextClick = Boolean(didMove || shouldToggleSelection);
      state.mobileZoomOutSteps = 0;
      state.isMobileEdgeZoomLocked = false;
      state.dragSession = null;
      setWidgetInteractionState('is-dragging', false);
      if (didMove) {
        saveBoardState();
      }
      render();
    };

    const onPointerCancel = (cancelEvent) => {
      if (!state.dragSession || cancelEvent.pointerId !== state.dragSession.pointerId) {
        return;
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      cancelDrag();
    };

    const onKeyDown = (keyEvent) => {
      if (!state.dragSession) {
        return;
      }

      if (keyEvent.key === 'Shift' && state.dragSession.allowShiftStack && !state.dragSession.keyboardShiftActive) {
        syncDragShiftStackState(state.dragSession, true);
        renderBoard();
      }
    };

    const onKeyUp = (keyEvent) => {
      if (!state.dragSession) {
        return;
      }

      if (keyEvent.key === 'Shift' && state.dragSession.allowShiftStack && state.dragSession.keyboardShiftActive) {
        syncDragShiftStackState(state.dragSession, false);
        renderBoard();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  function startResize(event, item, edge) {
    event.stopPropagation();
    event.preventDefault();
    setSingleSelection(item.id);
    closeFloatingPanels();

    const boardRect = getStageRect();
    const startPointerBoard = getPointWithinBoard(boardRect, event.clientX, event.clientY);

    state.resizeSession = {
      itemId: item.id,
      pointerId: event.pointerId,
      edge,
      originItem: { ...item },
      startPointerBoard,
      pointerBoard: startPointerBoard,
      mode: 'direct',
      candidateColStart: null,
      candidateItem: null,
      activeChoice: null,
      choices: [],
    };
    syncResizeSessionState(state.resizeSession, state.items);
    setWidgetInteractionState('is-resizing', true);
    renderBoard();

    const onPointerMove = (moveEvent) => {
      if (!state.resizeSession || moveEvent.pointerId !== state.resizeSession.pointerId) {
        return;
      }

      const nextBoardRect = getStageRect();
      state.resizeSession.pointerBoard = getPointWithinBoard(nextBoardRect, moveEvent.clientX, moveEvent.clientY);
      syncResizeSessionState(state.resizeSession, state.items);
      renderBoard();
    };

    const onPointerUp = (upEvent) => {
      if (!state.resizeSession || upEvent.pointerId !== state.resizeSession.pointerId) {
        return;
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);

      if (!state.resizeSession) {
        return;
      }

      const nextBoardRect = getStageRect();
      const visibleBoardRect = refs.board.getBoundingClientRect();
      state.resizeSession.pointerBoard = getPointWithinBoard(nextBoardRect, upEvent.clientX, upEvent.clientY);
      syncResizeSessionState(state.resizeSession, state.items);

      if (state.resizeSession.mode === 'expand-choice') {
        const activeChoice = state.resizeSession.choices.find(
          (choice) => choice.id === state.resizeSession.activeChoice && choice.available,
        );

        if (!activeChoice?.preview?.items) {
          cancelResize();
          return;
        }

        state.items = activeChoice.preview.items;
        saveBoardState();
        state.resizeSession = null;
        setWidgetInteractionState('is-resizing', false);
        render();
        return;
      }

      const isInsideBoard =
        upEvent.clientX >= visibleBoardRect.left &&
        upEvent.clientX <= visibleBoardRect.right &&
        upEvent.clientY >= visibleBoardRect.top &&
        upEvent.clientY <= visibleBoardRect.bottom;

      if (!isInsideBoard) {
        cancelResize();
        return;
      }

      const preview = previewResize(state.resizeSession, state.items);

      if (preview) {
        state.items = preview.items;
        saveBoardState();
      }

      state.resizeSession = null;
      setWidgetInteractionState('is-resizing', false);
      render();
    };

    const onPointerCancel = (cancelEvent) => {
      if (!state.resizeSession || cancelEvent.pointerId !== state.resizeSession.pointerId) {
        return;
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      cancelResize();
    };

    const onKeyDown = (keyEvent) => {
      if (keyEvent.key === 'Escape') {
        onPointerCancel();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
  }

  function startNewProject() {
    if (!window.confirm('Start a new project? This will clear the current board.')) {
      return;
    }

    state.items = [];
    state.layout = { ...DEFAULT_LAYOUT };
    state.exportBackgroundHex = DEFAULT_LAYOUT.exportBackgroundHex;
    state.exportBackgroundHexDraft = DEFAULT_LAYOUT.exportBackgroundHex;
    state.zoom = getDefaultZoom();
    state.isMultiSelectMode = false;
    state.viewportTransform = null;
    state.mobileZoomOutSteps = 0;
    state.isMobileEdgeZoomLocked = false;
    setFloatingPanels(false, false, false);
    state.exportTargetEdge = EXPORT_MAX_EDGE;
    clearSelection();
    state.dragSession = null;
    state.resizeSession = null;
    state.panSession = null;
    state.marqueeSession = null;
    state.cropAnchorSession = null;
    clearWidgetInteractionStates();
    refs.shell?.classList.remove('board-shell--panning');
    saveBoardState();
    render();
  }

  async function fileToDataUrl(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  function getTextTransfer(dataTransfer, type) {
    try {
      return dataTransfer?.getData(type) || '';
    } catch {
      return '';
    }
  }

  function extractFirstUrl(text) {
    if (typeof text !== 'string') {
      return null;
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const url = sanitizeSourceUrl(trimmed);

      if (url) {
        return url;
      }
    }

    return null;
  }

  function resolveHtmlUrl(value, baseUrl) {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }

    try {
      const url = baseUrl ? new URL(value.trim(), baseUrl) : new URL(value.trim());

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }

      return url.toString();
    } catch {
      return null;
    }
  }

  function extractUrlsFromHtml(html) {
    if (typeof html !== 'string' || !html.trim()) {
      return { imageUrl: null, sourceUrl: null };
    }

    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const baseHref = sanitizeSourceUrl(doc.querySelector('base')?.getAttribute('href'));
      const linkedImage = doc.querySelector('a[href] img[src]');
      const firstImage = linkedImage || doc.querySelector('img[src]');
      const sourceAnchor = linkedImage?.closest('a[href]');
      const imageUrl = resolveHtmlUrl(firstImage?.getAttribute('src'), baseHref);
      const sourceUrl =
        resolveHtmlUrl(sourceAnchor?.getAttribute('href'), baseHref) ||
        imageUrl;

      return { imageUrl, sourceUrl };
    } catch {
      return { imageUrl: null, sourceUrl: null };
    }
  }

  function extractWebDropData(dataTransfer) {
    const htmlPayload = extractUrlsFromHtml(getTextTransfer(dataTransfer, 'text/html'));
    const uriListUrl = extractFirstUrl(getTextTransfer(dataTransfer, 'text/uri-list'));
    const plainTextUrl = extractFirstUrl(getTextTransfer(dataTransfer, 'text/plain'));
    const imageUrl = htmlPayload.imageUrl || uriListUrl || plainTextUrl;
    const sourceUrl = htmlPayload.sourceUrl || uriListUrl || plainTextUrl;

    if (!imageUrl && !sourceUrl) {
      return null;
    }

    return {
      imageUrl: sanitizeSourceUrl(imageUrl),
      sourceUrl: sanitizeSourceUrl(sourceUrl),
    };
  }

  function hasSupportedDropData(dataTransfer) {
    const hasFiles = Array.from(dataTransfer?.types || []).includes('Files');

    if (hasFiles) {
      return true;
    }

    const webData = extractWebDropData(dataTransfer);
    return Boolean(webData?.imageUrl);
  }

  async function imageMetaFromBlob(blob, sourceMeta) {
    const src = await fileToDataUrl(blob);

    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        resolve({
          id: createItemId(),
          src,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          ...normalizeSourceMeta(sourceMeta?.sourceUrl, sourceMeta?.sourceKind),
        });
      };
      image.onerror = () => reject(new Error('Failed to load image'));
      image.src = src;
    });
  }

  async function imageMetaFromUrl(imageUrl, sourceMeta) {
    const src = sanitizeSourceUrl(imageUrl);

    if (!src) {
      throw new Error('Missing image URL');
    }

    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        resolve({
          id: createItemId(),
          src,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          ...normalizeSourceMeta(sourceMeta?.sourceUrl || src, sourceMeta?.sourceKind || 'web'),
        });
      };
      image.onerror = () => reject(new Error('Failed to load image'));
      image.src = src;
    });
  }

  async function insertFiles(files, point, sourceMeta) {
    if (!files.length) {
      return;
    }

    setImporting(true);

    try {
      const metas = await Promise.all(files.map((file) => imageMetaFromBlob(file, sourceMeta)));
      let nextItems = state.items;

      metas.forEach((imageMeta) => {
        nextItems = placeNewItem(imageMeta, point, nextItems).items;
      });

      state.items = nextItems;
      if (metas[metas.length - 1]) {
        setSingleSelection(metas[metas.length - 1].id);
      }
      saveBoardState();
      render();
    } finally {
      setImporting(false);
    }
  }

  async function insertImageUrl(imageUrl, point, sourceMeta) {
    setImporting(true);

    try {
      const imageMeta = await imageMetaFromUrl(imageUrl, sourceMeta);
      state.items = placeNewItem(imageMeta, point, state.items).items;
      setSingleSelection(imageMeta.id);
      saveBoardState();
      render();
    } finally {
      setImporting(false);
    }
  }

  function openImportPicker() {
    if (!refs.importInput) {
      return;
    }

    refs.importInput.value = '';
    refs.importInput.click();
  }

  function buildAppShell() {
    refs.host.classList.add('moodboard-grid-host');
    refs.host.innerHTML = `
      <div class="moodboard-grid" data-widget-id="${widgetId}" tabindex="0">
        <main class="app">
        <div class="board-shell">
          <div class="board-canvas" data-role="board">
            <div class="board-stage" data-role="stage"></div>
            <div class="board-overlay-layer" data-role="overlay-layer"></div>
          </div>
        </div>
        <div class="board-hud" data-role="hud">
          <div class="board-hud__bar">
            <p class="board-hud__title" data-role="title"></p>
            <span class="board-hud__status" data-role="import-status"></span>
            <span class="board-hud__count" data-role="image-count"></span>
          </div>
          <div class="board-hud__rule" aria-hidden="true"></div>
          <div class="board-hud__actions">
            <button type="button" class="board-hud__button" data-role="new-project">Start New Project</button>
            <button type="button" class="board-hud__button" data-role="import-images">Import</button>
            <input type="file" data-role="import-input" accept="image/*" multiple hidden />
            <button
              type="button"
              class="board-hud__button"
              data-role="multi-select-toggle"
              aria-pressed="false"
              hidden
            >Multi-select</button>
            <button
              type="button"
              class="board-hud__button"
              data-role="export-png"
              aria-haspopup="dialog"
              aria-expanded="false"
            >Export PNG</button>
            <button
              type="button"
              class="board-hud__button board-hud__button--layout"
              data-role="layout-toggle"
              aria-haspopup="dialog"
              aria-expanded="false"
            >Edit Layout</button>
            <button
              type="button"
              class="board-hud__button board-hud__button--layout"
              data-role="hints-toggle"
              aria-haspopup="dialog"
              aria-expanded="false"
            >Hints</button>
          </div>
        </div>
        <div class="board-layout-panel" data-role="layout-panel" hidden>
          <p class="board-layout-panel__title">Edit Layout</p>
          ${LAYOUT_CONTROL_CONFIG.map(
            ({ role, label, ariaLabel }) => `
              <div class="board-layout-panel__row">
                <span class="board-layout-panel__label">${label}</span>
                <button type="button" class="board-layout-panel__stepper" data-role="${role}-decrease" aria-label="Decrease ${ariaLabel}">-</button>
                <input
                  type="range"
                  class="board-layout-panel__slider"
                  data-role="${role}-range"
                  min="${LAYOUT_MIN_PX}"
                  max="${LAYOUT_MAX_PX}"
                  step="${LAYOUT_STEP_PX}"
                />
                <button type="button" class="board-layout-panel__stepper" data-role="${role}-increase" aria-label="Increase ${ariaLabel}">+</button>
                <span class="board-layout-panel__value" data-role="${role}-value"></span>
              </div>
            `,
          ).join('')}
          <div class="board-layout-panel__row board-layout-panel__row--color">
            <span class="board-layout-panel__label">Backdrop</span>
            <input
              type="color"
              class="board-export-panel__color-picker"
              data-role="layout-background-color"
              value="${DEFAULT_EXPORT_BACKGROUND_HEX}"
              aria-label="Choose export background colour"
            />
            <input
              type="text"
              class="board-export-panel__hex-input"
              data-role="layout-background-hex"
              value="${DEFAULT_EXPORT_BACKGROUND_HEX}"
              maxlength="7"
              spellcheck="false"
              autocapitalize="characters"
              aria-label="Export background HEX value"
            />
          </div>
        </div>
        <div class="board-export-panel" data-role="export-panel" hidden>
          <p class="board-export-panel__title">Export PNG</p>
          <div class="board-export-panel__preview" data-role="export-preview-frame" data-transparent="false" data-empty="true" data-loading="false">
            <canvas class="board-export-panel__preview-canvas" data-role="export-preview-canvas" hidden></canvas>
            <span class="board-export-panel__preview-message" data-role="export-preview-message">No images to preview.</span>
          </div>
          <div class="board-export-panel__meta">
            <span class="board-export-panel__label">Current cluster</span>
            <span class="board-export-panel__value" data-role="export-current-size"></span>
          </div>
          <div class="board-export-panel__meta">
            <span class="board-export-panel__label">Background</span>
            <div class="board-export-panel__sizes" data-role="export-background-modes">
              <button
                type="button"
                class="board-export-panel__size-button"
                data-export-background-mode="filled"
                aria-pressed="true"
              >Background</button>
              <button
                type="button"
                class="board-export-panel__size-button"
                data-export-background-mode="transparent"
                aria-pressed="false"
              >Transparent</button>
            </div>
          </div>
          <div class="board-export-panel__meta">
            <span class="board-export-panel__label">Longest edge</span>
            <div class="board-export-panel__sizes" data-role="export-size-options">
              ${EXPORT_EDGE_OPTIONS.map(
                (edge) => `
                  <button
                    type="button"
                    class="board-export-panel__size-button"
                    data-export-edge="${edge}"
                  >${edge / 1024}K</button>
                `,
              ).join('')}
            </div>
          </div>
          <div class="board-export-panel__meta">
            <span class="board-export-panel__label">Output PNG</span>
            <span class="board-export-panel__value" data-role="export-output-size"></span>
          </div>
          <div class="board-export-panel__actions">
            <button type="button" class="board-export-panel__action" data-role="export-cancel">Cancel</button>
            <button type="button" class="board-export-panel__action board-export-panel__action--primary" data-role="export-confirm">Export PNG</button>
          </div>
        </div>
        <div class="board-hints-panel" data-role="hints-panel" hidden>
          <p class="board-hints-panel__title">Hints</p>
          <ul class="board-hints-panel__list" data-role="hints-list"></ul>
        </div>
        </main>
      </div>
    `;

    refs.root = refs.host.querySelector('.moodboard-grid');
    root = refs.root;
    const getRoleRef = (role) => refs.root.querySelector(`[data-role="${role}"]`);

    refs.title = getRoleRef('title');
    refs.imageCount = getRoleRef('image-count');
    refs.importStatus = getRoleRef('import-status');
    refs.newProject = getRoleRef('new-project');
    refs.importImages = getRoleRef('import-images');
    refs.importInput = getRoleRef('import-input');
    refs.multiSelectToggle = getRoleRef('multi-select-toggle');
    refs.exportPng = getRoleRef('export-png');
    refs.layoutToggle = getRoleRef('layout-toggle');
    refs.hintsToggle = getRoleRef('hints-toggle');
    refs.layoutPanel = getRoleRef('layout-panel');
    refs.exportPanel = getRoleRef('export-panel');
    refs.hintsPanel = getRoleRef('hints-panel');
    refs.hintsList = getRoleRef('hints-list');
    refs.exportPreviewFrame = getRoleRef('export-preview-frame');
    refs.exportPreviewCanvas = getRoleRef('export-preview-canvas');
    refs.exportPreviewMessage = getRoleRef('export-preview-message');
    refs.exportCurrentSize = getRoleRef('export-current-size');
    refs.exportBackgroundModes = getRoleRef('export-background-modes');
    refs.layoutBackgroundColor = getRoleRef('layout-background-color');
    refs.layoutBackgroundHex = getRoleRef('layout-background-hex');
    refs.exportOutputSize = getRoleRef('export-output-size');
    refs.exportSizeOptions = getRoleRef('export-size-options');
    refs.exportCancel = getRoleRef('export-cancel');
    refs.exportConfirm = getRoleRef('export-confirm');
    refs.layoutControls = Object.fromEntries(
      LAYOUT_CONTROL_CONFIG.map(({ key, role }) => [
        key,
        {
          range: getRoleRef(`${role}-range`),
          value: getRoleRef(`${role}-value`),
          decrease: getRoleRef(`${role}-decrease`),
          increase: getRoleRef(`${role}-increase`),
        },
      ]),
    );
    refs.shell = refs.root.querySelector('.board-shell');
    refs.board = refs.root.querySelector('[data-role="board"]');
    refs.stage = refs.root.querySelector('[data-role="stage"]');
    refs.cropAnchorLayer = refs.root.querySelector('[data-role="overlay-layer"]');
    refs.hud = refs.root.querySelector('[data-role="hud"]');

    if (activeWidgetId === null) {
      setActiveWidget();
    }

    addManagedEventListener(refs.root, 'pointerdown', () => {
      setActiveWidget();
    });
    addManagedEventListener(refs.root, 'focusin', () => {
      setActiveWidget();
    });
    addManagedEventListener(refs.newProject, 'click', startNewProject);
    addManagedEventListener(refs.importImages, 'click', () => {
      setActiveWidget();
      openImportPicker();
    });
    addManagedEventListener(refs.multiSelectToggle, 'click', toggleMultiSelectMode);
    addManagedEventListener(refs.importInput, 'change', async (event) => {
      setActiveWidget();
      const files = Array.from(event.currentTarget.files || []).filter((file) => file.type.startsWith('image/'));

      if (!files.length) {
        event.currentTarget.value = '';
        return;
      }

      await insertFiles(files, getImportTargetPoint(), null);
      event.currentTarget.value = '';
    });
    addManagedEventListener(refs.exportPng, 'click', toggleExportPanel);
    addManagedEventListener(refs.layoutToggle, 'click', () => {
      toggleLayoutPanel();
    });
    addManagedEventListener(refs.hintsToggle, 'click', () => {
      toggleHintsPanel();
    });
    for (const { key } of LAYOUT_CONTROL_CONFIG) {
      const control = refs.layoutControls[key];

      addManagedEventListener(control.range, 'input', (event) => {
        setLayoutValue(key, Number(event.currentTarget.value));
      });
      addManagedEventListener(control.decrease, 'click', () => {
        adjustLayoutValue(key, -LAYOUT_STEP_PX);
      });
      addManagedEventListener(control.increase, 'click', () => {
        adjustLayoutValue(key, LAYOUT_STEP_PX);
      });
    }
    refs.exportSizeOptions.querySelectorAll('[data-export-edge]').forEach((button) => {
      addManagedEventListener(button, 'click', () => {
        state.exportTargetEdge = Number(button.dataset.exportEdge) || EXPORT_MAX_EDGE;
        renderExportPanel();
      });
    });
    refs.exportBackgroundModes.querySelectorAll('[data-export-background-mode]').forEach((button) => {
      addManagedEventListener(button, 'click', () => {
        state.exportIncludeBackground = button.dataset.exportBackgroundMode === 'filled';
        renderExportPanel();
      });
    });
    addManagedEventListener(refs.layoutBackgroundColor, 'input', (event) => {
      setExportBackgroundHex(event.currentTarget.value);
    });
    addManagedEventListener(refs.layoutBackgroundHex, 'input', (event) => {
      state.exportBackgroundHexDraft = event.currentTarget.value.toUpperCase();

      if (isValidExportBackgroundHex(state.exportBackgroundHexDraft)) {
        setExportBackgroundHex(state.exportBackgroundHexDraft, { syncDraft: false, rerender: false });
      }

      render();
    });
    addManagedEventListener(refs.layoutBackgroundHex, 'blur', () => {
      commitExportBackgroundHexDraft();
    });
    addManagedEventListener(refs.layoutBackgroundHex, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitExportBackgroundHexDraft();
        refs.layoutBackgroundHex.blur();
      }
    });
    addManagedEventListener(refs.exportCancel, 'click', () => {
      closeFloatingPanels();
    });
    addManagedEventListener(refs.exportConfirm, 'click', async () => {
      const exportSettings = getExportSettings();
      setFloatingPanels(false, false, false);
      renderHud();
      await exportClusterAsPng(exportSettings);
    });
    updateMobileMode();
    state.zoom = getDefaultZoom();

    addManagedEventListener(
      refs.shell,
      'pointerdown',
      (event) => {
        if (!isFloatingUiTarget(event.target)) {
          closeFloatingPanels();
        }

        startMiddlePan(event);
      },
      true,
    );

    addManagedEventListener(
      refs.shell,
      'mousedown',
      (event) => {
        if (event.button === 1 && !isInteractiveTarget(event.target)) {
          event.preventDefault();
        }
      },
      true,
    );

    addManagedEventListener(
      refs.shell,
      'auxclick',
      (event) => {
        if (event.button === 1 && state.panSession) {
          event.preventDefault();
        }
      },
      true,
    );

    addManagedEventListener(
      refs.shell,
      'wheel',
      (event) => {
        if (state.isMobileMode || !event.ctrlKey || state.dragSession || state.resizeSession || state.panSession) {
          return;
        }

        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        const anchor = getClusterAnchorClientPoint();
        setZoom(state.zoom + direction * ZOOM_STEP, anchor.clientX, anchor.clientY);
      },
      { passive: false },
    );

    addManagedEventListener(refs.stage, 'click', (event) => {
      if (consumeSuppressedClick()) {
        return;
      }

      if (isStageBackgroundTarget(event.target)) {
        clearSelectionAndRefresh();
      }
    });

    addManagedEventListener(refs.stage, 'pointerdown', (event) => {
      if (event.button === 0 && isStageBackgroundTarget(event.target) && canStartMobileMarquee()) {
        startMarqueeSelection(event);
      }
    });

    addManagedEventListener(refs.board, 'click', (event) => {
      if (consumeSuppressedClick()) {
        return;
      }

      if (event.target === refs.board) {
        clearSelectionAndRefresh();
      }
    });

    addManagedEventListener(refs.board, 'pointerdown', (event) => {
      if (event.button === 0 && event.target === refs.board && canStartMobileMarquee()) {
        startMarqueeSelection(event);
      }
    });

    addManagedEventListener(refs.board, 'dragover', (event) => {
      if (hasSupportedDropData(event.dataTransfer)) {
        event.preventDefault();
        refs.board.classList.add('board-canvas--drop');
      }
    });

    addManagedEventListener(refs.board, 'dragleave', (event) => {
      if (!refs.board.contains(event.relatedTarget)) {
        refs.board.classList.remove('board-canvas--drop');
      }
    });

    addManagedEventListener(refs.board, 'drop', async (event) => {
      setActiveWidget();
      event.preventDefault();
      refs.board.classList.remove('board-canvas--drop');

      const webDrop = extractWebDropData(event.dataTransfer);
      const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'));
      const sourceMeta = webDrop?.sourceUrl ? { sourceUrl: webDrop.sourceUrl, sourceKind: 'web' } : null;

      const boardRect = getStageRect();
      const point = getPointWithinBoard(boardRect, event.clientX, event.clientY);

      if (files.length) {
        await insertFiles(files, point, sourceMeta);
        return;
      }

      if (webDrop?.imageUrl) {
        await insertImageUrl(webDrop.imageUrl, point, {
          sourceUrl: webDrop.sourceUrl || webDrop.imageUrl,
          sourceKind: 'web',
        });
      }
    });

    addManagedEventListener(window, 'paste', async (event) => {
      if (!isWidgetActive()) {
        return;
      }

      const files = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file) => file && file.type.startsWith('image/'));

      if (!files.length) {
        return;
      }

      event.preventDefault();
      const webSource = extractWebDropData(event.clipboardData);
      const sourceMeta = webSource?.sourceUrl ? { sourceUrl: webSource.sourceUrl, sourceKind: 'web' } : null;
      await insertFiles(files, null, sourceMeta);
    });

    addManagedEventListener(window, 'resize', () => {
      updateMobileMode();
      state.zoom = clampZoom(state.zoom);
      render();
    });

    addManagedEventListener(document, 'pointerdown', (event) => {
      if (!hasOpenFloatingPanel() || isFloatingUiTarget(event.target) || isTargetInsideWidget(event.target)) {
        return;
      }

      closeFloatingPanels();
    });

    addManagedEventListener(window, 'keydown', (event) => {
      if (event.key === 'Escape' && hasOpenFloatingPanel()) {
        closeFloatingPanels();
      }
    });
  }

  buildAppShell();
  render();

  const instance = {
    container,
    element: refs.root,
    options: { ...settings },
    render,
    destroy() {
      clearWidgetInteractionStates();
      refs.shell?.classList.remove('board-shell--panning');
      for (const removeListener of managedListeners.splice(0)) {
        removeListener();
      }
      if (state.exportState.resetTimer) {
        window.clearTimeout(state.exportState.resetTimer);
      }
      widgetInstances.delete(container);
      if (activeWidgetId === widgetId) {
        activeWidgetId = null;
      }
      refs.host.innerHTML = '';
      refs.host.classList.remove('moodboard-grid-host');
    },
  };

  widgetInstances.set(container, instance);
  return instance;
}

function mountMoodboardGrid(container, options = {}) {
  return createMoodboardGrid(container, options);
}

function autoInitMoodboardGrid(root = document) {
  root.querySelectorAll(AUTO_INIT_SELECTOR).forEach((element) => {
    mountMoodboardGrid(element);
  });
}

const MoodboardGrid = {
  mount: mountMoodboardGrid,
  autoInit: autoInitMoodboardGrid,
};

if (typeof window !== 'undefined') {
  window.MoodboardGrid = MoodboardGrid;
}

export { autoInitMoodboardGrid as autoInit, mountMoodboardGrid as mount };
export default MoodboardGrid;
