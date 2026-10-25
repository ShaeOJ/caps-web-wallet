/* Ministry bulletin: BETA notice.
 *
 * Tells visitors plainly that CAPS is under active development before they
 * commit a miner or real funds to it. Deliberately self-contained — these are
 * static pages with no backend, so dismissal is remembered in localStorage.
 *
 * Shown once per version per browser. Bump NOTICE_VERSION to re-show it after
 * a materially different announcement.
 */
export function initBetaNotice() {
  var NOTICE_VERSION = '2026-10-caps-beta';
  var KEY = 'caps.betaNotice.wallet';

  try {
    if (localStorage.getItem(KEY) === NOTICE_VERSION) return;
  } catch (e) {
    /* storage blocked (private mode) — show it, just don't persist */
  }

  function dismiss(overlay) {
    overlay.classList.remove('show');
    try { localStorage.setItem(KEY, NOTICE_VERSION); } catch (e) {}
    setTimeout(function () { overlay.remove(); }, 320);
  }

  function build() {
    var overlay = document.createElement('div');
    overlay.className = 'beta-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'betaTitle');

    overlay.innerHTML = [
      '<div class="beta-box">',
      '  <div class="beta-scan" aria-hidden="true"></div>',
      '  <div class="beta-eyebrow">&#9670; Ministry Bulletin &#9670;</div>',
      '  <h2 class="beta-title" id="betaTitle">THIS WALLET IS IN BETA</h2>',
      '  <p class="beta-lede">CAPS is in <b>BETA</b> and under active development.',
      '     The chain, the pool, the explorer and the wallet are all live &mdash;',
      '     and all still being worked on.</p>',
      '  <ul class="beta-list">',
      '    <li>Expect downtime, resets and rough edges without notice.</li>',
      '    <li>Consensus rules may still change. Keep your node updated.</li>',
      '    <li>The wallet is non-custodial &mdash; <b>write down your recovery phrase</b>.</li>',
      '    <li>Not an investment. Mine it for the fun of it, not for a return.</li>',
      '  </ul>',
      '  <p class="beta-foot">Proceed, Comrade &mdash; the work is yours alone.</p>',
      '  <button class="beta-btn" type="button">Understood</button>',
      '</div>'
    ].join('');

    var close = function () { dismiss(overlay); };
    overlay.querySelector('.beta-btn').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();            // click the backdrop
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape' && document.body.contains(overlay)) {
        close();
        document.removeEventListener('keydown', onKey);
      }
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('show'); });
    overlay.querySelector('.beta-btn').focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
}
