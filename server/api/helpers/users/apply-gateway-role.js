/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Gives an existing account the role that its gateway groups imply. Sign-in
// (getOrCreateOneWithGateway) and the per-request check in the current-user
// hook both call this, so the role is written the same way in both places.
// The role itself comes from resolveRole in utils/gateway-identity.

const { getGatewayActor } = require('../../../utils/gateway-actor');

module.exports = {
  inputs: {
    record: {
      type: 'ref',
      required: true,
    },
    role: {
      type: 'string',
      required: true,
    },
    request: {
      type: 'ref',
    },
  },

  exits: {
    emailAlreadyInUse: {},
    usernameAlreadyInUse: {},
    activeLimitReached: {},
  },

  async fn(inputs) {
    const { record, role } = inputs;

    if (record.role === role) {
      return record;
    }

    sails.log.info(`Gateway role change for ${record.email}: ${record.role} -> ${role}`);

    return sails.helpers.users.updateOne
      .with({
        record,
        values: { role },
        actorUser: getGatewayActor(),
        request: inputs.request,
      })
      .intercept('emailAlreadyInUse', 'emailAlreadyInUse')
      .intercept('usernameAlreadyInUse', 'usernameAlreadyInUse')
      .intercept('activeLimitReached', 'activeLimitReached');
  },
};
