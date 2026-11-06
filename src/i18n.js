// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, button, errors). Errors
// thrown to Gladys are English (one language per message, like the core's);
// the statuses and button answers are { en, fr }. No text ever holds the
// password, the session token, the MAC nor an entry typed by the user; the
// certificate fingerprint met is shown (not a secret: the switch shows it to
// anyone), so that the user can compare it with the one of the switch.
// -----------------------------------------------------------------------------

import { CODES } from './qsw/errors.js';

/** A delay in words: seconds under a minute, then whole minutes (59.9 s is "1 min"). */
export function delayOf(ms) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  if (seconds < 60) return { en: `${seconds} s`, fr: `${seconds} s` };
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return { en: `${minutes} min`, fr: `${minutes} min` };
  const hours = Math.round(minutes / 60);
  return { en: `${hours} h`, fr: `${hours} h` };
}

/** Why the switch failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.LATE:
      return { en: 'too late to send', fr: 'trop tard pour envoyer' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.CREDENTIALS:
      return { en: 'user name or password refused', fr: 'identifiants refusés' };
    case CODES.ACCESS:
      return { en: 'access refused after login', fr: 'accès refusé après connexion' };
    case CODES.REDIRECT:
      return { en: 'redirection', fr: 'redirection' };
    case CODES.CERTIFICATE:
    case CODES.CERTIFICATE_TYPED:
      return { en: 'another HTTPS certificate', fr: 'autre certificat HTTPS' };
    case CODES.PIN_UNAVAILABLE:
      return { en: 'certificate cannot be kept', fr: 'certificat impossible à garder' };
    case CODES.TLS:
      return { en: 'TLS refused', fr: 'TLS refusé' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

export const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

const retry = (delay) => ({
  en: `Retried in ${delayOf(delay).en}.`,
  fr: `Nouvel essai dans ${delayOf(delay).fr}.`,
});

const SAVE_TO_RETRY = {
  en: 'Nothing is sent to the switch until the user name or the password is saved again.',
  fr: 'Plus rien n’est envoyé au commutateur tant que le nom d’utilisateur ou le mot de passe n’est pas enregistré à nouveau.',
};

const MISSING = {
  statistics: { en: 'rates', fr: 'débits' },
  sensor: { en: 'temperature and fans', fr: 'température et ventilateurs' },
  time: { en: 'uptime', fr: 'temps de fonctionnement' },
  firmware: { en: 'firmware', fr: 'firmware' },
};

export const T = {
  status: {
    ok: ({ label, up, count, missing = [] }) =>
      join(
        {
          en: `${label ?? 'The switch'} answers: ${up ?? '?'} of ${count ?? '?'} ports connected.`,
          fr: `${label ?? 'Le commutateur'} répond : ${up ?? '?'} port(s) connecté(s) sur ${count ?? '?'}.`,
        },
        missing.length > 0
          ? {
              en: `Not read this time: ${missing.map((m) => MISSING[m]?.en ?? m).join(', ')}.`,
              fr: `Non lu cette fois : ${missing.map((m) => MISSING[m]?.fr ?? m).join(', ')}.`,
            }
          : {},
      ),
    waiting: (delay) => ({
      en: `Started: the switch is read in ${delayOf(delay).en} (never sooner than the refresh interval).`,
      fr: `Démarré : le commutateur est lu dans ${delayOf(delay).fr} (jamais avant l’intervalle de rafraîchissement).`,
    }),
    hostMissing: {
      en: 'Enter the address of the switch.',
      fr: 'Saisissez l’adresse du commutateur.',
    },
    hostInvalid: {
      en: 'The address of the switch is not valid (an IP address or a host name, with an optional http:// or https:// and port).',
      fr: 'L’adresse du commutateur n’est pas valide (une adresse IP ou un nom d’hôte, avec http:// ou https:// et un port facultatifs).',
    },
    fingerprintHttp: {
      en: 'A certificate fingerprint only applies to HTTPS: empty it, or enter the address with https://.',
      fr: 'Une empreinte de certificat ne s’applique qu’en HTTPS : videz-la, ou saisissez l’adresse avec https://.',
    },
    usernameInvalid: {
      en: 'The user name is not valid (printable characters, no space).',
      fr: 'Le nom d’utilisateur n’est pas valide (caractères imprimables, sans espace).',
    },
    missingPassword: {
      en: 'Enter the password of the switch.',
      fr: 'Saisissez le mot de passe du commutateur.',
    },
    passwordInvalid: {
      en: 'The password holds a line break or a control character (pasted by mistake?): it was not sent.',
      fr: 'Le mot de passe contient un retour à la ligne ou un caractère de contrôle (collé par erreur ?) : il n’a pas été envoyé.',
    },
    fingerprintInvalid: {
      en: 'The certificate fingerprint is not a SHA-256 fingerprint (64 hexadecimal digits, colons allowed).',
      fr: 'L’empreinte du certificat n’est pas une empreinte SHA-256 (64 chiffres hexadécimaux, deux-points permis).',
    },
    credentialsRefused: join(
      {
        en: 'The switch refused the user name or the password.',
        fr: 'Le commutateur a refusé le nom d’utilisateur ou le mot de passe.',
      },
      SAVE_TO_RETRY,
      {
        en: 'The "Test the connection" button tries once more when a reading is due.',
        fr: 'Le bouton « Tester la connexion » essaie une fois de plus quand une lecture est due.',
      },
    ),
    certificateChanged: (fingerprint) => ({
      en: `The switch presents another HTTPS certificate than the one learned (SHA-256 ${fingerprint}). Nothing was sent. If you replaced or reset the switch, check this fingerprint in its web interface and type it in the "Certificate fingerprint" field.`,
      fr: `Le commutateur présente un autre certificat HTTPS que celui appris (SHA-256 ${fingerprint}). Rien n’a été envoyé. Si vous avez remplacé ou réinitialisé le commutateur, vérifiez cette empreinte dans son interface web et saisissez-la dans le champ « Empreinte du certificat ».`,
    }),
    certificateTyped: (fingerprint) => ({
      en: `The HTTPS certificate of the switch is not the fingerprint you typed (it presents SHA-256 ${fingerprint}). Nothing was sent.`,
      fr: `Le certificat HTTPS du commutateur n’est pas l’empreinte saisie (il présente SHA-256 ${fingerprint}). Rien n’a été envoyé.`,
    }),
    pinUnavailable: (reason, fingerprint) =>
      reason === 'unreadable'
        ? {
            en: `The storage of the integration (/data) cannot be read: the certificate of the switch is not learned blindly. Nothing was sent; /data is read again every 10 s. You may type the fingerprint of the switch (SHA-256 ${fingerprint}, check it in its web interface) in the "Certificate fingerprint" field.`,
            fr: `Le stockage de l’intégration (/data) est illisible : le certificat du commutateur n’est pas appris à l’aveugle. Rien n’a été envoyé ; /data est relu toutes les 10 s. Vous pouvez saisir l’empreinte du commutateur (SHA-256 ${fingerprint}, à vérifier dans son interface web) dans le champ « Empreinte du certificat ».`,
          }
        : {
            en: `The certificate of the switch cannot be kept (/data cannot be written): nothing was sent. Type its fingerprint (SHA-256 ${fingerprint}, check it in its web interface) in the "Certificate fingerprint" field.`,
            fr: `Le certificat du commutateur ne peut pas être gardé (/data non inscriptible) : rien n’a été envoyé. Saisissez son empreinte (SHA-256 ${fingerprint}, à vérifier dans son interface web) dans le champ « Empreinte du certificat ».`,
          },
    otherSwitch: {
      en: 'Another switch answers at this address (not the one read before): nothing is published nor commanded. Save the configuration to take this switch as the new one.',
      fr: 'Un autre commutateur répond à cette adresse (pas celui lu avant) : rien n’est publié ni commandé. Enregistrez la configuration pour prendre ce commutateur comme le nouveau.',
    },
    paused: (status, delay) => ({
      en: `The switch asked to wait (HTTP ${status}): no request for ${delayOf(delay).en}.`,
      fr: `Le commutateur a demandé d’attendre (HTTP ${status}) : aucune requête pendant ${delayOf(delay).fr}.`,
    }),
    tls: (delay) =>
      join(
        {
          en: 'The switch refused the TLS handshake. If it serves its interface in plain HTTP only, enter its address with http://.',
          fr: 'Le commutateur a refusé la négociation TLS. S’il ne sert son interface qu’en HTTP simple, saisissez son adresse avec http://.',
        },
        retry(delay),
      ),
    rebooting: (delay) =>
      join(
        {
          en: 'The switch is rebooting (reboot sent from Gladys).',
          fr: 'Le commutateur redémarre (redémarrage envoyé depuis Gladys).',
        },
        retry(delay),
      ),
    failure: (err, delay, secure) =>
      join(
        { en: 'The switch cannot be read:', fr: 'Le commutateur ne peut pas être lu :' },
        { en: `${reasonOf(err).en}.`, fr: `${reasonOf(err).fr}.` },
        secure && err?.code === CODES.BAD_ANSWER
          ? {
              en: 'If it serves its interface in plain HTTP only, enter its address with http://.',
              fr: 'S’il ne sert son interface qu’en HTTP simple, saisissez son adresse avec http://.',
            }
          : {},
        retry(delay),
      ),
    configNotRead: (delay) => ({
      en: `Gladys did not give the configuration: asked again in ${delayOf(delay).en}.`,
      fr: `Gladys n’a pas donné la configuration : nouvelle demande dans ${delayOf(delay).fr}.`,
    }),
  },
  test: {
    ok: (status) =>
      join(status, {
        en: 'Connection working.',
        fr: 'Connexion fonctionnelle.',
      }),
  },
  errors: {
    unknownDevice: 'Unknown device or feature',
    readOnly: 'This value is read only: only the reboot button acts',
    badValue: 'The reboot button only takes the value 1',
    rebootDisabled:
      'Rebooting the switch is disabled: turn on "Allow rebooting the switch" in the configuration',
    stillRunning: 'A reboot is already being sent',
    notConnected: 'The switch is not configured or a stop stands (see the status): nothing sent',
    otherSwitch: 'Another switch answers at this address: nothing sent',
    identityUnknown:
      'The identity of the switch (its MAC) is not known yet, or /data cannot be read: nothing sent',
    paused: (delay) => `The switch asked to wait: nothing sent for ${delayOf(delay).en}`,
    cooldown: (delay) =>
      `A reboot was sent less than 10 min ago: nothing sent, try again in ${delayOf(delay).en}`,
    tooSlow: 'The switch did not answer in time: nothing sent',
    cooldownNotKept: 'The 10 min delay between two reboots cannot be kept in /data: nothing sent',
    unknownState: (reason) => `The switch could not be read just before (${reason}): nothing sent`,
    notSent: (reason) => `Reboot not sent (${reason})`,
    refused: (reason) => `The switch refused the reboot (${reason})`,
    sentUnconfirmed: (reason) =>
      `Reboot sent, without an answer from the switch (${reason}): it may be rebooting`,
    testTooLong: 'The test took too long',
  },
};
