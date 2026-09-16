import * as M from './model.js';
import { render, go, wireGlobalEvents, toast } from './ui.js';

async function boot() {
  try {
    await M.load();
  } catch (err) {
    document.getElementById('view').innerHTML =
      `<p class="empty">Storage unavailable: ${err.message}.<br>Private browsing blocks the local database this app stores everything in.</p>`;
    return;
  }

  wireGlobalEvents();
  go(M.state.observations.length ? 'brief' : 'capture');

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

boot();

// Exposed for console poking / future automation.
window.spy = { model: M, render };
