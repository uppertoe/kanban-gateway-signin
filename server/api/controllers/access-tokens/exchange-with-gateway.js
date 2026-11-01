/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

/**
 * @swagger
 * /access-tokens/exchange-with-gateway:
 *   post:
 *     summary: Exchange the gateway identity for an access token
 *     description: Signs in the person whom the authenticating reverse proxy has already identified (local modification). Available only when GATEWAY_AUTH is enabled.
 *     tags:
 *       - Access Tokens
 *     operationId: exchangeWithGateway
 *     parameters:
 *       - name: withHttpOnlyToken
 *         in: query
 *         required: false
 *         description: Whether to include an HTTP-only authentication cookie
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Signed in successfully
 *       401:
 *         description: No trusted gateway identity on the request
 *       403:
 *         description: Not permitted, deactivated, or a further step (terms) is required
 *     security: []
 */

const { getRemoteAddress } = require('../../../utils/remote-address');
const { readGatewayIdentity } = require('../../../utils/gateway-identity');

const Errors = {
  GATEWAY_AUTH_DISABLED: {
    gatewayAuthDisabled: 'Gateway sign-in is not enabled',
  },
  NO_GATEWAY_IDENTITY: {
    noGatewayIdentity: 'No gateway identity',
  },
  NOT_PERMITTED: {
    notPermitted: 'Not permitted to use PLANKA',
  },
  USER_DEACTIVATED: {
    userDeactivated: 'User is deactivated',
  },
  EMAIL_ALREADY_IN_USE: {
    emailAlreadyInUse: 'Email already in use',
  },
  USERNAME_ALREADY_IN_USE: {
    usernameAlreadyInUse: 'Username already in use',
  },
  ACTIVE_USERS_LIMIT_REACHED: {
    activeUsersLimitReached: 'Active users limit reached',
  },
};

module.exports = {
  inputs: {
    withHttpOnlyToken: {
      type: 'boolean',
    },
  },

  exits: {
    gatewayAuthDisabled: {
      responseType: 'notFound',
    },
    noGatewayIdentity: {
      responseType: 'unauthorized',
    },
    notPermitted: {
      responseType: 'forbidden',
    },
    userDeactivated: {
      responseType: 'forbidden',
    },
    adminLoginRequiredToInitializeInstance: {
      responseType: 'forbidden',
    },
    termsAcceptanceRequired: {
      responseType: 'forbidden',
    },
    totpVerificationRequired: {
      responseType: 'forbidden',
    },
    emailAlreadyInUse: {
      responseType: 'conflict',
    },
    usernameAlreadyInUse: {
      responseType: 'conflict',
    },
    activeUsersLimitReached: {
      responseType: 'conflict',
    },
  },

  async fn(inputs) {
    const { gatewayAuthEnabled, gatewayAuthSecret } = sails.config.custom;

    if (!gatewayAuthEnabled) {
      throw Errors.GATEWAY_AUTH_DISABLED;
    }

    const remoteAddress = getRemoteAddress(this.req);
    const identity = readGatewayIdentity(this.req.headers, gatewayAuthSecret);

    if (!identity) {
      sails.log.warn(`Gateway sign-in without a trusted identity! (IP: ${remoteAddress})`);
      throw Errors.NO_GATEWAY_IDENTITY;
    }

    const user = await sails.helpers.users.getOrCreateOneWithGateway
      .with({
        identity,
        request: this.req,
      })
      .intercept('notPermitted', () => {
        sails.log.warn(`Gateway sign-in refused, no PLANKA group: ${identity.email}`);
        return Errors.NOT_PERMITTED;
      })
      .intercept('deactivated', () => {
        sails.log.warn(`Gateway sign-in refused, deactivated: ${identity.email}`);
        return Errors.USER_DEACTIVATED;
      })
      .intercept('emailAlreadyInUse', () => Errors.EMAIL_ALREADY_IN_USE)
      .intercept('usernameAlreadyInUse', () => Errors.USERNAME_ALREADY_IN_USE)
      .intercept('activeLimitReached', () => Errors.ACTIVE_USERS_LIMIT_REACHED);

    return sails.helpers.accessTokens.handleSteps
      .with({
        user,
        remoteAddress,
        request: this.req,
        response: this.res,
        withHttpOnlyToken: inputs.withHttpOnlyToken,
      })
      .intercept('adminLoginRequiredToInitializeInstance', (error) => ({
        adminLoginRequiredToInitializeInstance: error.raw,
      }))
      .intercept('termsAcceptanceRequired', (error) => ({
        termsAcceptanceRequired: error.raw,
      }))
      .intercept('totpVerificationRequired', (error) => ({
        totpVerificationRequired: error.raw,
      }));
  },
};
