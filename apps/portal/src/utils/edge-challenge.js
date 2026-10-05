import { HumanReadableError } from './errors';

// Fastly Next-Gen WAF can answer a members API request with a client challenge (HTML
// page) or a block instead of the API response. A fetch() can't solve a
// HTML response, so when one comes back we embed the challenge in a frame, wait for the
// visitor's browser to solve it (which sets the challenge cookie) and retry the request once.
// https://www.fastly.com/documentation/guides/security/bot-management/client-challenges/embedding-challenges-in-pages
const CHALLENGE_PATH_PREFIX = '/_fs-ch-';
// The interstitial itself loads a different script (script.js), so this can't be read from it
const CHALLENGE_SCRIPT_PATH = '/_fs-ch-1T1wmsGaOgGaSxcX/challenge.js';
// challenge.js reports progress here: started, processing, captcha_prompted, complete, error
const CHALLENGE_STATUS_ATTRIBUTE = 'data-challenge-status';
const CHALLENGE_TIMEOUT_MS = 60 * 1000;
// A visitor solving a CAPTCHA gets longer, but the retried request carries an integrity token
// fetched before the challenge, which Ghost only accepts for 5 minutes
const INTERACTIVE_CHALLENGE_TIMEOUT_MS = 4 * 60 * 1000;

// 406/449 are NGWAF block status
const EDGE_BLOCK_STATUSES = [406, 449];

// Opt-in per browser while the flow is verified against live NGWAF rules. Fastly strips
// non-`ghost-*` cookies before origin, so this never reaches Ghost or the cache key.
//   enable:  document.cookie = 'waf_challenge=1; Max-Age=2592000; Path=/; SameSite=Lax'
//   disable: document.cookie = 'waf_challenge=; Max-Age=0; Path=/'
const FEATURE_FLAG_COOKIE = 'waf_challenge=1';

export function isEdgeChallengeEnabled() {
  return document.cookie.split('; ').includes(FEATURE_FLAG_COOKIE);
}

export const EDGE_CHALLENGE_FAILED_MESSAGE = 'Unable to verify your request, please try again';

export class EdgeChallengeError extends HumanReadableError {
  constructor() {
    super(EDGE_CHALLENGE_FAILED_MESSAGE, { code: 'EDGE_CHALLENGE_FAILED' });
  }
}

function contentTypeOf(res) {
  return (res.headers?.get('content-type') || '').toLowerCase();
}

// Error pages (503, maintenance, etc) are HTML too, so only treat a response as a challenge
// when it loads the challenge assets.
export async function isEdgeChallengeResponse(res) {
  if (!contentTypeOf(res).includes('text/html')) {
    return false;
  }
  try {
    const body = await res.clone().text();
    return body.includes(CHALLENGE_PATH_PREFIX);
  } catch (e) {
    return false;
  }
}

export function isEdgeBlockResponse(res) {
  return (
    EDGE_BLOCK_STATUSES.includes(res.status) && !contentTypeOf(res).includes('application/json')
  );
}

function isSameOrigin(url) {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch (e) {
    return false;
  }
}

// Only dynamic challenges can be embedded, and they normally solve without showing anything,
// so the frame stays hidden. Fastly can still escalate to a CAPTCHA when it judges the traffic
// suspicious, in which case the frame covers the page, above the Portal popup.
// https://www.fastly.com/documentation/guides/security/bot-management/client-challenges/about-client-challenges/
const HIDDEN_FRAME_STYLE = {
  position: 'fixed',
  top: '0',
  left: '0',
  width: '0',
  height: '0',
  border: '0',
  zIndex: '4000000',
};
const INTERACTIVE_FRAME_STYLE = {
  width: '100%',
  height: '100%',
  background: 'rgba(0, 0, 0, 0.4)',
};
const FRAME_DOCUMENT_STYLE =
  'html,body{margin:0;height:100%;background:transparent}' +
  'body{display:flex;align-items:center;justify-content:center}';

let pendingChallenge = null;

/**
 * Solves a Fastly challenge and resolves once the challenge cookie has been set.
 *
 * challenge.js defines a non-configurable global `init`, so it can only run once per document:
 * loading it into the page a second time (e.g. once the challenge cookie has expired) throws.
 * Each challenge therefore runs in its own same-origin frame, which also keeps the script's
 * globals out of the site's theme code. The frame shares the site's cookies.
 *
 * challenge.js resolves URLs against the frame's own location, so the frame has to load a real
 * page on the site rather than stay on about:blank; it loads the challenge script itself, which
 * is fetched anyway and always exists where a challenge is served.
 * @returns {Promise<void>}
 */
export function solveEdgeChallenge() {
  if (pendingChallenge) {
    return pendingChallenge;
  }

  pendingChallenge = new Promise((resolve, reject) => {
    const scriptUrl = new URL(CHALLENGE_SCRIPT_PATH, window.location.origin).href;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, HIDDEN_FRAME_STYLE);
    frame.src = scriptUrl;

    const startedAt = Date.now();
    let observer = null;
    let timer = null;
    let interactive = false;
    const finish = (error) => {
      observer?.disconnect();
      clearTimeout(timer);
      frame.remove();
      pendingChallenge = null;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const embedChallenge = () => {
      // null when the frame failed to load and is showing the browser's error page
      const frameDocument = frame.contentDocument;
      if (!frameDocument?.head || !frameDocument.body) {
        finish(new EdgeChallengeError());
        return;
      }

      // The browser shows the challenge script it loaded as plain text, which would sit behind
      // a CAPTCHA, so start from an empty document
      frameDocument.head.replaceChildren();
      frameDocument.body.replaceChildren();

      const style = frameDocument.createElement('style');
      style.textContent = FRAME_DOCUMENT_STYLE;
      frameDocument.head.appendChild(style);

      const container = frameDocument.createElement('div');
      container.className = 'fastly-challenge';
      frameDocument.body.appendChild(container);

      observer = new MutationObserver(() => {
        const status = container.getAttribute(CHALLENGE_STATUS_ATTRIBUTE);
        if (status === 'complete') {
          finish();
        } else if (status === 'error') {
          finish(new EdgeChallengeError());
        } else if (status === 'captcha_prompted' && !interactive) {
          interactive = true;
          Object.assign(frame.style, INTERACTIVE_FRAME_STYLE);
          frame.removeAttribute('aria-hidden');
          frame.focus();
          clearTimeout(timer);
          timer = setTimeout(
            () => finish(new EdgeChallengeError()),
            INTERACTIVE_CHALLENGE_TIMEOUT_MS - (Date.now() - startedAt),
          );
        }
      });
      observer.observe(container, {
        attributes: true,
        attributeFilter: [CHALLENGE_STATUS_ATTRIBUTE],
      });

      const script = frameDocument.createElement('script');
      script.src = scriptUrl;
      script.addEventListener('error', () => finish(new EdgeChallengeError()));
      frameDocument.head.appendChild(script);
    };

    // Covers the frame failing to load as well as a challenge that never finishes
    timer = setTimeout(() => finish(new EdgeChallengeError()), CHALLENGE_TIMEOUT_MS);
    frame.addEventListener('load', embedChallenge, { once: true });
    document.body.appendChild(frame);
  });

  return pendingChallenge;
}

/**
 * fetch() for members API endpoints that NGWAF may challenge. Solves a challenge and retries
 * once; throws EdgeChallengeError when the request is blocked or still challenged. A plain
 * fetch() unless the waf_challenge flag is set.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithEdgeChallenge(url, options) {
  if (!isEdgeChallengeEnabled()) {
    return fetch(url, options);
  }

  const res = await fetch(url, options);
  if (isEdgeBlockResponse(res)) {
    throw new EdgeChallengeError();
  }
  if (!(await isEdgeChallengeResponse(res))) {
    return res;
  }

  // The challenge cookie is set on the page's origin, so solving it can't help a request
  // to another site (e.g. subscribing to a recommendation)
  if (!isSameOrigin(url)) {
    throw new EdgeChallengeError();
  }

  await solveEdgeChallenge();

  const retry = await fetch(url, options);
  if (isEdgeBlockResponse(retry) || (await isEdgeChallengeResponse(retry))) {
    throw new EdgeChallengeError();
  }
  return retry;
}
