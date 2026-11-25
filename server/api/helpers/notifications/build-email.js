/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Branded notification emails (local modification of PLANKA). Gathers what
// utils/notification-email.js needs for one notification and returns the
// options for sendEmail, or null for a type that is not emailed.

const { buildNotificationEmail } = require('../../../utils/notification-email');

module.exports = {
  inputs: {
    board: {
      type: 'ref',
      required: true,
    },
    card: {
      type: 'ref',
      required: true,
    },
    notification: {
      type: 'ref',
      required: true,
    },
    actorUser: {
      type: 'ref',
      required: true,
    },
    notifiableUser: {
      type: 'ref',
      required: true,
    },
    t: {
      type: 'ref',
      required: true,
    },
  },

  async fn(inputs) {
    const { board, card, notification, actorUser, notifiableUser, t } = inputs;

    let fromListName = '';
    let toListName = '';
    if (notification.type === Notification.Types.MOVE_CARD) {
      fromListName = sails.helpers.lists.resolveName(notification.data.fromList, t);
      toListName = sails.helpers.lists.resolveName(notification.data.toList, t);
    }

    const isCardSubscriber = await sails.helpers.users.isCardSubscriber(notifiableUser.id, card.id);

    const email = buildNotificationEmail({
      type: notification.type,
      data: notification.data,
      card,
      board,
      actorUser,
      isCardSubscriber,
      fromListName,
      toListName,
      baseUrl: sails.config.custom.baseUrl,
      branding: sails.config.custom.emailBranding,
    });

    if (!email) {
      return null;
    }

    return {
      ...email,
      to: notifiableUser.email,
    };
  },
};
