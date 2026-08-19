// IndexedDB wrapper for screenshot storage

const DB_NAME = 'BetterTabUnload';
const DB_VERSION = 2;
const STORE_NAME = 'screenshots';
const TAB_STORE_NAME = 'tabScreenshots';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let dbPromise = null;

function normalizeScreenshotUrlKey(url) {
  if (!url || typeof url !== 'string') {
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
    const hashIndex = url.indexOf('#');
    if (hashIndex === -1) {
      return url;
    }
    return url.slice(0, hashIndex);
  }
}

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }

      if (!db.objectStoreNames.contains(TAB_STORE_NAME)) {
        const tabStore = db.createObjectStore(TAB_STORE_NAME, { keyPath: 'tabId' });
        tabStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });

  return dbPromise;
}

async function saveScreenshot(url, dataUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const record = {
      url: url,
      screenshot: dataUrl,
      timestamp: Date.now()
    };

    const request = store.put(record);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function getScreenshot(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.get(url);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result?.screenshot || null);
  });
}

async function getAllScreenshots(limit = 0) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const request = index.openCursor(null, 'prev');
    const screenshots = [];

    request.onerror = () => reject(request.error);
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor || (limit > 0 && screenshots.length >= limit)) {
        resolve(screenshots);
        return;
      }

      screenshots.push(cursor.value);
      cursor.continue();
    };
  });
}

async function saveTabScreenshot(tabId, url, dataUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TAB_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(TAB_STORE_NAME);

    const record = {
      tabId: tabId,
      url: url,
      screenshot: dataUrl,
      timestamp: Date.now()
    };

    const request = store.put(record);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function getTabScreenshot(tabId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TAB_STORE_NAME, 'readonly');
    const store = transaction.objectStore(TAB_STORE_NAME);

    const request = store.get(tabId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

async function deleteTabScreenshot(tabId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TAB_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(TAB_STORE_NAME);

    const request = store.delete(tabId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function deleteScreenshot(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.delete(url);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function clearScreenshots() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, TAB_STORE_NAME], 'readwrite');
    const urlStore = transaction.objectStore(STORE_NAME);
    const tabStore = transaction.objectStore(TAB_STORE_NAME);

    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();

    urlStore.clear();
    tabStore.clear();
  });
}

async function cleanupStoreByTimestamp(db, storeName, cutoff) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const index = store.index('timestamp');
    const range = IDBKeyRange.upperBound(cutoff);
    const request = index.openCursor(range);

    request.onerror = () => reject(request.error);
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
  });
}

async function dedupeUrlScreenshots(db) {
  const records = await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    const collected = [];

    request.onerror = () => reject(request.error);
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(collected);
        return;
      }

      collected.push(cursor.value);
      cursor.continue();
    };
  });

  const canonicalMap = new Map();
  for (const record of records) {
    const canonicalUrl = normalizeScreenshotUrlKey(record.url);
    if (!canonicalUrl) {
      continue;
    }

    const current = canonicalMap.get(canonicalUrl);
    if (!current || (record.timestamp || 0) >= (current.timestamp || 0)) {
      canonicalMap.set(canonicalUrl, {
        url: canonicalUrl,
        screenshot: record.screenshot,
        timestamp: record.timestamp || Date.now()
      });
    }
  }

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();

    store.clear();
    for (const record of canonicalMap.values()) {
      store.put(record);
    }
  });
}

async function cleanup() {
  const db = await openDB();
  const cutoff = Date.now() - MAX_AGE_MS;

  await dedupeUrlScreenshots(db);
  await cleanupStoreByTimestamp(db, STORE_NAME, cutoff);
  await cleanupStoreByTimestamp(db, TAB_STORE_NAME, cutoff);
}

// Export for use in service worker
self.storage = {
  saveScreenshot,
  getScreenshot,
  getAllScreenshots,
  saveTabScreenshot,
  getTabScreenshot,
  deleteTabScreenshot,
  deleteScreenshot,
  clearScreenshots,
  cleanup
};
