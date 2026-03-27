const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT']);
const DELIMITER_REGEX = /([,.;!?，。；！？\n]+)/g;
const FEATURE_ENABLED_STORAGE_KEY = 'btvFeatureEnabled';
const CLICK_TEXT_HIT_PADDING = 2;
const CLICK_TEXT_MAX_DISTANCE = 8;
const NAVIGATION_FORCE_REFRESH_WINDOW_MS = 1500;

let tooltip = null;
let featureEnabled = true;
let lastKnownUrl = window.location.href;
let navigationPreprocessTimer = null;
let allowSnapshotForceRefreshUntil = 0;

const textNodeSnapshots = new WeakMap();
const pendingRoots = new Map();
let flushTimer = null;

function ensureTooltip() {
    if (tooltip && tooltip.isConnected) {
        return tooltip;
    }

    if (!document.body) {
        return null;
    }

    tooltip = document.createElement('div');
    tooltip.id = 'bilingual-tooltip';
    tooltip.classList.add('notranslate');
    tooltip.setAttribute('translate', 'no');
    tooltip.setAttribute('lang', 'und');
    document.body.appendChild(tooltip);
    return tooltip;
}

function shouldSkipTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.closest('#bilingual-tooltip')) return true;
    return false;
}

function splitTextIntoSegments(text) {
    const parts = text.split(DELIMITER_REGEX);
    const segments = [];
    let cursor = 0;
    let pendingText = '';
    let pendingStart = -1;

    for (const part of parts) {
        if (!part) continue;

        const isDelimiter = /^[,.;!?，。；！？\n]+$/.test(part);
        if (isDelimiter) {
            if (pendingStart !== -1) {
                pendingText += part;
                segments.push({
                    text: pendingText,
                    start: pendingStart,
                    end: pendingStart + pendingText.length
                });
                pendingText = '';
                pendingStart = -1;
            }
            cursor += part.length;
            continue;
        }

        if (part.trim().length === 0) {
            cursor += part.length;
            continue;
        }

        if (pendingStart === -1) {
            pendingStart = cursor;
            pendingText = part;
        } else {
            pendingText += part;
        }
        cursor += part.length;
    }

    if (pendingStart !== -1 && pendingText.trim().length > 0) {
        segments.push({
            text: pendingText,
            start: pendingStart,
            end: pendingStart + pendingText.length
        });
    }

    return segments;
}

function snapshotTextNode(textNode, force = false) {
    if (!(textNode instanceof Text)) return;
    if (shouldSkipTextNode(textNode)) return;

    const text = textNode.nodeValue || '';
    if (text.trim().length === 0) return;

    if (!force && textNodeSnapshots.has(textNode)) return;

    const segments = splitTextIntoSegments(text);
    if (segments.length === 0) return;

    textNodeSnapshots.set(textNode, {
        originalText: text,
        originalSegments: segments,
        indexedAt: Date.now()
    });
}

function preprocessRoot(root, force = false) {
    if (!root) return;

    if (root.nodeType === Node.TEXT_NODE) {
        snapshotTextNode(root, force);
        return;
    }

    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
        return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        snapshotTextNode(current, force);
        current = walker.nextNode();
    }
}

function getPreprocessTargets() {
    if (document.body) {
        return [document.body];
    }

    if (document.documentElement) {
        return [document.documentElement];
    }

    return [];
}

function runFullPreprocess(force = false) {
    const targets = getPreprocessTargets();
    targets.forEach((target) => preprocessRoot(target, force));
}

function queueRootForPreprocess(root, force = false) {
    if (!root) return;

    const previousForce = pendingRoots.get(root) || false;
    pendingRoots.set(root, previousForce || force);

    if (flushTimer !== null) return;

    flushTimer = window.setTimeout(() => {
        pendingRoots.forEach((queuedForce, queuedRoot) => preprocessRoot(queuedRoot, queuedForce));
        pendingRoots.clear();
        flushTimer = null;
    }, 120);
}

function scheduleForcedFullPreprocess(delay = 120) {
    allowSnapshotForceRefreshUntil = Date.now() + NAVIGATION_FORCE_REFRESH_WINDOW_MS;

    if (navigationPreprocessTimer !== null) {
        window.clearTimeout(navigationPreprocessTimer);
    }

    navigationPreprocessTimer = window.setTimeout(() => {
        navigationPreprocessTimer = null;
        runFullPreprocess(true);
    }, delay);
}

function maybeHandleUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl === lastKnownUrl) return;

    lastKnownUrl = currentUrl;
    scheduleForcedFullPreprocess(120);
}

function setupNavigationObservers() {
    const originalPushState = history.pushState;
    history.pushState = function patchedPushState(...args) {
        const result = originalPushState.apply(this, args);
        maybeHandleUrlChange();
        return result;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function patchedReplaceState(...args) {
        const result = originalReplaceState.apply(this, args);
        maybeHandleUrlChange();
        return result;
    };

    window.addEventListener('popstate', maybeHandleUrlChange, true);
    window.addEventListener('hashchange', maybeHandleUrlChange, true);
}

function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => queueRootForPreprocess(node, false));
            }

            if (mutation.type === 'characterData' && mutation.target instanceof Text) {
                const textNode = mutation.target;
                if (!textNodeSnapshots.has(textNode)) {
                    queueRootForPreprocess(textNode, false);
                } else if (Date.now() <= allowSnapshotForceRefreshUntil) {
                    queueRootForPreprocess(textNode, true);
                }
            }
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

function showTooltip(text, clientX, clientY) {
    if (!text || text.trim() === '') return;

    const tip = ensureTooltip();
    if (!tip) return;

    // Render from an attribute to avoid browser translators rewriting a text node.
    tip.setAttribute('data-original-text', text);
    tip.textContent = '';
    tip.style.display = 'block';

    const tooltipRect = tip.getBoundingClientRect();
    let top = clientY - tooltipRect.height - 14;
    let left = clientX - tooltipRect.width / 2;

    if (top < 8) top = clientY + 14;
    if (left < 8) left = 8;

    const maxLeft = window.innerWidth - tooltipRect.width - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);

    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
}

function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.display = 'none';
}

function getCaretInfoFromPoint(clientX, clientY) {
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(clientX, clientY);
        if (range) {
            return { node: range.startContainer, offset: range.startOffset };
        }
    }

    if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(clientX, clientY);
        if (position) {
            return { node: position.offsetNode, offset: position.offset };
        }
    }

    return null;
}

function getDistanceToRect(clientX, clientY, rect) {
    const dx = clientX < rect.left ? rect.left - clientX : (clientX > rect.right ? clientX - rect.right : 0);
    const dy = clientY < rect.top ? rect.top - clientY : (clientY > rect.bottom ? clientY - rect.bottom : 0);
    return Math.hypot(dx, dy);
}

function isPointNearTextRange(range, clientX, clientY) {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return false;

    const hasDirectHit = rects.some((rect) => (
        clientX >= rect.left - CLICK_TEXT_HIT_PADDING
        && clientX <= rect.right + CLICK_TEXT_HIT_PADDING
        && clientY >= rect.top - CLICK_TEXT_HIT_PADDING
        && clientY <= rect.bottom + CLICK_TEXT_HIT_PADDING
    ));

    if (hasDirectHit) return true;

    const minDistance = rects.reduce((min, rect) => Math.min(min, getDistanceToRect(clientX, clientY, rect)), Infinity);
    return minDistance <= CLICK_TEXT_MAX_DISTANCE;
}

function mapDisplayIndexToOriginalIndex(displayIndex, displayLength, originalLength) {
    if (originalLength === 0) return -1;
    if (displayLength === originalLength) return displayIndex;
    if (displayLength <= 1) return 0;

    const ratio = displayIndex / (displayLength - 1);
    return Math.min(originalLength - 1, Math.max(0, Math.round(ratio * (originalLength - 1))));
}

function getOriginalSegmentFromClick(clientX, clientY) {
    const caret = getCaretInfoFromPoint(clientX, clientY);
    if (!caret || !(caret.node instanceof Text)) return '';

    const snapshot = textNodeSnapshots.get(caret.node);
    if (!snapshot) return '';

    const displaySegments = splitTextIntoSegments(caret.node.nodeValue || '');
    if (displaySegments.length === 0) return '';

    let displayIndex = displaySegments.findIndex(
        (segment) => caret.offset >= segment.start && caret.offset < segment.end
    );

    if (displayIndex === -1) {
        displayIndex = displaySegments.findIndex((segment) => caret.offset === segment.end);
    }

    if (displayIndex === -1) return '';

    const displaySegment = displaySegments[displayIndex];
    if (!displaySegment) return '';

    const hitRange = document.createRange();
    try {
        hitRange.setStart(caret.node, displaySegment.start);
        hitRange.setEnd(caret.node, displaySegment.end);
    } catch (_error) {
        return '';
    }

    if (!isPointNearTextRange(hitRange, clientX, clientY)) {
        return '';
    }

    const originalIndex = mapDisplayIndexToOriginalIndex(
        displayIndex,
        displaySegments.length,
        snapshot.originalSegments.length
    );

    return snapshot.originalSegments[originalIndex]?.text || '';
}

function rangesIntersect(rangeA, rangeB) {
    try {
        const endToStart = rangeA.compareBoundaryPoints(Range.END_TO_START, rangeB);
        const startToEnd = rangeA.compareBoundaryPoints(Range.START_TO_END, rangeB);
        return endToStart > 0 && startToEnd < 0;
    } catch (_error) {
        return false;
    }
}

function collectOriginalSegmentsFromSelection(selection) {
    if (!selection || selection.rangeCount === 0) return [];

    const selectionRange = selection.getRangeAt(0);
    const root = selectionRange.commonAncestorContainer;
    const walkerRoot = root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
    if (!walkerRoot) return [];

    const originals = [];
    const seen = new Set();
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);

    let textNode = walker.nextNode();
    while (textNode) {
        const snapshot = textNodeSnapshots.get(textNode);
        if (!snapshot) {
            textNode = walker.nextNode();
            continue;
        }

        const displaySegments = splitTextIntoSegments(textNode.nodeValue || '');
        if (displaySegments.length === 0) {
            textNode = walker.nextNode();
            continue;
        }

        for (let index = 0; index < displaySegments.length; index += 1) {
            const displaySegment = displaySegments[index];
            const segmentRange = document.createRange();

            try {
                segmentRange.setStart(textNode, displaySegment.start);
                segmentRange.setEnd(textNode, displaySegment.end);
            } catch (_error) {
                continue;
            }

            if (!rangesIntersect(selectionRange, segmentRange)) continue;

            const originalIndex = mapDisplayIndexToOriginalIndex(
                index,
                displaySegments.length,
                snapshot.originalSegments.length
            );

            const text = snapshot.originalSegments[originalIndex]?.text;
            if (text && !seen.has(text)) {
                seen.add(text);
                originals.push(text);
            }
        }

        textNode = walker.nextNode();
    }

    return originals;
}

function setFeatureEnabled(enabled) {
    featureEnabled = Boolean(enabled);
    if (!featureEnabled) {
        hideTooltip();
    }
}

function synchronizeFeatureState() {
    if (!chrome.storage || !chrome.storage.local) {
        return;
    }

    chrome.storage.local.get(FEATURE_ENABLED_STORAGE_KEY, (result) => {
        if (chrome.runtime.lastError) {
            return;
        }
        setFeatureEnabled(result[FEATURE_ENABLED_STORAGE_KEY] !== false);
    });

    if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local' || !changes[FEATURE_ENABLED_STORAGE_KEY]) {
                return;
            }

            setFeatureEnabled(changes[FEATURE_ENABLED_STORAGE_KEY].newValue !== false);
        });
    }
}

document.addEventListener('click', (event) => {
    if (!featureEnabled) {
        hideTooltip();
        return;
    }

    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;

    const text = getOriginalSegmentFromClick(event.clientX, event.clientY);
    if (text) {
        showTooltip(text, event.clientX, event.clientY);
    } else {
        hideTooltip();
    }
});

document.addEventListener('mouseup', (event) => {
    if (!featureEnabled) {
        hideTooltip();
        return;
    }

    const selection = window.getSelection();
    if (!selection) {
        hideTooltip();
        return;
    }

    if (selection.toString().trim().length === 0) {
        return;
    }

    const originals = collectOriginalSegmentsFromSelection(selection);
    if (originals.length > 0) {
        showTooltip(originals.join(' '), event.clientX, event.clientY);
    } else {
        hideTooltip();
    }
});

document.addEventListener('scroll', hideTooltip, true);
window.addEventListener('resize', hideTooltip);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
        return;
    }

    if (message.type === 'BTV_PREPROCESS_NOW') {
        runFullPreprocess(true);
        sendResponse({ ok: true, time: Date.now() });
        return;
    }

    if (message.type === 'BTV_SET_ENABLED') {
        setFeatureEnabled(Boolean(message.enabled));
        sendResponse({ ok: true, enabled: featureEnabled });
    }
});

function initialize() {
    runFullPreprocess(false);
    setupMutationObserver();
    setupNavigationObservers();
    synchronizeFeatureState();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}