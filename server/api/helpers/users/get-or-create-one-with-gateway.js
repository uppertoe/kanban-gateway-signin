/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

const { nameFromEmail, resolveRole } = require('../../../utils/gateway-identity');

// Recorded as the actor on webhooks and actions for accounts that the gateway
// creates or whose role it changes. Built on use: models are not yet loaded
// when Sails reads the helpers.
const getGatewayActor = () => ({
  id: '_gateway',
  role: User.Roles.ADMIN,
});

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
    const { email, groups } = inputs.identity;

    // The role is set by gateway group membership on every sign-in, so
    // removing someone from the groups removes their PLANKA access at once.
    const role = resolveRole(groups, sails.config.custom.gatewayRoleGroups);
    if (!role) {
      throw 'notPermitted';
    }

    let user = await User.qm.getOneByEmail(email);

    if (!user) {
      return sails.helpers.users.createOne
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
    }

    // An account that an administrator has deactivated stays out, even while
    // its owner still holds a gateway group.
    if (user.isDeactivated) {
      throw 'deactivated';
    }

    if (user.role !== role) {
      user = await sails.helpers.users.updateOne
        .with({
          record: user,
          values: { role },
          actorUser: getGatewayActor(),
          request: inputs.request,
        })
        .intercept('emailAlreadyInUse', 'emailAlreadyInUse')
        .intercept('usernameAlreadyInUse', 'usernameAlreadyInUse')
        .intercept('activeLimitReached', 'activeLimitReached');
    }

    return user;
  },
};
