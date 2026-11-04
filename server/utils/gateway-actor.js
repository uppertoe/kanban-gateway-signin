/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Recorded as the actor on webhooks and actions for accounts that the gateway
// creates or whose role it changes. Built on use: models are not yet loaded
// when Sails reads the helpers.
const getGatewayActor = () => ({
  id: '_gateway',
  role: User.Roles.ADMIN,
});

module.exports = {
  getGatewayActor,
};
