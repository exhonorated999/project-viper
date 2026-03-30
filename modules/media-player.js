/**
 * Media Player module for V.I.P.E.R.
 * Embedded streaming player — Spotify, SiriusXM, YouTube, Pandora, ESPN, Pluto TV.
 * Ported from PULSE MediaPlayer.tsx to vanilla JS.
 */

const BUILTIN_SERVICES = [
  { id: 'spotify',  label: 'Spotify',  url: 'https://open.spotify.com',                icon: '🎵', builtin: true },
  { id: 'siriusxm', label: 'SiriusXM', url: 'https://player.siriusxm.com/now-playing', icon: '📻', builtin: true },
  { id: 'youtube',  label: 'YouTube',  url: 'https://www.youtube.com',                 icon: '▶️', builtin: true },
  { id: 'pandora',  label: 'Pandora',  url: 'https://www.pandora.com',                 icon: '🎶', builtin: true },
  { id: 'espn',     label: 'ESPN',     url: 'https://www.espn.com/watch',              icon: '🏈', builtin: true },
  { id: 'plutotv',  label: 'Pluto TV', url: 'https://pluto.tv/us/live-tv',            icon: '📡', builtin: true },
];

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function loadUserServices() {
  try {
    const raw = localStorage.getItem('mediaPlayer_userServices');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveUserServices(services) {
  localStorage.setItem('mediaPlayer_userServices', JSON.stringify(services));
}

/**
 * Render the media player into a container element.
 * @param {HTMLElement} container — sidebar element to inject into
 */
function renderMediaPlayer(container) {
  // State
  let activeService = localStorage.getItem('mediaPlayer_service') || null;
  let activeUrl = localStorage.getItem('mediaPlayer_url') || '';
  let showPicker = false;
  let userServices = loadUserServices();
  let deleteConfirm = null;
  let zoom = parseFloat(localStorage.getItem('mediaPlayer_zoom') || '0.65');

  function allServices() { return [...BUILTIN_SERVICES, ...userServices]; }

  function setActive(id, url) {
    activeService = id;
    activeUrl = url;
    localStorage.setItem('mediaPlayer_service', id);
    localStorage.setItem('mediaPlayer_url', url);
    render();
  }

  function clearActive() {
    activeService = null;
    activeUrl = '';
    localStorage.removeItem('mediaPlayer_service');
    localStorage.removeItem('mediaPlayer_url');
    render();
  }

  function handleZoom(delta) {
    zoom = Math.round(Math.min(1.5, Math.max(0.3, zoom + delta)) * 100) / 100;
    localStorage.setItem('mediaPlayer_zoom', String(zoom));
    applyZoom();
  }

  function applyZoom() {
    const wv = container.querySelector('webview');
    if (!wv) return;
    wv.addEventListener('dom-ready', function onReady() {
      wv.setZoomFactor(zoom);
      wv.removeEventListener('dom-ready', onReady);
    });
    // Also apply immediately if already loaded
    try { wv.setZoomFactor(zoom); } catch {}
  }

  function addService() {
    const name = prompt('Service name:');
    if (!name) return;
    const url = prompt('Service URL (https://...):');
    if (!url || !url.startsWith('http')) return;
    const id = 'custom_' + Date.now();
    const svc = { id, label: name.trim(), url: url.trim(), icon: '🌐' };
    userServices.push(svc);
    saveUserServices(userServices);
    setActive(id, svc.url);
  }

  function removeService(id) {
    userServices = userServices.filter(s => s.id !== id);
    saveUserServices(userServices);
    if (activeService === id) clearActive();
    else render();
  }

  async function popOut() {
    if (!activeUrl) return;
    try {
      await window.electronAPI.popOutMediaPlayer(activeUrl);
    } catch (e) {
      console.error('Pop-out failed:', e);
    }
  }

  function render() {
    const svcs = allServices();
    const activeSvc = svcs.find(s => s.id === activeService);

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;border-top:1px solid rgba(0,217,255,0.2);padding-top:8px;">
        <!-- Header bar -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0 12px 6px;">
          <span style="font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;">Media Player</span>
          <div style="display:flex;align-items:center;gap:4px;">
            ${activeUrl ? `
              <button class="mp-btn" data-action="zoom-out" title="Zoom out" style="font-size:11px;padding:2px 5px;">−</button>
              <span style="font-size:9px;color:#8b949e;min-width:30px;text-align:center;">${Math.round(zoom * 100)}%</span>
              <button class="mp-btn" data-action="zoom-in" title="Zoom in" style="font-size:11px;padding:2px 5px;">+</button>
              <button class="mp-btn" data-action="popout" title="Pop out to window" style="font-size:11px;padding:2px 5px;">⧉</button>
            ` : ''}
            <button class="mp-btn" data-action="toggle-picker" title="Services" style="font-size:11px;padding:2px 5px;">
              ${showPicker ? '▼' : '▲'}
            </button>
          </div>
        </div>

        <!-- Service picker -->
        ${showPicker ? `
          <div style="padding:4px 8px 8px;border-bottom:1px solid rgba(0,217,255,0.1);">
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;">
              ${svcs.map(svc => `
                <button class="mp-svc-btn ${svc.id === activeService ? 'active' : ''}"
                        data-action="select-service" data-id="${svc.id}" data-url="${svc.url}"
                        ${!svc.builtin ? 'oncontextmenu="return false;"' : ''}>
                  ${!svc.builtin ? `<span class="mp-svc-remove" data-action="remove-service" data-id="${svc.id}">×</span>` : ''}
                  <span style="font-size:13px;">${svc.icon}</span>
                  <span style="font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;text-align:center;">${svc.label}</span>
                </button>
              `).join('')}
              <button class="mp-svc-btn" data-action="add-service">
                <span style="font-size:13px;">➕</span>
                <span style="font-size:9px;">Add</span>
              </button>
            </div>
            ${userServices.length > 0 ? '<p style="font-size:8px;color:#555;text-align:center;margin:4px 0 0;">Right-click custom service to remove</p>' : ''}
          </div>
        ` : ''}

        <!-- Content area -->
        <div style="flex:1;min-height:0;position:relative;">
          ${activeUrl ? `
            <webview src="${activeUrl}"
                     partition="persist:media"
                     useragent="${DESKTOP_UA}"
                     allowpopups="true"
                     plugins="true"
                     style="width:100%;height:100%;border:0;">
            </webview>
          ` : `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#555;">
              <svg width="32" height="32" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="opacity:0.15;margin-bottom:8px;">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/>
              </svg>
              <p style="font-size:11px;">Select a service above</p>
            </div>
          `}
        </div>
      </div>
    `;

    // Wire up events via delegation
    container.querySelectorAll('[data-action]').forEach(el => {
      const action = el.dataset.action;
      if (action === 'toggle-picker') {
        el.addEventListener('click', () => { showPicker = !showPicker; render(); });
      } else if (action === 'zoom-in') {
        el.addEventListener('click', () => handleZoom(0.1));
      } else if (action === 'zoom-out') {
        el.addEventListener('click', () => handleZoom(-0.1));
      } else if (action === 'popout') {
        el.addEventListener('click', popOut);
      } else if (action === 'select-service') {
        el.addEventListener('click', () => setActive(el.dataset.id, el.dataset.url));
        if (!BUILTIN_SERVICES.find(b => b.id === el.dataset.id)) {
          el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (confirm(`Remove "${el.querySelector('span:last-child').textContent}"?`)) {
              removeService(el.dataset.id);
            }
          });
        }
      } else if (action === 'remove-service') {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          removeService(el.dataset.id);
        });
      } else if (action === 'add-service') {
        el.addEventListener('click', addService);
      }
    });

    // Apply zoom to webview after render
    setTimeout(applyZoom, 100);
  }

  // Initial render — start with picker open if nothing selected
  showPicker = !activeService;
  render();

  // Listen for pop-out closed to refresh webview
  window.electronAPI.onMediaPopoutClosed(() => {
    if (activeUrl) render();
  });
}

// Inject CSS for media player buttons
(function injectMediaPlayerStyles() {
  if (document.getElementById('media-player-styles')) return;
  const style = document.createElement('style');
  style.id = 'media-player-styles';
  style.textContent = `
    .mp-btn {
      background: rgba(0,217,255,0.08);
      border: 1px solid rgba(0,217,255,0.15);
      color: #8b949e;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      line-height: 1;
    }
    .mp-btn:hover { background: rgba(0,217,255,0.15); color: #00d9ff; }
    .mp-svc-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 6px 4px;
      border-radius: 6px;
      border: 1px solid transparent;
      background: rgba(0,217,255,0.05);
      color: #8b949e;
      cursor: pointer;
      font-family: inherit;
      position: relative;
      transition: all 0.15s;
    }
    .mp-svc-btn:hover { background: rgba(0,217,255,0.12); color: #fff; border-color: rgba(0,217,255,0.2); }
    .mp-svc-btn.active { background: rgba(0,217,255,0.15); color: #00d9ff; border-color: rgba(0,217,255,0.4); }
    .mp-svc-remove {
      position: absolute;
      top: -4px;
      right: -4px;
      width: 14px;
      height: 14px;
      background: #e53e3e;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 8px;
      line-height: 1;
      cursor: pointer;
      z-index: 10;
    }
    .mp-svc-remove:hover { background: #fc5555; }
  `;
  document.head.appendChild(style);
})();

// Export for use
if (typeof window !== 'undefined') {
  window.ViperMediaPlayer = { render: renderMediaPlayer };
}
