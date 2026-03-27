const FEATURE_ENABLED_STORAGE_KEY = 'btvFeatureEnabled';

const preprocessButton = document.getElementById('preprocess-btn');
const toggleButton = document.getElementById('toggle-feature-btn');
const statusEl = document.getElementById('status');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b91c1c' : '#334155';
}

function renderToggleButton(enabled) {
  if (enabled) {
    toggleButton.textContent = '关闭原文显示';
    toggleButton.classList.remove('is-disabled');
  } else {
    toggleButton.textContent = '开启原文显示';
    toggleButton.classList.add('is-disabled');
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('无法获取当前标签页');
  }
  return tab;
}

async function ensureContentScriptReady(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['assets/styles/content.css']
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/content.js']
  });

  // Wait until content script initialized.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function sendMessageWithReconnect(tabId, payload, allowReconnect = true) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const shouldReconnect = errMsg.includes('Receiving end does not exist')
      || errMsg.includes('Could not establish connection');

    if (!allowReconnect || !shouldReconnect) {
      throw err;
    }

    await ensureContentScriptReady(tabId);
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

async function getFeatureEnabledState() {
  const result = await chrome.storage.local.get(FEATURE_ENABLED_STORAGE_KEY);
  return result[FEATURE_ENABLED_STORAGE_KEY] !== false;
}

async function setFeatureEnabledState(enabled) {
  await chrome.storage.local.set({ [FEATURE_ENABLED_STORAGE_KEY]: enabled });
}

async function triggerPreprocess() {
  preprocessButton.disabled = true;
  setStatus('正在预处理当前页面...');

  try {
    const tab = await getActiveTab();
    const response = await sendMessageWithReconnect(tab.id, {
      type: 'BTV_PREPROCESS_NOW'
    }, true);

    if (!response || !response.ok) {
      throw new Error('内容脚本没有返回成功状态');
    }

    setStatus('预处理完成。现在可以开始翻译页面。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`预处理失败：${message}`, true);
  } finally {
    preprocessButton.disabled = false;
  }
}

async function toggleFeatureEnabled() {
  toggleButton.disabled = true;

  try {
    const previousEnabled = await getFeatureEnabledState();
    const nextEnabled = !previousEnabled;

    const tab = await getActiveTab();
    try {
      let response = await sendMessageWithReconnect(tab.id, {
        type: 'BTV_SET_ENABLED',
        enabled: nextEnabled
      }, true);

      if (!response || response.ok !== true) {
        await ensureContentScriptReady(tab.id);
        response = await sendMessageWithReconnect(tab.id, {
          type: 'BTV_SET_ENABLED',
          enabled: nextEnabled
        }, false);
      }

      if (!response || response.ok !== true) {
        throw new Error('页面未确认更新功能开关状态');
      }
    } catch (syncError) {
      const syncMessage = syncError instanceof Error ? syncError.message : String(syncError);
      setStatus(`切换失败：${syncMessage}`, true);
      return;
    }

    await setFeatureEnabledState(nextEnabled);
    renderToggleButton(nextEnabled);

    setStatus(nextEnabled ? '原文显示已开启。' : '原文显示已关闭。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`切换失败：${message}`, true);
  } finally {
    toggleButton.disabled = false;
  }
}

async function initializePopup() {
  try {
    const enabled = await getFeatureEnabledState();
    renderToggleButton(enabled);
    setStatus(enabled ? '功能已开启。' : '功能已关闭。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`初始化失败：${message}`, true);
  }
}

preprocessButton.addEventListener('click', triggerPreprocess);
toggleButton.addEventListener('click', toggleFeatureEnabled);

initializePopup();
