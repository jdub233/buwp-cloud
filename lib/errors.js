/**
 * Error helpers shared by commands.
 */

// AWS error names that mean the credentials are missing, expired or wrong, rather than that the
// call itself was refused.
const CREDENTIAL_ERRORS = new Set([
  'CredentialsProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidAccessKeyId',
  'InvalidClientTokenId',
  'InvalidToken',
  'SignatureDoesNotMatch',
  'TokenRefreshRequired',
]);
const EXPIRED_ERRORS = new Set(['ExpiredToken', 'ExpiredTokenException', 'TokenRefreshRequired']);

/**
 * What an AWS error name says about the credentials.
 * @param {string|null} code
 * @returns {'expired'|'invalid'|null} null when the error isn't about credentials
 */
export function credentialProblem(code) {
  if (EXPIRED_ERRORS.has(code)) {
    return 'expired';
  }
  return CREDENTIAL_ERRORS.has(code) ? 'invalid' : null;
}

/**
 * The AWS error name (AccessDenied, ExpiredToken), or null for a plain error.
 * @param {unknown} err
 * @returns {string|null}
 */
export function errorCode(err) {
  return err instanceof Error && err.name && err.name !== 'Error' ? err.name : null;
}

/**
 * One-line description of an error, keeping the AWS error name.
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const code = errorCode(err);
  return code ? `${code}: ${err.message}` : err.message;
}

/**
 * What to do about a profile that failed on its credentials, or null for any other failure.
 * @param {{code: string|null, profile: string|null}} error - A discovery error
 * @param {{source: string}} context - Where the profile list came from
 * @returns {string|null}
 */
export function credentialHint({ code, profile }, { source }) {
  if (!CREDENTIAL_ERRORS.has(code)) {
    return null;
  }
  if (profile === null) {
    return 'No AWS credentials found. Pass --profile, export AWS_PROFILE, '
      + 'or list profiles in a .buwp-cloud.json (see `buwp-cloud config --init`).';
  }
  const from = source === 'env' ? ' (from AWS_PROFILE)' : '';
  return `Check that AWS profile "${profile}"${from} exists and its credentials haven't expired.`;
}
