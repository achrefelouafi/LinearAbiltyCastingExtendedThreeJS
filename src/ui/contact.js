/**
 * The one panel in the HUD that is not about the sandbox — it is about who
 * built it.
 *
 * This scene is a portfolio piece before it is a toy, so the card stands in
 * the bottom-right corner — the one the rest of the HUD leaves empty — and
 * carries the two links that matter: the feed the work is posted to, and the
 * studio site.
 *
 * The ring around the portrait picks up the armed ability's accent, so the
 * card is lit by whatever the visitor is casting rather than by a fixed brand
 * colour — the only part of the HUD that changes colour with the sandbox.
 */

const SITE_URL = 'https://chirostudio.xyz';
const X_URL = 'https://x.com/chirovisuals';

/** X, from the official mark, in a 24 box so it sits on the pixel grid at 13px. */
const ICON_X = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68
      l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>`;

/** A globe for the studio — stroked, so it matches the ability sigils. */
const ICON_SITE = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"/>
    <path d="M3.4 9h17.2M3.4 15h17.2"/>
    <path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/>
  </svg>`;

const ICON_GO = `
  <svg class="contact__go" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 17 17 7M9 7h8v8"/>
  </svg>`;

const link = (href, className, icon, label, sub) => `
  <a class="contact__link ${className}" href="${href}" target="_blank" rel="noopener noreferrer">
    <span class="contact__icon">${icon}</span>
    <span class="contact__link-text">
      <b>${label}</b>
      <em>${sub}</em>
    </span>
    ${ICON_GO}
  </a>`;

/**
 * Markup for the card. Injected by the HUD alongside everything else so the
 * whole overlay is still built in one pass.
 */
export const CONTACT_MARKUP = `
  <div class="hud__contact" data-contact>
    <div class="contact">
      <button class="contact__toggle" type="button" data-contact-toggle
        aria-label="Hide the contact card" title="Hide">
        <span class="contact__toggle-bar"></span>
      </button>

      <div class="contact__head">
        <div class="contact__portrait">
          <span class="contact__frame">
            <img src="./contact/p.jpg" alt="Portrait of Chiro" decoding="async" draggable="false" />
          </span>
        </div>
        <div class="contact__who">
          <span class="contact__status"><i></i>Available for work</span>
          <span class="contact__name">Chiro</span>
          <span class="contact__role">Real-time VFX &amp; shader engineer</span>
        </div>
      </div>

      <p class="contact__note">
        Every ability, shader and tool in this scene is hand-written. Yours could be too.
      </p>

      <div class="contact__links">
        ${link(X_URL, 'contact__link--x', ICON_X, '@chirovisuals', 'Work in motion, daily')}
        ${link(SITE_URL, 'contact__link--site', ICON_SITE, 'chirostudio.xyz', 'Portfolio &amp; contact')}
      </div>
    </div>
  </div>
`;

const STORE_KEY = 'chiro.contact.collapsed';

/**
 * Where the card has room to stand open.
 *
 * The ability bar is laid out from `left: 50%`, so it can never be wider than
 * half the window and its right edge never passes 75vw; the card clears it from
 * about 1200px up. The editor's column sets the height: below ~780px its bottom
 * reaches into the corner. Narrower or shorter than that and the card opens as
 * the portrait alone, which fits anywhere.
 */
const ROOM = '(min-width: 1240px) and (min-height: 800px)';

/** Reads/writes are best-effort: private windows throw on the first touch. */
function readCollapsed() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORE_KEY);
  } catch {
    /* fall through to the window's own answer. */
  }
  if (stored !== null) return stored === '1';
  return !window.matchMedia(ROOM).matches;
}

function writeCollapsed(collapsed) {
  try {
    localStorage.setItem(STORE_KEY, collapsed ? '1' : '0');
  } catch {
    /* nothing to do — the card just forgets between visits. */
  }
}

/**
 * Behaviour for the card: the collapse toggle, the accent hand-off and the
 * entrance, which waits for the loading veil so it is not played behind it.
 */
export class ContactCard {
  constructor(root) {
    this.root = root.querySelector('[data-contact]');
    if (!this.root) return;

    this.toggle = this.root.querySelector('[data-contact-toggle]');
    this.setCollapsed(readCollapsed(), { silent: true });

    this.toggle.addEventListener('click', () => this.setCollapsed(!this._collapsed));
    // The canvas takes pointerdown; the overlay must not hand it a cast.
    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  setCollapsed(collapsed, { silent = false } = {}) {
    this._collapsed = collapsed;
    this.root?.classList.toggle('is-collapsed', collapsed);
    if (this.toggle) {
      const label = collapsed ? 'Show the contact card' : 'Hide the contact card';
      this.toggle.setAttribute('aria-label', label);
      this.toggle.title = collapsed ? 'Work with me' : 'Hide';
    }
    if (!silent) writeCollapsed(collapsed);
  }

  /** Tint the portrait ring with the selected ability's accent. */
  setAccent(accent) {
    if (accent) this.root?.style.setProperty('--contact-accent', accent);
  }

  /** Called once the loading veil is on its way out. */
  reveal() {
    this.root?.classList.add('is-ready');
  }
}
