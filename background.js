// Import storage module
importScripts('storage.js');

// Track discarded/reloading tab state
const discardedTabIds = new Set();
const reloadingDiscardedTabs = new Set();
const reloadStateTimeouts = new Map();
const recentTabScreenshots = new Map();
const pendingRestoreScreenshots = new Map();
const TAB_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const RELOAD_STATE_MAX_MS = 15 * 1000;
// Opt-in debug switch. Shipped as `false` on purpose: debug logs include full
// page URLs of every tab this extension touches. Flip to `true` (and to `true`
// in content.js) only while diagnosing a problem, and treat the resulting
// service-worker console output as private browsing data.
const DEBUG_LOGS = false;
let restoreSequence = 0;
const restoreTraceByTab = new Map();
const reloadKickoffByTab = new Map();
const RELOAD_KICKOFF_MAX_MS = 5000;
const restoreInterstitialByTab = new Map();
const overlaySentForReload = new Set();
const captureCooldownByTab = new Map();
const CAPTURE_COOLDOWN_MS = 1200;
const SESSION_REHYDRATE_DELAY_MS = 600;

function nowIso() {
  return new Date().toISOString();
}

function traceAgeMs(tabId) {
  const trace = restoreTraceByTab.get(tabId);
  if (!trace) {
    return null;
  }

  return Math.round(performance.now() - trace.startedAt);
}

function logDebug(event, details = {}) {
  if (!DEBUG_LOGS) {
    return;
  }

  console.log(`[BetterTabUnload][BG][${nowIso()}] ${event}`, details);
}

// Always-on diagnostics. Must never include page URLs or other browsing data,
// so that DEBUG_LOGS=false really means "no browsing history in the console".
function logWarn(event, details = {}) {
  console.warn(`[BetterTabUnload][BG] ${event}`, details);
}

function logInfo(event, details = {}) {
  console.info(`[BetterTabUnload][BG] ${event}`, details);
}

// URLs to skip (special Chrome pages)
const SKIP_URL_PATTERNS = [
  /^chrome:\/\//,
  /^chrome-extension:\/\//,
  /^about:/,
  /^edge:\/\//,
  /^brave:\/\//,
  /^devtools:\/\//,
  /^view-source:/,
  /^file:\/\//
];

function shouldSkipUrl(url) {
  if (!url) return true;
  return SKIP_URL_PATTERNS.some(pattern => pattern.test(url));
}

function isRestorePageUrl(url) {
  if (!url) {
    return false;
  }

  return url.startsWith(chrome.runtime.getURL('restore.html'));
}

// tab.url is only the last *committed* URL. While a navigation is pending
// (e.g. Chrome session restore after a browser restart) the tab's real
// destination lives in tab.pendingUrl and tab.url still reports an older
// history entry. Committing tab.url in that state overwrites the tab with a
// stale URL, so every restore target must be derived from this helper.
function tabEffectiveUrl(tab) {
  return tab?.pendingUrl || tab?.url || null;
}

function stripHash(url) {
  if (!url) return url;
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return url;
  return url.slice(0, hashIndex);
}

function normalizeScreenshotUrl(url) {
  if (!url || shouldSkipUrl(url)) {
    return null;
  }

  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (!parsed.search && parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch (error) {
    const withoutHash = stripHash(url);
    if (!withoutHash || shouldSkipUrl(withoutHash)) {
      return null;
    }
    return withoutHash;
  }
}

function buildUrlCandidates(url) {
  if (!url) return [];
  const candidates = new Set();
  const add = (value) => {
    if (value && !shouldSkipUrl(value)) {
      candidates.add(value);
    }
  };

  add(normalizeScreenshotUrl(url));
  add(url);

  const withoutHash = stripHash(url);
  add(withoutHash);

  try {
    const parsed = new URL(withoutHash);
    if (!parsed.search && parsed.pathname !== '/') {
      const toggled = new URL(parsed.toString());
      if (parsed.pathname.endsWith('/')) {
        toggled.pathname = parsed.pathname.slice(0, -1);
      } else {
        toggled.pathname = `${parsed.pathname}/`;
      }
      add(toggled.toString());
    }
  } catch (error) {
    // Ignore malformed URLs and keep existing candidates.
  }

  return Array.from(candidates);
}

function urlsMatch(actualUrl, candidateUrl) {
  if (!actualUrl || !candidateUrl) {
    return false;
  }

  const actualCandidates = new Set(buildUrlCandidates(actualUrl));
  const candidateCandidates = new Set(buildUrlCandidates(candidateUrl));

  for (const value of actualCandidates) {
    if (candidateCandidates.has(value)) {
      return true;
    }
  }

  return false;
}

async function getStoredScreenshotForUrl(url) {
  const candidates = buildUrlCandidates(url);
  for (const candidate of candidates) {
    const screenshot = await self.storage.getScreenshot(candidate);
    if (screenshot) {
      return screenshot;
    }
  }

  return null;
}

async function saveScreenshotForUrlVariants(url, dataUrl) {
  const normalized = normalizeScreenshotUrl(url);
  if (!normalized) {
    return;
  }

  const candidates = buildUrlCandidates(url).filter((candidate) => candidate !== normalized);
  await self.storage.saveScreenshot(normalized, dataUrl);
  await Promise.all(
    candidates.map((candidate) =>
      self.storage.deleteScreenshot(candidate).catch(() => {})
    )
  );
}

function cacheScreenshotForTab(tabId, url, screenshot) {
  if (typeof tabId !== 'number' || !url || !screenshot || shouldSkipUrl(url)) {
    return;
  }

  const normalized = normalizeScreenshotUrl(url);
  if (!normalized) {
    return;
  }

  recentTabScreenshots.set(tabId, {
    url: normalized,
    screenshot,
    timestamp: Date.now()
  });
}

function getCachedScreenshotForTab(tabId, url) {
  const entry = recentTabScreenshots.get(tabId);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > TAB_CACHE_MAX_AGE_MS) {
    recentTabScreenshots.delete(tabId);
    return null;
  }

  if (!url) {
    return entry.screenshot;
  }

  const candidates = new Set(buildUrlCandidates(url));
  if (candidates.has(entry.url)) {
    return entry.screenshot;
  }

  return null;
}

async function getOverlayScreenshot(tabId, url) {
  const cached = getCachedScreenshotForTab(tabId, url);
  if (cached) {
    return cached;
  }

  const tabScopedRecord = await self.storage.getTabScreenshot(tabId);
  if (tabScopedRecord?.screenshot && (!url || urlsMatch(url, tabScopedRecord.url))) {
    cacheScreenshotForTab(tabId, tabScopedRecord.url || url, tabScopedRecord.screenshot);
    return tabScopedRecord.screenshot;
  }

  const stored = await getStoredScreenshotForUrl(url);
  if (stored) {
    cacheScreenshotForTab(tabId, url, stored);
    return stored;
  }

  return null;
}

async function prepareRestoreScreenshot(tabId, url) {
  if (pendingRestoreScreenshots.has(tabId)) {
    logDebug('prepareRestoreScreenshot:cache-hit', {
      tabId,
      ageMs: traceAgeMs(tabId)
    });
    return pendingRestoreScreenshots.get(tabId);
  }

  const startAt = performance.now();
  const screenshot = await getOverlayScreenshot(tabId, url);
  if (screenshot) {
    pendingRestoreScreenshots.set(tabId, screenshot);
    logDebug('prepareRestoreScreenshot:loaded', {
      tabId,
      ageMs: traceAgeMs(tabId),
      loadMs: Math.round(performance.now() - startAt)
    });
  } else {
    logDebug('prepareRestoreScreenshot:missing', {
      tabId,
      ageMs: traceAgeMs(tabId),
      loadMs: Math.round(performance.now() - startAt),
      url
    });
  }

  return screenshot;
}

async function maybeShowRestoreInterstitial(tabId, url, traceId = null) {
  if (shouldSkipUrl(url)) {
    return false;
  }

  const existing = restoreInterstitialByTab.get(tabId);
  if (existing && urlsMatch(existing.url, url) && Date.now() - existing.shownAt < RELOAD_STATE_MAX_MS) {
    logDebug('restoreInterstitial:already-shown', {
      tabId,
      traceId: traceId ?? existing.traceId ?? null,
      ageMs: Date.now() - existing.shownAt
    });
    return true;
  }

  const screenshot = pendingRestoreScreenshots.get(tabId) || await prepareRestoreScreenshot(tabId, url);
  if (!screenshot) {
    logDebug('restoreInterstitial:no-screenshot', { tabId, traceId, url });
    return false;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) {
      return false;
    }

    if (!tab.active) {
      logDebug('restoreInterstitial:skip-inactive-tab', { tabId, traceId });
      return false;
    }

    const currentUrl = tabEffectiveUrl(tab);

    if (isRestorePageUrl(tab.url) || isRestorePageUrl(tab.pendingUrl)) {
      logDebug('restoreInterstitial:tab-already-restore-page', { tabId, traceId });
      return true;
    }

    // If the tab already finished loading, the interstitial is no longer
    // useful — regardless of which URL it finished on. Navigating a completed
    // tab could only replace real content.
    if (tab.status === 'complete' && !tab.discarded) {
      logDebug('restoreInterstitial:skip-target-already-complete', {
        tabId,
        traceId,
        matchesTarget: urlsMatch(tab.url, url)
      });
      return false;
    }

    // Never commit a URL the tab does not currently have. If the tab's
    // committed/pending URL no longer matches the captured target, the
    // snapshot is stale (typical during session restore) and navigating
    // would overwrite the tab's real URL with another history entry.
    if (!urlsMatch(currentUrl, url)) {
      logDebug('restoreInterstitial:skip-url-mismatch', {
        tabId,
        traceId,
        currentUrl,
        targetUrl: url
      });
      return false;
    }

    const restoreUrl = new URL(chrome.runtime.getURL('restore.html'));
    restoreUrl.searchParams.set('tabId', String(tabId));
    restoreUrl.searchParams.set('target', url);
    if (traceId !== null) {
      restoreUrl.searchParams.set('traceId', String(traceId));
    }

    await chrome.tabs.update(tabId, { url: restoreUrl.toString() });
    restoreInterstitialByTab.set(tabId, {
      url,
      shownAt: Date.now(),
      traceId: traceId ?? null
    });
    logDebug('restoreInterstitial:shown', {
      tabId,
      traceId,
      ageMs: traceAgeMs(tabId)
    });
    return true;
  } catch (error) {
    logDebug('restoreInterstitial:failed', {
      tabId,
      traceId,
      error: error.message
    });
    return false;
  }
}

// Capture screenshot of an active, fully loaded tab and store it
async function captureAndStore(tabId) {
  try {
    const now = Date.now();
    const lastCapture = captureCooldownByTab.get(tabId) || 0;
    if (now - lastCapture < CAPTURE_COOLDOWN_MS) {
      return;
    }

    const tab = await chrome.tabs.get(tabId);

    if (!tab || !tab.active || tab.status !== 'complete' || shouldSkipUrl(tab.url) || tab.discarded) {
      return;
    }

    // Get the window to ensure the tab is in an active window
    const window = await chrome.windows.get(tab.windowId);
    if (window.state === 'minimized') {
      return;
    }

    // Capture the visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 90
    });

    // Store by URL and normalized variants to survive minor URL differences.
    await Promise.all([
      saveScreenshotForUrlVariants(tab.url, dataUrl),
      self.storage.saveTabScreenshot(tabId, tab.url, dataUrl)
    ]);
    captureCooldownByTab.set(tabId, now);
    cacheScreenshotForTab(tabId, tab.url, dataUrl);
    logDebug('captureAndStore:stored', { tabId, url: tab.url });

  } catch (error) {
    // Expected in many situations (tab closed mid-capture, special page,
    // missing permission, capture quota), so this is not surfaced as a warning.
    logDebug('captureAndStore:failed', { tabId, error: error.message });
  }
}

function markDiscardedReload(tabId, url, reason = 'unknown') {
  if (shouldSkipUrl(url)) {
    logDebug('markDiscardedReload:skip-url', { tabId, url, reason });
    return;
  }

  let trace = restoreTraceByTab.get(tabId);
  if (!trace) {
    trace = {
      id: ++restoreSequence,
      startedAt: performance.now(),
      url,
      createdAt: Date.now()
    };
    restoreTraceByTab.set(tabId, trace);
  } else {
    const age = Date.now() - (trace.createdAt || Date.now());
    if (age < 250 && urlsMatch(trace.url, url)) {
      logDebug('markDiscardedReload:deduped', {
        tabId,
        traceId: trace.id,
        reason,
        ageMs: age
      });
      return;
    }
    trace.url = url;
    trace.createdAt = Date.now();
  }

  logDebug('markDiscardedReload', {
    tabId,
    traceId: trace.id,
    reason,
    url
  });

  if (reloadStateTimeouts.has(tabId)) {
    clearTimeout(reloadStateTimeouts.get(tabId));
  }

  reloadingDiscardedTabs.add(tabId);
  overlaySentForReload.delete(tabId);
  const timeoutId = setTimeout(() => {
    logDebug('markDiscardedReload:timeout-clear', {
      tabId,
      traceId: trace?.id,
      ageMs: traceAgeMs(tabId)
    });
    reloadingDiscardedTabs.delete(tabId);
    reloadStateTimeouts.delete(tabId);
    pendingRestoreScreenshots.delete(tabId);
    restoreInterstitialByTab.delete(tabId);
    overlaySentForReload.delete(tabId);
    restoreTraceByTab.delete(tabId);
  }, RELOAD_STATE_MAX_MS);
  reloadStateTimeouts.set(tabId, timeoutId);
  prepareRestoreScreenshot(tabId, url);
  maybeShowRestoreInterstitial(tabId, url, trace.id);
  scheduleOverlayPush(tabId, url);
}

async function pushOverlayToTab(tabId, url, attempt = null, delayMs = null) {
  if (shouldSkipUrl(url)) {
    logDebug('pushOverlayToTab:skip-url', { tabId, attempt, delayMs, url });
    return false;
  }

  if (!reloadingDiscardedTabs.has(tabId)) {
    logDebug('pushOverlayToTab:not-reloading', {
      tabId,
      attempt,
      delayMs
    });
    return false;
  }

  if (overlaySentForReload.has(tabId)) {
    logDebug('pushOverlayToTab:already-sent', {
      tabId,
      attempt,
      delayMs
    });
    return false;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.status === 'complete') {
      logDebug('pushOverlayToTab:tab-complete', {
        tabId,
        attempt,
        delayMs,
        status: tab?.status
      });
      return false;
    }
  } catch (error) {
    logDebug('pushOverlayToTab:tab-get-failed', {
      tabId,
      attempt,
      delayMs,
      error: error.message
    });
    return false;
  }

  const screenshot = pendingRestoreScreenshots.get(tabId) || await prepareRestoreScreenshot(tabId, url);
  if (!screenshot) {
    logDebug('pushOverlayToTab:no-screenshot', {
      tabId,
      attempt,
      delayMs
    });
    return false;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_SCREENSHOT_OVERLAY',
      screenshot: screenshot
    });
    overlaySentForReload.add(tabId);
    logDebug('pushOverlayToTab:sent', {
      tabId,
      attempt,
      delayMs,
      ageMs: traceAgeMs(tabId)
    });
    return true;
  } catch (error) {
    // Content script may not be ready yet.
    logDebug('pushOverlayToTab:send-failed', {
      tabId,
      attempt,
      delayMs,
      error: error.message
    });
    return false;
  }
}

function hideOverlayInTab(tabId) {
  const delays = [100, 180, 300];
  for (const delay of delays) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, {
        type: 'HIDE_SCREENSHOT_OVERLAY'
      }).then(() => {
        logDebug('hideOverlayInTab:sent', {
          tabId,
          delay,
          ageMs: traceAgeMs(tabId)
        });
      }).catch((error) => {
        // Content script may not be ready or unavailable for this URL.
        logDebug('hideOverlayInTab:send-failed', {
          tabId,
          delay,
          error: error.message
        });
      });
    }, delay);
  }
}

function scheduleOverlayPush(tabId, url) {
  const delays = [0, 50, 120, 220, 380, 600];
  for (let index = 0; index < delays.length; index += 1) {
    const delay = delays[index];
    setTimeout(() => {
      pushOverlayToTab(tabId, url, index + 1, delay);
    }, delay);
  }
}

async function ensureReloadKickoff(tabId, reason) {
  if (!reloadingDiscardedTabs.has(tabId)) {
    return;
  }

  const lastKickoff = reloadKickoffByTab.get(tabId) || 0;
  const now = Date.now();
  if (now - lastKickoff < RELOAD_KICKOFF_MAX_MS) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) {
      return;
    }

    if (isRestorePageUrl(tab.url) || restoreInterstitialByTab.has(tabId)) {
      logDebug('ensureReloadKickoff:skip-restore-interstitial', {
        tabId,
        reason
      });
      return;
    }

    if (tab.status === 'loading' || tab.status === 'complete') {
      logDebug('ensureReloadKickoff:skip-tab-already-loading', {
        tabId,
        reason,
        status: tab.status
      });
      return;
    }

    // A pending navigation means Chrome is already taking this tab somewhere
    // (e.g. session restore). Reloading now would cancel it and re-commit the
    // stale last-committed entry instead.
    if (tab.pendingUrl) {
      logDebug('ensureReloadKickoff:skip-pending-navigation', {
        tabId,
        reason,
        pendingUrl: tab.pendingUrl
      });
      return;
    }

    reloadKickoffByTab.set(tabId, now);
    await chrome.tabs.reload(tabId);
    logDebug('ensureReloadKickoff:reload-called', { tabId, reason });
  } catch (error) {
    logDebug('ensureReloadKickoff:reload-failed', {
      tabId,
      reason,
      error: error.message
    });
  }
}

function scheduleReloadKickoff(tabId, reason) {
  setTimeout(() => {
    ensureReloadKickoff(tabId, reason);
  }, 140);
}

async function takeOverlayScreenshot(tabId, url) {
  if (shouldSkipUrl(url)) {
    return null;
  }

  const screenshot = await getOverlayScreenshot(tabId, url);

  if (!screenshot) {
    logDebug('takeOverlayScreenshot:missing', { tabId, url });
    return null;
  }

  return screenshot;
}

async function tabHasContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'BTU_PING'
    });
    return response?.ok === true;
  } catch (error) {
    return false;
  }
}

async function ensureContentScript(tabId, url, reason = 'unknown') {
  if (!Number.isFinite(tabId) || shouldSkipUrl(url)) {
    return 'skipped';
  }

  const hasScript = await tabHasContentScript(tabId);
  if (hasScript) {
    return 'already';
  }

  if (!chrome.scripting) {
    logDebug('ensureContentScript:missing-scripting-api', { tabId, reason });
    return 'failed';
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css']
    });
  } catch (error) {
    logDebug('ensureContentScript:insert-css-failed', {
      tabId,
      reason,
      error: error.message
    });
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });

    const available = await tabHasContentScript(tabId);
    if (available) {
      logDebug('ensureContentScript:injected', { tabId, reason });
      return 'injected';
    }
  } catch (error) {
    logDebug('ensureContentScript:execute-failed', {
      tabId,
      reason,
      error: error.message
    });
  }

  return 'failed';
}

async function rehydrateSessionTabs(reason = 'unknown') {
  try {
    await primeDiscardedTabs();
    const tabs = await chrome.tabs.query({});
    let scanned = 0;
    let injected = 0;
    let failed = 0;

    for (const tab of tabs) {
      if (typeof tab.id !== 'number' || shouldSkipUrl(tab.url)) {
        continue;
      }

      scanned += 1;
      const status = await ensureContentScript(tab.id, tab.url, reason);
      if (status === 'injected') {
        injected += 1;
      } else if (status === 'failed') {
        failed += 1;
      }

      if (tab.active && tab.status === 'complete') {
        setTimeout(() => captureAndStore(tab.id), 700);
        setTimeout(() => captureAndStore(tab.id), 1900);
      }

      if (tab.active && tab.discarded) {
        // If Chrome has already started restoring this tab (a navigation is
        // pending or loading), leave it alone: hijacking that navigation can
        // commit a stale URL. The overlay path still covers the visuals.
        if (tab.pendingUrl || tab.status === 'loading') {
          logDebug('rehydrateSessionTabs:skip-tab-being-restored', {
            tabId: tab.id,
            reason,
            status: tab.status,
            hasPendingUrl: Boolean(tab.pendingUrl)
          });
          continue;
        }

        markDiscardedReload(tab.id, tabEffectiveUrl(tab), `${reason}.activeDiscarded`);
        scheduleReloadKickoff(tab.id, `${reason}.activeDiscarded`);
      }
    }

    logDebug('rehydrateSessionTabs:done', {
      reason,
      scanned,
      injected,
      failed
    });
  } catch (error) {
    logDebug('rehydrateSessionTabs:failed', {
      reason,
      error: error.message
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_RESTORE_INTERSTITIAL_DATA') {
    (async () => {
      try {
        const tabId = typeof sender.tab?.id === 'number'
          ? sender.tab.id
          : Number(message.tabId);
        const url = message.targetUrl;

        if (!Number.isFinite(tabId) || !url || shouldSkipUrl(url)) {
          sendResponse({ screenshot: null });
          return;
        }

        const screenshot = pendingRestoreScreenshots.get(tabId) || await prepareRestoreScreenshot(tabId, url);
        logDebug('GET_RESTORE_INTERSTITIAL_DATA:reply', {
          tabId,
          hasScreenshot: Boolean(screenshot),
          ageMs: traceAgeMs(tabId)
        });
        sendResponse({ screenshot: screenshot || null });
      } catch (error) {
        logDebug('GET_RESTORE_INTERSTITIAL_DATA:failed', {
          tabId: sender.tab?.id ?? null,
          error: error.message
        });
        sendResponse({ screenshot: null });
      }
    })();

    return true;
  }

  if (message.type === 'CONTENT_DEBUG_LOG') {
    logDebug(`CS:${message.event || 'event'}`, {
      tabId: sender.tab?.id ?? null,
      url: sender.tab?.url ?? null,
      details: message.details || {}
    });
    return false;
  }

  if (message.type !== 'REQUEST_SCREENSHOT_OVERLAY') {
    return false;
  }

  (async () => {
    try {
      const tab = sender.tab;
      const tabId = tab?.id;
      const url = message.url || tab?.url;
      const documentReadyState = message.documentReadyState || 'loading';

      if (typeof tabId !== 'number' || !url || shouldSkipUrl(url)) {
        sendResponse({ screenshot: null });
        return;
      }

      const discardedHint = message.wasDiscarded === true;
      const loadingHint = documentReadyState !== 'complete';
      const hadRestoreInterstitial = restoreInterstitialByTab.has(tabId);
      const shouldServeOverlay =
        reloadingDiscardedTabs.has(tabId) ||
        discardedTabIds.has(tabId) ||
        discardedHint;

      if (hadRestoreInterstitial) {
        logDebug('REQUEST_SCREENSHOT_OVERLAY:skip-after-restore-interstitial', {
          tabId,
          readyState: documentReadyState,
          attempt: message.attempt
        });
        sendResponse({ screenshot: null });
        return;
      }

      if (!shouldServeOverlay || !loadingHint) {
        logDebug('REQUEST_SCREENSHOT_OVERLAY:ignored', {
          tabId,
          shouldServeOverlay,
          loadingHint,
          readyState: documentReadyState,
          attempt: message.attempt,
          wasDiscarded: discardedHint
        });
        sendResponse({ screenshot: null });
        return;
      }

      const screenshot = pendingRestoreScreenshots.get(tabId) || await takeOverlayScreenshot(tabId, url);
      logDebug('REQUEST_SCREENSHOT_OVERLAY:reply', {
        tabId,
        hasScreenshot: Boolean(screenshot),
        readyState: documentReadyState,
        attempt: message.attempt,
        ageMs: traceAgeMs(tabId)
      });
      sendResponse({ screenshot: screenshot || null });
    } catch (error) {
      logWarn('overlayRequestFailed', { error: error.message });
      sendResponse({ screenshot: null });
    }
  })();

  return true;
});

// Handle tab activation (switching tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  logDebug('onActivated', { tabId: activeInfo.tabId });
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.discarded || discardedTabIds.has(activeInfo.tabId)) {
      const effectiveUrl = tabEffectiveUrl(tab);
      logDebug('onActivated:discarded-tab', { tabId: activeInfo.tabId, url: effectiveUrl });
      markDiscardedReload(activeInfo.tabId, effectiveUrl, 'onActivated');
      scheduleReloadKickoff(activeInfo.tabId, 'onActivated');
    }
  } catch (error) {
    // Tab may no longer exist.
    logDebug('onActivated:get-tab-failed', {
      tabId: activeInfo.tabId,
      error: error.message
    });
  }

  // Capture after activation; captureVisibleTab can only capture the active tab.
  setTimeout(() => captureAndStore(activeInfo.tabId), 800);
  setTimeout(() => captureAndStore(activeInfo.tabId), 2200);
  setTimeout(() => captureAndStore(activeInfo.tabId), 4200);
});

// Handle tab updates (detecting discarded tab reload)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  logDebug('onUpdated', {
    tabId,
    changeInfo,
    status: tab?.status,
    discarded: tab?.discarded,
    url: tab?.url
  });

  if (changeInfo.discarded === true) {
    discardedTabIds.add(tabId);
    logDebug('onUpdated:discarded-true', { tabId });
  }

  const effectiveUrl = tabEffectiveUrl(tab);

  // Detect when a discarded tab is being reactivated.
  if (changeInfo.discarded === false && !shouldSkipUrl(effectiveUrl)) {
    discardedTabIds.delete(tabId);
    logDebug('onUpdated:discarded-tab-reactivating', { tabId, url: effectiveUrl });
    markDiscardedReload(tabId, effectiveUrl, 'onUpdated.discardedFalse');
    scheduleReloadKickoff(tabId, 'onUpdated.discardedFalse');
  }

  // Fallback: some Chrome versions only surface a loading state while the tab
  // remains marked as discarded in cached tab state.
  if (changeInfo.status === 'loading' && discardedTabIds.has(tabId) && !shouldSkipUrl(effectiveUrl)) {
    markDiscardedReload(tabId, effectiveUrl, 'onUpdated.loadingWithDiscardedSet');
  }

  if (changeInfo.status === 'loading' && reloadingDiscardedTabs.has(tabId) && !shouldSkipUrl(effectiveUrl)) {
    scheduleOverlayPush(tabId, effectiveUrl);
  }

  // Refresh screenshot for currently active tabs after a navigation completes.
  if (changeInfo.status === 'complete' && tab.active) {
    setTimeout(() => captureAndStore(tabId), 600);
    setTimeout(() => captureAndStore(tabId), 1800);
    setTimeout(() => captureAndStore(tabId), 3500);
  }

  // When the tab finishes loading, remove transient overlay tracking.
  if (changeInfo.status === 'complete') {
    if (isRestorePageUrl(tab?.url)) {
      logDebug('onUpdated:complete-restore-page', {
        tabId,
        ageMs: traceAgeMs(tabId)
      });
      return;
    }

    logDebug('onUpdated:complete', {
      tabId,
      ageMs: traceAgeMs(tabId)
    });
    hideOverlayInTab(tabId);
    discardedTabIds.delete(tabId);
    reloadingDiscardedTabs.delete(tabId);
    pendingRestoreScreenshots.delete(tabId);
    restoreInterstitialByTab.delete(tabId);
    overlaySentForReload.delete(tabId);
    restoreTraceByTab.delete(tabId);
    if (reloadStateTimeouts.has(tabId)) {
      clearTimeout(reloadStateTimeouts.get(tabId));
      reloadStateTimeouts.delete(tabId);
    }
    reloadKickoffByTab.delete(tabId);
  }
});

// Handle tab removal (cleanup)
chrome.tabs.onRemoved.addListener((tabId) => {
  logDebug('onRemoved', { tabId });
  discardedTabIds.delete(tabId);
  reloadingDiscardedTabs.delete(tabId);
  if (reloadStateTimeouts.has(tabId)) {
    clearTimeout(reloadStateTimeouts.get(tabId));
    reloadStateTimeouts.delete(tabId);
  }
  pendingRestoreScreenshots.delete(tabId);
  restoreInterstitialByTab.delete(tabId);
  overlaySentForReload.delete(tabId);
  recentTabScreenshots.delete(tabId);
  captureCooldownByTab.delete(tabId);
  restoreTraceByTab.delete(tabId);
  reloadKickoffByTab.delete(tabId);
  self.storage.deleteTabScreenshot(tabId).catch(() => {});
});

async function primeDiscardedTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    discardedTabIds.clear();

    for (const tab of tabs) {
      if (tab.discarded && typeof tab.id === 'number') {
        discardedTabIds.add(tab.id);
      }
    }
  } catch (error) {
    logWarn('primeDiscardedTabsFailed', { error: error.message });
  }
}

function cleanupEphemeralCaches() {
  const now = Date.now();
  for (const [tabId, entry] of recentTabScreenshots) {
    if (!entry || now - entry.timestamp > TAB_CACHE_MAX_AGE_MS) {
      recentTabScreenshots.delete(tabId);
    }
  }
}

// Periodic cleanup of old screenshots (run on startup and every hour)
async function runCleanup() {
  try {
    await self.storage.cleanup();
    cleanupEphemeralCaches();
    logDebug('cleanup:completed');
  } catch (error) {
    logWarn('cleanupFailed', { error: error.message });
  }
}

// Run cleanup on startup
runCleanup();
primeDiscardedTabs();

chrome.runtime.onStartup.addListener(() => {
  setTimeout(() => {
    rehydrateSessionTabs('runtime.onStartup');
  }, SESSION_REHYDRATE_DELAY_MS);
});

chrome.runtime.onInstalled.addListener(() => {
  setTimeout(() => {
    rehydrateSessionTabs('runtime.onInstalled');
  }, SESSION_REHYDRATE_DELAY_MS);
});

// Schedule cleanup every hour
setInterval(runCleanup, 60 * 60 * 1000);

logInfo('serviceWorkerStarted', { debugLogs: DEBUG_LOGS });
