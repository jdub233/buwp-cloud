/**
 * buwp-cloud: operate BU's WordPress clusters on AWS ECS
 * Main library exports
 */

export {
  CONFIG_FILE_NAME,
  OVERRIDE_FILE_NAME,
  CONFIG_ENV_VAR,
  findConfigDir,
  findConfigFiles,
  loadConfig,
  resolveProfiles,
} from './config.js';

export {
  CONTEXT_KEY,
  parseContextBucketName,
  isWordpressContext,
  isProduction,
  toTarget,
  discoverTargets,
} from './discovery.js';

export { errorCode, describeError, credentialHint } from './errors.js';

export { createAwsAdapter } from './aws.js';
