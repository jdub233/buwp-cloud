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

export { TargetError, normalizeTargetName, findTarget } from './targets.js';

export {
  WORDPRESS_CONTAINER,
  taskIdFromArn,
  taskDefinitionLabel,
  summarizeTask,
  execBlocker,
  pickTask,
  loadServiceTasks,
} from './tasks.js';

export {
  withTargetAccount,
  execArgs,
  shellQuote,
  formatCommandLine,
  productionNotice,
  singleTaskWarning,
  startSession,
  runInteractive,
} from './session.js';

export {
  NO_STATUS_EXIT_CODE,
  newNonce,
  sessionLabel,
  commandLine,
  wrapCapture,
  captureScript,
  printableScriptFor,
  printableScript,
  remoteCommand,
  remoteCommandExpression,
  printedCommand,
  runCaptured,
  sessionFailure,
  createOutputSplitter,
} from './capture.js';

export {
  CHUNK_CHARS,
  NEW_FILE_MODE,
  parseLocation,
  newCopyId,
  stagingPath,
  sha256,
  chunks,
  appendCommand,
  dropFunction,
  readFunction,
  parseDropReport,
  parseReadOutput,
} from './filecopy.js';

export {
  parseHostPort,
  databaseFromTaskDefinition,
  parseSecretRef,
  readSecretRef,
  parseMysqlGreeting,
} from './database.js';

export {
  PORT_FORWARD_DOCUMENT,
  ssmTarget,
  portForwardArgs,
  isPortFree,
  probePort,
  waitForTunnel,
} from './tunnel.js';

export {
  HEALTH_CHECK_PATH,
  isPassingHealthCheck,
  logConfigFromTaskDefinition,
  taskStreamName,
  grepPattern,
  parseTime,
  toLogEvent,
  fetchLogEvents,
  localTime,
} from './logs.js';

export { formatTable, formatDuration, formatJobRunner, shortDigest } from './format.js';

export { createAwsAdapter } from './aws.js';
