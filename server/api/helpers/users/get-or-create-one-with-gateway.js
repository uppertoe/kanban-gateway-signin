/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

const { getGatewayActor } = require('../../../utils/gateway-actor');
const { nameFromEmail, resolveIdentityRole } = require('../../../utils/gateway-identity');

module.exports = {
  inputs: {
    identity: {
      type: 'ref',
      required: true,
    },
    request: {
      type: 'ref',
    },
  },

  exits: {
    notPermitted: {},
    deactivated: {},
    emailAlreadyInUse: {},
    usernameAlreadyInUse: {},
    activeLimitReached: {},
  },

  async fn(inputs) {
    const { email } = inputs.identity;

    // The role is set by the gateway's app roles or group membership at every
    // sign-in, and the current-user hook keeps it in step on later requests.
    const role = resolveIdentityRole(inputs.identity, sails.config.custom.gatewayRoleGroups);
    if (!role) {
      throw 'notPermitted';
    }

    const user = await User.qm.getOneByEmail(email);

    if (!user) {
      const created = await sails.helpers.users.createOne
        .with({
          values: {
            email,
            role,
            name: nameFromEmail(email),
          },
          actorUser: getGatewayActor(),
          request: inputs.request,
        })
        .intercept('emailAlreadyInUse', 'emailAlreadyInUse')
        .intercept('usernameAlreadyInUse', 'usernameAlreadyInUse')
        .intercept('activeLimitReached', 'activeLimitReached');

      // A new person's boards from their gateway groups (gateway-board-sync).
      const boardSync = sails.hooks && sails.hooks['gateway-board-sync'];
      if (boardSync) {
        boardSync.requestSync();
      }

      return created;
    }

    // An account that an administrator has deactivated stays out, even while
    // its owner still holds a gateway group.
    if (user.isDeactivated) {
      throw 'deactivated';
    }

    return sails.helpers.users.applyGatewayRole
      .with({
        record: user,
        role,
        request: inputs.request,
      })
      .intercept('emailAlreadyInUse', 'emailAlreadyInUse')
      .intercept('usernameAlreadyInUse', 'usernameAlreadyInUse')
      .intercept('activeLimitReached', 'activeLimitReached');
  },
};
