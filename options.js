function formatTimestamp(timestamp) {
  if (!timestamp) {
    return 'Unknown date';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp));
}

function estimateBytesFromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return 0;
  }

  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) {
    return 0;
  }

  const base64Length = dataUrl.length - commaIndex - 1;
  return Math.max(0, Math.floor((base64Length * 3) / 4));
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  const digits = exponent < 2 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

const refreshButton = document.getElementById('refresh-button');
const clearButton = document.getElementById('clear-button');
const countValue = document.getElementById('count-value');
const sizeValue = document.getElementById('size-value');
const statusText = document.getElementById('status-text');
const emptyState = document.getElementById('empty-state');
const screenshotGrid = document.getElementById('screenshot-grid');

let isLoading = false;

function setBusy(busy) {
  isLoading = busy;
  refreshButton.disabled = busy;
  clearButton.disabled = busy;
}

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle('error', isError);
}

function renderScreenshots(records) {
  screenshotGrid.textContent = '';

  const totalBytes = records.reduce((sum, record) => {
    return sum + estimateBytesFromDataUrl(record.screenshot);
  }, 0);

  countValue.textContent = String(records.length);
  sizeValue.textContent = formatBytes(totalBytes);

  const hasScreenshots = records.length > 0;
  emptyState.hidden = hasScreenshots;

  if (!hasScreenshots) {
    return;
  }

  for (const record of records) {
    const card = document.createElement('article');
    card.className = 'card';

    const image = document.createElement('img');
    image.className = 'preview';
    image.src = record.screenshot;
    image.alt = `Screenshot for ${record.url}`;
    image.loading = 'lazy';

    const meta = document.createElement('div');
    meta.className = 'meta';

    const urlLine = document.createElement('p');
    urlLine.className = 'url';

    const link = document.createElement('a');
    link.href = record.url;
    link.textContent = record.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';

    const timestamp = document.createElement('p');
    timestamp.className = 'timestamp';
    timestamp.textContent = `Captured ${formatTimestamp(record.timestamp)}`;

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', async () => {
      deleteButton.disabled = true;
      try {
        await self.storage.deleteScreenshot(record.url);
        await loadScreenshots(`Removed screenshot for ${record.url}`);
      } catch (error) {
        setStatus(`Failed to delete screenshot: ${error.message}`, true);
      } finally {
        deleteButton.disabled = false;
      }
    });

    urlLine.appendChild(link);
    actions.appendChild(deleteButton);
    meta.appendChild(urlLine);
    meta.appendChild(timestamp);
    meta.appendChild(actions);

    card.appendChild(image);
    card.appendChild(meta);
    screenshotGrid.appendChild(card);
  }
}

async function loadScreenshots(statusMessage = '') {
  if (isLoading) {
    return;
  }

  if (!self.storage || typeof self.storage.getAllScreenshots !== 'function') {
    setStatus('Storage API not available on settings page.', true);
    return;
  }

  setBusy(true);
  setStatus('Loading screenshots...');

  try {
    const records = await self.storage.getAllScreenshots();
    renderScreenshots(records);
    if (statusMessage) {
      setStatus(statusMessage);
    } else {
      setStatus(`Loaded ${records.length} screenshot${records.length === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    setStatus(`Failed to load screenshots: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

refreshButton.addEventListener('click', async () => {
  await loadScreenshots('Screenshot list refreshed.');
});

clearButton.addEventListener('click', async () => {
  if (!self.storage || typeof self.storage.clearScreenshots !== 'function') {
    setStatus('Storage API not available on settings page.', true);
    return;
  }

  if (!confirm('Delete all saved screenshots?')) {
    return;
  }

  setBusy(true);
  setStatus('Clearing screenshots...');

  try {
    await self.storage.clearScreenshots();
    renderScreenshots([]);
    setStatus('All screenshots cleared.');
  } catch (error) {
    setStatus(`Failed to clear screenshots: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
});

loadScreenshots();
