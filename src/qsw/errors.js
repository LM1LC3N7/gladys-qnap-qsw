// -----------------------------------------------------------------------------
// The errors of the switch. A SwitchError message never holds the address, the
// password, the session token nor an identifier: it may be logged and shown.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  /** No TCP connection (refused, no route, DNS). */
  UNREACHABLE: 'unreachable',
  /** No complete answer within the deadline. */
  TIMEOUT: 'timeout',
  /** The deadline of a command or a reading passed before the request was written. */
  LATE: 'late',
  /** An answer above the size cap. */
  TOO_LARGE: 'too_large',
  /** Something answered, but not the QSS API (another protocol, not JSON, missing fields). */
  BAD_ANSWER: 'bad_answer',
  /** An HTTP status this code does not expect (`status`, `retryAfterMs`). */
  HTTP: 'http',
  /** The login route refused the user name or the password (HTTP 401/403): final until they change. */
  CREDENTIALS: 'credentials',
  /** Another route refused a session that was just opened (never a refusal of the credentials). */
  ACCESS: 'access',
  /** A redirection (the switch wants another address or protocol): never followed. */
  REDIRECT: 'redirect',
  /** The certificate is not the one pinned (`fingerprint` holds the one met). */
  CERTIFICATE: 'certificate',
  /** The certificate is not the fingerprint typed in the configuration (`fingerprint`). */
  CERTIFICATE_TYPED: 'certificate_typed',
  /** No pin, and /data cannot keep one: nothing is sent (`reason`: 'unreadable' | 'unwritable'). */
  PIN_UNAVAILABLE: 'pin_unavailable',
  /** A TLS handshake the switch refused. */
  TLS: 'tls',
});

export class SwitchError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message safe to log
   * @param {{ notSent?: boolean, status?: number, retryAfterMs?: number, fingerprint?: string, reason?: string }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SwitchError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** The failures that stop every request until the user acts. */
export const isFinal = (err) =>
  err?.code === CODES.CREDENTIALS ||
  err?.code === CODES.CERTIFICATE ||
  err?.code === CODES.CERTIFICATE_TYPED ||
  err?.code === CODES.PIN_UNAVAILABLE;

/** A main route asking to wait (429, 5xx): a pause of every request. */
export const isPause = (err) =>
  err?.code === CODES.HTTP && (err.status === 429 || err.status >= 500);
