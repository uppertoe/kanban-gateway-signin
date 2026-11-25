/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

module.exports = {
  inputs: {
    transporter: {
      type: 'ref',
      required: true,
    },
    to: {
      type: 'string',
      required: true,
    },
    subject: {
      type: 'string',
      required: true,
    },
    html: {
      type: 'string',
      required: true,
    },
    // Branded emails (local modification): a plain-text part, and a thread id
    // shared by every email about one card.
    text: {
      type: 'string',
    },
    references: {
      type: 'string',
    },
  },

  async fn(inputs) {
    try {
      const { transporter, ...message } = inputs;
      const info = await transporter.sendMail(message);

      sails.log.info(`Email sent: ${info.messageId}`);
    } catch (error) {
      sails.log.error(`Error sending email: ${error}`);
    }
  },
};
