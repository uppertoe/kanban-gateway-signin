/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

const escapeMarkdown = require('escape-markdown');
const escapeHtml = require('escape-html');

const { mentionMarkupToText } = require('../../../utils/mentions');

const buildTitle = (notification, t) => {
  switch (notification.type) {
    case Notification.Types.MOVE_CARD:
      return t('Card Moved');
    case Notification.Types.COMMENT_CARD:
      return t('New Comment');
    case Notification.Types.ADD_MEMBER_TO_CARD:
      return t('You Were Added to Card');
    case Notification.Types.MENTION_IN_COMMENT:
      return t('You Were Mentioned in Comment');
    default:
      return null;
  }
};

const buildBodyByFormat = (board, card, notification, actorUser, t) => {
  const markdownCardLink = `[${escapeMarkdown(card.name)}](${sails.config.custom.baseUrl}/cards/${card.id})`;
  const htmlCardLink = `<a href="${sails.config.custom.baseUrl}/cards/${card.id}">${escapeHtml(card.name)}</a>`;

  switch (notification.type) {
    case Notification.Types.MOVE_CARD: {
      const fromListName = sails.helpers.lists.resolveName(notification.data.fromList, t);
      const toListName = sails.helpers.lists.resolveName(notification.data.toList, t);

      return {
        text: t(
          '%s moved %s from %s to %s on %s',
          actorUser.name,
          card.name,
          fromListName,
          toListName,
          board.name,
        ),
        markdown: t(
          '%s moved %s from %s to %s on %s',
          escapeMarkdown(actorUser.name),
          markdownCardLink,
          `**${escapeMarkdown(fromListName)}**`,
          `**${escapeMarkdown(toListName)}**`,
          escapeMarkdown(board.name),
        ),
        html: t(
          '%s moved %s from %s to %s on %s',
          escapeHtml(actorUser.name),
          htmlCardLink,
          `<b>${escapeHtml(fromListName)}</b>`,
          `<b>${escapeHtml(toListName)}</b>`,
          escapeHtml(board.name),
        ),
      };
    }
    case Notification.Types.COMMENT_CARD: {
      const commentText = _.truncate(mentionMarkupToText(notification.data.text));

      return {
        text: `${t(
          '%s left a new comment to %s on %s',
          actorUser.name,
          card.name,
          board.name,
        )}:\n${commentText}`,
        markdown: `${t(
          '%s left a new comment to %s on %s',
          escapeMarkdown(actorUser.name),
          markdownCardLink,
          escapeMarkdown(board.name),
        )}:\n\n*${escapeMarkdown(commentText)}*`,
        html: `${t(
          '%s left a new comment to %s on %s',
          escapeHtml(actorUser.name),
          htmlCardLink,
          escapeHtml(board.name),
        )}:\n\n<i>${escapeHtml(commentText)}</i>`,
      };
    }
    case Notification.Types.ADD_MEMBER_TO_CARD:
      return {
        text: t('%s added you to %s on %s', actorUser.name, card.name, board.name),
        markdown: t(
          '%s added you to %s on %s',
          escapeMarkdown(actorUser.name),
          markdownCardLink,
          escapeMarkdown(board.name),
        ),
        html: t(
          '%s added you to %s on %s',
          escapeHtml(actorUser.name),
          htmlCardLink,
          escapeHtml(board.name),
        ),
      };
    case Notification.Types.MENTION_IN_COMMENT: {
      const commentText = _.truncate(mentionMarkupToText(notification.data.text));

      return {
        text: `${t(
          '%s mentioned you in %s on %s',
          actorUser.name,
          card.name,
          board.name,
        )}:\n${commentText}`,
        markdown: `${t(
          '%s mentioned you in %s on %s',
          escapeMarkdown(actorUser.name),
          markdownCardLink,
          escapeMarkdown(board.name),
        )}:\n\n*${escapeMarkdown(commentText)}*`,
        html: `${t(
          '%s mentioned you in %s on %s',
          escapeHtml(actorUser.name),
          htmlCardLink,
          escapeHtml(board.name),
        )}:\n\n<i>${escapeHtml(commentText)}</i>`,
      };
    }
    default:
      return null;
  }
};

const buildAndSendNotifications = async (services, board, card, notification, actorUser, t) => {
  await sails.helpers.utils.sendNotifications(
    services,
    buildTitle(notification, t),
    buildBodyByFormat(board, card, notification, actorUser, t),
  );
};

const sendEmails = async (transporter, emails) => {
  await Promise.all(
    emails.map((email) =>
      sails.helpers.utils.sendEmail.with({
        ...email,
        transporter,
      }),
    ),
  );

  transporter.close();
};

module.exports = {
  inputs: {
    arrayOfValues: {
      type: 'ref',
      required: true,
    },
    project: {
      type: 'ref',
      required: true,
    },
    board: {
      type: 'ref',
      required: true,
    },
    list: {
      type: 'ref',
      required: true,
    },
    webhooks: {
      type: 'ref',
      required: true,
    },
  },

  async fn(inputs) {
    const { arrayOfValues } = inputs;

    const ids = await sails.helpers.utils.generateIds(arrayOfValues.length);
    const valuesById = {};

    const notifications = await Notification.qm.create(
      arrayOfValues.map((values) => {
        const id = ids.shift();

        const nextValues = {
          ...values,
          id,
          creatorUserId: values.creatorUser.id,
          boardId: values.card.boardId,
          cardId: values.card.id,
        };
        if (values.comment) {
          nextValues.commentId = values.comment.id;
        }
        if (values.action) {
          nextValues.actionId = values.action.id;
        }

        valuesById[id] = { ...nextValues }; // FIXME: hack
        return nextValues;
      }),
    );

    notifications.forEach((notification) => {
      const values = valuesById[notification.id];

      sails.sockets.broadcast(`user:${notification.userId}`, 'notificationCreate', {
        item: notification,
        included: {
          users: [sails.helpers.users.presentOne(values.creatorUser, {})], // FIXME: hack
        },
      });

      sails.helpers.utils.sendWebhooks.with({
        webhooks: inputs.webhooks,
        event: Webhook.Events.NOTIFICATION_CREATE,
        buildData: () => ({
          item: notification,
          included: {
            projects: [inputs.project],
            boards: [inputs.board],
            lists: [inputs.list],
            cards: [values.card],
            ...(notification.commentId
              ? {
                  comments: [values.comment],
                }
              : {
                  actions: [values.action],
                }),
          },
        }),
        user: values.creatorUser,
      });
    });

    const notificationsByUserId = _.groupBy(notifications, 'userId');

    const notifiableUsers = await User.qm.getByIds(Object.keys(notificationsByUserId), {
      withDeactivated: false,
    });

    if (notifiableUsers.length > 0) {
      const notifiableUserIds = sails.helpers.utils.mapRecords(notifiableUsers);

      const notificationServices = await NotificationService.qm.getByUserIds(notifiableUserIds);
      const { transporter } = await sails.helpers.utils.makeSmtpTransporter();

      if (notificationServices.length > 0 || transporter) {
        const notificationServicesByUserId = _.groupBy(notificationServices, 'userId');

        notifiableUsers.forEach(async (notifiableUser) => {
          const t = sails.helpers.utils.makeTranslator(notifiableUser.language);

          const userNotifications = notificationsByUserId[notifiableUser.id];

          if (notificationServicesByUserId[notifiableUser.id]) {
            const services = notificationServicesByUserId[notifiableUser.id].map(
              (notificationService) => _.pick(notificationService, ['url', 'format']),
            );

            userNotifications.forEach((notification) => {
              const values = valuesById[notification.id];

              buildAndSendNotifications(
                services,
                inputs.board,
                values.card,
                notification,
                values.creatorUser,
                t,
              );
            });
          }

          // Branded emails (local modification): helpers/notifications/build-email.js.
          const emails = [];

          if (transporter) {
            // eslint-disable-next-line no-restricted-syntax
            for (const notification of userNotifications) {
              const values = valuesById[notification.id];

              // eslint-disable-next-line no-await-in-loop
              const email = await sails.helpers.notifications.buildEmail.with({
                board: inputs.board,
                card: values.card,
                notification,
                actorUser: values.creatorUser,
                notifiableUser,
                t,
              });

              if (email) {
                emails.push(email);
              }
            }
          }

          if (emails.length > 0) {
            sendEmails(transporter, emails);
          }
        });
      }
    }

    return notifications;
  },
};
