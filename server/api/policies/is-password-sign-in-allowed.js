/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// With gateway sign-in the gateway owns identity: PLANKA neither accepts a
// password nor lets an account change the email address it is matched by.
module.exports = async function isPasswordSignInAllowed(req, res, proceed) {
  if (sails.config.custom.gatewayAuthEnabled) {
    return res.notFound();
  }

  return proceed();
};
