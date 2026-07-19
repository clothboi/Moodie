import {
  detectMobileMode,
  getMobileViewportTransform,
  getViewportFrameRect,
} from './mobileViewport.js';
import {
  DEFAULT_EXPORT_BACKGROUND_HEX,
  getExportRenderMetrics,
  isValidExportBackgroundHex,
  normalizeExportBackgroundHex,
  paintExportBackground,
} from './exportUtils.js';

const DEFAULT_STORAGE_KEY = 'moodboard-grid.board';
// Global (not per-board) so the last text/arrow settings a user chose carry
// across every board.
const ANNOTATION_PREFS_STORAGE_KEY = 'moodboard-grid.annotationPrefs';
const DEFAULT_TITLE = 'Moodboard Grid';
const AUTO_INIT_SELECTOR = '[data-moodboard-grid]';
const widgetInstances = new WeakMap();
let nextWidgetId = 1;
let activeWidgetId = null;

// --- Minimal ZIP writer (STORE method, no compression) ----------------------
// Images are already compressed (PNG/JPEG), so storing them uncompressed keeps
// the code tiny while producing a standards-valid archive. Avoids any external
// dependency.
const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBlob(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (arr) => {
    chunks.push(arr);
    offset += arr.length;
  };
  const u16 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = zipCrc32(file.data);
    const size = file.data.length;
    const localOffset = offset;

    push(u32(0x04034b50)); // local file header signature
    push(u16(20)); // version needed to extract
    push(u16(0)); // general purpose flag
    push(u16(0)); // compression method: store
    push(u16(0)); // last mod time
    push(u16(0)); // last mod date
    push(u32(crc));
    push(u32(size)); // compressed size
    push(u32(size)); // uncompressed size
    push(u16(nameBytes.length));
    push(u16(0)); // extra field length
    push(nameBytes);
    push(file.data);

    central.push({ nameBytes, crc, size, localOffset });
  }

  const centralStart = offset;

  for (const entry of central) {
    push(u32(0x02014b50)); // central directory header signature
    push(u16(20)); // version made by
    push(u16(20)); // version needed
    push(u16(0)); // flags
    push(u16(0)); // compression
    push(u16(0)); // mod time
    push(u16(0)); // mod date
    push(u32(entry.crc));
    push(u32(entry.size));
    push(u32(entry.size));
    push(u16(entry.nameBytes.length));
    push(u16(0)); // extra length
    push(u16(0)); // comment length
    push(u16(0)); // disk number start
    push(u16(0)); // internal attributes
    push(u32(0)); // external attributes
    push(u32(entry.localOffset));
    push(entry.nameBytes);
  }

  const centralSize = offset - centralStart;

  push(u32(0x06054b50)); // end of central directory signature
  push(u16(0)); // disk number
  push(u16(0)); // disk with central directory
  push(u16(central.length)); // entries on this disk
  push(u16(central.length)); // total entries
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(0)); // comment length

  return new Blob(chunks, { type: 'application/zip' });
}

function mimeToImageExtension(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
  };
  return map[mime] || 'png';
}

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
    maxColumns: 20,
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
  const ANNOTATION_TEXT_DEFAULTS = {
    color: '#ffffff',
    fontSize: 22,
    width: 220,
    align: 'left',
    font: 'sans',
  };
  // Font stacks chosen to render consistently in the DOM and on the export
  // canvas across macOS + Windows (no web fonts to load).
  const ANNOTATION_FONTS = [
    { id: 'sans', label: 'Sans', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
    { id: 'serif', label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
    { id: 'mono', label: 'Mono', stack: "'Courier New', Courier, monospace" },
    { id: 'condensed', label: 'Condensed', stack: "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif" },
    { id: 'display', label: 'Display', stack: "Impact, Haettenschweiler, 'Arial Black', sans-serif" },
  ];
  const ANNOTATION_ARROW_DEFAULTS = {
    color: '#ffffff',
    weight: 3,
  };
  const ANNOTATION_TEXT_MIN_WIDTH = 24;
  const ANNOTATION_TEXT_MAX_WIDTH = 440;
  const ANNOTATION_FONT_MIN = 10;
  const ANNOTATION_FONT_MAX = 96;
  const ANNOTATION_ARROW_MIN_WEIGHT = 1;
  const ANNOTATION_ARROW_MAX_WEIGHT = 14;
  const ARROW_SIMPLIFY_TOLERANCE = 4;
  const LAYOUT_MIN_PX = 0;
  const LAYOUT_MAX_PX = 24;
  const LAYOUT_STEP_PX = 2;
  const CROP_ZOOM_MIN = 1;
  const CROP_ZOOM_MAX = 2;
  const CROP_ZOOM_STEP = 0.1;
  const ZOOM_MIN = 0.5;
  const MOBILE_ZOOM_MIN = 0.05;
  const ZOOM_MAX = 1.5;
  const ZOOM_STEP = 0.05;
  const EXPORT_MAX_EDGE = 4096;
  const EXPORT_STATUS_DURATION_MS = 2800;
  const EXPORT_EDGE_OPTIONS = [1024, 2048, 3072, 4096];
  const VIEWPORT_VERTICAL_BUFFER_FACTOR = 1;
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
    'Drag the bottom-right handle through the visible snap targets to switch between 1 or 2 columns and the allowed height variants.',
    'Use the bottom slider to zoom the image and drag the floating anchor above to reposition it.',
  ];
  const MOBILE_HUD_HINTS = [
    'Drop files, links, or paste images into the fullscreen board.',
    'Use the vertical zoom rail on the right edge to scale the board instead of pinch zooming.',
    'Use Multi-select in the HUD to tap tiles into a selection or drag a marquee.',
    'Drag a selected tile to move the current selection together.',
    'Use the floating Stack button while dragging a tile to enable the shift-stack move.',
    'Drag the bottom-right handle through the visible snap targets to switch width and step through the allowed height variants, then use the bottom slider to zoom its crop.',
  ];
  const MOBILE_FALLBACK_VISIBLE_COLUMNS = 20;
  const DEFAULT_VISIBLE_COLUMNS = 20;
  const GRID_WIDTH = GRID_SPEC.maxColumns * GRID_SPEC.columnPx;
  const persistedBoardState = loadBoardState();
  const exportImageCache = new Map();
  let exportPreviewRequestId = 0;

  const state = {
    items: persistedBoardState.items,
    layout: persistedBoardState.layout,
    annotations: persistedBoardState.annotations,
    activeTool: null,
    selectedAnnotationId: null,
    editingAnnotationId: null,
    annotationDragSession: null,
    arrowDrawSession: null,
    arrowEndpointSession: null,
    zoom: 1,
    isUtilityPanelOpen: false,
    activeUtilityTab: 'layout',
    isExportPanelOpen: false,
    exportFormat: 'png',
    exportPdfRoundedCorners: true,
    exportTargetEdge: EXPORT_MAX_EDGE,
    exportIncludeBackground: true,
    exportBackgroundHex: persistedBoardState.layout.exportBackgroundHex,
    exportBackgroundHexDraft: persistedBoardState.layout.exportBackgroundHex,
    isMobileMode: false,
    mobileBaseZoom: null,
    mobilePanX: 0,
    mobilePanY: 0,
    isMultiSelectMode: false,
    selectedItemIds: [],
    selectionAnchorId: null,
    isImporting: false,
    viewportTransform: null,
    mobileFitZoom: null,
    _longPressTimer: null,
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
    singleSelectionUiEnabled: false,
  };

  const refs = {
    host: container,
    root: null,
  };

  const annotationTextEls = new Map();
  let arrowSvgEl = null;
  // Last settings the user chose for each annotation kind (colour, size, font,
  // weight), so new text/arrows inherit them. Persisted per board.
  const annotationPrefs = loadAnnotationPrefs();
  // Latest pointer position (client coords), so the T shortcut can drop a text
  // box exactly where the cursor is.
  let lastPointerClient = null;
  // Undo/redo history of board snapshots. Snapshots share the big image `src`
  // strings by reference (only structure/transforms are cloned), so the stack
  // stays cheap even for image-heavy boards.
  const HISTORY_LIMIT = 80;
  const history = { stack: [], index: -1, applying: false };

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
    return refs.shell?.clientWidth || refs.host?.clientWidth || window.innerWidth;
  }

  function getViewportHeight() {
    return refs.shell?.clientHeight || refs.host?.clientHeight || window.innerHeight;
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
    state.mobileBaseZoom = null;
    state.mobilePanX = 0;
    state.mobilePanY = 0;
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
    const fallbackVisibleColumns = state.isMobileMode ? MOBILE_FALLBACK_VISIBLE_COLUMNS : DEFAULT_VISIBLE_COLUMNS;

    return {
      left: 0,
      top: 0,
      width: GRID_SPEC.columnPx * fallbackVisibleColumns,
      height: state.isMobileMode ? logicalBoardHeight : Math.min(logicalBoardHeight, GRID_SPEC.rowPx * 8),
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
      baseZoom: state.mobileBaseZoom,
      sidePadding: MOBILE_VIEWPORT_SIDE_PADDING,
      bottomPadding: MOBILE_VIEWPORT_BOTTOM_PADDING,
      topGap: MOBILE_VIEWPORT_TOP_GAP,
    });
  }

  function applyMobilePanToViewport(viewportTransform, logicalBoardHeight) {
    if (!state.isMobileMode || !viewportTransform) {
      return viewportTransform;
    }

    const stageWidth = GRID_WIDTH * viewportTransform.zoom;
    const stageHeight = logicalBoardHeight * viewportTransform.zoom;
    const minOffsetX = Math.min(viewportTransform.contentLeft, viewportTransform.contentRight - stageWidth);
    const maxOffsetX = Math.max(viewportTransform.contentLeft, viewportTransform.contentRight - stageWidth);
    const minOffsetY = Math.min(viewportTransform.contentTop, viewportTransform.contentBottom - stageHeight);
    const maxOffsetY = Math.max(viewportTransform.contentTop, viewportTransform.contentBottom - stageHeight);
    const offsetX = clamp(viewportTransform.offsetX + state.mobilePanX, minOffsetX, maxOffsetX);
    const offsetY = clamp(viewportTransform.offsetY + state.mobilePanY, minOffsetY, maxOffsetY);

    state.mobilePanX = offsetX - viewportTransform.offsetX;
    state.mobilePanY = offsetY - viewportTransform.offsetY;

    return {
      ...viewportTransform,
      offsetX,
      offsetY,
    };
  }

  function setMobileZoom(nextZoom) {
    if (!state.isMobileMode) {
      return;
    }

    const normalizedZoom = clamp(Math.round(nextZoom / ZOOM_STEP) * ZOOM_STEP, MOBILE_ZOOM_MIN, ZOOM_MAX);

    if (normalizedZoom === state.mobileBaseZoom) {
      return;
    }

    state.mobileBaseZoom = normalizedZoom;
    state.mobilePanX = 0;
    state.mobilePanY = 0;
    render();
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

  function parseHexColor(value) {
    const normalized = normalizeExportBackgroundHex(value, DEFAULT_EXPORT_BACKGROUND_HEX);
    return {
      red: Number.parseInt(normalized.slice(1, 3), 16),
      green: Number.parseInt(normalized.slice(3, 5), 16),
      blue: Number.parseInt(normalized.slice(5, 7), 16),
    };
  }

  function getGridOverlayPalette(backgroundHex = state.exportBackgroundHex) {
    const { red, green, blue } = parseHexColor(backgroundHex);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    const inkRgb = luminance > 0.58 ? '0, 0, 0' : '255, 255, 255';

    return {
      lineColor: `rgba(${inkRgb}, ${luminance > 0.58 ? 0.16 : 0.08})`,
      dotColor: `rgba(${inkRgb}, ${luminance > 0.58 ? 0.3 : 0.34})`,
      subDotColor: `rgba(${inkRgb}, ${luminance > 0.58 ? 0.15 : 0.18})`,
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

  function getFontStack(fontId) {
    const match = ANNOTATION_FONTS.find((font) => font.id === fontId);
    return (match ?? ANNOTATION_FONTS[0]).stack;
  }

  function loadAnnotationPrefs() {
    const prefs = {
      text: {
        color: ANNOTATION_TEXT_DEFAULTS.color,
        fontSize: ANNOTATION_TEXT_DEFAULTS.fontSize,
        font: ANNOTATION_TEXT_DEFAULTS.font,
      },
      arrow: {
        color: ANNOTATION_ARROW_DEFAULTS.color,
        weight: ANNOTATION_ARROW_DEFAULTS.weight,
      },
    };

    try {
      const raw = window.localStorage.getItem(ANNOTATION_PREFS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;

      if (parsed && typeof parsed === 'object') {
        if (parsed.text && typeof parsed.text === 'object') {
          prefs.text.color = normalizeExportBackgroundHex(parsed.text.color, prefs.text.color);
          prefs.text.fontSize = clamp(
            Math.round(Number(parsed.text.fontSize) || prefs.text.fontSize),
            ANNOTATION_FONT_MIN,
            ANNOTATION_FONT_MAX,
          );
          if (ANNOTATION_FONTS.some((font) => font.id === parsed.text.font)) {
            prefs.text.font = parsed.text.font;
          }
        }
        if (parsed.arrow && typeof parsed.arrow === 'object') {
          prefs.arrow.color = normalizeExportBackgroundHex(parsed.arrow.color, prefs.arrow.color);
          prefs.arrow.weight = clamp(
            Math.round(Number(parsed.arrow.weight) || prefs.arrow.weight),
            ANNOTATION_ARROW_MIN_WEIGHT,
            ANNOTATION_ARROW_MAX_WEIGHT,
          );
        }
      }
    } catch {
      // Ignore storage failures — fall back to defaults.
    }

    return prefs;
  }

  function persistAnnotationPrefs() {
    try {
      window.localStorage.setItem(ANNOTATION_PREFS_STORAGE_KEY, JSON.stringify(annotationPrefs));
    } catch {
      // Ignore storage failures.
    }
  }

  // Capture whatever the user just set on an annotation as the default for the
  // next one of the same kind.
  function rememberAnnotationDefaults(annotation) {
    if (!annotation) {
      return;
    }

    if (annotation.type === 'text') {
      annotationPrefs.text.color = annotation.color;
      annotationPrefs.text.fontSize = annotation.fontSize;
      annotationPrefs.text.font = annotation.font;
    } else if (annotation.type === 'arrow') {
      annotationPrefs.arrow.color = annotation.color;
      annotationPrefs.arrow.weight = annotation.weight;
    }

    persistAnnotationPrefs();
  }

  function isAnnotation(annotation) {
    if (!annotation || typeof annotation.id !== 'string') {
      return false;
    }

    if (annotation.type === 'text') {
      return typeof annotation.x === 'number' && typeof annotation.y === 'number';
    }

    if (annotation.type === 'arrow') {
      return (
        Array.isArray(annotation.points) &&
        annotation.points.length >= 2 &&
        annotation.points.every((point) => point && typeof point.x === 'number' && typeof point.y === 'number')
      );
    }

    return false;
  }

  function normalizeAnnotation(annotation) {
    if (annotation.type === 'text') {
      const fontSize = clamp(
        Math.round(typeof annotation.fontSize === 'number' ? annotation.fontSize : ANNOTATION_TEXT_DEFAULTS.fontSize),
        ANNOTATION_FONT_MIN,
        ANNOTATION_FONT_MAX,
      );
      const align = ['left', 'center', 'right'].includes(annotation.align) ? annotation.align : ANNOTATION_TEXT_DEFAULTS.align;
      const font = ANNOTATION_FONTS.some((option) => option.id === annotation.font)
        ? annotation.font
        : ANNOTATION_TEXT_DEFAULTS.font;

      return {
        id: annotation.id,
        type: 'text',
        x: annotation.x,
        y: annotation.y,
        width: Math.max(ANNOTATION_TEXT_MIN_WIDTH, typeof annotation.width === 'number' ? annotation.width : ANNOTATION_TEXT_DEFAULTS.width),
        text: typeof annotation.text === 'string' ? annotation.text : '',
        color: normalizeExportBackgroundHex(annotation.color, ANNOTATION_TEXT_DEFAULTS.color),
        fontSize,
        align,
        font,
      };
    }

    return {
      id: annotation.id,
      type: 'arrow',
      fromTextId: typeof annotation.fromTextId === 'string' ? annotation.fromTextId : null,
      points: annotation.points.map((point) => ({ x: point.x, y: point.y })),
      color: normalizeExportBackgroundHex(annotation.color, ANNOTATION_ARROW_DEFAULTS.color),
      weight: clamp(
        typeof annotation.weight === 'number' ? annotation.weight : ANNOTATION_ARROW_DEFAULTS.weight,
        ANNOTATION_ARROW_MIN_WEIGHT,
        ANNOTATION_ARROW_MAX_WEIGHT,
      ),
    };
  }

  function normalizeAnnotations(annotations) {
    if (!Array.isArray(annotations)) {
      return [];
    }

    return annotations.filter(isAnnotation).map(normalizeAnnotation);
  }

  function createEmptyBoardState() {
    return {
      items: [],
      layout: { ...DEFAULT_LAYOUT },
      annotations: [],
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

    if (selectionIds.length !== 1) {
      state.singleSelectionUiEnabled = false;
    }
  }

  function setSingleSelection(itemId) {
    setSelection(itemId ? [itemId] : [], itemId);
    state.singleSelectionUiEnabled = Boolean(itemId);
  }

  function clearSelection() {
    setSelection([]);
    state.singleSelectionUiEnabled = false;
  }

  function toggleSelection(itemId) {
    const selectionIds = getSelectionIds();

    if (selectionIds.includes(itemId)) {
      setSelection(
        selectionIds.filter((candidateId) => candidateId !== itemId),
        state.selectionAnchorId === itemId ? selectionIds[selectionIds.length - 1] || null : state.selectionAnchorId,
      );
      state.singleSelectionUiEnabled = false;
      return;
    }

    setSelection([...selectionIds, itemId], itemId);
    state.singleSelectionUiEnabled = false;
  }

  function shouldShowSingleSelectionUi(itemId = null) {
    if (!state.singleSelectionUiEnabled) {
      return false;
    }

    const selectionIds = getSelectionIds();

    if (selectionIds.length !== 1) {
      return false;
    }

    return !itemId || selectionIds[0] === itemId;
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
      refs.mobileZoomRail?.contains(target) ||
      refs.utilityPanel?.contains(target) ||
      refs.exportPanel?.contains(target) ||
      refs.selectionToolbar?.contains(target) ||
      refs.toast?.contains(target)
    );
  }

  function getToastState() {
    if (state.exportState.isExporting || state.exportState.message) {
      return {
        message: state.exportState.message,
        tone: state.exportState.tone,
      };
    }

    if (state.isImporting) {
      return {
        message: 'Importing images...',
        tone: 'working',
      };
    }

    return {
      message: '',
      tone: 'idle',
    };
  }

  function getModeSummary() {
    if (state.isMobileMode) {
      return isMobileMultiSelectActive() ? 'Touch canvas · multi-select on' : 'Touch canvas';
    }

    return 'Desktop canvas';
  }

  function getPrimarySelectedItem() {
    const anchorId = getSelectionAnchorId();
    return anchorId ? getItemById(state.items, anchorId) : null;
  }

  function deleteSelection(targetItemId = null) {
    const selectionIds = getSelectionIds();
    const deleteIds = selectionIds.length
      ? selectionIds
      : targetItemId
        ? [targetItemId]
        : [];

    if (!deleteIds.length) {
      return;
    }

    state.items = deleteIds.length > 1 ? deleteItems(deleteIds, state.items) : deleteItem(deleteIds[0], state.items);
    clearSelection();
    saveBoardState();
    render();
  }

  function formatCropZoomLabel(zoom) {
    return `${Math.round(zoom * 100)}%`;
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

  function findPasteSlot(rowSpan, items) {
    if (items.length === 0) {
      return findFirstOpenSlot(1, rowSpan, items);
    }

    const clusterRight = Math.max(...items.map((item) => item.colStart + item.colSpan));
    const clusterLeft = Math.min(...items.map((item) => item.colStart));
    const clusterTop = Math.min(...items.map((item) => item.rowStart));
    const clusterBottom = Math.max(...items.map((item) => item.rowStart + item.rowSpan));

    // 1. Two cols to the right of cluster
    const col2 = clusterRight + 2;
    if (col2 + 1 <= GRID_SPEC.maxColumns && rectFits({ colStart: col2, rowStart: clusterTop, colSpan: 1, rowSpan }, items)) {
      return { colStart: col2, rowStart: clusterTop };
    }

    // 2. One col to the right of cluster
    const col1 = clusterRight + 1;
    if (col1 + 1 <= GRID_SPEC.maxColumns && rectFits({ colStart: col1, rowStart: clusterTop, colSpan: 1, rowSpan }, items)) {
      return { colStart: col1, rowStart: clusterTop };
    }

    // 3. Immediately adjacent right
    if (clusterRight + 1 <= GRID_SPEC.maxColumns && rectFits({ colStart: clusterRight, rowStart: clusterTop, colSpan: 1, rowSpan }, items)) {
      return { colStart: clusterRight, rowStart: clusterTop };
    }

    // 4. Below the cluster (nearest available)
    return findNearestOpenSlot(clusterLeft, clusterBottom, 1, rowSpan, items);
  }

  function placeNewItem(imageMeta, targetPoint, items) {
    const rowSpan = computeRowSpan(imageMeta, 1);
    const nextZIndex = items.reduce((maxZIndex, item) => Math.max(maxZIndex, item.zIndex), 0) + 1;
    const targetCol = targetPoint ? clampColStart(Math.round(targetPoint.x / GRID_SPEC.columnPx), 1) : 0;
    const targetRow = targetPoint ? Math.max(0, Math.round(targetPoint.y / GRID_SPEC.rowPx)) : 0;
    const slot = targetPoint
      ? findNearestOpenSlot(targetCol, targetRow, 1, rowSpan, items)
      : findPasteSlot(rowSpan, items);

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

  function getResizeRowSpanVariants(item, colSpan) {
    const baseRowSpan = computeRowSpan(item, colSpan);
    const delta = colSpan === 2 ? 2 : 1;

    return [
      {
        slot: 'short',
        rowIndex: 0,
        rowSpan: Math.max(1, baseRowSpan - delta),
        projectedRowSpan: baseRowSpan - delta,
      },
      {
        slot: 'base',
        rowIndex: 1,
        rowSpan: baseRowSpan,
        projectedRowSpan: baseRowSpan,
      },
      {
        slot: 'tall',
        rowIndex: 2,
        rowSpan: baseRowSpan + delta,
        projectedRowSpan: baseRowSpan + delta,
      },
    ];
  }

  function getNearestResizeRowSpanVariant(rowSpanVariants, targetRowSpan) {
    return rowSpanVariants.reduce((closestVariant, candidateVariant) => {
      if (!closestVariant) {
        return candidateVariant;
      }

      const currentDistance = Math.abs(candidateVariant.projectedRowSpan - targetRowSpan);
      const closestDistance = Math.abs(closestVariant.projectedRowSpan - targetRowSpan);

      if (currentDistance < closestDistance) {
        return candidateVariant;
      }

      if (
        currentDistance === closestDistance &&
        candidateVariant.projectedRowSpan < closestVariant.projectedRowSpan
      ) {
        return candidateVariant;
      }

      return closestVariant;
    }, null);
  }

  function getResizeVariantForRowSpan(rowSpanVariants, rowSpan) {
    const exactVariant = rowSpanVariants.find((variant) => variant.rowSpan === rowSpan);

    if (exactVariant) {
      return exactVariant;
    }

    return getNearestResizeRowSpanVariant(rowSpanVariants, rowSpan) ?? rowSpanVariants[1] ?? rowSpanVariants[0];
  }

  function getResizeOriginVariant(originItem) {
    const originVariants = getResizeRowSpanVariants(originItem, originItem.colSpan);
    return getResizeVariantForRowSpan(originVariants, originItem.rowSpan);
  }

  function getResizeOriginTargetId(originItem) {
    const originVariant = getResizeOriginVariant(originItem);
    return getResizeTargetId(originItem.colSpan, originVariant?.slot ?? 'base');
  }

  function getResizeTargetId(colSpan, slot) {
    return `resize-${colSpan}-${slot}`;
  }

  function buildResizeOverlayState(resizeSession, items = []) {
    if (!resizeSession?.originItem) {
      return null;
    }

    const originItem = resizeSession.originItem;
    const targets = [1, 2].flatMap((colSpan) =>
      getResizeRowSpanVariants(originItem, colSpan)
        .filter((variant) =>
          rectFits({ colStart: originItem.colStart, rowStart: originItem.rowStart, colSpan, rowSpan: variant.rowSpan }, items, originItem.id),
        )
        .map((variant) => ({
          id: getResizeTargetId(colSpan, variant.slot),
          colSpan,
          rowSpan: variant.rowSpan,
          slot: variant.slot,
          rowIndex: variant.rowIndex,
        })),
    );
    const originTargetId = getResizeOriginTargetId(originItem);

    return {
      activeTargetId: resizeSession.intent?.activeTargetId ?? originTargetId,
      originTargetId,
      targets,
    };
  }

  function getResizeOverlayLayout(resizeSession, viewportTransform = getCurrentViewportTransform()) {
    if (!resizeSession?.originItem) {
      return null;
    }

    const overlay = resizeSession.overlay ?? buildResizeOverlayState(resizeSession);

    if (!overlay) {
      return null;
    }

    const originItem = resizeSession.originItem;
    const zoom = viewportTransform.zoom;
    const thumbBaseSize = state.isMobileMode ? 34 : 28;
    const thumbSize = resizeSession.anchorViewport?.size ?? thumbBaseSize * zoom;
    const handleInset = (state.isMobileMode ? 12 : 10) * zoom;
    const originFrame = getViewportFrameRect(getTileFrame(originItem), viewportTransform);
    const originX = resizeSession.anchorViewport?.x ?? (originFrame.left + originFrame.width - handleInset - thumbSize / 2);
    const originY = resizeSession.anchorViewport?.y ?? (originFrame.top + originFrame.height - handleInset - thumbSize / 2);
    const pointerViewport = resizeSession.pointerBoard
      ? getViewportFrameRect(
          {
            left: resizeSession.pointerBoard.x,
            top: resizeSession.pointerBoard.y,
            width: 0,
            height: 0,
          },
          viewportTransform,
        )
      : null;
    const startPointerViewport = resizeSession.startPointerBoard
      ? getViewportFrameRect(
          {
            left: resizeSession.startPointerBoard.x,
            top: resizeSession.startPointerBoard.y,
            width: 0,
            height: 0,
          },
          viewportTransform,
        )
      : null;
    const targetFrames = overlay.targets.map((target) => {
      const ghostLogical = getTileFrame({ colStart: originItem.colStart, rowStart: originItem.rowStart, colSpan: target.colSpan, rowSpan: target.rowSpan });
      const ghostViewport = getViewportFrameRect(ghostLogical, viewportTransform);
      const centerX = ghostViewport.left + ghostViewport.width - handleInset - thumbSize / 2;
      const centerY = ghostViewport.top + ghostViewport.height - handleInset - thumbSize / 2;

      return {
        ...target,
        left: ghostViewport.left,
        top: ghostViewport.top,
        width: ghostViewport.width,
        height: ghostViewport.height,
        centerX,
        centerY,
      };
    });

    return {
      pointerViewport: pointerViewport
        ? {
            x: pointerViewport.left,
            y: pointerViewport.top,
          }
        : null,
      startPointerViewport: startPointerViewport
        ? {
            x: startPointerViewport.left,
            y: startPointerViewport.top,
          }
        : null,
      targetFrames,
      originX,
      originY,
      thumbSize,
      haloPadding: 0,
      originTargetId: overlay.originTargetId,
    };
  }

  function buildResizedItem(currentItem, nextColSpan, nextRowSpan, items) {
    const baseItem = currentItem || null;

    if (!baseItem) {
      return null;
    }

    const nextColStart = baseItem.colStart;

    if (nextColStart < 0 || nextColStart + nextColSpan > GRID_SPEC.maxColumns) {
      return null;
    }

    return {
      ...baseItem,
      colStart: nextColStart,
      colSpan: nextColSpan,
      rowSpan: Math.max(1, nextRowSpan),
      zIndex: items.reduce((maxZIndex, item) => Math.max(maxZIndex, item.zIndex), 0) + 1,
    };
  }

  function resizeItemToShape(itemId, nextColSpan, nextRowSpan, items) {
    const currentItem = items.find((item) => item.id === itemId);

    if (!currentItem || (currentItem.colSpan === nextColSpan && currentItem.rowSpan === nextRowSpan)) {
      return { items, movedItemIds: [] };
    }

    const oldColumns = getTouchedColumns(currentItem);
    const resizedItem = buildResizedItem(currentItem, nextColSpan, nextRowSpan, items);

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

    if (nextColSpan > currentItem.colSpan || resizedItem.rowSpan > currentItem.rowSpan) {
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

  function getResizeIntent(resizeSession, items = []) {
    if (!resizeSession.pointerBoard) {
      return null;
    }

    const originItem = resizeSession.originItem;
    const overlay = buildResizeOverlayState(resizeSession, items);
    const layout = getResizeOverlayLayout({ ...resizeSession, overlay });
    const movementThreshold = state.isMobileMode ? 10 : 8;
    const hasClearedOriginDeadzone =
      Boolean(layout?.pointerViewport && layout?.startPointerViewport) &&
      Math.hypot(
        layout.pointerViewport.x - layout.startPointerViewport.x,
        layout.pointerViewport.y - layout.startPointerViewport.y,
      ) >= movementThreshold;
    const hoveredTarget = hasClearedOriginDeadzone
      ? overlay.targets
          .filter((target) => {
            const ghostLogical = getTileFrame({ colStart: originItem.colStart, rowStart: originItem.rowStart, colSpan: target.colSpan, rowSpan: target.rowSpan });

            return (
              resizeSession.pointerBoard.x >= ghostLogical.left &&
              resizeSession.pointerBoard.x <= ghostLogical.left + ghostLogical.width &&
              resizeSession.pointerBoard.y >= ghostLogical.top &&
              resizeSession.pointerBoard.y <= ghostLogical.top + ghostLogical.height
            );
          })
          .sort((a, b) => a.colSpan * a.rowSpan - b.colSpan * b.rowSpan)[0] ?? null
      : null;
    const originTarget = overlay.targets.find((target) => target.id === overlay.originTargetId) ?? overlay.targets[0] ?? null;
    const selectedTarget = hoveredTarget ?? originTarget;
    const nextColSpan = selectedTarget?.colSpan ?? originItem.colSpan;
    const rowSpanVariants = getResizeRowSpanVariants(originItem, nextColSpan);
    const nextVariant =
      rowSpanVariants.find((variant) => variant.slot === selectedTarget?.slot) ??
      getResizeVariantForRowSpan(rowSpanVariants, originItem.rowSpan);
    const baseRowSpan = computeRowSpan(originItem, nextColSpan);
    const allowedRowSpans = rowSpanVariants.map((variant) => variant.rowSpan);
    const nextRowSpan = nextVariant?.rowSpan ?? baseRowSpan;

    return {
      nextColSpan,
      nextRowSpan,
      allowedRowSpans,
      baseRowSpan,
      activeSlot: nextVariant?.slot ?? 'base',
      rowSpanVariants,
      activeTargetId: selectedTarget?.id ?? getResizeOriginTargetId(originItem),
      overlayLayout: layout,
      isHoveringTarget: Boolean(hoveredTarget),
    };
  }

  function syncResizeSessionState(resizeSession, items) {
    if (!resizeSession) {
      return;
    }

    resizeSession.intent = getResizeIntent(resizeSession, items);
    resizeSession.overlay = buildResizeOverlayState(resizeSession, items);
    resizeSession.overlayLayout = resizeSession.intent?.overlayLayout ?? getResizeOverlayLayout(resizeSession);
  }

  function previewResize(resizeSession, items) {
    const intent = resizeSession.intent ?? getResizeIntent(resizeSession, items);

    if (!intent) {
      return null;
    }

    const commitResult = resizeItemToShape(resizeSession.itemId, intent.nextColSpan, intent.nextRowSpan, items);
    const previewItem =
      buildResizedItem(resizeSession.originItem, intent.nextColSpan, intent.nextRowSpan, items) ??
      resizeSession.originItem;

    return {
      items,
      commitItems: commitResult.items,
      movedItemIds: commitResult.movedItemIds,
      previewItem,
      intent,
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

  function parseBoardState(parsed) {
    if (!parsed || !Array.isArray(parsed.items)) {
      return null;
    }

    const items = parsed.items.filter(isBoardItem).map(normalizeBoardItem);

    if (parsed.version === 1) {
      return {
        items,
        layout: { ...DEFAULT_LAYOUT },
        annotations: [],
      };
    }

    if (parsed.version === 2 || parsed.version === CURRENT_VERSION) {
      return {
        items,
        layout: normalizeLayout(parsed.layout),
        annotations: normalizeAnnotations(parsed.annotations),
      };
    }

    return null;
  }

  function loadBoardState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);

      if (!raw) {
        return createEmptyBoardState();
      }

      return parseBoardState(JSON.parse(raw)) ?? createEmptyBoardState();
    } catch {
      return createEmptyBoardState();
    }
  }

  function serializeBoard() {
    return {
      version: CURRENT_VERSION,
      items: state.items.map(normalizeBoardItem),
      layout: normalizeLayout(state.layout),
      annotations: state.annotations.map(normalizeAnnotation),
    };
  }

  function saveBoardState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeBoard()));
    } catch {
      // Ignore storage failures.
    }
    recordHistory();
  }

  // --- Undo / redo ------------------------------------------------------------

  function cloneItemForHistory(item) {
    return { ...item, crop: item.crop ? { ...item.crop } : item.crop };
  }

  function cloneAnnotationForHistory(annotation) {
    return annotation.type === 'arrow'
      ? { ...annotation, points: annotation.points.map((point) => ({ x: point.x, y: point.y })) }
      : { ...annotation };
  }

  function snapshotBoard() {
    return {
      items: state.items.map(cloneItemForHistory),
      layout: { ...state.layout },
      annotations: state.annotations.map(cloneAnnotationForHistory),
    };
  }

  // Signature of everything that can change EXCEPT image bytes (which never
  // change for an existing id), used to skip recording no-op saves cheaply.
  function boardSignature() {
    const items = state.items.map((it) => [
      it.id, it.colStart, it.rowStart, it.colSpan, it.rowSpan, it.zIndex,
      it.crop?.zoom, it.crop?.offsetX, it.crop?.offsetY,
    ]);
    const annotations = state.annotations.map((a) =>
      a.type === 'text'
        ? ['t', a.id, a.x, a.y, a.width, a.text, a.color, a.fontSize, a.font, a.align]
        : ['a', a.id, a.fromTextId, a.color, a.weight, a.points.map((p) => [p.x, p.y])],
    );
    return JSON.stringify({ items, layout: state.layout, annotations });
  }

  function recordHistory() {
    // Skip while applying an undo/redo, and while a text box is mid-edit — the
    // transient empty box shouldn't be its own undo step; it's captured on commit.
    if (history.applying || state.editingAnnotationId) {
      return;
    }

    const sig = boardSignature();

    if (history.index >= 0 && history.stack[history.index].sig === sig) {
      return;
    }

    // Drop any redo branch, then push the new state.
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push({ snap: snapshotBoard(), sig });

    if (history.stack.length > HISTORY_LIMIT) {
      history.stack.shift();
    }

    history.index = history.stack.length - 1;
  }

  function applyHistoryEntry(entry) {
    history.applying = true;

    try {
      state.items = entry.snap.items.map(cloneItemForHistory);
      state.layout = { ...entry.snap.layout };
      state.annotations = entry.snap.annotations.map(cloneAnnotationForHistory);
      state.exportBackgroundHex = state.layout.exportBackgroundHex;
      state.exportBackgroundHexDraft = state.layout.exportBackgroundHex;
      // Clear transient sessions/selection that may reference removed content.
      state.selectedItemIds = [];
      state.selectionAnchorId = null;
      state.selectedAnnotationId = null;
      state.editingAnnotationId = null;
      state.annotationDragSession = null;
      state.arrowDrawSession = null;
      state.arrowEndpointSession = null;
      state.dragSession = null;
      state.resizeSession = null;
      saveBoardState();
      render();
    } finally {
      history.applying = false;
    }
  }

  function canUndo() {
    return history.index > 0;
  }

  function canRedo() {
    return history.index < history.stack.length - 1;
  }

  function undoBoard() {
    if (!canUndo()) {
      return;
    }
    history.index -= 1;
    applyHistoryEntry(history.stack[history.index]);
  }

  function redoBoard() {
    if (!canRedo()) {
      return;
    }
    history.index += 1;
    applyHistoryEntry(history.stack[history.index]);
  }

  function applyBoardState(next) {
    state.items = next.items;
    state.layout = next.layout;
    state.annotations = next.annotations ?? [];
    state.exportBackgroundHex = next.layout.exportBackgroundHex;
    state.exportBackgroundHexDraft = next.layout.exportBackgroundHex;
    state.activeTool = null;
    state.selectedAnnotationId = null;
    state.editingAnnotationId = null;
    state.annotationDragSession = null;
    state.arrowDrawSession = null;
    state.arrowEndpointSession = null;
    state.isMultiSelectMode = false;
    state.viewportTransform = null;
    state.dragSession = null;
    state.resizeSession = null;
    state.panSession = null;
    state.marqueeSession = null;
    state.cropAnchorSession = null;
    state.zoom = getDefaultZoom();
    clearSelection();
    setFloatingPanels(false, false);
    clearWidgetInteractionStates();
    saveBoardState();
    render();
  }

  // Ask the user where to save. Uses the File System Access "Save As" picker
  // where available (Chromium), falling back to a normal download elsewhere.
  // Returns null if the user cancels the picker (so callers can bail quietly).
  // MUST be the first await after a user gesture, or the picker loses activation.
  async function pickSaveTarget(suggestedName, { description = 'File', accept } = {}) {
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: accept ? [{ description, accept }] : undefined,
        });
        return { handle, suggestedName };
      } catch (error) {
        if (error && error.name === 'AbortError') {
          return null; // user cancelled — do not fall back to a download
        }
        // Unsupported context / permission issue: fall back to a download.
        return { handle: null, suggestedName };
      }
    }
    return { handle: null, suggestedName };
  }

  async function writeSaveTarget(target, blob) {
    if (target.handle) {
      const writable = await target.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = target.suggestedName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function defaultBoardFileName(extension) {
    const safeTitle =
      (settings.title || 'moodboard')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'moodboard';
    const stamp = new Date().toISOString().slice(0, 10);
    return `${safeTitle}-${stamp}.${extension}`;
  }

  async function saveBoardToFile() {
    try {
      const target = await pickSaveTarget(defaultBoardFileName('json'), {
        description: 'Moodboard board file',
        accept: { 'application/json': ['.json'] },
      });

      if (!target) {
        return; // cancelled
      }

      const payload = JSON.stringify(serializeBoard(), null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      await writeSaveTarget(target, blob);
      setExportStatus('Board saved to file', 'success', { resetAfter: EXPORT_STATUS_DURATION_MS });
    } catch {
      setExportStatus('Could not save the board file', 'error', { resetAfter: EXPORT_STATUS_DURATION_MS });
    }
  }

  function openBoardPicker() {
    refs.openInput?.click();
  }

  async function loadBoardFromFile(file) {
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const next = parseBoardState(JSON.parse(text));

      if (!next) {
        setExportStatus('That file is not a valid board', 'error', { resetAfter: EXPORT_STATUS_DURATION_MS });
        return;
      }

      const hasContent = state.items.length > 0 || state.annotations.length > 0;

      if (hasContent && !window.confirm('Open this board? It will replace what is currently on the board.')) {
        return;
      }

      applyBoardState(next);
      setExportStatus('Board loaded', 'success', { resetAfter: EXPORT_STATUS_DURATION_MS });
    } catch {
      setExportStatus('Could not read that board file', 'error', { resetAfter: EXPORT_STATUS_DURATION_MS });
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

  function getAnnotationsBounds() {
    let minLeft = Number.POSITIVE_INFINITY;
    let minTop = Number.POSITIVE_INFINITY;
    let maxRight = Number.NEGATIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;
    let has = false;

    for (const annotation of state.annotations) {
      if (annotation.type === 'text') {
        const rect = getTextBoxRect(annotation);
        minLeft = Math.min(minLeft, rect.left);
        minTop = Math.min(minTop, rect.top);
        maxRight = Math.max(maxRight, rect.left + rect.width);
        maxBottom = Math.max(maxBottom, rect.top + rect.height);
        has = true;
      } else if (annotation.type === 'arrow') {
        const points = resolveArrowPoints(annotation);
        const margin = annotation.weight * 3 + 8;
        for (const point of points) {
          minLeft = Math.min(minLeft, point.x - margin);
          minTop = Math.min(minTop, point.y - margin);
          maxRight = Math.max(maxRight, point.x + margin);
          maxBottom = Math.max(maxBottom, point.y + margin);
        }
        has = true;
      }
    }

    if (!has) {
      return null;
    }

    const pad = 8;
    return {
      left: minLeft - pad,
      top: minTop - pad,
      right: maxRight + pad,
      bottom: maxBottom + pad,
      width: maxRight - minLeft + pad * 2,
      height: maxBottom - minTop + pad * 2,
    };
  }

  function unionBounds(a, b) {
    if (!a) return b;
    if (!b) return a;
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    const right = Math.max(a.right, b.right);
    const bottom = Math.max(a.bottom, b.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function getExportContentBounds(items = state.items) {
    return unionBounds(getClusterBounds(items), getAnnotationsBounds());
  }

  function wrapCanvasText(context, text, maxWidth) {
    const lines = [];

    for (const paragraph of String(text).split('\n')) {
      const words = paragraph.split(' ');
      let current = '';

      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;

        if (current && context.measureText(candidate).width > maxWidth) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }

      lines.push(current);
    }

    return lines;
  }

  function drawTextAnnotationToCanvas(context, annotation) {
    const padX = 6;
    const padY = 4;
    const fontFamily = getFontStack(annotation.font);

    context.save();
    context.font = `${annotation.fontSize}px ${fontFamily}`;
    context.textBaseline = 'top';
    context.fillStyle = annotation.color;
    context.shadowColor = 'rgba(0, 0, 0, 0.55)';
    context.shadowBlur = 2;
    context.shadowOffsetY = 1;

    const maxWidth = Math.max(10, annotation.width - padX * 2 - 2);
    const lines = wrapCanvasText(context, annotation.text, maxWidth);
    const lineHeight = annotation.fontSize * 1.3;
    let y = annotation.y + padY;

    for (const line of lines) {
      let x = annotation.x + padX;

      if (annotation.align === 'center') {
        x = annotation.x + annotation.width / 2;
        context.textAlign = 'center';
      } else if (annotation.align === 'right') {
        x = annotation.x + annotation.width - padX;
        context.textAlign = 'right';
      } else {
        context.textAlign = 'left';
      }

      context.fillText(line, x, y);
      y += lineHeight;
    }

    context.restore();
  }

  function drawArrowAnnotationToCanvas(context, annotation) {
    const points = resolveArrowPoints(annotation);
    const geo = buildArrowGeometry(points);

    context.save();
    context.strokeStyle = annotation.color;
    context.fillStyle = annotation.color;
    context.lineWidth = annotation.weight;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.stroke(new Path2D(geo.path));
    context.fill(new Path2D(buildArrowHeadData(geo.end, geo.tangentFrom, annotation.weight)));
    context.restore();
  }

  function drawAnnotationsToCanvas(context, bounds) {
    if (!state.annotations.length) {
      return;
    }

    context.save();
    context.translate(-bounds.left, -bounds.top);

    for (const annotation of state.annotations) {
      if (annotation.type === 'arrow') {
        drawArrowAnnotationToCanvas(context, annotation);
      }
    }

    for (const annotation of state.annotations) {
      if (annotation.type === 'text') {
        drawTextAnnotationToCanvas(context, annotation);
      }
    }

    context.restore();
  }

  async function buildAnnotationOverlayPngBytes(bounds, scale = 2) {
    if (!state.annotations.length) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bounds.width * scale));
    canvas.height = Math.max(1, Math.round(bounds.height * scale));
    const context = canvas.getContext('2d');

    if (!context) {
      return null;
    }

    context.scale(scale, scale);
    drawAnnotationsToCanvas(context, bounds);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Annotation overlay failed'));
          return;
        }

        blob.arrayBuffer().then(resolve, reject);
      }, 'image/png');
    });
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
    const hudBottom = refs.hudContext?.getBoundingClientRect().bottom ?? shellRect.top;
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
    bounds = getExportContentBounds(items),
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

    drawAnnotationsToCanvas(context, bounds);

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

    const bounds = getExportContentBounds();

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

    const bounds = getExportContentBounds();
    const currentWidth = bounds ? Math.max(1, Math.round(bounds.width)) : 0;
    const currentHeight = bounds ? Math.max(1, Math.round(bounds.height)) : 0;
    const output = getExportOutputSize(bounds, state.exportTargetEdge);
    const controlsDisabled = !bounds || state.exportState.isExporting;
    const isPdf = state.exportFormat === 'pdf';
    const isZip = state.exportFormat === 'zip';
    const imageCount = state.items.length;

    refs.exportCurrentSize.textContent = bounds ? `${currentWidth} x ${currentHeight}px` : 'No images';
    refs.exportOutputSize.textContent = bounds
      ? isZip
        ? `${imageCount} image${imageCount === 1 ? '' : 's'}`
        : isPdf
          ? `${currentWidth} x ${currentHeight}px`
          : `${output.width} x ${output.height}px PNG`
      : 'No export available';
    if (refs.exportOutputLabel) refs.exportOutputLabel.textContent = isZip ? 'Images' : isPdf ? 'Output PDF' : 'Output PNG';
    if (refs.exportSizeRow) refs.exportSizeRow.hidden = false;
    if (refs.exportEdgeRow) refs.exportEdgeRow.hidden = isPdf || isZip;
    if (refs.exportBackgroundRow) refs.exportBackgroundRow.hidden = isZip;
    if (refs.exportPdfOptions) {
      refs.exportPdfOptions.hidden = !isPdf;
      refs.exportPdfOptions.querySelectorAll('[data-export-corners]').forEach((button) => {
        const selected = (button.dataset.exportCorners === 'rounded') === state.exportPdfRoundedCorners;
        button.classList.toggle('board-export-panel__size-button--active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    }
    if (refs.exportPanelTitle) refs.exportPanelTitle.textContent = isZip ? 'Image ZIP' : isPdf ? 'PDF output' : 'PNG output';
    if (refs.exportConfirm) refs.exportConfirm.textContent = isZip ? 'Export ZIP' : isPdf ? 'Export PDF' : 'Export PNG';
    refs.exportPreviewFrame.dataset.transparent = String(!state.exportIncludeBackground);

    refs.exportFormatOptions?.querySelectorAll('[data-export-format]').forEach((button) => {
      const selected = button.dataset.exportFormat === state.exportFormat;
      button.classList.toggle('board-export-panel__size-button--active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });

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
    refs.modeStatus.textContent = getModeSummary();
    refs.modeStatus.dataset.mode = state.isMobileMode ? 'mobile' : 'desktop';
  }

  function renderToast() {
    if (!refs.toast) {
      return;
    }

    const toastState = getToastState();
    refs.toast.hidden = !toastState.message;

    if (!toastState.message) {
      refs.toast.textContent = '';
      refs.toast.dataset.tone = 'idle';
      return;
    }

    refs.toast.dataset.tone = toastState.tone;
    refs.toast.textContent = toastState.message;
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

  function renderMobileZoomRail() {
    if (!refs.mobileZoomRail || !refs.mobileZoomSlider || !refs.mobileZoomValue) {
      return;
    }

    const shouldShow = state.isMobileMode;
    refs.mobileZoomRail.hidden = !shouldShow;

    if (!shouldShow) {
      return;
    }

    const fitZoom = state.mobileFitZoom ?? MOBILE_ZOOM_MIN;
    const displayedZoom = clamp(state.zoom || state.viewportTransform?.zoom || fitZoom, fitZoom, ZOOM_MAX);
    refs.mobileZoomSlider.min = String(fitZoom);
    refs.mobileZoomSlider.max = String(ZOOM_MAX);
    refs.mobileZoomSlider.step = String(ZOOM_STEP);
    refs.mobileZoomSlider.value = String(displayedZoom);
    const pct = fitZoom > 0 ? Math.round((displayedZoom / fitZoom) * 100) : 100;
    refs.mobileZoomValue.textContent = `${pct}%`;
  }

  function renderSelectionToolbar() {
    if (!refs.selectionToolbar) {
      return;
    }

    refs.selectionToolbar.replaceChildren();
    const selectionIds = getSelectionIds();
    const selectedCount = selectionIds.length;
    const shouldShow =
      selectedCount > 1 &&
      !state.dragSession &&
      !state.resizeSession &&
      !state.marqueeSession;

    refs.selectionToolbar.hidden = !shouldShow;

    if (!shouldShow) {
      return;
    }

    const primaryItem = getPrimarySelectedItem();
    const isSingleSelection = selectedCount === 1 && primaryItem;
    const summary = document.createElement('div');
    summary.className = 'board-selection-toolbar__summary';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'board-selection-toolbar__eyebrow';
    eyebrow.textContent = selectedCount === 1 ? 'Selection' : 'Multi-selection';

    const title = document.createElement('p');
    title.className = 'board-selection-toolbar__title';
    title.textContent = selectedCount === 1 ? '1 image selected' : `${selectedCount} images selected`;

    summary.append(eyebrow, title);

    if (isSingleSelection) {
      const detail = document.createElement('p');
      detail.className = 'board-selection-toolbar__detail';
      detail.textContent =
        primaryItem.sourceKind === 'web' && primaryItem.sourceUrl
          ? 'Resize from the bottom-right handle and snap through the visible targets, adjust crop below, or open the source link.'
          : 'Resize from the bottom-right handle and snap through the visible targets, then use the crop controls below to reframe the image.';
      summary.append(detail);
    } else {
      const detail = document.createElement('p');
      detail.className = 'board-selection-toolbar__detail';
      detail.textContent = 'Drag any selected tile to move the whole selection together, or delete the current group.';
      summary.append(detail);
    }

    const actions = document.createElement('div');
    actions.className = 'board-selection-toolbar__actions';

    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'board-selection-toolbar__button';
    clearButton.textContent = 'Clear';
    clearButton.addEventListener('click', () => {
      clearSelection();
      renderBoard();
    });
    actions.appendChild(clearButton);

    if (isSingleSelection && primaryItem.sourceKind === 'web' && primaryItem.sourceUrl) {
      const linkButton = document.createElement('button');
      linkButton.type = 'button';
      linkButton.className = 'board-selection-toolbar__button board-selection-toolbar__button--primary';
      linkButton.textContent = 'Open Link';
      linkButton.addEventListener('click', () => {
        openItemSource(primaryItem);
      });
      actions.appendChild(linkButton);
    }

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'board-selection-toolbar__button board-selection-toolbar__button--danger';
    deleteButton.textContent = selectedCount === 1 ? 'Delete' : `Delete ${selectedCount}`;
    deleteButton.addEventListener('click', () => {
      deleteSelection(primaryItem?.id ?? null);
    });
    actions.appendChild(deleteButton);

    refs.selectionToolbar.append(summary, actions);

    if (isSingleSelection) {
      const cropRow = document.createElement('div');
      cropRow.className = 'board-selection-toolbar__crop';

      const cropLabel = document.createElement('span');
      cropLabel.className = 'board-selection-toolbar__crop-label';
      cropLabel.textContent = 'Crop zoom';

      const cropValue = document.createElement('span');
      cropValue.className = 'board-selection-toolbar__crop-value';
      cropValue.textContent = formatCropZoomLabel(getItemCrop(primaryItem).zoom);

      const cropSlider = document.createElement('input');
      cropSlider.type = 'range';
      cropSlider.className = 'board-selection-toolbar__slider';
      cropSlider.min = String(CROP_ZOOM_MIN);
      cropSlider.max = String(CROP_ZOOM_MAX);
      cropSlider.step = String(CROP_ZOOM_STEP);
      cropSlider.value = String(getItemCrop(primaryItem).zoom);
      cropSlider.setAttribute('aria-label', 'Crop zoom');
      cropSlider.addEventListener('input', (event) => {
        const nextZoom = Number(event.currentTarget.value);
        cropValue.textContent = formatCropZoomLabel(nextZoom);
        setItemCropZoom(primaryItem.id, nextZoom);
      });
      cropSlider.addEventListener('change', (event) => {
        setItemCropZoom(primaryItem.id, Number(event.currentTarget.value), { save: true });
      });

      cropRow.append(cropLabel, cropValue, cropSlider);
      refs.selectionToolbar.append(cropRow);
    }
  }

  function syncLayoutControls() {
    if (!refs.utilityPanel || !refs.layoutControls) {
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
    if (!panel || panel.hidden || !refs.root) {
      return;
    }

    if (state.isMobileMode) {
      panel.style.left = '';
      panel.style.top = '';
      return;
    }

    if (!refs.hud || !refs.root) {
      return;
    }

    const hudRect = refs.hud.getBoundingClientRect();
    const rootRect = refs.root.getBoundingClientRect();
    panel.style.left = `${hudRect.left - rootRect.left}px`;
    panel.style.top = `${hudRect.bottom - rootRect.top + 12}px`;
  }

  function renderHud() {
    renderStatus();
    renderToast();
    syncLayoutControls();
    renderHintsPanel();
    renderMobileZoomRail();
    refs.root?.classList.toggle('is-mobile-mode', state.isMobileMode);
    if (refs.mobileGate) refs.mobileGate.hidden = !state.isMobileMode;

    if (refs.utilityToggle) {
      refs.utilityToggle.setAttribute('aria-expanded', String(state.isUtilityPanelOpen));
      refs.utilityToggle.classList.toggle('board-hud__button--active', state.isUtilityPanelOpen);
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

    if (refs.utilityPanel) {
      refs.utilityPanel.hidden = !state.isUtilityPanelOpen;
      refs.utilityTabLayout?.classList.toggle('board-utility-panel__tab--active', state.activeUtilityTab === 'layout');
      refs.utilityTabLayout?.setAttribute('aria-pressed', String(state.activeUtilityTab === 'layout'));
      refs.utilityTabHints?.classList.toggle('board-utility-panel__tab--active', state.activeUtilityTab === 'hints');
      refs.utilityTabHints?.setAttribute('aria-pressed', String(state.activeUtilityTab === 'hints'));
      if (refs.utilityLayoutSection) {
        refs.utilityLayoutSection.hidden = state.activeUtilityTab !== 'layout';
      }
      if (refs.utilityHintsSection) {
        refs.utilityHintsSection.hidden = state.activeUtilityTab !== 'hints';
      }
      positionFloatingPanel(refs.utilityPanel);
    }

    renderExportPanel();
  }

  function renderPlaceholder(previewResult) {
    if (state.resizeSession?.overlay) {
      const originItem = state.resizeSession.originItem;
      const overlay = state.resizeSession.overlay;

      for (const target of overlay.targets) {
        const frame = getTileFrame({ colStart: originItem.colStart, rowStart: originItem.rowStart, colSpan: target.colSpan, rowSpan: target.rowSpan });
        const ghost = document.createElement('div');

        ghost.className = `board-resize-ghost${target.id === overlay.activeTargetId ? ' board-resize-ghost--active' : ''}`;
        ghost.style.left = `${frame.left}px`;
        ghost.style.top = `${frame.top}px`;
        ghost.style.width = `${frame.width}px`;
        ghost.style.height = `${frame.height}px`;
        ghost.style.zIndex = String(1800 - target.colSpan * target.rowSpan);
        refs.stage.appendChild(ghost);
      }

      return;
    }

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
    const selectionIds = getSelectionIds();
    const isSingleSelectedTile = Boolean(
      selectedItem &&
      shouldShowSingleSelectionUi(selectedItem.id) &&
      selectionIds.length === 1 &&
      !state.dragSession &&
      !state.resizeSession &&
      !state.marqueeSession,
    );
    const baseTileViewportFrame =
      selectedItem && frame ? getViewportFrameRect(frame, viewportTransform) : null;
    const tileViewportFrame =
      baseTileViewportFrame && isSingleSelectedTile
        ? (() => {
            const liftScale = 1.1;
            const nextWidth = baseTileViewportFrame.width * liftScale;
            const nextHeight = baseTileViewportFrame.height * liftScale;
            const deltaWidth = nextWidth - baseTileViewportFrame.width;
            const deltaHeight = nextHeight - baseTileViewportFrame.height;

            return {
              left: baseTileViewportFrame.left - deltaWidth / 2,
              top: baseTileViewportFrame.top - deltaHeight / 2 - 4,
              width: nextWidth,
              height: nextHeight,
            };
          })()
        : baseTileViewportFrame;

    if (
      selectedItem &&
      shouldShowSingleSelectionUi(selectedItem.id) &&
      !state.dragSession &&
      !state.resizeSession &&
      !state.marqueeSession
    ) {
      const session = state.cropAnchorSession?.itemId === selectedItem.id ? state.cropAnchorSession : null;
      const anchorSize = clamp(30 * zoom, 16, 30);
      const anchorDotSize = clamp(anchorSize * 0.27, 5, 8);
      const anchorLogicalSize = anchorSize / zoom;
      const anchorPoint =
        tileViewportFrame
          ? {
              left: tileViewportFrame.left + tileViewportFrame.width / 2,
              top: tileViewportFrame.top + tileViewportFrame.height - 36 * zoom - anchorLogicalSize * zoom / 2,
            }
          : getViewportFrameRect(
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

    if (isSingleSelectedTile && selectedItem && tileViewportFrame) {
      const safeAreaInsets = getSafeAreaInsets();
      const topBarGap = 18 * zoom;
      const bottomBarGap = 10 * zoom;
      const horizontalInset = 8;
      const hasLink = selectedItem.sourceKind === 'web' && selectedItem.sourceUrl;
      const actionBarWidth = tileViewportFrame.width * 1.1;
      const cropBarWidth = tileViewportFrame.width * 1.1;
      const actionBarHeight = 46 * zoom;
      const cropBarHeight = 58 * zoom;
      const stackedBarGap = 8 * zoom;
      const scrollLeft = refs.shell?.scrollLeft ?? 0;
      const scrollTop = refs.shell?.scrollTop ?? 0;
      const tileCenterX = tileViewportFrame.left + tileViewportFrame.width / 2;
      const actionBarLeft = tileCenterX - actionBarWidth / 2;
      const cropBarLeft = tileCenterX - cropBarWidth / 2;
      const minTop = scrollTop + safeAreaInsets.top + horizontalInset;
      const maxCropBarTop = scrollTop + getViewportHeight() - safeAreaInsets.bottom - horizontalInset - cropBarHeight;
      const preferredCropBarTopBelow = tileViewportFrame.top + tileViewportFrame.height + bottomBarGap;
      const canPlaceCropBelow = preferredCropBarTopBelow <= maxCropBarTop;
      const cropBarTop = canPlaceCropBelow
        ? preferredCropBarTopBelow
        : Math.max(minTop, tileViewportFrame.top - cropBarHeight - bottomBarGap);
      const actionBarTop = canPlaceCropBelow
        ? Math.max(minTop, tileViewportFrame.top - actionBarHeight - topBarGap)
        : Math.max(minTop, cropBarTop - actionBarHeight - stackedBarGap);
      const actionBar = document.createElement('div');
      actionBar.className = 'board-tile-selection-bar board-tile-selection-bar--top';
      actionBar.style.left = `${actionBarLeft}px`;
      actionBar.style.top = `${actionBarTop}px`;
      actionBar.style.width = `${actionBarWidth}px`;
      actionBar.style.padding = `${10 * zoom}px ${12 * zoom}px`;
      actionBar.style.gap = `${10 * zoom}px`;
      actionBar.style.borderRadius = `${14 * zoom}px`;
      actionBar.style.minHeight = `${46 * zoom}px`;

      const actionGroup = document.createElement('div');
      actionGroup.className = 'board-tile-selection-bar__actions';
      actionGroup.style.gap = `${6 * zoom}px`;

      if (state.isMobileMode) {
        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.className = 'board-selection-toolbar__button board-tile-selection-bar__button';
        selectButton.textContent = 'Select';
        selectButton.style.minHeight = `${34 * zoom}px`;
        selectButton.style.paddingInline = `${8 * zoom}px`;
        selectButton.style.fontSize = `${0.65 * zoom}rem`;
        selectButton.addEventListener('click', () => {
          state.isMultiSelectMode = true;
          renderHud();
          renderBoard();
        });
        actionGroup.appendChild(selectButton);
      }

      if (hasLink) {
        const linkButton = document.createElement('button');
        linkButton.type = 'button';
        linkButton.className = 'board-selection-toolbar__button board-selection-toolbar__button--primary board-tile-selection-bar__button';
        linkButton.textContent = 'Open Link';
        linkButton.style.minHeight = `${34 * zoom}px`;
        linkButton.style.paddingInline = `${8 * zoom}px`;
        linkButton.style.fontSize = `${0.65 * zoom}rem`;
        linkButton.addEventListener('click', () => {
          openItemSource(selectedItem);
        });
        actionGroup.appendChild(linkButton);
      }

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'board-selection-toolbar__button board-selection-toolbar__button--danger board-tile-selection-bar__button';
      deleteButton.textContent = 'Delete';
      deleteButton.style.minHeight = `${34 * zoom}px`;
      deleteButton.style.paddingInline = `${8 * zoom}px`;
      deleteButton.style.fontSize = `${0.65 * zoom}rem`;
      deleteButton.addEventListener('click', () => {
        deleteSelection(selectedItem.id);
      });
      actionGroup.appendChild(deleteButton);
      actionBar.appendChild(actionGroup);
      refs.cropAnchorLayer.appendChild(actionBar);

      const cropBar = document.createElement('div');
      cropBar.className = 'board-tile-selection-bar board-tile-selection-bar--bottom';
      cropBar.style.left = `${cropBarLeft}px`;
      cropBar.style.top = `${cropBarTop}px`;
      cropBar.style.width = `${cropBarWidth}px`;
      cropBar.style.padding = `${10 * zoom}px ${12 * zoom}px`;
      cropBar.style.gap = `${10 * zoom}px`;
      cropBar.style.borderRadius = `${14 * zoom}px`;
      cropBar.style.minHeight = `${58 * zoom}px`;

      const cropMeta = document.createElement('div');
      cropMeta.className = 'board-tile-selection-bar__meta';
      cropMeta.style.gap = `${12 * zoom}px`;

      const cropLabel = document.createElement('span');
      cropLabel.className = 'board-tile-selection-bar__label';
      cropLabel.textContent = 'Crop zoom';
      cropLabel.style.fontSize = `${0.76 * zoom}rem`;

      const cropValue = document.createElement('span');
      cropValue.className = 'board-tile-selection-bar__value';
      cropValue.textContent = formatCropZoomLabel(getItemCrop(selectedItem).zoom);
      cropValue.style.fontSize = `${0.76 * zoom}rem`;

      cropMeta.append(cropLabel, cropValue);

      const cropSlider = document.createElement('input');
      cropSlider.type = 'range';
      cropSlider.className = 'board-selection-toolbar__slider board-tile-selection-bar__slider';
      cropSlider.min = String(CROP_ZOOM_MIN);
      cropSlider.max = String(CROP_ZOOM_MAX);
      cropSlider.step = String(CROP_ZOOM_STEP);
      cropSlider.value = String(getItemCrop(selectedItem).zoom);
      cropSlider.setAttribute('aria-label', 'Crop zoom');
      cropSlider.addEventListener('input', (event) => {
        const nextZoom = Number(event.currentTarget.value);
        cropValue.textContent = formatCropZoomLabel(nextZoom);
        setItemCropZoom(selectedItem.id, nextZoom);
      });
      cropSlider.addEventListener('change', (event) => {
        setItemCropZoom(selectedItem.id, Number(event.currentTarget.value), { save: true });
      });

      cropBar.append(cropMeta, cropSlider);
      refs.cropAnchorLayer.appendChild(cropBar);
    }

    if (state.resizeSession?.overlay) {
      const overlay = state.resizeSession.overlay;
      const layout = state.resizeSession.overlayLayout ?? getResizeOverlayLayout(state.resizeSession, viewportTransform);
      const targetFrames = layout?.targetFrames ?? [];
      const activeTarget = targetFrames.find((target) => target.id === overlay.activeTargetId) ?? targetFrames[0];

      if (layout) {
        const { originX, originY, thumbSize } = layout;
        const pointerX = layout.pointerViewport?.x ?? originX;
        const pointerY = layout.pointerViewport?.y ?? originY;
        const grabOffset = state.resizeSession.grabOffsetViewport ?? { x: 0, y: 0 };
        const isSnapped = Boolean(activeTarget && state.resizeSession.intent?.isHoveringTarget);
        const desiredThumbX = isSnapped ? activeTarget.centerX : pointerX - grabOffset.x;
        const desiredThumbY = isSnapped ? activeTarget.centerY : pointerY - grabOffset.y;
        const previousThumb = state.resizeSession.visualThumbViewport ?? { x: originX, y: originY };
        const smoothing = isSnapped ? 1 : 0.38;
        const nextThumbX = previousThumb.x + (desiredThumbX - previousThumb.x) * smoothing;
        const nextThumbY = previousThumb.y + (desiredThumbY - previousThumb.y) * smoothing;

        state.resizeSession.visualThumbViewport = { x: nextThumbX, y: nextThumbY };

        const thumb = document.createElement('span');
        thumb.className = `board-resize-thumb${isSnapped ? ' board-resize-thumb--snapped' : ''}`;
        thumb.style.width = `${thumbSize}px`;
        thumb.style.height = `${thumbSize}px`;
        thumb.style.left = `${nextThumbX}px`;
        thumb.style.top = `${nextThumbY}px`;
        thumb.style.setProperty('--resize-control-radius', `${10 * viewportTransform.zoom}px`);
        thumb.style.setProperty('--resize-icon-main-size', `${9 * viewportTransform.zoom}px`);
        thumb.style.setProperty('--resize-icon-main-offset', `${7 * viewportTransform.zoom}px`);
        thumb.style.setProperty('--resize-icon-inner-size', `${5 * viewportTransform.zoom}px`);
        thumb.style.setProperty('--resize-icon-inner-offset', `${12 * viewportTransform.zoom}px`);
        thumb.style.setProperty('--resize-icon-stroke', `${2 * viewportTransform.zoom}px`);
        thumb.innerHTML = '<span class="board-resize-thumb__icon" aria-hidden="true"></span>';
        refs.cropAnchorLayer.appendChild(thumb);
      }
    }

    if (state.isMobileMode && state.dragSession?.allowShiftStack) {
      const safeAreaInsets = getSafeAreaInsets();
      const buttonW = 52;
      const buttonH = 28;
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
            thumbFrame.left + thumbFrame.width / 2 - buttonW / 2,
            safeAreaInsets.left + 8,
            getViewportWidth() - safeAreaInsets.right - buttonW - 8,
          )
        : getViewportWidth() / 2 - buttonW / 2;
      const thumbTop = thumbFrame
        ? clamp(
            thumbFrame.top - buttonH / 2,
            safeAreaInsets.top + 8,
            getViewportHeight() - safeAreaInsets.bottom - buttonH - 8,
          )
        : safeAreaInsets.top + 18;

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

  function renderBoard() {
    const dragPreviewResult = state.dragSession ? previewDragMove(state.dragSession, state.items) : null;
    const resizePreviewResult = !state.dragSession && state.resizeSession ? previewResize(state.resizeSession, state.items) : null;
    const previewResult = dragPreviewResult ?? resizePreviewResult;
    const previewItems = dragPreviewResult?.items ?? state.items;
    const rows = getBoardRows(state.items);
    const visibleHeight = getViewportHeight();
    const visibleWidth = getViewportWidth();
    let logicalBoardHeight;
    if (state.isMobileMode) {
      const roughFitZoom = Math.max(MOBILE_ZOOM_MIN, (visibleWidth - 2 * MOBILE_VIEWPORT_SIDE_PADDING) / GRID_WIDTH);
      const mobileRows = Math.ceil(visibleHeight / (GRID_SPEC.rowPx * roughFitZoom));
      logicalBoardHeight = mobileRows * GRID_SPEC.rowPx;
    } else {
      const minScrollableHeight = visibleHeight / Math.max(getCurrentZoom(), ZOOM_MIN) * (1 + VIEWPORT_VERTICAL_BUFFER_FACTOR);
      logicalBoardHeight = Math.max(minScrollableHeight, rows * GRID_SPEC.rowPx);
    }
    const currentItemsById = new Map(state.items.map((item) => [item.id, item]));
    const clusterBounds = getClusterBounds(previewItems) ?? getFallbackClusterBounds(logicalBoardHeight);
    const selectedItem = state.isMobileMode && state.selectionAnchorId
      ? getItemById(previewItems, state.selectionAnchorId)
      : null;
    const focusBounds = selectedItem
      ? (() => { const f = getTileFrame(selectedItem); return { left: f.left, top: f.top, width: f.width, height: f.height }; })()
      : clusterBounds;

    if (state.isMobileMode) {
      const savedBaseZoom = state.mobileBaseZoom;
      state.mobileBaseZoom = null;
      state.mobileFitZoom = buildMobileViewportState(clusterBounds, logicalBoardHeight).zoom;
      state.mobileBaseZoom = savedBaseZoom;
    }

    let viewportTransform = state.isMobileMode
      ? buildMobileViewportState(focusBounds, logicalBoardHeight)
      : {
          zoom: state.zoom,
          offsetX: 0,
          offsetY: 0,
        };

    if (state.isMobileMode) {
      viewportTransform = applyMobilePanToViewport(viewportTransform, logicalBoardHeight);
    }

    state.viewportTransform = state.isMobileMode ? viewportTransform : null;
    state.zoom = viewportTransform.zoom;
    renderMobileZoomRail();

    refs.board.style.width = state.isMobileMode
      ? `${visibleWidth}px`
      : `${Math.max(visibleWidth, GRID_WIDTH * state.zoom)}px`;
    refs.board.style.height = state.isMobileMode
      ? `${visibleHeight}px`
      : `${logicalBoardHeight * state.zoom}px`;
    refs.board.style.setProperty('--board-radius', `${getRadiusPx()}px`);
    refs.board.style.setProperty('--board-backdrop-color', state.exportBackgroundHex);
    const gridPalette = getGridOverlayPalette();
    refs.board.style.setProperty('--grid-line-color', gridPalette.lineColor);
    refs.board.style.setProperty('--grid-dot-color', gridPalette.dotColor);
    refs.board.style.setProperty('--grid-sub-dot-color', gridPalette.subDotColor);
    refs.stage.style.width = `${GRID_WIDTH}px`;
    refs.stage.style.height = `${logicalBoardHeight}px`;
    refs.stage.style.transform = state.isMobileMode
      ? `translate(${viewportTransform.offsetX}px, ${viewportTransform.offsetY}px) scale(${viewportTransform.zoom})`
      : `scale(${state.zoom})`;
    if (refs.annotationLayer) {
      refs.annotationLayer.style.width = `${GRID_WIDTH}px`;
      refs.annotationLayer.style.height = `${logicalBoardHeight}px`;
      refs.annotationLayer.style.transform = refs.stage.style.transform;
      refs.annotationLayer.style.setProperty('--inv-zoom', String(1 / Math.max(state.zoom, 0.0001)));
    }
    refs.stage.style.setProperty('--board-radius', `${getRadiusPx()}px`);
    refs.stage.style.setProperty('--board-backdrop-color', state.exportBackgroundHex);
    refs.stage.style.setProperty('--grid-line-color', gridPalette.lineColor);
    refs.stage.style.setProperty('--grid-dot-color', gridPalette.dotColor);
    refs.stage.style.setProperty('--grid-sub-dot-color', gridPalette.subDotColor);
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
    const hasFocusedTile = !hasMultiSelection && !!selectionAnchorId && !state.dragSession && !state.resizeSession && !state.marqueeSession && state.singleSelectionUiEnabled;
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
      const showSingleSelectionUi = shouldShowSingleSelectionUi(item.id);
      const shouldLiftTile =
        isPrimarySelected &&
        showSingleSelectionUi &&
        !hasMultiSelection &&
        !state.dragSession &&
        !state.resizeSession &&
        !state.marqueeSession;
      const tile = document.createElement('div');
      tile.className = `board-tile${isSelected ? ' board-tile--selected' : ''}${
        isSelected && hasMultiSelection ? ' board-tile--multi-selected' : ''
      }${isAffectedPreviewItem ? ' board-tile--affected' : ''}${shouldLiftTile ? ' board-tile--lifted' : ''}${hasFocusedTile && !isPrimarySelected ? ' board-tile--dimmed' : ''}`;
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', 'Moodboard image tile');
      tile.dataset.itemId = item.id;
      tile.style.left = `${frame.left}px`;
      tile.style.top = `${frame.top}px`;
      tile.style.width = `${frame.width}px`;
      tile.style.height = `${frame.height}px`;
      tile.style.zIndex = String(item.zIndex + (shouldLiftTile ? 1000 : 0));

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

        if (selectedCount === 1 && showSingleSelectionUi) {
          cropAnchorTarget = { item, frame };
          const cornerHandle = document.createElement('button');
          cornerHandle.type = 'button';
          cornerHandle.className = 'board-tile__handle board-tile__handle--corner';
          cornerHandle.setAttribute('aria-label', 'Resize');
          cornerHandle.addEventListener('pointerdown', (event) => {
            if (state.isMobileMode) {
              event.preventDefault();
              event.stopPropagation();
              cycleMobileResize(item);
            } else {
              startResize(event, item);
            }
          });
          actions.appendChild(cornerHandle);
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

        if (state.isMobileMode && !isMobileMultiSelectActive()) {
          state._longPressTimer = setTimeout(() => {
            state._longPressTimer = null;
            if (state.dragSession?.itemId === item.id && !state.dragSession.didMove) {
              state.dragSession.removeListeners?.();
              state.dragSession = null;
              setWidgetInteractionState('is-dragging', false);
              state.isMultiSelectMode = true;
              setSingleSelection(item.id);
              state.suppressNextClick = true;
              renderHud();
              renderBoard();
            }
          }, 450);
        }

        startTileDrag(event, item);
      });

      refs.stage.appendChild(tile);
    }

    renderPlaceholder(previewResult);
    renderAffectedPlaceholders(previewItems);
    renderDragPreview(previewResult);
    renderMarqueeSelection();
    renderOverlayControls(cropAnchorTarget?.item ?? null, cropAnchorTarget?.frame ?? null, previewResult);
    renderSelectionToolbar();

    if (previewItems.length === 0) {
      const viewportTransform = getCurrentViewportTransform();
      const visibleCenterX = state.isMobileMode
        ? (viewportTransform.contentLeft + viewportTransform.contentRight) / (2 * viewportTransform.zoom)
        : refs.shell.scrollLeft / viewportTransform.zoom + refs.shell.clientWidth / (2 * viewportTransform.zoom);
      const visibleCenterY = state.isMobileMode
        ? (viewportTransform.contentTop + viewportTransform.contentBottom) / (2 * viewportTransform.zoom)
        : refs.shell.scrollTop / viewportTransform.zoom + refs.shell.clientHeight / (2 * viewportTransform.zoom);
      const empty = document.createElement('div');
      empty.className = 'board-empty-state';
      empty.style.left = `${visibleCenterX}px`;
      empty.style.top = `${visibleCenterY}px`;
      empty.innerHTML = `
        <div class="board-empty-state__card">
          <p class="board-empty-state__eyebrow">Start the board</p>
          <h2 class="board-empty-state__title">Import images into the snapping grid.</h2>
          <p class="board-empty-state__copy">Drop files, paste screenshots, or import references to build a structured moodboard that stays aligned as it grows.</p>
          <div class="board-empty-state__actions">
            <button type="button" class="board-empty-state__button">Import images</button>
          </div>
          <div class="board-empty-state__hints">
            <span class="board-empty-state__hint">Drop files or links</span>
            <span class="board-empty-state__hint">Paste from clipboard</span>
            <span class="board-empty-state__hint">Tiles snap into rhythm</span>
          </div>
        </div>
      `;
      empty.querySelector('.board-empty-state__button')?.addEventListener('click', () => {
        openImportPicker();
      });
      refs.stage.appendChild(empty);
    }
  }

  // ---------------------------------------------------------------------------
  // Annotations: free-floating text boxes + arrows above the grid
  // ---------------------------------------------------------------------------

  function getAnnotationById(id) {
    return state.annotations.find((annotation) => annotation.id === id) ?? null;
  }

  function boardPointFromEvent(event) {
    return getPointWithinBoard(getStageRect(), event.clientX, event.clientY);
  }

  function setActiveTool(tool) {
    state.activeTool = tool;

    if (tool) {
      selectAnnotation(null, { render: false });
    }

    if (refs.textTool) {
      refs.textTool.setAttribute('aria-pressed', String(tool === 'text'));
      refs.textTool.classList.toggle('board-hud__button--active', tool === 'text');
    }

    render();
  }

  function toggleTextTool() {
    setActiveTool(state.activeTool === 'text' ? null : 'text');
  }

  function selectAnnotation(id, { render: shouldRender = true } = {}) {
    if (state.editingAnnotationId && state.editingAnnotationId !== id) {
      commitAnnotationEditing({ render: false });
    }

    state.selectedAnnotationId = id;

    if (id) {
      state.selectedItemIds = [];
      state.selectionAnchorId = null;
    }

    if (shouldRender) {
      render();
    }
  }

  function createTextAnnotation(x, y) {
    const annotation = {
      id: createItemId(),
      type: 'text',
      x,
      y,
      width: ANNOTATION_TEXT_DEFAULTS.width,
      text: '',
      color: annotationPrefs.text.color,
      fontSize: annotationPrefs.text.fontSize,
      align: ANNOTATION_TEXT_DEFAULTS.align,
      font: annotationPrefs.text.font,
    };
    state.annotations.push(annotation);
    state.activeTool = null;

    if (refs.textTool) {
      refs.textTool.setAttribute('aria-pressed', 'false');
      refs.textTool.classList.remove('board-hud__button--active');
    }

    state.selectedAnnotationId = annotation.id;
    state.editingAnnotationId = annotation.id;
    saveBoardState();
    render();

    window.requestAnimationFrame(() => {
      const el = annotationTextEls.get(annotation.id);
      const content = el?.querySelector('.annotation-text__content');

      if (content) {
        content.focus();
        placeCaretAtEnd(content);
      }
    });
  }

  // Drop a text box under the current cursor (or board centre as a fallback)
  // and jump straight into editing — the T keyboard shortcut path.
  function createTextAtCursor() {
    if (state.editingAnnotationId) {
      return;
    }

    setActiveTool(null);

    const rect = getStageRect();
    let clientX;
    let clientY;

    if (lastPointerClient) {
      ({ x: clientX, y: clientY } = lastPointerClient);
    } else {
      clientX = rect.left + (refs.shell?.clientWidth ?? rect.width) / 2;
      clientY = rect.top + (refs.shell?.clientHeight ?? rect.height) / 2;
    }

    const point = getPointWithinBoard(rect, clientX, clientY);
    createTextAnnotation(point.x, point.y);
  }

  function beginEditAnnotation(id) {
    const annotation = getAnnotationById(id);

    if (!annotation || annotation.type !== 'text') {
      return;
    }

    state.selectedAnnotationId = id;
    state.editingAnnotationId = id;
    render();

    window.requestAnimationFrame(() => {
      const el = annotationTextEls.get(id);
      const content = el?.querySelector('.annotation-text__content');

      if (content) {
        content.focus();
        placeCaretAtEnd(content);
      }
    });
  }

  function commitAnnotationEditing({ render: shouldRender = true } = {}) {
    const id = state.editingAnnotationId;

    if (!id) {
      return;
    }

    const annotation = getAnnotationById(id);
    const el = annotationTextEls.get(id);
    const content = el?.querySelector('.annotation-text__content');

    if (annotation && content) {
      annotation.text = content.innerText.replace(/ /g, ' ').trim();
    }

    state.editingAnnotationId = null;

    // Drop empty text boxes so a stray click does not litter the board.
    // deleteAnnotation also freezes/ungues any arrows glued to this box.
    if (annotation && annotation.type === 'text' && !annotation.text) {
      deleteAnnotation(id);
      return;
    }

    saveBoardState();

    if (shouldRender) {
      render();
    }
  }

  function deleteAnnotation(id) {
    const target = getAnnotationById(id);

    if (!target) {
      return;
    }

    // Deleting a text box also removes any arrows anchored to it — a dangling
    // arrow with no text to point from reads as a mistake.
    const removeIds = new Set([id]);

    if (target.type === 'text') {
      for (const annotation of state.annotations) {
        if (annotation.type === 'arrow' && annotation.fromTextId === id) {
          removeIds.add(annotation.id);
        }
      }
    }

    if (state.editingAnnotationId === id) {
      state.editingAnnotationId = null;
    }

    state.annotations = state.annotations.filter((annotation) => !removeIds.has(annotation.id));

    if (state.selectedAnnotationId && removeIds.has(state.selectedAnnotationId)) {
      state.selectedAnnotationId = null;
    }

    saveBoardState();
    render();
  }

  function updateAnnotation(id, patch, { save = true } = {}) {
    const annotation = getAnnotationById(id);

    if (!annotation) {
      return;
    }

    Object.assign(annotation, patch);

    if (save) {
      saveBoardState();
    }
  }

  function placeCaretAtEnd(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function getTextBoxHeight(annotation) {
    const el = annotationTextEls.get(annotation.id);

    if (el && el.offsetHeight) {
      return el.offsetHeight;
    }

    return Math.max(annotation.fontSize * 1.6, 24);
  }

  function getTextBoxRect(annotation) {
    return {
      left: annotation.x,
      top: annotation.y,
      width: annotation.width,
      height: getTextBoxHeight(annotation),
    };
  }

  // Arrows pull from — and stay anchored to — the centre of the text box's
  // bottom edge.
  function getTextAnchorPoint(annotation) {
    const rect = getTextBoxRect(annotation);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height };
  }

  function resolveArrowPoints(arrow) {
    const points = arrow.points.map((point) => ({ x: point.x, y: point.y }));

    if (arrow.fromTextId) {
      const annotation = getAnnotationById(arrow.fromTextId);

      if (annotation && annotation.type === 'text') {
        points[0] = getTextAnchorPoint(annotation);
      }
    }

    return points;
  }

  function polylineLength(points) {
    let total = 0;

    for (let i = 1; i < points.length; i += 1) {
      total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }

    return total;
  }

  function squareSegmentDistance(point, start, end) {
    let x = start.x;
    let y = start.y;
    let dx = end.x - x;
    let dy = end.y - y;

    if (dx !== 0 || dy !== 0) {
      const t = ((point.x - x) * dx + (point.y - y) * dy) / (dx * dx + dy * dy);

      if (t > 1) {
        x = end.x;
        y = end.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }

    dx = point.x - x;
    dy = point.y - y;

    return dx * dx + dy * dy;
  }

  function simplifyPath(points, tolerance) {
    if (points.length <= 2) {
      return points.map((point) => ({ x: point.x, y: point.y }));
    }

    const squareTolerance = tolerance * tolerance;
    const keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;
    const stack = [[0, points.length - 1]];

    while (stack.length) {
      const [first, last] = stack.pop();
      let maxSquare = 0;
      let index = -1;

      for (let i = first + 1; i < last; i += 1) {
        const square = squareSegmentDistance(points[i], points[first], points[last]);

        if (square > maxSquare) {
          maxSquare = square;
          index = i;
        }
      }

      if (maxSquare > squareTolerance && index !== -1) {
        keep[index] = true;
        stack.push([first, index], [index, last]);
      }
    }

    return points.filter((_, i) => keep[i]).map((point) => ({ x: point.x, y: point.y }));
  }

  // Reduce a freehand stroke to start + end + at most two apex points. Feeding
  // so few points into the Catmull-Rom smoother yields a clean, gentle arc
  // instead of a jittery polyline that traces every hand tremor.
  function reduceArrowPoints(points) {
    if (points.length <= 2) {
      return points.map((point) => ({ x: point.x, y: point.y }));
    }

    const start = points[0];
    const end = points[points.length - 1];
    const chord = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    // Unit normal to the start→end chord; signed distance tells us which side
    // of the chord (and how far) each sampled point bows out.
    const nx = -(end.y - start.y) / chord;
    const ny = (end.x - start.x) / chord;

    let maxPos = 0;
    let maxNeg = 0;
    let posIdx = -1;
    let negIdx = -1;

    for (let i = 1; i < points.length - 1; i += 1) {
      const signed = (points[i].x - start.x) * nx + (points[i].y - start.y) * ny;
      if (signed > maxPos) {
        maxPos = signed;
        posIdx = i;
      }
      if (signed < maxNeg) {
        maxNeg = signed;
        negIdx = i;
      }
    }

    const span = maxPos - maxNeg;
    const startPoint = { x: start.x, y: start.y };
    const endPoint = { x: end.x, y: end.y };

    // Effectively straight — one clean segment reads better than a forced bend.
    if (span < chord * 0.06 || span < 6) {
      return [startPoint, endPoint];
    }

    const mids = [];
    const bowsBothWays = maxPos > chord * 0.05 && -maxNeg > chord * 0.05 && posIdx !== -1 && negIdx !== -1;

    if (bowsBothWays) {
      // S-curve: keep both apexes, ordered as they were drawn.
      const [a, b] = posIdx < negIdx ? [posIdx, negIdx] : [negIdx, posIdx];
      mids.push({ x: points[a].x, y: points[a].y }, { x: points[b].x, y: points[b].y });
    } else {
      // Simple arc: keep the single furthest apex.
      const apex = -maxNeg > maxPos ? negIdx : posIdx;
      if (apex !== -1) {
        mids.push({ x: points[apex].x, y: points[apex].y });
      }
    }

    return [startPoint, ...mids, endPoint];
  }

  // Turn the reduced arrow points into a rounded path plus the tangent that
  // aims the arrowhead. The dominant case is a single gentle bow, rendered as
  // ONE quadratic bézier that passes through the apex — a clean, symmetric arc
  // that reads far rounder than a multi-segment spline. S-curves chain
  // quadratics through the midpoints between their control points.
  function buildArrowGeometry(points) {
    const n = points.length;
    const end = points[n - 1];

    if (n <= 2) {
      const start = points[0] ?? end;
      return { path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, tangentFrom: start, end };
    }

    if (n === 3) {
      const [s, a, e] = points;
      // Place the control so the curve passes through the apex at its midpoint:
      // B(0.5) = (s + 2c + e) / 4 = a  ⇒  c = 2a − (s + e) / 2.
      const c = { x: 2 * a.x - (s.x + e.x) / 2, y: 2 * a.y - (s.y + e.y) / 2 };
      return { path: `M ${s.x} ${s.y} Q ${c.x} ${c.y} ${e.x} ${e.y}`, tangentFrom: c, end: e };
    }

    // n >= 4: interior points act as quadratic controls, joined at the
    // midpoints between them so the transitions stay C1-smooth.
    const s = points[0];
    let path = `M ${s.x} ${s.y}`;

    for (let i = 1; i < n - 1; i += 1) {
      const ctrl = points[i];
      const anchor =
        i === n - 2
          ? end
          : { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
      path += ` Q ${ctrl.x} ${ctrl.y} ${anchor.x} ${anchor.y}`;
    }

    return { path, tangentFrom: points[n - 2], end };
  }

  function buildArrowHeadData(end, tangentFrom, weight) {
    let dx = end.x - tangentFrom.x;
    let dy = end.y - tangentFrom.y;

    // Degenerate tangent (control landed on the tip): fall back to horizontal.
    if (Math.hypot(dx, dy) < 0.5) {
      dx = 1;
      dy = 0;
    }

    const angle = Math.atan2(dy, dx);
    const size = weight * 3 + 7;
    const spread = 0.5;
    const left = { x: end.x + Math.cos(angle + Math.PI - spread) * size, y: end.y + Math.sin(angle + Math.PI - spread) * size };
    const right = { x: end.x + Math.cos(angle + Math.PI + spread) * size, y: end.y + Math.sin(angle + Math.PI + spread) * size };

    return `M ${end.x} ${end.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;
  }

  function getArrowNubPosition(annotation) {
    return getTextAnchorPoint(annotation);
  }

  // --- Annotation pointer sessions -------------------------------------------

  function onTextBoxPointerDown(event, id) {
    if (event.button !== 0) {
      return;
    }

    if (state.editingAnnotationId === id) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    selectAnnotation(id);

    const annotation = getAnnotationById(id);

    if (!annotation || annotation.type !== 'text') {
      return;
    }

    const point = boardPointFromEvent(event);
    state.annotationDragSession = {
      id,
      grabX: point.x - annotation.x,
      grabY: point.y - annotation.y,
      moved: false,
    };
  }

  function onArrowNubPointerDown(event, textId) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    const point = boardPointFromEvent(event);
    state.arrowDrawSession = {
      fromTextId: textId,
      raw: [point],
    };
    renderArrowsSvg();
  }

  function onArrowEndpointPointerDown(event, arrowId, pointIndex) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    selectAnnotation(arrowId);
    state.arrowEndpointSession = { id: arrowId, pointIndex };
  }

  function onArrowHitPointerDown(event, arrowId) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    selectAnnotation(arrowId);
  }

  function onAnnotationPointerMove(event) {
    if (state.annotationDragSession) {
      const session = state.annotationDragSession;
      const annotation = getAnnotationById(session.id);

      if (!annotation) {
        return;
      }

      const point = boardPointFromEvent(event);
      annotation.x = point.x - session.grabX;
      annotation.y = point.y - session.grabY;
      session.moved = true;
      renderAnnotations();
      renderAnnotationToolbar();
      return;
    }

    if (state.arrowDrawSession) {
      const session = state.arrowDrawSession;
      const point = boardPointFromEvent(event);
      const last = session.raw[session.raw.length - 1];

      if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 2) {
        session.raw.push(point);
        renderArrowsSvg();
      }
      return;
    }

    if (state.arrowEndpointSession) {
      const annotation = getAnnotationById(state.arrowEndpointSession.id);

      if (!annotation || annotation.type !== 'arrow') {
        return;
      }

      const index = clamp(state.arrowEndpointSession.pointIndex, 0, annotation.points.length - 1);
      const point = boardPointFromEvent(event);
      annotation.points[index] = { x: point.x, y: point.y };
      renderArrowsSvg();
      renderAnnotationToolbar();
    }
  }

  function onAnnotationPointerUp() {
    if (state.annotationDragSession) {
      const moved = state.annotationDragSession.moved;
      state.annotationDragSession = null;

      if (moved) {
        saveBoardState();
      }

      renderAnnotationToolbar();
      return;
    }

    if (state.arrowDrawSession) {
      const session = state.arrowDrawSession;
      state.arrowDrawSession = null;
      const simplified = session.raw.length >= 2
        ? reduceArrowPoints(simplifyPath(session.raw, ARROW_SIMPLIFY_TOLERANCE))
        : session.raw.map((point) => ({ x: point.x, y: point.y }));

      if (simplified.length >= 2 && polylineLength(simplified) >= 14) {
        // An arrow pulled from a text box inherits that box's colour so the two
        // read as one unit; weight still comes from the remembered default.
        const fromText = session.fromTextId ? getAnnotationById(session.fromTextId) : null;
        const arrowColor = fromText && fromText.type === 'text' ? fromText.color : annotationPrefs.arrow.color;
        const arrow = {
          id: createItemId(),
          type: 'arrow',
          fromTextId: session.fromTextId,
          points: simplified,
          color: arrowColor,
          weight: annotationPrefs.arrow.weight,
        };
        state.annotations.push(arrow);
        state.selectedAnnotationId = arrow.id;
        saveBoardState();
      }

      render();
      return;
    }

    if (state.arrowEndpointSession) {
      state.arrowEndpointSession = null;
      saveBoardState();
      renderAnnotationToolbar();
    }
  }

  // --- Annotation rendering ---------------------------------------------------

  function createTextBoxElement(annotation) {
    const el = document.createElement('div');
    el.className = 'annotation-text';
    el.dataset.annotationId = annotation.id;

    const content = document.createElement('div');
    content.className = 'annotation-text__content';
    content.setAttribute('spellcheck', 'false');
    el.appendChild(content);

    // Plain listeners: this element is removed from the DOM on delete and on
    // widget destroy, so its listeners are garbage-collected. The managed
    // registry would otherwise retain detached nodes for the widget's lifetime.
    el.addEventListener('pointerdown', (event) => onTextBoxPointerDown(event, annotation.id));
    el.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      beginEditAnnotation(annotation.id);
    });
    content.addEventListener('input', () => {
      const current = getAnnotationById(annotation.id);
      if (current) {
        current.text = content.innerText.replace(/ /g, ' ');
      }
    });
    content.addEventListener('blur', () => {
      if (state.editingAnnotationId === annotation.id) {
        commitAnnotationEditing();
      }
    });

    return el;
  }

  function updateTextBoxElement(el, annotation) {
    el.style.left = `${annotation.x}px`;
    el.style.top = `${annotation.y}px`;
    // Hug the text: the box grows with its content (up to a cap, then wraps)
    // instead of holding a fixed width, so nothing floats in empty space and an
    // arrow glued to the box starts right at the glyphs.
    el.style.width = 'max-content';
    el.style.maxWidth = `${ANNOTATION_TEXT_MAX_WIDTH}px`;

    const content = el.querySelector('.annotation-text__content');
    content.style.color = annotation.color;
    content.style.fontSize = `${annotation.fontSize}px`;
    content.style.textAlign = annotation.align;
    content.style.fontFamily = getFontStack(annotation.font);

    const isEditing = state.editingAnnotationId === annotation.id;
    const isSelected = state.selectedAnnotationId === annotation.id;
    content.contentEditable = isEditing ? 'true' : 'false';

    if (!isEditing && content.innerText !== annotation.text) {
      content.textContent = annotation.text;
    }

    el.classList.toggle('is-selected', isSelected && !isEditing);
    el.classList.toggle('is-editing', isEditing);
    el.classList.toggle('is-empty', !annotation.text && !isEditing);

    // Reading offsetWidth reflows synchronously, so this reflects the fitted
    // size. Store it so getTextBoxRect / the arrow nub / export all agree with
    // what's on screen. (Kept within the same render pass before arrows draw.)
    const measured = el.offsetWidth;
    if (measured > 0) {
      annotation.width = clamp(measured, ANNOTATION_TEXT_MIN_WIDTH, ANNOTATION_TEXT_MAX_WIDTH);
    }
  }

  function ensureArrowSvg() {
    if (arrowSvgEl && arrowSvgEl.isConnected) {
      return arrowSvgEl;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'board-annotation-arrows');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';
    svg.style.pointerEvents = 'none';
    refs.annotationLayer.insertBefore(svg, refs.annotationLayer.firstChild);
    arrowSvgEl = svg;
    return svg;
  }

  function svgEl(name, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, String(value));
    }
    return node;
  }

  function renderArrowsSvg() {
    if (!refs.annotationLayer) {
      return;
    }

    const svg = ensureArrowSvg();
    svg.replaceChildren();
    const zoom = Math.max(getCurrentZoom(), 0.0001);
    const handleRadius = 7 / zoom;

    for (const annotation of state.annotations) {
      if (annotation.type !== 'arrow') {
        continue;
      }

      const points = resolveArrowPoints(annotation);
      const geo = buildArrowGeometry(points);
      const pathData = geo.path;
      const isSelected = state.selectedAnnotationId === annotation.id;

      const hit = svgEl('path', {
        d: pathData,
        fill: 'none',
        stroke: 'transparent',
        'stroke-width': Math.max(annotation.weight, 16 / zoom),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      hit.style.pointerEvents = 'stroke';
      hit.style.cursor = 'pointer';
      hit.addEventListener('pointerdown', (event) => onArrowHitPointerDown(event, annotation.id));
      svg.appendChild(hit);

      const line = svgEl('path', {
        d: pathData,
        fill: 'none',
        stroke: annotation.color,
        'stroke-width': annotation.weight,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      line.style.pointerEvents = 'none';
      svg.appendChild(line);

      const head = svgEl('path', {
        d: buildArrowHeadData(geo.end, geo.tangentFrom, annotation.weight),
        fill: annotation.color,
        stroke: annotation.color,
        'stroke-width': annotation.weight * 0.4,
        'stroke-linejoin': 'round',
      });
      head.style.pointerEvents = 'none';
      svg.appendChild(head);

      if (isSelected) {
        // A handle for every editable node: the end, plus the 1–2 mid points so
        // the curve can be reshaped. The start is skipped when the arrow is glued
        // to a text box, since that end tracks the box automatically.
        const startEditable = !annotation.fromTextId;
        const lastIndex = points.length - 1;

        for (let i = 0; i < points.length; i += 1) {
          if (i === 0 && !startEditable) {
            continue;
          }

          const node = points[i];
          const isEnd = i === lastIndex;
          const handle = svgEl('circle', {
            cx: node.x,
            cy: node.y,
            r: isEnd ? handleRadius : handleRadius * 0.85,
            class: isEnd ? 'annotation-endpoint' : 'annotation-endpoint annotation-endpoint--mid',
          });
          handle.style.pointerEvents = 'auto';
          handle.style.cursor = 'grab';
          handle.addEventListener('pointerdown', (event) => onArrowEndpointPointerDown(event, annotation.id, i));
          svg.appendChild(handle);
        }
      }
    }

    // Arrow-start nub on the selected text box.
    const selected = state.selectedAnnotationId ? getAnnotationById(state.selectedAnnotationId) : null;

    if (selected && selected.type === 'text' && !state.editingAnnotationId) {
      const nubPos = getArrowNubPosition(selected);
      const nub = svgEl('circle', {
        cx: nubPos.x,
        cy: nubPos.y,
        r: handleRadius,
        class: 'annotation-arrow-nub',
      });
      nub.style.pointerEvents = 'auto';
      nub.style.cursor = 'crosshair';
      nub.addEventListener('pointerdown', (event) => onArrowNubPointerDown(event, selected.id));
      svg.appendChild(nub);
    }

    // Live preview while drawing an arrow.
    if (state.arrowDrawSession) {
      const session = state.arrowDrawSession;
      let previewPoints = session.raw.length >= 2
        ? reduceArrowPoints(simplifyPath(session.raw, ARROW_SIMPLIFY_TOLERANCE))
        : session.raw.slice();
      const fromAnnotation = getAnnotationById(session.fromTextId);

      if (fromAnnotation && fromAnnotation.type === 'text' && previewPoints.length) {
        // Anchor the start to the box's centre-bottom by REPLACING the first
        // point (not prepending) so the preview keeps the same point count — and
        // therefore the same rounded shape — as the committed arrow.
        previewPoints = previewPoints.map((point) => ({ x: point.x, y: point.y }));
        previewPoints[0] = getTextAnchorPoint(fromAnnotation);
      }

      if (previewPoints.length >= 2) {
        // Preview in the source text box's colour — the committed arrow will
        // inherit it, so the preview should match.
        const previewColor =
          fromAnnotation && fromAnnotation.type === 'text' ? fromAnnotation.color : annotationPrefs.arrow.color;
        const preview = svgEl('path', {
          d: buildArrowGeometry(previewPoints).path,
          fill: 'none',
          stroke: previewColor,
          'stroke-width': annotationPrefs.arrow.weight,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'stroke-dasharray': `${6 / zoom} ${5 / zoom}`,
          opacity: '0.75',
        });
        preview.style.pointerEvents = 'none';
        svg.appendChild(preview);
      }
    }
  }

  function renderAnnotations() {
    if (!refs.annotationLayer) {
      return;
    }

    const layer = refs.annotationLayer;
    layer.classList.toggle('is-tool-active', state.activeTool === 'text');
    ensureArrowSvg();

    const wanted = new Set();

    for (const annotation of state.annotations) {
      if (annotation.type !== 'text') {
        continue;
      }

      wanted.add(annotation.id);
      let el = annotationTextEls.get(annotation.id);

      if (!el) {
        el = createTextBoxElement(annotation);
        annotationTextEls.set(annotation.id, el);
        layer.appendChild(el);
      }

      updateTextBoxElement(el, annotation);
    }

    for (const [id, el] of annotationTextEls) {
      if (!wanted.has(id)) {
        el.remove();
        annotationTextEls.delete(id);
      }
    }

    renderArrowsSvg();
  }

  function positionAnnotationToolbar(el, annotation) {
    const stageRect = getStageRect();
    const zoom = getCurrentZoom();
    let boardX;
    let boardY;

    if (annotation.type === 'text') {
      boardX = annotation.x + annotation.width / 2;
      boardY = annotation.y;
    } else {
      const points = resolveArrowPoints(annotation);
      const end = points[points.length - 1];
      boardX = end.x;
      boardY = end.y;
    }

    el.style.left = `${stageRect.left + boardX * zoom}px`;
    el.style.top = `${stageRect.top + boardY * zoom}px`;
  }

  function renderAnnotationToolbar() {
    const el = refs.annotationToolbar;

    if (!el) {
      return;
    }

    const annotation = state.selectedAnnotationId ? getAnnotationById(state.selectedAnnotationId) : null;
    const show = Boolean(annotation) && !state.editingAnnotationId && !state.arrowDrawSession && !state.annotationDragSession;

    if (!show) {
      el.hidden = true;
      el.dataset.forId = '';
      el.dataset.forType = '';
      return;
    }

    if (el.dataset.forId !== annotation.id || el.dataset.forType !== annotation.type) {
      el.dataset.forId = annotation.id;
      el.dataset.forType = annotation.type;

      if (annotation.type === 'text') {
        const activeFont = annotation.font || ANNOTATION_TEXT_DEFAULTS.font;
        const fontOptions = ANNOTATION_FONTS.map(
          (font) => `<option value="${font.id}"${font.id === activeFont ? ' selected' : ''}>${font.label}</option>`,
        ).join('');
        el.innerHTML = `
          <input type="color" class="annotation-toolbar__color" data-atb="color" value="${annotation.color}" aria-label="Text colour" />
          <select class="annotation-toolbar__select" data-atb="font" aria-label="Font">${fontOptions}</select>
          <button type="button" class="annotation-toolbar__btn" data-atb="font-dec" aria-label="Smaller text">A-</button>
          <button type="button" class="annotation-toolbar__btn" data-atb="font-inc" aria-label="Larger text">A+</button>
          <button type="button" class="annotation-toolbar__btn annotation-toolbar__btn--danger" data-atb="delete" aria-label="Delete text">Delete</button>
        `;
      } else {
        el.innerHTML = `
          <input type="color" class="annotation-toolbar__color" data-atb="color" value="${annotation.color}" aria-label="Arrow colour" />
          <button type="button" class="annotation-toolbar__btn" data-atb="weight-dec" aria-label="Thinner arrow">-</button>
          <button type="button" class="annotation-toolbar__btn" data-atb="weight-inc" aria-label="Thicker arrow">+</button>
          <button type="button" class="annotation-toolbar__btn annotation-toolbar__btn--danger" data-atb="delete" aria-label="Delete arrow">Delete</button>
        `;
      }
    } else {
      const colorInput = el.querySelector('[data-atb="color"]');
      if (colorInput && colorInput.value.toLowerCase() !== annotation.color.toLowerCase()) {
        colorInput.value = annotation.color;
      }
      if (annotation.type === 'text') {
        const fontSelect = el.querySelector('[data-atb="font"]');
        const activeFont = annotation.font || ANNOTATION_TEXT_DEFAULTS.font;
        if (fontSelect && fontSelect.value !== activeFont) {
          fontSelect.value = activeFont;
        }
      }
    }

    el.hidden = false;
    positionAnnotationToolbar(el, annotation);
  }

  function render() {
    renderHud();
    renderBoard();
    renderAnnotations();
    renderAnnotationToolbar();
  }

  function cancelDrag() {
    if (state._longPressTimer !== null) {
      clearTimeout(state._longPressTimer);
      state._longPressTimer = null;
    }
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
    renderBoard();
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
    return state.isUtilityPanelOpen || state.isExportPanelOpen;
  }

  function setFloatingPanels(utilityOpen, exportOpen) {
    state.isUtilityPanelOpen = utilityOpen;
    state.isExportPanelOpen = exportOpen;
  }

  function closeFloatingPanels() {
    if (!hasOpenFloatingPanel()) {
      return;
    }

    exportPreviewRequestId += 1;
    resetExportBackgroundHexDraft();
    setFloatingPanels(false, false);
    renderHud();
  }

  function toggleUtilityPanel() {
    const nextOpen = !state.isUtilityPanelOpen;
    setFloatingPanels(nextOpen, false);
    renderHud();
  }

  function openUtilityTab(tab) {
    state.activeUtilityTab = tab;
    setFloatingPanels(true, false);
    renderHud();
  }

  function toggleExportPanel() {
    if (!state.items.length || state.exportState.isExporting) {
      return;
    }

    const nextOpen = !state.isExportPanelOpen;
    exportPreviewRequestId += 1;
    resetExportBackgroundHexDraft();
    setFloatingPanels(false, nextOpen);
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

    const bounds = getExportContentBounds();

    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      setExportStatus('Nothing to export', 'error', { resetAfter: EXPORT_STATUS_DURATION_MS });
      return;
    }

    // Ask where to save first, while we still have the click's user activation.
    const target = await pickSaveTarget(defaultBoardFileName('png'), {
      description: 'PNG image',
      accept: { 'image/png': ['.png'] },
    });

    if (!target) {
      return; // cancelled
    }

    setExportStatus('Exporting PNG...', 'working', { isExporting: true });

    try {
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

      await writeSaveTarget(target, blob);

      setExportStatus('PNG exported.', 'success', { resetAfter: EXPORT_STATUS_DURATION_MS });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'PNG export failed. Remote images may block browser export.';
      setExportStatus(message, 'error', { resetAfter: EXPORT_STATUS_DURATION_MS });
    }
  }

  async function exportClusterAsPdf({
    includeBackground = state.exportIncludeBackground,
    backgroundHex = state.exportBackgroundHex,
  } = {}) {
    if (!state.items.length || state.exportState.isExporting) {
      return;
    }

    const bounds = getExportContentBounds();

    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      setExportStatus('Nothing to export', 'error', { resetAfter: EXPORT_STATUS_DURATION_MS });
      return;
    }

    // Ask where to save first, while we still have the click's user activation.
    const target = await pickSaveTarget(defaultBoardFileName('pdf'), {
      description: 'PDF document',
      accept: { 'application/pdf': ['.pdf'] },
    });

    if (!target) {
      return; // cancelled
    }

    setExportStatus('Exporting PDF...', 'working', { isExporting: true });

    try {
      const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, moveTo, lineTo, appendBezierCurve, closePath, clip, endPath } =
        await import('https://esm.sh/pdf-lib');

      const PX_TO_PT = 0.75;
      const pageWidth = bounds.width * PX_TO_PT;
      const pageHeight = bounds.height * PX_TO_PT;

      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([pageWidth, pageHeight]);

      if (includeBackground) {
        const hex = (backgroundHex ?? DEFAULT_EXPORT_BACKGROUND_HEX).replace('#', '');
        const r = parseInt(hex.slice(0, 2), 16) / 255;
        const g = parseInt(hex.slice(2, 4), 16) / 255;
        const b = parseInt(hex.slice(4, 6), 16) / 255;
        page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: rgb(r, g, b) });
      }

      const imageDataList = await Promise.all(
        state.items.map(async (item) => ({
          item,
          bytes: await fetch(item.src).then((r) => r.arrayBuffer()),
        })),
      );
      const bytesById = new Map(imageDataList.map(({ item, bytes }) => [item.id, bytes]));

      for (const item of sortByVisualOrder(state.items)) {
        const bytes = bytesById.get(item.id);

        if (!bytes) {
          continue;
        }

        const header = new Uint8Array(bytes).slice(0, 4);
        const isPng = header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71;
        const isJpeg = header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
        let pdfImage;

        if (isPng) {
          pdfImage = await pdfDoc.embedPng(bytes);
        } else if (isJpeg) {
          pdfImage = await pdfDoc.embedJpg(bytes);
        } else {
          // WebP or other format — convert to PNG via canvas
          const img = await loadImageForExport(item.src);
          const offscreen = document.createElement('canvas');
          offscreen.width = img.naturalWidth;
          offscreen.height = img.naturalHeight;
          offscreen.getContext('2d').drawImage(img, 0, 0);
          const pngBytes = await new Promise((resolve, reject) =>
            offscreen.toBlob((blob) => (blob ? blob.arrayBuffer().then(resolve) : reject(new Error('Canvas conversion failed'))), 'image/png'),
          );
          pdfImage = await pdfDoc.embedPng(pngBytes);
        }

        const frame = getTileFrame(item);
        const exportFrame = {
          left: frame.left - bounds.left,
          top: frame.top - bounds.top,
          width: frame.width,
          height: frame.height,
        };
        const geometry = getCropGeometry(item, frame);

        const x = exportFrame.left * PX_TO_PT;
        const y = pageHeight - (exportFrame.top + exportFrame.height) * PX_TO_PT;
        const w = exportFrame.width * PX_TO_PT;
        const h = exportFrame.height * PX_TO_PT;
        const imgX = x + geometry.left * PX_TO_PT;
        const imgY = pageHeight - (exportFrame.top + geometry.top + geometry.height) * PX_TO_PT;
        const imgW = geometry.width * PX_TO_PT;
        const imgH = geometry.height * PX_TO_PT;

        const r = state.exportPdfRoundedCorners ? getRadiusPx() * PX_TO_PT : 0;
        const k = 0.5523;
        const clipOps = r > 0
          ? [
              pushGraphicsState(),
              // bottom-left → bottom-right (bottom edge)
              moveTo(x + r, y),
              lineTo(x + w - r, y),
              appendBezierCurve(x + w - r + k * r, y, x + w, y + k * r, x + w, y + r),
              // bottom-right → top-right (right edge)
              lineTo(x + w, y + h - r),
              appendBezierCurve(x + w, y + h - r + k * r, x + w - r + k * r, y + h, x + w - r, y + h),
              // top-right → top-left (top edge)
              lineTo(x + r, y + h),
              appendBezierCurve(x + r - k * r, y + h, x, y + h - r + k * r, x, y + h - r),
              // top-left → bottom-left (left edge)
              lineTo(x, y + r),
              appendBezierCurve(x, y + r - k * r, x + r - k * r, y, x + r, y),
              closePath(),
              clip(),
              endPath(),
            ]
          : [
              pushGraphicsState(),
              moveTo(x, y),
              lineTo(x + w, y),
              lineTo(x + w, y + h),
              lineTo(x, y + h),
              closePath(),
              clip(),
              endPath(),
            ];
        page.pushOperators(...clipOps);
        page.drawImage(pdfImage, { x: imgX, y: imgY, width: imgW, height: imgH });
        page.pushOperators(popGraphicsState());
      }

      const overlayBytes = await buildAnnotationOverlayPngBytes(bounds, 2);

      if (overlayBytes) {
        const overlayImage = await pdfDoc.embedPng(overlayBytes);
        page.drawImage(overlayImage, { x: 0, y: 0, width: pageWidth, height: pageHeight });
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      await writeSaveTarget(target, blob);

      setExportStatus('PDF exported.', 'success', { resetAfter: EXPORT_STATUS_DURATION_MS });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'PDF export failed. Remote images may block browser export.';
      setExportStatus(message, 'error', { resetAfter: EXPORT_STATUS_DURATION_MS });
    }
  }

  async function exportImagesAsZip() {
    if (!state.items.length || state.exportState.isExporting) {
      return;
    }

    // Ask where to save first, while we still have the click's user activation.
    const target = await pickSaveTarget(defaultBoardFileName('zip'), {
      description: 'ZIP archive',
      accept: { 'application/zip': ['.zip'] },
    });

    if (!target) {
      return; // cancelled
    }

    setExportStatus('Zipping images...', 'working', { isExporting: true });

    try {
      const ordered = sortByVisualOrder(state.items);
      const files = [];
      const usedNames = new Set();
      let index = 0;

      for (const item of ordered) {
        index += 1;
        try {
          const response = await fetch(item.src);
          const blob = await response.blob();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const ext = mimeToImageExtension(blob.type);
          let name = `image-${String(index).padStart(2, '0')}.${ext}`;
          // Guard against the (unlikely) duplicate name.
          while (usedNames.has(name)) {
            name = `image-${String(index).padStart(2, '0')}-${createItemId().slice(0, 4)}.${ext}`;
          }
          usedNames.add(name);
          files.push({ name, data: bytes });
        } catch {
          // Skip images that can't be read (e.g. a remote URL blocked by CORS).
        }
      }

      if (!files.length) {
        throw new Error('No images could be read for export');
      }

      const zipBlob = buildZipBlob(files);
      await writeSaveTarget(target, zipBlob);

      const skipped = ordered.length - files.length;
      setExportStatus(
        skipped > 0
          ? `Exported ${files.length} of ${ordered.length} images (${skipped} blocked)`
          : `Exported ${files.length} image${files.length === 1 ? '' : 's'} to ZIP`,
        skipped > 0 ? 'error' : 'success',
        { resetAfter: EXPORT_STATUS_DURATION_MS },
      );
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'ZIP export failed.';
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

    const removeListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };

    const finishSelection = () => {
      removeListeners();

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

    state.marqueeSession.removeListeners = removeListeners;
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

    const removeListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };

    const finishDrag = (shouldSave) => {
      removeListeners();

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

    state.cropAnchorSession.removeListeners = removeListeners;
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

    state.panSession.removeListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function startMobilePan(event) {
    if (
      !state.isMobileMode ||
      event.button !== 0 ||
      state.dragSession ||
      state.resizeSession ||
      state.panSession ||
      state.cropAnchorSession ||
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
      startPanX: state.mobilePanX,
      startPanY: state.mobilePanY,
      mode: 'mobile',
    };
    setWidgetInteractionState('is-panning', true);
    refs.shell?.classList.add('board-shell--panning');

    const onPointerMove = (moveEvent) => {
      if (!state.panSession || state.panSession.pointerId !== moveEvent.pointerId || state.panSession.mode !== 'mobile') {
        return;
      }

      moveEvent.preventDefault();
      state.mobilePanX = state.panSession.startPanX + (moveEvent.clientX - state.panSession.startClientX);
      state.mobilePanY = state.panSession.startPanY + (moveEvent.clientY - state.panSession.startClientY);
      renderBoard();
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

    state.panSession.removeListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
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
        if (state._longPressTimer !== null) {
          clearTimeout(state._longPressTimer);
          state._longPressTimer = null;
        }
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
        state.singleSelectionUiEnabled = !didMove && (state.dragSession.groupItemIds?.length ?? 1) === 1;
      }
      state.suppressNextClick = Boolean(didMove || shouldToggleSelection);
      if (state._longPressTimer !== null) {
        clearTimeout(state._longPressTimer);
        state._longPressTimer = null;
      }
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

    state.dragSession.removeListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  function cycleMobileResize(item) {
    const fakeSession = { originItem: { ...item } };
    const overlay = buildResizeOverlayState(fakeSession, state.items);
    if (!overlay) return;
    const currentTargetId = getResizeOriginTargetId(item);
    const currentIndex = overlay.targets.findIndex((t) => t.id === currentTargetId);
    const nextTarget = overlay.targets[(currentIndex + 1) % overlay.targets.length];
    if (!nextTarget) return;
    const result = resizeItemToShape(item.id, nextTarget.colSpan, nextTarget.rowSpan, state.items);
    state.items = result.items;
    saveBoardState();
    render();
  }

  function startResize(event, item) {
    event.stopPropagation();
    event.preventDefault();
    setSingleSelection(item.id);
    closeFloatingPanels();

    const boardRect = getStageRect();
    const startPointerBoard = getPointWithinBoard(boardRect, event.clientX, event.clientY);
    const rootRect = refs.root?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const handleRect = event.currentTarget.getBoundingClientRect();

    state.resizeSession = {
      itemId: item.id,
      pointerId: event.pointerId,
      originItem: { ...item },
      startPointerBoard,
      pointerBoard: startPointerBoard,
      anchorViewport: {
        x: handleRect.left - rootRect.left + handleRect.width / 2,
        y: handleRect.top - rootRect.top + handleRect.height / 2,
        size: Math.max(handleRect.width, handleRect.height),
      },
      intent: null,
    };
    syncResizeSessionState(state.resizeSession, state.items);
    if (state.resizeSession.overlayLayout?.pointerViewport) {
      state.resizeSession.grabOffsetViewport = {
        x: state.resizeSession.overlayLayout.pointerViewport.x - state.resizeSession.overlayLayout.originX,
        y: state.resizeSession.overlayLayout.pointerViewport.y - state.resizeSession.overlayLayout.originY,
      };
    } else {
      state.resizeSession.grabOffsetViewport = { x: 0, y: 0 };
    }
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
        state.items = preview.commitItems ?? preview.items;
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

    state.resizeSession.removeListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
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
    state.annotations = [];
    state.activeTool = null;
    state.selectedAnnotationId = null;
    state.editingAnnotationId = null;
    state.annotationDragSession = null;
    state.arrowDrawSession = null;
    state.arrowEndpointSession = null;
    state.layout = { ...DEFAULT_LAYOUT };
    state.exportBackgroundHex = DEFAULT_LAYOUT.exportBackgroundHex;
    state.exportBackgroundHexDraft = DEFAULT_LAYOUT.exportBackgroundHex;
    state.zoom = getDefaultZoom();
    state.isMultiSelectMode = false;
    state.viewportTransform = null;
    setFloatingPanels(false, false);
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
            <div class="board-annotation-layer" data-role="annotation-layer"></div>
            <div class="board-overlay-layer" data-role="overlay-layer"></div>
          </div>
        </div>
        <div class="board-hud" data-role="hud">
          <div class="board-hud__context" data-role="hud-context">
            <div class="board-hud__context-row">
              <p class="board-hud__title" data-role="title"></p>
              <span class="board-hud__mode" data-role="mode-status"></span>
            </div>
            <div class="board-hud__meta">
              <span class="board-hud__count" data-role="image-count"></span>
              <span class="board-hud__summary">Snap images into a live editorial canvas.</span>
            </div>
          </div>
          <div class="board-hud__actions" data-role="hud-actions">
            <button type="button" class="board-hud__button board-hud__button--primary" data-role="import-images">Import</button>
            <input type="file" data-role="import-input" accept="image/*" multiple hidden />
            <button
              type="button"
              class="board-hud__button"
              data-role="text-tool"
              aria-pressed="false"
              title="Text tool (T)"
            >Text</button>
            <button
              type="button"
              class="board-hud__button"
              data-role="multi-select-toggle"
              aria-pressed="false"
              hidden
            >Multi-select</button>
            <button type="button" class="board-hud__button" data-role="save-board">Save</button>
            <button type="button" class="board-hud__button" data-role="open-board">Open</button>
            <input type="file" data-role="open-input" accept="application/json,.json" hidden />
            <button
              type="button"
              class="board-hud__button"
              data-role="export-png"
              aria-haspopup="dialog"
              aria-expanded="false"
            >Export</button>
            <button
              type="button"
              class="board-hud__button"
              data-role="utility-toggle"
              aria-haspopup="dialog"
              aria-expanded="false"
            >Settings</button>
          </div>
        </div>
        <div class="board-mobile-zoom" data-role="mobile-zoom" hidden>
          <span class="board-mobile-zoom__value" data-role="mobile-zoom-value">100%</span>
          <input
            type="range"
            class="board-mobile-zoom__slider"
            data-role="mobile-zoom-slider"
            min="${MOBILE_ZOOM_MIN}"
            max="${ZOOM_MAX}"
            step="${ZOOM_STEP}"
            value="1"
            aria-label="Board zoom"
          />
        </div>
        <div class="board-utility-panel" data-role="utility-panel" hidden>
          <div class="board-panel__header">
            <div>
              <p class="board-panel__eyebrow">Board tools</p>
              <p class="board-panel__title">Layout and guidance</p>
            </div>
            <button type="button" class="board-panel__dismiss" data-role="utility-close">Done</button>
          </div>
          <div class="board-utility-panel__tabs">
            <button type="button" class="board-utility-panel__tab" data-role="utility-tab-layout" aria-pressed="true">Layout</button>
          </div>
          <div class="board-utility-panel__section" data-role="utility-layout-section">
            <p class="board-utility-panel__copy">Adjust the board rhythm and export backdrop while keeping the snapping behaviour unchanged.</p>
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
                class="board-export-panel__color-picker board-layout-panel__color-picker"
                data-role="layout-background-color"
                value="${DEFAULT_EXPORT_BACKGROUND_HEX}"
                aria-label="Choose export background colour"
              />
              <div class="board-layout-panel__backdrop-controls">
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
                <button
                  type="button"
                  class="board-layout-panel__reset"
                  data-role="layout-background-reset"
                  aria-label="Reset backdrop colour"
                >Reset</button>
              </div>
            </div>
            <div class="board-utility-panel__danger">
              <div>
                <p class="board-utility-panel__danger-title">Start new project</p>
                <p class="board-utility-panel__danger-copy">Clear the current board and restore the default layout settings.</p>
              </div>
              <button type="button" class="board-hud__button board-hud__button--danger" data-role="new-project">Start New Project</button>
            </div>
          </div>
        </div>
        <div class="board-export-panel" data-role="export-panel" hidden>
          <div class="board-panel__header">
            <div>
              <p class="board-panel__eyebrow">Export</p>
              <p class="board-panel__title" data-role="export-panel-title">PNG output</p>
            </div>
          </div>
          <div class="board-export-panel__preview" data-role="export-preview-frame" data-transparent="false" data-empty="true" data-loading="false">
            <canvas class="board-export-panel__preview-canvas" data-role="export-preview-canvas" hidden></canvas>
            <span class="board-export-panel__preview-message" data-role="export-preview-message">No images to preview.</span>
          </div>
          <div class="board-export-panel__meta">
            <span class="board-export-panel__label">File type</span>
            <div class="board-export-panel__sizes" data-role="export-format-options">
              <button type="button" class="board-export-panel__size-button board-export-panel__size-button--active" data-export-format="png" aria-pressed="true">PNG</button>
              <button type="button" class="board-export-panel__size-button" data-export-format="pdf" aria-pressed="false">PDF</button>
              <button type="button" class="board-export-panel__size-button" data-export-format="zip" aria-pressed="false">Images (ZIP)</button>
            </div>
          </div>
          <div class="board-export-panel__meta">
            <span class="board-export-panel__label">Current cluster</span>
            <span class="board-export-panel__value" data-role="export-current-size"></span>
          </div>
          <div class="board-export-panel__meta" data-role="export-background-row">
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
          <div class="board-export-panel__meta" data-role="export-edge-row">
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
          <div class="board-export-panel__meta" data-role="export-pdf-options" hidden>
            <span class="board-export-panel__label">Corners</span>
            <div class="board-export-panel__sizes">
              <button type="button" class="board-export-panel__size-button board-export-panel__size-button--active" data-export-corners="rounded" aria-pressed="true">Rounded</button>
              <button type="button" class="board-export-panel__size-button" data-export-corners="square" aria-pressed="false">Square</button>
            </div>
          </div>
          <div class="board-export-panel__meta" data-role="export-size-row">
            <span class="board-export-panel__label" data-role="export-output-label">Output PNG</span>
            <span class="board-export-panel__value" data-role="export-output-size"></span>
          </div>
          <div class="board-export-panel__actions">
            <button type="button" class="board-export-panel__action" data-role="export-cancel">Cancel</button>
            <button type="button" class="board-export-panel__action board-export-panel__action--primary" data-role="export-confirm">Export PNG</button>
          </div>
        </div>
        <div class="board-selection-toolbar" data-role="selection-toolbar" hidden></div>
        <div class="annotation-toolbar" data-role="annotation-toolbar" hidden></div>
        <div class="board-toast" data-role="toast" hidden></div>
        <div class="board-mobile-gate" data-role="mobile-gate" hidden>
          <div class="board-mobile-gate__content">
            <p class="board-mobile-gate__eyebrow">Desktop only for now</p>
            <h2 class="board-mobile-gate__title">Moodboard Grid</h2>
            <p class="board-mobile-gate__message">Mobile support is coming soon. For the full experience, open this on a desktop or laptop.</p>
          </div>
        </div>
        </main>
      </div>
    `;

    refs.root = refs.host.querySelector('.moodboard-grid');
    root = refs.root;
    const getRoleRef = (role) => refs.root.querySelector(`[data-role="${role}"]`);

    refs.title = getRoleRef('title');
    refs.imageCount = getRoleRef('image-count');
    refs.modeStatus = getRoleRef('mode-status');
    refs.newProject = getRoleRef('new-project');
    refs.importImages = getRoleRef('import-images');
    refs.importInput = getRoleRef('import-input');
    refs.multiSelectToggle = getRoleRef('multi-select-toggle');
    refs.textTool = getRoleRef('text-tool');
    refs.saveBoard = getRoleRef('save-board');
    refs.openBoard = getRoleRef('open-board');
    refs.openInput = getRoleRef('open-input');
    refs.exportPng = getRoleRef('export-png');
    refs.utilityToggle = getRoleRef('utility-toggle');
    refs.utilityPanel = getRoleRef('utility-panel');
    refs.utilityClose = getRoleRef('utility-close');
    refs.utilityTabLayout = getRoleRef('utility-tab-layout');
    refs.utilityTabHints = getRoleRef('utility-tab-hints');
    refs.utilityLayoutSection = getRoleRef('utility-layout-section');
    refs.utilityHintsSection = getRoleRef('utility-hints-section');
    refs.exportPanel = getRoleRef('export-panel');
    refs.hintsList = getRoleRef('hints-list');
    refs.exportPreviewFrame = getRoleRef('export-preview-frame');
    refs.exportPreviewCanvas = getRoleRef('export-preview-canvas');
    refs.exportPreviewMessage = getRoleRef('export-preview-message');
    refs.exportCurrentSize = getRoleRef('export-current-size');
    refs.exportBackgroundModes = getRoleRef('export-background-modes');
    refs.exportBackgroundRow = getRoleRef('export-background-row');
    refs.layoutBackgroundColor = getRoleRef('layout-background-color');
    refs.layoutBackgroundHex = getRoleRef('layout-background-hex');
    refs.layoutBackgroundReset = getRoleRef('layout-background-reset');
    refs.exportOutputSize = getRoleRef('export-output-size');
    refs.exportOutputLabel = getRoleRef('export-output-label');
    refs.exportSizeRow = getRoleRef('export-size-row');
    refs.exportEdgeRow = getRoleRef('export-edge-row');
    refs.exportPdfOptions = getRoleRef('export-pdf-options');
    refs.exportSizeOptions = getRoleRef('export-size-options');
    refs.exportFormatOptions = getRoleRef('export-format-options');
    refs.exportPanelTitle = getRoleRef('export-panel-title');
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
    refs.annotationLayer = refs.root.querySelector('[data-role="annotation-layer"]');
    refs.cropAnchorLayer = refs.root.querySelector('[data-role="overlay-layer"]');
    refs.hud = refs.root.querySelector('[data-role="hud"]');
    refs.hudContext = getRoleRef('hud-context');
    refs.hudActions = getRoleRef('hud-actions');
    refs.mobileZoomRail = getRoleRef('mobile-zoom');
    refs.mobileZoomSlider = getRoleRef('mobile-zoom-slider');
    refs.mobileZoomValue = getRoleRef('mobile-zoom-value');
    refs.selectionToolbar = getRoleRef('selection-toolbar');
    refs.annotationToolbar = getRoleRef('annotation-toolbar');
    refs.toast = getRoleRef('toast');
    refs.mobileGate = getRoleRef('mobile-gate');

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
    addManagedEventListener(refs.mobileZoomSlider, 'input', (event) => {
      setActiveWidget();
      setMobileZoom(Number(event.currentTarget.value));
    });
    addManagedEventListener(refs.multiSelectToggle, 'click', toggleMultiSelectMode);
    addManagedEventListener(refs.importInput, 'change', async (event) => {
      setActiveWidget();
      const input = event.currentTarget;
      const files = Array.from(input.files || []).filter((file) => file.type.startsWith('image/'));

      if (!files.length) {
        input.value = '';
        return;
      }

      await insertFiles(files, getImportTargetPoint(), null);
      input.value = '';
    });
    addManagedEventListener(refs.textTool, 'click', () => {
      setActiveWidget();
      toggleTextTool();
    });
    addManagedEventListener(refs.saveBoard, 'click', () => {
      setActiveWidget();
      saveBoardToFile();
    });
    addManagedEventListener(refs.openBoard, 'click', () => {
      setActiveWidget();
      openBoardPicker();
    });
    addManagedEventListener(refs.openInput, 'change', async (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0] ?? null;
      await loadBoardFromFile(file);
      input.value = '';
    });
    addManagedEventListener(refs.exportPng, 'click', toggleExportPanel);
    addManagedEventListener(refs.utilityToggle, 'click', toggleUtilityPanel);
    addManagedEventListener(refs.utilityClose, 'click', closeFloatingPanels);
    addManagedEventListener(refs.utilityTabLayout, 'click', () => {
      openUtilityTab('layout');
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
    addManagedEventListener(refs.layoutBackgroundReset, 'click', () => {
      setExportBackgroundHex(DEFAULT_EXPORT_BACKGROUND_HEX);
    });
    addManagedEventListener(refs.exportCancel, 'click', () => {
      closeFloatingPanels();
    });
    addManagedEventListener(refs.exportConfirm, 'click', async () => {
      const exportSettings = getExportSettings();
      const format = state.exportFormat;
      setFloatingPanels(false, false);
      renderHud();
      if (format === 'pdf') {
        await exportClusterAsPdf(exportSettings);
      } else if (format === 'zip') {
        await exportImagesAsZip();
      } else {
        await exportClusterAsPng(exportSettings);
      }
    });

    addManagedEventListener(refs.exportFormatOptions, 'click', (event) => {
      const button = event.target.closest('[data-export-format]');
      if (!button) return;
      state.exportFormat = button.dataset.exportFormat;
      renderExportPanel();
    });
    addManagedEventListener(refs.exportPdfOptions, 'click', (event) => {
      const button = event.target.closest('[data-export-corners]');
      if (!button) return;
      state.exportPdfRoundedCorners = button.dataset.exportCorners === 'rounded';
      renderExportPanel();
    });
    addManagedEventListener(refs.annotationLayer, 'pointerdown', (event) => {
      if (state.activeTool === 'text' && event.target === refs.annotationLayer) {
        event.stopPropagation();
        setActiveWidget();
        const point = boardPointFromEvent(event);
        createTextAnnotation(point.x, point.y);
      }
    });
    addManagedEventListener(document, 'pointermove', (event) => {
      lastPointerClient = { x: event.clientX, y: event.clientY };
    });
    addManagedEventListener(document, 'pointermove', onAnnotationPointerMove);
    addManagedEventListener(document, 'pointerup', onAnnotationPointerUp);
    addManagedEventListener(
      document,
      'pointerdown',
      (event) => {
        if (!isWidgetActive()) {
          return;
        }

        const target = event.target;
        const insideAnnotation =
          target instanceof Element &&
          (target.closest('.annotation-text') ||
            target.closest('[data-role="annotation-toolbar"]') ||
            target.closest('.board-annotation-arrows'));

        if (insideAnnotation) {
          return;
        }

        // Clicking the background dismisses the annotation entirely: commit any
        // in-progress edit, then clear the selection so the floating toolbar
        // closes (a bare commit would leave the box selected and the bar open).
        if (state.editingAnnotationId) {
          commitAnnotationEditing({ render: false });
        }

        if (state.selectedAnnotationId) {
          selectAnnotation(null);
        }
      },
      true,
    );
    addManagedEventListener(refs.annotationToolbar, 'input', (event) => {
      const control = event.target.closest('[data-atb]');
      if (!control) return;
      const annotation = state.selectedAnnotationId ? getAnnotationById(state.selectedAnnotationId) : null;
      if (!annotation) return;
      if (control.dataset.atb === 'color') {
        // Live board preview only — persisting the whole board on every picker
        // tick would re-serialize all image data URLs, so that waits for 'change'.
        updateAnnotation(annotation.id, { color: control.value }, { save: false });
        // But DO remember the colour live: <input type="color"> fires 'input'
        // reliably, whereas its 'change' event is flaky across browsers, and
        // persisting the tiny prefs object here is cheap.
        rememberAnnotationDefaults(annotation);
        renderAnnotations();
      }
    });
    addManagedEventListener(refs.annotationToolbar, 'change', (event) => {
      const control = event.target.closest('[data-atb]');
      if (!control) return;
      const annotation = state.selectedAnnotationId ? getAnnotationById(state.selectedAnnotationId) : null;
      if (!annotation) return;
      if (control.dataset.atb === 'color') {
        saveBoardState();
        rememberAnnotationDefaults(annotation);
      } else if (control.dataset.atb === 'font') {
        updateAnnotation(annotation.id, { font: control.value });
        rememberAnnotationDefaults(annotation);
        renderAnnotations();
      }
    });
    addManagedEventListener(refs.annotationToolbar, 'click', (event) => {
      const control = event.target.closest('[data-atb]');
      if (!control) return;
      const annotation = state.selectedAnnotationId ? getAnnotationById(state.selectedAnnotationId) : null;
      if (!annotation) return;
      const action = control.dataset.atb;

      if (action === 'delete') {
        deleteAnnotation(annotation.id);
        return;
      }

      if (action === 'font-dec') {
        updateAnnotation(annotation.id, { fontSize: clamp(annotation.fontSize - 2, ANNOTATION_FONT_MIN, ANNOTATION_FONT_MAX) });
      } else if (action === 'font-inc') {
        updateAnnotation(annotation.id, { fontSize: clamp(annotation.fontSize + 2, ANNOTATION_FONT_MIN, ANNOTATION_FONT_MAX) });
      } else if (action === 'weight-dec') {
        updateAnnotation(annotation.id, { weight: clamp(annotation.weight - 1, ANNOTATION_ARROW_MIN_WEIGHT, ANNOTATION_ARROW_MAX_WEIGHT) });
      } else if (action === 'weight-inc') {
        updateAnnotation(annotation.id, { weight: clamp(annotation.weight + 1, ANNOTATION_ARROW_MIN_WEIGHT, ANNOTATION_ARROW_MAX_WEIGHT) });
      }

      rememberAnnotationDefaults(annotation);
      renderAnnotations();
      renderAnnotationToolbar();
    });
    addManagedEventListener(
      window,
      'scroll',
      () => {
        if (state.selectedAnnotationId) {
          renderAnnotationToolbar();
        }
      },
      true,
    );
    addManagedEventListener(window, 'resize', () => {
      if (state.selectedAnnotationId) {
        renderAnnotationToolbar();
      }
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
        if (state.isMobileMode) {
          return;
        }

        event.preventDefault();

        if (!state.dragSession && !state.resizeSession && !state.panSession) {
          const direction = event.deltaY < 0 ? 1 : -1;
          const anchor = getClusterAnchorClientPoint();
          setZoom(state.zoom + direction * ZOOM_STEP, anchor.clientX, anchor.clientY);
        }
      },
      { passive: false },
    );

    addManagedEventListener(
      refs.root,
      'touchmove',
      (event) => {
        if (state.isMobileMode && event.touches.length > 1) {
          event.preventDefault();
        }
      },
      { passive: false },
    );

    ['gesturestart', 'gesturechange', 'gestureend'].forEach((eventName) => {
      addManagedEventListener(refs.root, eventName, (event) => {
        if (state.isMobileMode) {
          event.preventDefault();
        }
      });
    });

    addManagedEventListener(refs.stage, 'click', (event) => {
      if (consumeSuppressedClick()) {
        return;
      }

      if (isStageBackgroundTarget(event.target)) {
        clearSelectionAndRefresh();
      }
    });

    addManagedEventListener(refs.stage, 'pointerdown', (event) => {
      if (event.button === 0 && isStageBackgroundTarget(event.target)) {
        if (canStartMobileMarquee()) {
          startMarqueeSelection(event);
        } else if (state.isMobileMode) {
          startMobilePan(event);
        }
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
      if (event.button === 0 && event.target === refs.board) {
        if (canStartMobileMarquee()) {
          startMarqueeSelection(event);
        } else if (state.isMobileMode) {
          startMobilePan(event);
        }
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

    if (typeof ResizeObserver !== 'undefined' && refs.shell) {
      const shellResizeObserver = new ResizeObserver(() => {
        const h = refs.shell.clientHeight;
        // Guard against auto-height infinite loops: only re-render when the shell
        // height looks like an externally-set viewport size (not content-driven growth).
        if (h > 0 && h <= window.innerHeight + 200) {
          updateMobileMode();
          state.zoom = clampZoom(state.zoom);
          render();
        }
      });
      shellResizeObserver.observe(refs.shell);
      managedListeners.push(() => shellResizeObserver.disconnect());
    }

    addManagedEventListener(document, 'pointerdown', (event) => {
      if (!hasOpenFloatingPanel() || isFloatingUiTarget(event.target) || isTargetInsideWidget(event.target)) {
        return;
      }

      closeFloatingPanels();
    });

    addManagedEventListener(window, 'keydown', (event) => {
      if (!isWidgetActive()) return;
      // Undo / redo — Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y). Skipped
      // while editing text so the browser's own text undo still works there.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        (event.key === 'z' || event.key === 'Z' || event.key === 'y' || event.key === 'Y')
      ) {
        if (
          state.editingAnnotationId ||
          isInteractiveTarget(event.target) ||
          (event.target instanceof Element && event.target.closest('[contenteditable="true"]'))
        ) {
          return;
        }

        const redo = event.key === 'y' || event.key === 'Y' || event.shiftKey;
        event.preventDefault();
        if (redo) {
          redoBoard();
        } else {
          undoBoard();
        }
        return;
      }
      if (
        (event.key === 't' || event.key === 'T') &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !state.editingAnnotationId &&
        !isInteractiveTarget(event.target) &&
        !(event.target instanceof Element && event.target.closest('[contenteditable="true"]'))
      ) {
        event.preventDefault();
        createTextAtCursor();
        return;
      }
      if (event.key === 'Escape') {
        if (state.editingAnnotationId) {
          event.preventDefault();
          commitAnnotationEditing();
          return;
        }
        if (state.activeTool) {
          event.preventDefault();
          setActiveTool(null);
          return;
        }
        if (state.selectedAnnotationId) {
          event.preventDefault();
          selectAnnotation(null);
          return;
        }
        if (hasOpenFloatingPanel()) {
          closeFloatingPanels();
        }
      }
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        !state.editingAnnotationId &&
        !isInteractiveTarget(event.target) &&
        !(event.target instanceof Element && event.target.closest('[contenteditable="true"]'))
      ) {
        if (state.selectedAnnotationId) {
          event.preventDefault();
          deleteAnnotation(state.selectedAnnotationId);
          return;
        }
        const selectionIds = getSelectionIds();
        if (selectionIds.length > 0) {
          event.preventDefault();
          deleteSelection();
        }
      }
    });
  }

  buildAppShell();
  render();
  recordHistory(); // seed the undo baseline with the loaded board

  const instance = {
    container,
    element: refs.root,
    options: { ...settings },
    render,
    destroy() {
      if (state._longPressTimer !== null) {
        clearTimeout(state._longPressTimer);
        state._longPressTimer = null;
      }
      state.dragSession?.removeListeners?.();
      state.resizeSession?.removeListeners?.();
      state.panSession?.removeListeners?.();
      state.marqueeSession?.removeListeners?.();
      state.cropAnchorSession?.removeListeners?.();
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
