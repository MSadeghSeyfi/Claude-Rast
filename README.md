# Claude RTL Fix

A Chrome extension that adds full **RTL (Right-to-Left)** support to [Claude.ai](https://claude.ai) for Persian, Arabic, and Hebrew text.

Claude.ai renders all responses in LTR, which makes Persian/Arabic/Hebrew text unreadable. This extension automatically detects RTL content and fixes the rendering — in paragraphs, lists, tables, code blocks, math formulas, and diagrams.

## Features

- **Smart RTL Detection** — Automatically detects RTL-dominant text at block level (paragraphs, headings, list items, table cells, etc.)
- **BiDi Fix** — Correct placement of numbers, English words, and math operators within RTL text using Unicode Isolate characters
- **Arrow Mirroring** — LTR arrows (`→`, `⇒`, `➡`, ...) are swapped to their RTL equivalents with proper word reordering
- **KaTeX / LaTeX Support** — Math formulas stay LTR (as they should) even inside RTL blocks
- **Code Blocks** — Persian/Arabic code blocks (no language) become full RTL; actual code (Python, JS, etc.) uses per-line BiDi detection
- **Mermaid Diagrams** — RTL text inside SVG diagrams is fixed
- **Lists & Blockquotes** — Bullets, numbers, and quote borders move to the right side
- **Tables** — RTL table cells get proper alignment
- **Toggle On/Off** — One-click toggle from the extension popup
- **Zero UI Impact** — Only touches assistant response content, never the page UI

## Installation

### From Source (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/MSadeghSeyfi/claude-rast.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the cloned folder
5. Navigate to [claude.ai](https://claude.ai) — RTL text should now render correctly

## How It Works

The extension injects a content script (`content.js`) and stylesheet (`styles.css`) into Claude.ai pages. It uses a `MutationObserver` to watch for new content as Claude streams responses, and applies fixes in real-time:

1. **Block-level scan** — Finds `<p>`, `<li>`, `<h1>`..`<h6>`, `<td>`, etc. and checks if their text is RTL-dominant (>25% RTL characters)
2. **BiDi isolation** — Wraps English words and numbers in Unicode LRI/PDI isolates so the browser's BiDi algorithm places them correctly within RTL flow
3. **Arrow replacement** — Swaps directional arrows and wraps surrounding words in isolates for correct visual ordering
4. **KaTeX protection** — Forces all `.katex` elements to remain `dir="ltr"` so math notation doesn't break
5. **Code block detection** — Distinguishes between "text" blocks (full RTL) and "code" blocks (per-line BiDi via `unicode-bidi: plaintext`)

## File Structure

```
claude-rast/
  manifest.json      # Chrome Extension manifest (v3)
  content.js         # Main content script — RTL detection & fixing logic
  styles.css         # Injected CSS for RTL layout
  background.js      # Service worker — sets default enabled state
  popup.html         # Extension popup UI
  popup.js           # Popup toggle logic
  icons/             # Extension icons (16, 32, 48, 128)
```

## Compatibility

- **Browser**: Chrome, Edge, Brave, and other Chromium-based browsers
- **Site**: Claude.ai (`https://claude.ai/*`)
- **Languages**: Persian (Farsi), Arabic, Hebrew, Urdu, and any RTL script

## Author

**Mohammad Sadegh Seyfi** — [GitHub](https://github.com/MSadeghSeyfi)

## License

MIT
