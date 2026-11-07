/**
 * buwp-cloud: operate BU's WordPress clusters on AWS ECS
 * Main library exports
 */

export {
  CONFIG_ENV_VAR,
  configPath,
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
  describeError,
} from './discovery.js';

export { createAwsAdapter } from './aws.js';
