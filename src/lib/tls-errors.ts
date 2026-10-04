/** OpenSSL / Node codes meaning the server's certificate wasn't accepted (not that the server was unreachable). */
const CERTIFICATE_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export const isCertificateError = (code: unknown): boolean => typeof code === "string" && CERTIFICATE_CODES.has(code);

/**
 * What to tell the user when the connection is encrypted but the certificate isn't trusted. On a home network or PC
 * the usual cause is antivirus "mail scanning" or a proxy that re-signs the connection with its own certificate.
 * Ghost-Hub never skips certificate checks: the fix is on the machine, not here.
 */
export const CERTIFICATE_HELP =
  "The mail server's security certificate isn't trusted, so Ghost-Hub refused to send your login. This usually means antivirus " +
  "\"mail scanning\" or a proxy is re-signing the connection (for example Avast Mail Shield, Kaspersky or ESET): turn off SSL/TLS scanning " +
  "for IMAP port 993 and try again. Ghost-Hub never skips certificate checks.";
