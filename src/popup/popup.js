const FEATURE_ENABLED_STORAGE_KEY = 'btvFeatureEnabled';
const browserUserAgent = navigator.userAgent || '';
const IS_EDGE_BROWSER = /\bEdg\//.test(browserUserAgent);
const PING_RETRY_INTERVAL_MS = IS_EDGE_BROWSER ? 45 : 60;
const PING_RETRY_ATTEMPTS_BEFORE_INJECT = IS_EDGE_BROWSER ? 2 : 3;
const PING_RETRY_ATTEMPTS_AFTER_INJECT = IS_EDGE_BROWSER ? 8 : 12;

const pendingEnsureByTabId = new Map();

const preprocessButton = document.getElementById('preprocess-btn');
const recaptureButton = document.getElementById('recapture-btn');
const restoreButton = document.getElementById('restore-btn');
const toggleButton = document.getElementById('toggle-feature-btn');
const featureStatusEl = document.getElementById('feature-status');
const pageStatusEl = document.getElementById('page-status');

function t(key, fallback = '') {
  const message = chrome.i18n?.getMessage(key);
  return message || fallback;
}

function localizeStaticText() {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach((element) => {
    const key = element.getAttribute('data-i18n');
    if (!key) return;

    const message = t(key, element.textContent || '');
    element.textContent = message;
  });
}

function isHttpOrHttpsTab(tab) {
  return typeof tab?.url === 'string' && /^https?:\/\//i.test(tab.url);
}

function ensureSupportedTab(tab) {
  if (!isHttpOrHttpsTab(tab)) {
    throw new Error(t('popupErrorUnsupportedPage', 'This page is not supported. Please open an HTTP/HTTPS page.'));
  }
}

function setPageStatus(text, kind = '') {
  pageStatusEl.textContent = text;
  pageStatusEl.className = `status${kind ? ` is-${kind}` : ''}`;
}

function renderToggleButton(enabled) {
  if (enabled) {
    toggleButton.textContent = t('popupTogglePause', 'Pause');
    toggleButton.classList.remove('is-disabled');
  } else {
    toggleButton.textContent = t('popupToggleResume', 'Resume');
    toggleButton.classList.add('is-disabled');
  }
}

function renderFeatureStatus(enabled) {
  featureStatusEl.textContent = enabled
    ? t('popupFeatureEnabled', 'On. Pausing keeps captured originals.')
    : t('popupFeaturePaused', 'Paused. Captured originals are kept.');
}

function renderPageState(status) {
  if (status.unknown) {
    setPageStatus(t('popupPageUnknown', 'Page source is uncertain. Old originals will not be shown for changed text.'), 'error');
  } else if (status.translated) {
    setPageStatus(t('popupPageTranslated', 'Translation detected. Existing originals are protected.'), 'success');
  } else if (status.sentences > 0) {
    setPageStatus(t('popupPageReady', 'Ready. The loaded page has been captured.'), 'success');
  } else {
    setPageStatus(t('popupPageNotReady', 'Not prepared. Capture the original page before translating.'));
  }
}

const ERROR_KEYS = {
  disabled: 'popupErrorFeatureDisabled', loading: 'popupErrorLoading', busy: 'popupErrorBusy',
  alreadyTranslated: 'popupErrorAlreadyTranslated', uncertainSource: 'popupErrorUncertainSource',
  prepareFailed: 'popupErrorPrepareFailed'
};

function responseError(response, fallbackKey) {
  const key = ERROR_KEYS[response?.error] || fallbackKey;
  return new Error(t(key, 'The page did not complete this action.'));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    throw new Error(t('popupErrorNoActiveTab', 'Unable to get the active tab.'));
  }
  return tab;
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'BTV_PING' });
    return Boolean(response && response.ok === true);
  } catch (_error) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContentScript(tabId, attempts, intervalMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await pingContentScript(tabId)) {
      return true;
    }

    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }

  return false;
}

function getBrowserContentScriptFile() {
  return 'src/content/content.core.js';
}

async function ensureContentScriptReady(tab) {
  const tabId = tab?.id;
  ensureSupportedTab(tab);

  if (typeof tabId !== 'number') {
    throw new Error(t('popupErrorNoActiveTab', 'Unable to get the active tab.'));
  }

  if (pendingEnsureByTabId.has(tabId)) {
    return pendingEnsureByTabId.get(tabId);
  }

  const ensurePromise = (async () => {
    if (await pingContentScript(tabId)) {
      return;
    }

    // Give content script a short warm-up window before reinjecting.
    if (await waitForContentScript(tabId, PING_RETRY_ATTEMPTS_BEFORE_INJECT, PING_RETRY_INTERVAL_MS)) {
      return;
    }

    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['assets/styles/content.css']
      });
    } catch (_error) {
      // Ignore duplicate/temporary CSS injection failures and continue script init.
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [getBrowserContentScriptFile()]
    });

    const ready = await waitForContentScript(
      tabId,
      PING_RETRY_ATTEMPTS_AFTER_INJECT,
      PING_RETRY_INTERVAL_MS
    );

    if (!ready) {
      throw new Error(t('popupErrorContentScriptNotReady', 'Content script failed to initialize.'));
    }
  })().finally(() => {
    pendingEnsureByTabId.delete(tabId);
  });

  pendingEnsureByTabId.set(tabId, ensurePromise);
  return ensurePromise;
}

async function sendMessageWithReconnect(tab, payload, allowReconnect = true) {
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const shouldReconnect = errMsg.includes('Receiving end does not exist')
      || errMsg.includes('Could not establish connection');

    if (!allowReconnect || !shouldReconnect) {
      throw err;
    }

    await ensureContentScriptReady(tab);
    return await chrome.tabs.sendMessage(tab.id, payload);
  }
}

async function getFeatureEnabledState() {
  const result = await chrome.storage.local.get(FEATURE_ENABLED_STORAGE_KEY);
  return result[FEATURE_ENABLED_STORAGE_KEY] === true;
}

async function setFeatureEnabledState(enabled) {
  await chrome.storage.local.set({ [FEATURE_ENABLED_STORAGE_KEY]: enabled });
}

async function triggerPreprocess() {
  return runPageAction(preprocessButton, 'BTV_PREPROCESS_NOW', 'prepare');
}

async function runPageAction(button, type, action) {
  button.disabled = true;
  setPageStatus(t(action === 'restore' ? 'popupStatusRestoreRunning' : 'popupStatusPreprocessRunning', 'Working...'));

  try {
    const tab = await getActiveTab();
    await ensureContentScriptReady(tab);
    const response = await sendMessageWithReconnect(tab, {
      type
    }, false);

    if (!response || response.ok !== true || (action !== 'restore' && response.complete !== true)) {
      throw responseError(response, action === 'restore' ? 'popupErrorRestoreNoAck' : 'popupErrorPreprocessNoAck');
    }
    if (action === 'restore') {
      setPageStatus(t('popupStatusRestoreDone', 'Extension markers were removed. Page language was not changed.'), 'success');
    } else {
      setPageStatus(t('popupStatusPreprocessDone', 'Ready. You can translate the page now.'), 'success');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPageStatus(message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function toggleFeatureEnabled() {
  toggleButton.disabled = true;

  try {
    const previousEnabled = await getFeatureEnabledState();
    const nextEnabled = !previousEnabled;

    const tab = await getActiveTab();
    await ensureContentScriptReady(tab);

    try {
      const response = await sendMessageWithReconnect(tab, {
        type: 'BTV_SET_ENABLED',
        enabled: nextEnabled
      }, true);

      if (!response || response.ok !== true) {
        throw new Error(t('popupErrorToggleNoAck', 'Page did not confirm feature switch update.'));
      }
    } catch (syncError) {
      const syncMessage = syncError instanceof Error ? syncError.message : String(syncError);
      setPageStatus(`${t('popupStatusToggleFailedPrefix', 'Switch failed: ')}${syncMessage}`, 'error');
      return;
    }

    await setFeatureEnabledState(nextEnabled);
    renderToggleButton(nextEnabled);
    renderFeatureStatus(nextEnabled);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPageStatus(`${t('popupStatusToggleFailedPrefix', 'Switch failed: ')}${message}`, 'error');
  } finally {
    toggleButton.disabled = false;
  }
}

async function initializePopup() {
  localizeStaticText();

  try {
    const enabled = await getFeatureEnabledState();
    renderToggleButton(enabled);
    renderFeatureStatus(enabled);
    const tab = await getActiveTab();
    ensureSupportedTab(tab);
    await ensureContentScriptReady(tab);
    const status = await sendMessageWithReconnect(tab, { type: 'BTV_GET_STATUS' }, false);
    if (!status?.ok) throw responseError(status, 'popupErrorStatusNoAck');
    renderToggleButton(status.enabled);
    renderFeatureStatus(status.enabled);
    renderPageState(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPageStatus(`${t('popupStatusInitFailedPrefix', 'Initialization failed: ')}${message}`, 'error');
  }
}

preprocessButton.addEventListener('click', triggerPreprocess);
recaptureButton.addEventListener('click', () => runPageAction(recaptureButton, 'BTV_RECAPTURE_SOURCE', 'recapture'));
restoreButton.addEventListener('click', () => runPageAction(restoreButton, 'BTV_RESTORE_STRUCTURE', 'restore'));
toggleButton.addEventListener('click', toggleFeatureEnabled);

initializePopup();
