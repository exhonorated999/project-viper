/**
 * UC Chat — Notification preload (plain JS, CommonJS).
 *
 * Injected via session.setPreloads() into every UC chat partition
 * (persist:uc_<personaId>). Runs inside the social-platform page's renderer.
 *
 *   1. Override window.Notification — capture {title, body, icon} and forward
 *      to main as 'uc-notif-raw'.
 *   2. Poll document.title for unread-count changes ("(3) Discord") and
 *      forward as 'uc-title-signal' when the count grows.
 *
 * The main process maps event.sender.id -> chatId, so this preload does not
 * need to know which chat it serves.
 */

const { ipcRenderer } = require('electron');

/* ── Notification API hijack ─────────────────────────────── */
try {
  const RealNotification = window.Notification;
  if (RealNotification) {
    const HookedNotification = function (title, options) {
      try {
        ipcRenderer.send('uc-notif-raw', {
          title: title || '',
          body: (options && options.body) || '',
          icon: (options && options.icon) || '',
        });
      } catch (_) { /* swallow */ }
      // Let the page believe the notification fired (some apps gate UI on it).
      return new RealNotification(title, options);
    };
    HookedNotification.permission = 'granted';
    HookedNotification.requestPermission = (cb) => {
      const p = 'granted';
      if (cb) { try { cb(p); } catch (_) {} }
      return Promise.resolve(p);
    };
    window.Notification = HookedNotification;
  }
} catch (_) { /* swallow */ }

/* ── Title polling ───────────────────────────────────────── */
let lastUnread = 0;
function parseTitleUnread(title) {
  if (!title) return 0;
  const paren = title.match(/\((\d+)\+?\)/);
  if (paren) return Math.min(99, parseInt(paren[1], 10) || 0);
  const bracket = title.match(/\[(\d+)\]/);
  if (bracket) return Math.min(99, parseInt(bracket[1], 10) || 0);
  if (/^[●•▲]\s/.test(title)) return 1;
  return 0;
}

function checkTitle() {
  try {
    const t = document.title || '';
    const n = parseTitleUnread(t);
    if (n > lastUnread) ipcRenderer.send('uc-title-signal', { unread: n });
    lastUnread = n;
  } catch (_) { /* swallow */ }
}

if (typeof document !== 'undefined') {
  setTimeout(checkTitle, 1500);
  setInterval(checkTitle, 1500);
}
