/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

module.exports = {
  sync: true,

  inputs: {
    internalConfig: {
      type: 'ref',
      required: true,
    },
    user: {
      type: 'ref',
    },
  },

  fn(inputs) {
    const data = {
      termsLanguages: sails.hooks.terms.getLanguages(),
      version: sails.config.custom.version,
    };

    if (inputs.user && inputs.user.role === User.Roles.ADMIN) {
      Object.assign(data, {
        activeUsersLimit: inputs.internalConfig.activeUsersLimit,
        customerPanelUrl: sails.config.custom.customerPanelUrl,
      });
    }

    if (sails.config.custom.demoMode) {
      data.isDemoMode = true;
    }

    // Gateway sign-in (local modification): tells the client to sign in from
    // the gateway identity instead of showing the password form.
    if (sails.config.custom.gatewayAuthEnabled) {
      data.gateway = {
        logoutUrl: sails.config.custom.gatewayLogoutUrl,
      };
    }

    return data;
  },
};
