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
const RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '.font-claude-message',
  '[data-is-streaming]',
  '.message-content',
];

// Block-level elements within responses to check for RTL
const BLOCK_ELEMENTS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION',
  'DT', 'DD', 'SUMMARY', 'CAPTION',
]);

// Elements where we must NOT touch content (code integrity)
const CODE_ANCESTORS = new Set(['PRE', 'CODE', 'MATH', 'SCRIPT', 'STYLE']);

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
function isRTLDominant(text) {
  const stripped = text.replace(/[\s\d\p{P}]/gu, '');
  if (!stripped.length) return false;
  const rtlChars = (stripped.match(new RegExp(RTL_REGEX.source, 'g')) || []).length;
  return (rtlChars / stripped.length) >= 0.25; // 25%+ RTL chars → RTL element
}

// ─── Utility: Check if an element has a CODE/PRE ancestor ─────────────────
function hasCodeAncestor(el) {
  let node = el.parentElement;
  while (node) {
    if (CODE_ANCESTORS.has(node.tagName)) return true;
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

// ─── Fix: Inject BiDi control chars into text nodes for correct ordering ──
// In RTL context, numbers and LTR words get misplaced by the BiDi algorithm.
// We use Unicode Isolate characters (LRI/RLI/PDI) to wrap segments and
// RLM/LRM marks to anchor numbers in the correct visual position.
function fixBiDiInTextNode(textNode) {
  const text = textNode.nodeValue;
  if (!text) return;
  // Skip if already processed (contains isolate chars)
  if (text.indexOf(LRI) !== -1 || text.indexOf(RLI) !== -1) return;
  // Only process nodes that mix RTL and non-RTL content
  if (!hasRTLChars(text)) return;
  if (!/[A-Za-z0-9]/.test(text)) return;

  let result = text;

  // Step 1: Wrap contiguous English word sequences in LRI...PDI isolates.
  // This handles "Dumbbell Goblet Squat", "Plank", "Sigmoid", etc.
  // Match: one or more Latin words (with possible numbers/hyphens within)
  result = result.replace(
    /[A-Za-z][\w]*(?:[\s\-]+[A-Za-z][\w]*)*/g,
    match => LRI + match + PDI
  );

  // Step 2: Wrap number+operator groups in LRI...PDI isolates.
  // This handles "3 × 30", "3 × 12", "0.92", "25/100" etc.
  // These are numeric expressions with operators/symbols between digits.
  result = result.replace(
    /\d[\d\s×x*.\-+/()%=,]*\d[\d.]*/g,
    match => LRI + match + PDI
  );

  // Step 3: Handle standalone single numbers adjacent to RTL text
  // (e.g., "3 ست" → wrap "3" in isolate so it stays on the correct side)
  result = result.replace(
    /(?<![.\d\u2066])(\d+)(?![.\d\u2069])/g,
    LRI + '$1' + PDI
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
function fixArrowsInElement(el) {
  if (!ARROW_REGEX.test(el.innerHTML)) return;

  const walker = document.createTreeWalker(
    el,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip text nodes inside code/pre/math elements
        if (hasCodeAncestor(node)) return NodeFilter.FILTER_REJECT;
        return ARROW_REGEX.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    }
  );

  const nodesToFix = [];
  while (walker.nextNode()) nodesToFix.push(walker.currentNode);

  for (const textNode of nodesToFix) {
    ARROW_REGEX.lastIndex = 0;
    textNode.nodeValue = textNode.nodeValue.replace(
      ARROW_REGEX,
      match => ARROW_MAP[match] || match
    );
  }
}

// ─── Fix: Code Blocks containing RTL text ────────────────────────────────
function fixCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.dataset.rtlxDone === '1') return;
    const text = pre.textContent || '';
    if (hasRTLChars(text)) {
      pre.classList.add('rtlx-code-block');
      // Apply plaintext direction on the code element for per-line BiDi
      pre.querySelectorAll('code').forEach(code => {
        code.classList.add('rtlx-code-block');
      });
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

  // 2. Fix code blocks
  fixCodeBlocks(container);

  // 3. Fix Mermaid SVG diagrams
  fixMermaidDiagrams(container);

  // 4. Fix inline elements (optional pass for deep RTL spans)
  // Disabled by default to avoid perf overhead on large responses;
  // the block-level pass covers most cases. Uncomment if needed:
  // fixInlineRTL(container);
}

// ─── Main: Apply RTL fixes to ALL response containers on the page ─────────
function applyAllRTLFixes() {
  if (!isRunning) return;
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
