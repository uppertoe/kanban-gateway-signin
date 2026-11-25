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

// Branded emails (local modification): helpers/notifications/build-email.js.
const buildAndSendEmail = async (
  transporter,
  board,
  card,
  notification,
  actorUser,
  notifiableUser,
  t,
) => {
  const email = await sails.helpers.notifications.buildEmail.with({
    board,
    card,
    notification,
    actorUser,
    notifiableUser,
    t,
  });

  if (email) {
    await sails.helpers.utils.sendEmail.with({
      ...email,
      transporter,
    });
  }

  transporter.close();
};

module.exports = {
  inputs: {
    values: {
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
    const { values } = inputs;

    if (values.comment) {
      values.commentId = values.comment.id;
    }

    if (values.action) {
      values.actionId = values.action.id;
    }

    const notification = await Notification.qm.createOne({
      ...values,
      creatorUserId: values.creatorUser.id,
      boardId: values.card.boardId,
      cardId: values.card.id,
    });

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
          ...(values.comment && {
            comments: [values.comment],
          }),
          ...(values.action && {
            actions: [values.action],
          }),
        },
      }),
      user: values.creatorUser,
    });

    const notifiableUser = await User.qm.getOneById(notification.userId, {
      withDeactivated: false,
    });

    if (notifiableUser) {
      const notificationServices = await NotificationService.qm.getByUserId(notification.userId);
      const { transporter } = await sails.helpers.utils.makeSmtpTransporter();

      if (notificationServices.length > 0 || transporter) {
        const t = sails.helpers.utils.makeTranslator(notifiableUser.language);

        if (notificationServices.length > 0) {
          const services = notificationServices.map((notificationService) =>
            _.pick(notificationService, ['url', 'format']),
          );

          buildAndSendNotifications(
            services,
            inputs.board,
            values.card,
            notification,
            values.creatorUser,
            t,
          );
        }

        if (transporter) {
          buildAndSendEmail(
            transporter,
            inputs.board,
            values.card,
            notification,
            values.creatorUser,
            notifiableUser,
            t,
          );
        }
      }
    }

    return notification;
  },
};
