import * as M from './model.js';
import { render, go, wireGlobalEvents, toast, seedCapture, runSync } from './ui.js';

const SYNC_EVERY_HOURS = 24;

// Anything the Android share sheet passed in, consumed once then cleared from
// the URL so a reload does not re-seed the same draft.
function takeSharedContent() {
  const params = new URLSearchParams(location.search);
  const shared = ['title', 'text', 'url'].reduce((acc, key) => {
    if (params.get(key)) acc[key] = params.get(key);
    return acc;
  }, {});
  if (Object.keys(shared).length) history.replaceState({}, '', location.pathname);
  return Object.keys(shared).length ? shared : null;
}

async function boot() {
  try {
    await M.init();
  } catch (err) {
    document.getElementById('view').innerHTML =
      `<p class="empty">Storage unavailable: ${err.message}.<br>Private browsing blocks the local database this app stores everything in.</p>`;
    return;
  }

  wireGlobalEvents();

  const shared = takeSharedContent();
  if (M.isLocked()) {
    // Hold it until the file is open; unlocking lands on the seeded draft.
    if (shared) window.addEventListener('fieldnotes:unlocked', () => seedCapture(shared), { once: true });
    render();
  } else if (shared) {
    seedCapture(shared);
  } else {
    go(M.state.observations.length ? 'brief' : 'capture');
  }

  scheduleBackgroundSync();

  // Ask the browser not to evict this origin when the device runs low on space.
  // Chrome grants it for installed PWAs; without it, storage is "best-effort"
  // and can be cleared to reclaim disk.
  if (navigator.storage?.persist) {
    try {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch {}
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    const show = () => e.prompt();
    toast('Add to home screen for one-tap capture.');
    document.getElementById('streak').addEventListener('click', show, { once: true });
  });
}

// Fire-and-forget: a stale off-device backup is sent once the app is open and
// unlocked. Failure is logged, never shown — it must not interrupt capture.
function scheduleBackgroundSync() {
  const attempt = async () => {
    if (M.isLocked() || !navigator.onLine) return;
    const hours = M.hoursSinceSync();
    if (hours !== null && hours < SYNC_EVERY_HOURS) return;
    if (!(await M.loadSyncConfig())) return;
    const result = await runSync();
    if (result.ok) console.info('Backed up off-device.');
  };
  setTimeout(attempt, 4000);
  window.addEventListener('fieldnotes:unlocked', () => setTimeout(attempt, 2000), { once: true });
}

boot();

// Exposed for console poking / future automation.
window.spy = { model: M, render };
