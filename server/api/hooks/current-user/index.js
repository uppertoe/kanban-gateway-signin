/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

/**
 * current-user hook
 *
 * @description :: A hook definition. Extends Sails by adding shadow routes, implicit actions,
 *                 and/or initialization logic.
 * @docs        :: https://sailsjs.com/docs/concepts/extending-sails/hooks
 */

const { readGatewayIdentity } = require('../../../utils/gateway-identity');

module.exports = function defineCurrentUserHook(sails) {
  const TOKEN_PATTERN = /^Bearer /;
  const API_KEY_HEADER_NAME = 'x-api-key';

  // Gateway sign-in (local modification): a PLANKA session counts only while
  // the gateway still vouches for the same person. If someone signs out of the
  // gateway and another person signs in on the same browser, the old PLANKA
  // session is treated as signed out and the client signs in afresh. Socket
  // requests carry no per-request headers; the socket handshake itself has
  // already passed the gateway.
  const isSessionVouchedFor = (req, user) => {
    const { gatewayAuthEnabled, gatewayAuthSecret } = sails.config.custom;

    if (!gatewayAuthEnabled || req.isSocket) {
      return true;
    }

    const identity = readGatewayIdentity(req.headers, gatewayAuthSecret);

    return !!identity && identity.email === user.email.toLowerCase();
  };

  const getSessionAndUserByAccessToken = async (accessToken, httpOnlyToken) => {
    let payload;
    try {
      payload = sails.helpers.utils.verifyJwtToken(accessToken);
    } catch (error) {
      return null;
    }

    const session = await Session.qm.getOneUndeletedByAccessToken(accessToken);

    if (!session) {
      return null;
    }

    if (session.httpOnlyToken && httpOnlyToken !== session.httpOnlyToken) {
      return null;
    }

    const user = await User.qm.getOneById(payload.subject, {
      withDeactivated: false,
    });

    if (!user) {
      return null;
    }

    if (user.passwordChangedAt > payload.issuedAt) {
      return null;
    }

    return {
      session,
      user,
    };
  };

  const getUserByApiKey = (apiKey) => {
    const apiKeyHash = sails.helpers.utils.hash(apiKey);

    return User.qm.getOneActiveByApiKeyHash(apiKeyHash);
  };

  return {
    /**
     * Runs when this Sails app loads/lifts.
     */

    async initialize() {
      sails.log.info('Initializing custom hook (`current-user`)');
    },

    routes: {
      before: {
        '/api/*': {
          async fn(req, res, next) {
            const { authorization: authorizationHeader, [API_KEY_HEADER_NAME]: apiKey } =
              req.headers;

            if (authorizationHeader && TOKEN_PATTERN.test(authorizationHeader)) {
              const accessToken = authorizationHeader.replace(TOKEN_PATTERN, '');
              const { internalAccessToken } = sails.config.custom;

              if (internalAccessToken && accessToken === internalAccessToken) {
                req.currentUser = User.INTERNAL;
              } else {
                const { httpOnlyToken } = req.cookies;

                const sessionAndUser = await getSessionAndUserByAccessToken(
                  accessToken,
                  httpOnlyToken,
                );

                if (sessionAndUser && isSessionVouchedFor(req, sessionAndUser.user)) {
                  const { session, user } = sessionAndUser;

                  if (user.language) {
                    req.setLocale(user.language);
                  }

                  Object.assign(req, {
                    currentSession: session,
                    currentUser: user,
                  });

                  if (req.isSocket) {
                    sails.sockets.join(req, `@accessToken:${session.accessToken}`);
                    sails.sockets.join(req, `@user:${user.id}`);
                  }
                }
              }
            } else if (apiKey) {
              const user = await getUserByApiKey(apiKey);

              if (user) {
                if (user.language) {
                  req.setLocale(user.language);
                }

                req.currentUser = user;

                if (req.isSocket) {
                  sails.sockets.join(req, `@user:${user.id}`);
                }
              }
            }

            return next();
          },
        },
        '/attachments/*': {
          async fn(req, res, next) {
            const { accessToken, httpOnlyToken } = req.cookies;

            if (accessToken) {
              const sessionAndUser = await getSessionAndUserByAccessToken(
                accessToken,
                httpOnlyToken,
              );

              if (sessionAndUser && isSessionVouchedFor(req, sessionAndUser.user)) {
                const { session, user } = sessionAndUser;

                Object.assign(req, {
                  currentSession: session,
                  currentUser: user,
                });
              }
            } else {
              const { [API_KEY_HEADER_NAME]: apiKey } = req.headers;

              if (apiKey) {
                const user = await getUserByApiKey(apiKey);

                if (user) {
                  req.currentUser = user;
                }
              }
            }

            return next();
          },
        },
      },
    },
  };
};
