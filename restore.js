(function () {
  const params = new URLSearchParams(window.location.search);
  const targetUrl = params.get('target');
  const tabIdParam = Number(params.get('tabId'));
  const screenshotEl = document.getElementById('restore-screenshot');
  const statusEl = document.getElementById('restore-status');
  let navigationStarted = false;
  const MIN_VISIBLE_MS = 100;
  const NAVIGATION_FAILSAFE_MS = 2000;
  const ALLOWED_TARGET_PROTOCOLS = ['http:', 'https:'];

  function isSafeTargetUrl(url) {
    if (!url) {
      return false;
    }

    try {
      const parsed = new URL(url);
      return ALLOWED_TARGET_PROTOCOLS.includes(parsed.protocol);
    } catch (error) {
      return false;
    }
  }

  function log(event, details = {}) {
    chrome.runtime.sendMessage({
      type: 'CONTENT_DEBUG_LOG',
      event: `restore:${event}`,
      details
    }).catch(() => {});
  }

  function setStatus(text) {
    if (statusEl) {
      statusEl.textContent = text;
    }
  }

  function navigateToTarget() {
    if (navigationStarted || !targetUrl) {
      return;
    }

    if (!isSafeTargetUrl(targetUrl)) {
      setStatus('Invalid restore target');
      log('navigate-blocked-unsafe-target', { targetUrl });
      return;
    }

    navigationStarted = true;
    log('navigate', { targetUrl });
    // replace() keeps the interstitial itself out of the final history stack.
    window.location.replace(targetUrl);
  }

  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  function preloadDataUrl(dataUrl) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = dataUrl;
    });
  }

  async function fetchScreenshot() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_RESTORE_INTERSTITIAL_DATA',
        tabId: Number.isFinite(tabIdParam) ? tabIdParam : undefined,
        targetUrl
      });
      return response?.screenshot || null;
    } catch (error) {
      log('fetch-error', { error: error.message });
      return null;
    }
  }

  async function runRestoreFlow() {
    log('start', {
      targetUrl,
      tabId: Number.isFinite(tabIdParam) ? tabIdParam : null
    });

    setTimeout(() => {
      if (!navigationStarted) {
        log('navigate-failsafe');
        navigateToTarget();
      }
    }, NAVIGATION_FAILSAFE_MS);

    if (!targetUrl) {
      setStatus('Missing target URL');
      log('missing-target');
      return;
    }

    setStatus('Restoring tab...');
    const screenshot = await fetchScreenshot();
    if (screenshot && screenshotEl) {
      log('screenshot-hit');
      await preloadDataUrl(screenshot);
      screenshotEl.style.backgroundImage = `url(${screenshot})`;
      await waitForPaint();
      setTimeout(navigateToTarget, MIN_VISIBLE_MS);
      return;
    }

    log('screenshot-miss');
    setStatus('Loading page...');
    navigateToTarget();
  }

  runRestoreFlow();
})();
