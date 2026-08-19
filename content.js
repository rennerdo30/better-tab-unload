// Content script for displaying screenshot overlay

(function() {
  // Prevent multiple injections
  if (window.__betterTabUnloadInjected) {
    return;
  }
  window.__betterTabUnloadInjected = true;

  let overlay = null;
  let overlayAutoRemoveTimer = null;
  let overlayReadyStateMonitor = null;
  let overlayDeferredRemovalTimer = null;
  let overlayFadeRemoveTimer = null;
  // Opt-in debug switch, shipped as `false`. Must be enabled together with
  // DEBUG_LOGS in background.js; see that file for the privacy caveat.
  const DEBUG_LOGS = false;
  const POST_LOAD_HOLD_MS = 100;
  const OVERLAY_FADE_MS = 140;

  function logToServiceWorker(event, details = {}) {
    if (!DEBUG_LOGS) {
      return;
    }

    chrome.runtime.sendMessage({
      type: 'CONTENT_DEBUG_LOG',
      event,
      details
    }).catch(() => {
      // Ignore debug transport errors.
    });
  }

  // Create and show the screenshot overlay
  function showOverlay(screenshotDataUrl) {
    if (document.readyState === 'complete') {
      return false;
    }

    if (overlay) {
      logToServiceWorker('overlay-show-skip-already-visible', {
        readyState: document.readyState
      });
      return true;
    }

    // Remove any existing overlay
    removeOverlayNow();

    // Create overlay element
    overlay = document.createElement('div');
    overlay.id = 'better-tab-unload-overlay';
    overlay.className = 'better-tab-unload-overlay';
    overlay.style.backgroundImage = `url(${screenshotDataUrl})`;

    // Insert at the beginning of body or document element
    const container = document.body || document.documentElement;
    container.insertBefore(overlay, container.firstChild);

    logToServiceWorker('overlay-shown', {
      readyState: document.readyState
    });
    scheduleOverlayRemoval();

    return true;
  }

  function clearOverlayTimers() {
    if (overlayAutoRemoveTimer) {
      clearTimeout(overlayAutoRemoveTimer);
      overlayAutoRemoveTimer = null;
    }

    if (overlayReadyStateMonitor) {
      clearInterval(overlayReadyStateMonitor);
      overlayReadyStateMonitor = null;
    }

    if (overlayDeferredRemovalTimer) {
      clearTimeout(overlayDeferredRemovalTimer);
      overlayDeferredRemovalTimer = null;
    }

    if (overlayFadeRemoveTimer) {
      clearTimeout(overlayFadeRemoveTimer);
      overlayFadeRemoveTimer = null;
    }

  }

  function schedulePostLoadRemoval(delayMs = POST_LOAD_HOLD_MS) {
    if (!overlay) {
      removeOverlayNow();
      return;
    }

    if (overlayDeferredRemovalTimer) {
      return;
    }

    if (overlayAutoRemoveTimer) {
      clearTimeout(overlayAutoRemoveTimer);
      overlayAutoRemoveTimer = null;
    }

    if (overlayReadyStateMonitor) {
      clearInterval(overlayReadyStateMonitor);
      overlayReadyStateMonitor = null;
    }

    overlayDeferredRemovalTimer = setTimeout(() => {
      overlayDeferredRemovalTimer = null;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          removeOverlaySmooth();
        });
      });
    }, delayMs);
  }

  function removeOverlaySmooth() {
    if (!overlay) {
      removeOverlayNow();
      return;
    }

    if (overlay.classList.contains('better-tab-unload-fade-out')) {
      return;
    }

    overlay.classList.add('better-tab-unload-fade-out');
    overlayFadeRemoveTimer = setTimeout(() => {
      overlayFadeRemoveTimer = null;
      removeOverlayNow();
    }, OVERLAY_FADE_MS);
  }

  function scheduleOverlayRemoval() {
    clearOverlayTimers();

    // Hard timeout to avoid overlay lingering if load events are unreliable.
    overlayAutoRemoveTimer = setTimeout(removeOverlayNow, 6000);

    // Remove quickly once the document reaches complete.
    overlayReadyStateMonitor = setInterval(() => {
      if (document.readyState === 'complete') {
        schedulePostLoadRemoval();
      }
    }, 50);
  }

  function removeOverlayNow() {
    if (!overlay) {
      clearOverlayTimers();
      logToServiceWorker('overlay-remove-now-noop');
      return;
    }

    clearOverlayTimers();
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
    logToServiceWorker('overlay-removed');
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'BTU_PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'SHOW_SCREENSHOT_OVERLAY') {
      const shown = showOverlay(message.screenshot);
      logToServiceWorker('message-show', {
        shown,
        readyState: document.readyState
      });
      sendResponse({ success: shown });
    } else if (message.type === 'HIDE_SCREENSHOT_OVERLAY') {
      schedulePostLoadRemoval();
      logToServiceWorker('message-hide');
      sendResponse({ success: true });
    }
    return true;
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function requestOverlayDuringLoad() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (attempt > 0) {
        await sleep(40);
      }

      try {
        logToServiceWorker('request-overlay', {
          attempt: attempt + 1,
          readyState: document.readyState,
          wasDiscarded: document.wasDiscarded === true
        });
        const response = await chrome.runtime.sendMessage({
          type: 'REQUEST_SCREENSHOT_OVERLAY',
          url: window.location.href,
          documentReadyState: document.readyState,
          wasDiscarded: document.wasDiscarded === true,
          attempt: attempt + 1
        });

        if (response?.screenshot && document.readyState !== 'complete') {
          logToServiceWorker('request-overlay-hit', {
            attempt: attempt + 1,
            readyState: document.readyState
          });
          if (showOverlay(response.screenshot)) {
            return;
          }
        } else {
          logToServiceWorker('request-overlay-miss', {
            attempt: attempt + 1,
            readyState: document.readyState
          });
        }
      } catch (error) {
        // Ignore transient sendMessage errors during navigation.
        logToServiceWorker('request-overlay-error', {
          attempt: attempt + 1,
          error: error.message
        });
      }

      if (document.readyState === 'complete') {
        logToServiceWorker('request-overlay-stop-complete', {
          attempt: attempt + 1
        });
        return;
      }
    }

    logToServiceWorker('request-overlay-stop-max-attempts');
  }

  // Remove overlay when page loads
  function onPageLoad() {
    schedulePostLoadRemoval();
  }

  // Listen for various load events
  if (document.readyState === 'complete') {
    onPageLoad();
  } else {
    window.addEventListener('load', onPageLoad);
  }

  // Safety timeout - remove overlay after 12 seconds no matter what
  setTimeout(() => {
    if (overlay) {
      logToServiceWorker('overlay-safety-timeout');
      removeOverlayNow();
    }
  }, 12000);

  requestOverlayDuringLoad();

})();
