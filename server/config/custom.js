/**
 * Custom configuration
 * (sails.config.custom)
 *
 * One-off settings specific to your application.
 *
 * For more information on custom configuration, visit:
 * https://sailsjs.com/config/custom
 */

const path = require('path');
const { URL } = require('url');
const bytes = require('bytes');
const sails = require('sails');

const version = require('../version');

const envToNumber = (value) => {
  if (!value) {
    return null;
  }

  const number = parseInt(value, 10);
  return Number.isNaN(number) ? null : number;
};

const envToBytes = (value) => bytes(value);

const envToArray = (value) => (value ? value.split(',') : []);

const baseUrl = envToArray(process.env.BASE_URL)[0];
const parsedBasedUrl = new URL(baseUrl);

// Gateway sign-in (local modification, see GATEWAY.md). When enabled, PLANKA
// trusts the identity headers of the authenticating reverse proxy in front of
// it, and password sign-in is switched off.
const gatewayIdentity = require('../utils/gateway-identity');

const gatewayConfig = (() => {
  const gatewayAuthEnabled = process.env.GATEWAY_AUTH === 'true';

  if (!gatewayAuthEnabled) {
    return { gatewayAuthEnabled };
  }

  const gatewayAuthSecret = process.env.GATEWAY_AUTH_SECRET || '';
  if (gatewayAuthSecret.length < gatewayIdentity.MIN_SECRET_LENGTH) {
    throw new Error(
      `GATEWAY_AUTH=true needs GATEWAY_AUTH_SECRET of at least ${gatewayIdentity.MIN_SECRET_LENGTH} characters`,
    );
  }

  const roleGroups = {
    admin: gatewayIdentity.parseList(process.env.GATEWAY_ADMIN_GROUPS),
    projectOwner: gatewayIdentity.parseList(process.env.GATEWAY_PROJECT_OWNER_GROUPS),
    boardUser: gatewayIdentity.parseList(process.env.GATEWAY_BOARD_USER_GROUPS),
  };

  if (Object.values(roleGroups).every((groups) => groups.length === 0)) {
    throw new Error('GATEWAY_AUTH=true needs at least one of the GATEWAY_*_GROUPS settings');
  }

  return {
    gatewayAuthEnabled,
    gatewayAuthSecret,
    gatewayRoleGroups: roleGroups,
    gatewayLogoutUrl: process.env.GATEWAY_LOGOUT_URL || null,
  };
})();

module.exports.custom = {
  /**
   *
   * Any other custom config this Sails app should use during development.
   *
   */

  version,

  baseUrl,
  baseUrlPath: parsedBasedUrl.pathname.replace(/\/$/, ''), // Remove trailing slash
  baseUrlSecure: parsedBasedUrl.protocol === 'https:',

  maxUploadFileSize: envToBytes(process.env.MAX_UPLOAD_FILE_SIZE),
  tokenExpiresIn: (parseInt(process.env.TOKEN_EXPIRES_IN, 10) || 365) * 24 * 60 * 60,

  storageLimit: envToBytes(process.env.STORAGE_LIMIT),
  activeUsersLimit: envToNumber(process.env.ACTIVE_USERS_LIMIT),

  // Location to receive uploaded files in. Default (non-string value) is a Sails-specific location.
  uploadsTempPath: null,
  uploadsBasePath: path.join(sails.config.appPath, 'data'),

  faviconsPathSegment: 'protected/favicons',
  userAvatarsPathSegment: 'protected/user-avatars',
  backgroundImagesPathSegment: 'protected/background-images',
  attachmentsPathSegment: 'private/attachments',

  defaultAdminEmail:
    process.env.DEFAULT_ADMIN_EMAIL && process.env.DEFAULT_ADMIN_EMAIL.toLowerCase(),

  showDetailedAuthErrors: process.env.SHOW_DETAILED_AUTH_ERRORS === 'true',
  outgoingProxy: process.env.OUTGOING_PROXY,
  swaggerExposed: process.env.SWAGGER_EXPOSED === 'true',

  s3Endpoint: process.env.S3_ENDPOINT,
  s3Region: process.env.S3_REGION,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  s3Bucket: process.env.S3_BUCKET,
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  s3RequestChecksumCalculation: process.env.S3_REQUEST_CHECKSUM_CALCULATION,

  smtpHost: process.env.SMTP_HOST,
  smtpPort: process.env.SMTP_PORT || 587,
  smtpName: process.env.SMTP_NAME,
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpTlsRejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
  smtpUser: process.env.SMTP_USER,
  smtpPassword: process.env.SMTP_PASSWORD,
  smtpFrom: process.env.SMTP_FROM,

  gravatarBaseUrl: process.env.GRAVATAR_BASE_URL,

  /* Internal */

  internalAccessToken: process.env.INTERNAL_ACCESS_TOKEN,
  termsType: process.env.TERMS_TYPE || 'custom',
  customerPanelUrl: process.env.CUSTOMER_PANEL_URL,
  demoMode: process.env.DEMO_MODE === 'true',

  /* Gateway sign-in (local modification, see GATEWAY.md) */

  ...gatewayConfig,
};
