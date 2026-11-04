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

const { readGatewayIdentity, resolveVouchedRole } = require('../../../utils/gateway-identity');

module.exports = function defineCurrentUserHook(sails) {
  const TOKEN_PATTERN = /^Bearer /;
  const API_KEY_HEADER_NAME = 'x-api-key';

  // Gateway sign-in (local modification): a PLANKA session counts only while
  // the gateway still vouches for the same person, and the person's role
  // follows their gateway groups on every request rather than only at sign-in.
  // Returns the user to treat as signed in, or null to treat the request as
  // signed out (the client then signs in afresh).
  const applyGatewayIdentity = async (req, user) => {
    const { gatewayAuthEnabled, gatewayAuthSecret, gatewayRoleGroups } = sails.config.custom;

    if (!gatewayAuthEnabled) {
      return user;
    }

    if (req.isSocket) {
      // The headers of a socket request come from the client, so only the
      // handshake headers can be trusted: they passed through the gateway when
      // the socket connected. They describe the gateway at that moment, so a
      // role that no longer matches the account means the connection is stale.
      // Writing that role back could undo a newer change, so the request is
      // refused instead and the client signs in again on a new connection.
      const { handshake } = req.socket || {};
      const identity = readGatewayIdentity(handshake && handshake.headers, gatewayAuthSecret);

      if (!identity) {
        return user;
      }

      return resolveVouchedRole(identity, user.email, gatewayRoleGroups) === user.role
        ? user
        : null;
    }

    const identity = readGatewayIdentity(req.headers, gatewayAuthSecret);
    const role = resolveVouchedRole(identity, user.email, gatewayRoleGroups);

    if (!role) {
      return null;
    }

    if (role === user.role) {
      return user;
    }

    try {
      return await sails.helpers.users.applyGatewayRole.with({
        record: user,
        role,
        request: req,
      });
    } catch (error) {
      sails.log.error(`Gateway role change failed for ${user.email}: ${error}`);
      return null;
    }
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

                const user =
                  sessionAndUser && (await applyGatewayIdentity(req, sessionAndUser.user));

                if (user) {
                  const { session } = sessionAndUser;

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

              const user = sessionAndUser && (await applyGatewayIdentity(req, sessionAndUser.user));

              if (user) {
                const { session } = sessionAndUser;

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
