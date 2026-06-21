/**
 * Claude RTL Fix — Content Script
 * Applies full RTL (Right-to-Left) text rendering fixes to Claude.ai's
 * generated response content. Does NOT touch any page UI elements.
 */

'use strict';

// ─── RTL Unicode Ranges ────────────────────────────────────────────────────
// Arabic, Arabic Extended-A/B, Arabic Presentation Forms A/B,
// Hebrew, Persian, Urdu, RLM character (U+200F)
const RTL_REGEX = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF\u200F]/;

// ─── Arrow Replacement Map (LTR → RTL equivalents) ────────────────────────
const ARROW_MAP = {
  '\u2192': '\u2190', // → → ←
  '\u27F6': '\u27F5', // ⟶ → ⟵
  '\u21D2': '\u21D0', // ⇒ → ⇐
  '\u27A1': '\u2B05', // ➡ → ⬅
  '\u279C': '\u2B05', // ➜ → ⬅
  '\u279E': '\u2B05', // ➞ → ⬅
  '\u2794': '\u2B05', // ➔ → ⬅
  '\u21A6': '\u21A4', // ↦ → ↤
  '\u21FE': '\u21FD', // ⇾ → ⇽
  '\u27E9': '\u27E8', // ⟩ → ⟨ (angle brackets often used as arrows)
};
const ARROW_REGEX = new RegExp(
  Object.keys(ARROW_MAP).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g'
);

// ─── Selectors for Claude.ai Response Content ONLY ────────────────────────
// Multiple selectors for robustness across Claude.ai DOM changes.
// These all target the assistant message content, never the page UI.
// claude.ai/code uses epitaxy-* classes; classic claude.ai uses the others.
const RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '.font-claude-message',
  '[data-is-streaming]',
  '.message-content',
  // claude.ai/code (Epitaxy UI)
  '.epitaxy-markdown',
  '[data-epitaxy-entry]',
  // claude.ai/design (Cowork/Design UI) — styled-components hash classes
  // are unstable, so we anchor on the stable data-testid container instead.
  '[data-testid="chat-messages"]',
  // Artifact / file-preview panel (e.g. previewing a generated .md file) —
  // a separate panel from the chat list, not covered by the selectors above.
  '.font-claude-response',
  '[data-skill-file-viewer="true"]',
];

// Block-level elements within responses to check for RTL
const BLOCK_ELEMENTS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION',
  'DT', 'DD', 'SUMMARY', 'CAPTION',
]);

// Elements where we must NOT touch content (code integrity)
const CODE_ANCESTORS = new Set(['PRE', 'CODE', 'MATH', 'SCRIPT', 'STYLE']);

// CSS classes that indicate a KaTeX/LaTeX ancestor (must stay LTR)
const KATEX_CLASSES = ['katex', 'katex-html', 'katex-mathml', 'katex-display'];

let isRunning = false;
let debounceTimer = null;
let observer = null;

// Unicode BiDi control characters
const RLM = '\u200F'; // Right-to-Left Mark
const LRM = '\u200E'; // Left-to-Right Mark
const RLI = '\u2067'; // Right-to-Left Isolate
const LRI = '\u2066'; // Left-to-Right Isolate
const PDI = '\u2069'; // Pop Directional Isolate

// ─── Utility: Check if text contains RTL characters ───────────────────────
function hasRTLChars(text) {
  return RTL_REGEX.test(text);
}

// ─── Utility: Check if RTL characters dominate the text ───────────────────
// Checks the whole text first, then checks each line individually.
// This handles elements like "<strong>Dumbbell Shoulder Press</strong>\n3 ست × 10 تکرار"
// where the long English name dominates overall, but the second line is clearly RTL.
function isRTLDominant(text) {
  const stripRegex = /[\s\d\p{P}\p{S}]/gu; // strip whitespace, digits, punctuation, symbols (×, =, etc.)
  const rtlSourceRegex = new RegExp(RTL_REGEX.source, 'g');

  // Check whole text
  const stripped = text.replace(stripRegex, '');
  if (!stripped.length) return false;
  const rtlChars = (stripped.match(rtlSourceRegex) || []).length;
  if ((rtlChars / stripped.length) >= 0.25) return true;

  // Per-line check: if any line is RTL-dominant, the whole element should be RTL
  const lines = text.split('\n');
  for (const line of lines) {
    const lineStripped = line.replace(stripRegex, '');
    if (!lineStripped.length) continue;
    const lineRtl = (lineStripped.match(new RegExp(RTL_REGEX.source, 'g')) || []).length;
    if ((lineRtl / lineStripped.length) >= 0.25) return true;
  }
  return false;
}

// ─── Utility: Check if an element has a CODE/PRE/KaTeX ancestor ───────────
function hasCodeAncestor(el) {
  let node = el.parentElement;
  while (node) {
    if (CODE_ANCESTORS.has(node.tagName)) return true;
    // Check for KaTeX classes
    if (node.classList && KATEX_CLASSES.some(cls => node.classList.contains(cls))) return true;
    node = node.parentElement;
  }
  return false;
}

// ─── Utility: Get the response container elements ─────────────────────────
function getResponseContainers() {
  const found = new Set();
  for (const selector of RESPONSE_SELECTORS) {
    document.querySelectorAll(selector).forEach(el => found.add(el));
  }
  return [...found];
}

// ─── Utility: Wrap regex matches only if NOT inside an existing LRI…PDI ───
// Prevents nested isolates which break the BiDi algorithm.
function wrapOutsideIsolates(str, regex, wrapFn) {
  return str.replace(regex, function () {
    const match = arguments[0];
    const offset = arguments[arguments.length - 2];
    // Check if this position is inside an unclosed LRI isolate
    const before = str.substring(0, offset);
    const lastLRI = before.lastIndexOf(LRI);
    const lastPDI = before.lastIndexOf(PDI);
    if (lastLRI !== -1 && lastLRI > lastPDI) return match; // inside isolate → skip
    return wrapFn(match);
  });
}

// ─── Fix: Inject BiDi control chars into text nodes for correct ordering ──
// In RTL context, numbers and LTR words get misplaced by the BiDi algorithm.
// We use Unicode Isolate characters (LRI/RLI/PDI) to wrap segments and
// RLM/LRM marks to anchor numbers in the correct visual position.
//
// Step order matters — multi-digit decimals (0.5) must be wrapped BEFORE
// operator+number (=0.5) to avoid nested isolates like ⁦=⁦0.5⁩⁩.
function fixBiDiInTextNode(textNode) {
  const text = textNode.nodeValue;
  if (!text) return;
  // Skip if already processed (contains isolate chars)
  if (text.indexOf(LRI) !== -1 || text.indexOf(RLI) !== -1) return;

  // This function only runs on text nodes inside a block we already marked
  // dir="rtl". A text node with NO RTL characters (e.g. a pure-English
  // suggestion chip like "Explain like I'm 5") still needs isolating \u2014
  // otherwise a trailing/standalone digit gets visually relocated by the
  // browser's native BiDi algorithm under the RTL paragraph context.
  if (!hasRTLChars(text)) {
    if (text.trim() && /[A-Za-z0-9]/.test(text)) {
      textNode.nodeValue = LRI + text + PDI;
    }
    return;
  }
  if (!/[A-Za-z0-9\u0370-\u03FF]/.test(text)) return;

  let result = text;

  // Step 1: Wrap contiguous English word sequences in LRI...PDI isolates.
  // Optionally captures a leading integer so "2 GB", "16 MB", "2GB" stay as
  // a single LTR unit instead of two separate isolates that swap in RTL flow.
  result = result.replace(
    /(?<![.\d\w])(?:\d+\s*)?[A-Za-z][\w]*(?:[\s\-]+[A-Za-z][\w]*)*/g,
    match => LRI + match + PDI
  );

  // Step 1.5: Wrap Greek letter + operator + number as a single unit.
  // This handles "α=1", "β=0.5", "ρ=0.1", "σ=2" etc.
  // Greek letters (U+0370–U+03FF) are LTR but not caught by Step 1.
  // Without this, bare "α" between isolates creates a continuous LTR run
  // that swallows commas and breaks RTL ordering of parameter lists.
  result = result.replace(
    /[\u0370-\u03FF]\s*[=<>≤≥≠≈+\-×÷]\s*\d[\d.]*/g,
    match => LRI + match + PDI
  );

  // Step 2: Wrap multi-digit number expressions in LRI...PDI isolates.
  // This handles "3 × 30", "0.5", "0.92", "25/100" etc.
  // Must run BEFORE operator+number so "=0.5" doesn't create nested isolates.
  result = wrapOutsideIsolates(result,
    /\d[\d\s×x*.\-+/()%=,]*\d[\d.]*/g,
    match => LRI + match + PDI
  );

  // Step 3: Wrap math operator + number groups in LRI...PDI isolates.
  // This handles "= 1", "≥ 0", "≤ 100" etc.
  // After steps 1.5/2, "α=1" and "=⁦0.5⁩" are already wrapped,
  // so only genuinely unwrapped operator+number pairs are caught.
  result = wrapOutsideIsolates(result,
    /[=<>≤≥≠≈+\-×÷]\s*\d[\d.]*/g,
    match => LRI + match + PDI
  );

  // Step 4: Handle standalone single numbers adjacent to RTL text
  // (e.g., "3 ست" → wrap "3" in isolate so it stays on the correct side)
  result = wrapOutsideIsolates(result,
    /(?<![.\d])\d+(?![.\d])/g,
    match => LRI + match + PDI
  );

  if (result !== text) {
    textNode.nodeValue = result;
  }
}

// ─── Fix: Walk text nodes in an RTL element and fix BiDi ordering ─────────
function fixBiDiInElement(el) {
  const walker = document.createTreeWalker(
    el,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (hasCodeAncestor(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    fixBiDiInTextNode(node);
  }
}

// ─── Fix: Apply RTL to a block element ────────────────────────────────────
function applyRTLToBlock(el) {
  if (el.dataset.rtlxDone === '1') return; // already processed stably
  const text = el.textContent || '';
  if (!text.trim()) return;

  if (isRTLDominant(text)) {
    el.setAttribute('dir', 'rtl');
    el.classList.add('rtlx-block');
    fixBiDiInElement(el);
    fixArrowsInElement(el);
  }
  // Mark as processed so we don't re-check on every mutation
  el.dataset.rtlxDone = '1';
}

// ─── Fix: Replace LTR arrows with RTL arrows in text nodes ───────────────
// When arrows are inside RTL blocks, we need TWO things:
// 1. Swap the arrow direction (→ to ←)
// 2. Wrap LTR words in LRI isolates so BiDi reorders them in RTL
// Without step 2, "Settings ← Billing" stays as one LTR run and
// doesn't get reordered. With both steps:
//   Logical: ⁦Settings⁩ ← ⁦Billing⁩
//   Visual:  Billing ← Settings  (Settings on right, pointing to Billing)
function fixArrowsInElement(el) {
  ARROW_REGEX.lastIndex = 0;
  if (!ARROW_REGEX.test(el.innerHTML)) return;

  const walker = document.createTreeWalker(
    el,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip text nodes inside code/pre/math/katex elements
        if (hasCodeAncestor(node)) return NodeFilter.FILTER_REJECT;
        ARROW_REGEX.lastIndex = 0;
        return ARROW_REGEX.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    }
  );

  const nodesToFix = [];
  while (walker.nextNode()) nodesToFix.push(walker.currentNode);

  for (const textNode of nodesToFix) {
    let text = textNode.nodeValue;

    // If this text node has no RTL chars and hasn't been BiDi-processed,
    // wrap LTR words in isolates so BiDi reordering works correctly
    // with the swapped arrows.
    if (!hasRTLChars(text) && text.indexOf(LRI) === -1) {
      text = text.replace(
        /[A-Za-z][\w]*(?:[\s\-]+[A-Za-z][\w]*)*/g,
        match => LRI + match + PDI
      );
    }

    // Swap arrow direction
    ARROW_REGEX.lastIndex = 0;
    text = text.replace(
      ARROW_REGEX,
      match => ARROW_MAP[match] || match
    );

    textNode.nodeValue = text;
  }
}

// ─── Fix: KaTeX/LaTeX elements inside RTL blocks — force LTR ─────────────
// Math notation is universally LTR. The CSS handles visual styling, but
// we also need to set attributes so the browser's BiDi algorithm doesn't
// reorder elements inside the formula.
function fixKaTeXInContainer(container) {
  container.querySelectorAll('.katex').forEach(katex => {
    if (katex.dataset.rtlxDone === '1') return;
    // Force LTR on the katex root
    katex.setAttribute('dir', 'ltr');
    katex.dataset.rtlxDone = '1';
  });
  // Also handle display-mode KaTeX (block formulas)
  container.querySelectorAll('.katex-display').forEach(kd => {
    if (kd.dataset.rtlxDone === '1') return;
    kd.setAttribute('dir', 'ltr');
    kd.dataset.rtlxDone = '1';
  });
}

// ─── Fix: Code Blocks containing RTL text ────────────────────────────────
// Two strategies based on block type:
// 1. "text" blocks (no language-* class): full RTL — direction: rtl, text-align: right
//    These are pseudocode, explanations, etc. written in Persian.
// 2. "code" blocks (has language-* class, OR box-drawing tree art): per-line
//    BiDi via unicode-bidi: plaintext. Real code AND ASCII/Unicode directory
//    trees must stay LTR — flipping the whole block to dir="rtl" scrambles
//    the ├── └── │ characters even though only the inline comments are Persian.
const TREE_CHARS_REGEX = /[├└│─┌┐┘┬┴┼┣┗┃━┳┻╋]/;
function fixCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.dataset.rtlxDone === '1') return;
    const text = pre.textContent || '';
    if (hasRTLChars(text)) {
      pre.classList.add('rtlx-code-block');

      const codeEl = pre.querySelector('code');
      if (codeEl) {
        codeEl.classList.add('rtlx-code-block');
        // Detect if this is actual code/diagram or plain prose
        const isActualCode = /\blanguage-\w+/.test(codeEl.className || '')
          || TREE_CHARS_REGEX.test(text);
        pre.dataset.rtlxType = isActualCode ? 'code' : 'text';

        // For text blocks, also apply RTL attributes directly
        if (!isActualCode && isRTLDominant(text)) {
          pre.setAttribute('dir', 'rtl');
          codeEl.setAttribute('dir', 'rtl');
        }
      }
    }
    pre.dataset.rtlxDone = '1';
  });
}

// ─── Fix: Mermaid Diagram SVG elements ───────────────────────────────────
function fixMermaidDiagrams(container) {
  // Mermaid renders inside .mermaid > svg, or directly as svg
  const svgs = container.querySelectorAll('svg');
  svgs.forEach(svg => {
    if (svg.dataset.rtlxDone === '1') return;

    // Fix <text> SVG elements
    svg.querySelectorAll('text, tspan').forEach(textEl => {
      const content = textEl.textContent || '';
      if (hasRTLChars(content)) {
        textEl.setAttribute('direction', 'rtl');
        textEl.setAttribute('text-anchor', 'end');
        textEl.dataset.rtlx = '1';
      }
    });

    // Fix <foreignObject> elements (some Mermaid themes use HTML inside SVG)
    svg.querySelectorAll('foreignObject').forEach(fo => {
      const inner = fo.querySelector('div, span, p');
      if (inner && hasRTLChars(inner.textContent || '')) {
        fo.setAttribute('dir', 'rtl');
        inner.setAttribute('dir', 'rtl');
        inner.classList.add('rtlx-block');
      }
    });

    svg.dataset.rtlxDone = '1';
  });
}

// ─── Fix: Inline elements (spans, strong, em) that are purely RTL ─────────
function fixInlineRTL(container) {
  // Handle cases where Claude wraps RTL words in spans without dir attribute
  const inlines = container.querySelectorAll(
    'span:not([data-rtlx-done]), strong:not([data-rtlx-done]), em:not([data-rtlx-done])'
  );
  inlines.forEach(el => {
    if (el.dataset.rtlxDone === '1') return;
    const text = el.textContent || '';
    if (isRTLDominant(text) && !hasCodeAncestor(el)) {
      el.setAttribute('dir', 'rtl');
      el.classList.add('rtlx-inline');
    }
    el.dataset.rtlxDone = '1';
  });
}

// ─── Main: Apply all RTL fixes to a single response container ─────────────
function fixContainer(container) {
  // Tag every matched container with one shared class so styles.css only
  // needs a single ancestor selector instead of repeating per-UI selectors
  // (classic chat, claude.ai/code, claude.ai/design, artifact viewer, etc.)
  container.classList.add('rtlx-scope');

  // 1. Fix block-level elements
  const blockQuery = [...BLOCK_ELEMENTS].map(t => t.toLowerCase()).join(',');
  container.querySelectorAll(blockQuery).forEach(applyRTLToBlock);

  // Also check the container itself (e.g., if a <div> directly holds RTL text)
  if (container.textContent && isRTLDominant(container.textContent)) {
    // Only set on the container if it has no block children with content
    const hasBlockChildren = [...BLOCK_ELEMENTS].some(
      tag => container.querySelector(tag.toLowerCase())
    );
    if (!hasBlockChildren) {
      container.setAttribute('dir', 'rtl');
      container.classList.add('rtlx-block');
      fixArrowsInElement(container);
    }
  }

  // 2. Fix KaTeX/LaTeX — must run AFTER block RTL so we can override
  fixKaTeXInContainer(container);

  // 3. Fix code blocks
  fixCodeBlocks(container);

  // 4. Fix Mermaid SVG diagrams
  fixMermaidDiagrams(container);

  // 5. Fix inline elements (spans without a block wrapper).
  // Needed for claude.ai/design, which renders user messages as bare
  // <span> text instead of <p>/<li> — the block-level pass alone misses them.
  fixInlineRTL(container);
}

// ─── Fix: Chat input field — set RTL direction ───────────────────────────
// Makes the input box RTL so Persian text is typed right-to-left.
// Uses dir="auto" on inner <p> elements so each paragraph auto-detects
// its direction (Persian → RTL, English → LTR).
// Covers both classic claude.ai and claude.ai/code (Epitaxy UI).
function fixChatInput() {
  document.querySelectorAll(
    '[data-testid="chat-input"].ProseMirror, .ProseMirror[contenteditable="true"]'
  ).forEach(input => {
    if (input.dataset.rtlxDone === '1') return;
    input.setAttribute('dir', 'rtl');
    // Per-paragraph auto-detection for mixed RTL/LTR typing
    input.querySelectorAll('p').forEach(p => {
      if (!p.dataset.rtlxDone) p.setAttribute('dir', 'auto');
    });
    input.dataset.rtlxDone = '1';
  });
}

// ─── Main: Apply RTL fixes to ALL response containers on the page ─────────
function applyAllRTLFixes() {
  if (!isRunning) return;
  fixChatInput();
  const containers = getResponseContainers();
  containers.forEach(fixContainer);
}

// ─── Init: Start the MutationObserver ─────────────────────────────────────
function initRTLFixer() {
  isRunning = true;

  // Run once immediately for already-rendered content
  applyAllRTLFixes();

  // Watch for DOM changes (Claude streams responses token by token)
  observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyAllRTLFixes, 150);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// ─── Init: Stop the fixer (when user toggles OFF) ─────────────────────────
function stopRTLFixer() {
  isRunning = false;
  clearTimeout(debounceTimer);
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────
chrome.storage.local.get(['isEnabled'], ({ isEnabled }) => {
  // isEnabled defaults to true on install (set by background.js).
  // If explicitly set to false, do nothing.
  if (isEnabled !== false) {
    initRTLFixer();
  }
});

// Listen for toggle messages from popup
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'RTL_TOGGLE') {
    if (message.isEnabled) {
      initRTLFixer();
    } else {
      stopRTLFixer();
    }
  }
});
