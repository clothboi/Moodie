# Moodboard Grid

Embeddable moodboard editor for Webflow and other no-code sites. The widget mounts into any container with `data-moodboard-grid`, stores each visitor's board in `localStorage`, and can be hosted from GitHub Pages.

## Local Development

```bash
npm install
npm run dev
```

The demo page lives at the project root and auto-mounts the widget with:

```html
<div
  data-moodboard-grid
  data-title="Moodboard Grid Demo"
  data-storage-key="moodboard-grid.demo"
></div>
```

## Public API

The browser bundle exposes:

```js
window.MoodboardGrid.mount(element, {
  title: 'Moodboard Grid',
  storageKey: 'moodboard-grid.board',
});

window.MoodboardGrid.autoInit();
```

`autoInit()` mounts every `[data-moodboard-grid]` element it finds. Use a unique `data-storage-key` for each embed if you place multiple boards across different pages.

## Build Output

```bash
npm run build
```

The production widget bundle is emitted to `dist/` as:

- `moodboard-grid.js`
- `moodboard-grid.css`

## Webflow Embed

Add an Embed block or page-level custom code with:

```html
<link rel="stylesheet" href="https://YOUR-USERNAME.github.io/YOUR-REPO/moodboard-grid.css" />

<div
  data-moodboard-grid
  data-title="Moodboard Grid"
  data-storage-key="moodboard-grid.webflow"
></div>

<script src="https://YOUR-USERNAME.github.io/YOUR-REPO/moodboard-grid.js" defer></script>
<script>
  window.addEventListener('load', function () {
    window.MoodboardGrid.autoInit();
  });
</script>
```

## GitHub Repo Setup

1. Create a new public GitHub repository.
2. Connect this folder to that repo and push your default branch.
3. Let GitHub Actions deploy `dist/` to GitHub Pages.
4. Use the GitHub Pages URLs in your Webflow embed snippet.

## Notes

- The current widget is per-visitor only. It does not publish one shared board state to all visitors.
- Local backup folders are ignored by Git and left on disk.
- The legacy React `src/` implementation is still in the repo, but the standalone widget at the root is the production integration path.

