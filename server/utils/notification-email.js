/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Branded notification emails (local modification of PLANKA). Builds the
// subject, an HTML part and a plain-text part for one notification, with the
// deployment's name, accent colour and logo from EMAIL_* settings. Pure, so
// it can be tested without Sails; the notification helpers call it.

const escapeHtml = require('escape-html');

const { mentionMarkupToText } = require('./mentions');

const Types = {
  MOVE_CARD: 'moveCard',
  COMMENT_CARD: 'commentCard',
  ADD_MEMBER_TO_CARD: 'addMemberToCard',
  MENTION_IN_COMMENT: 'mentionInComment',
};

// Why the recipient was sent the email, which decides the footer.
const Reasons = {
  CARD_SUBSCRIPTION: 'cardSubscription',
  BOARD_SUBSCRIPTION: 'boardSubscription',
  MENTION: 'mention',
  CARD_MEMBER: 'cardMember',
};

const DEFAULT_BRAND_NAME = 'PLANKA';
const DEFAULT_ACCENT_COLOR = '#22548a';

const HEX_COLOR_REGEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Settings come from the environment, so anything malformed falls back to the
// default rather than reaching an inline style or an <img> unchecked.
const normalizeBranding = (branding = {}) => {
  const name = (branding.name || '').trim() || DEFAULT_BRAND_NAME;
  const accentColor = HEX_COLOR_REGEX.test(branding.accentColor || '')
    ? branding.accentColor
    : DEFAULT_ACCENT_COLOR;

  let logoUrl = null;
  if (branding.logoUrl) {
    try {
      const url = new URL(branding.logoUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        logoUrl = url.href;
      }
    } catch (error) {
      logoUrl = null;
    }
  }

  const subjectPrefix = (branding.subjectPrefix || '').trim();

  return { name, accentColor, logoUrl, subjectPrefix };
};

const reasonFor = (type, isCardSubscriber) => {
  switch (type) {
    case Types.MENTION_IN_COMMENT:
      return Reasons.MENTION;
    case Types.ADD_MEMBER_TO_CARD:
      return Reasons.CARD_MEMBER;
    default:
      return isCardSubscriber ? Reasons.CARD_SUBSCRIPTION : Reasons.BOARD_SUBSCRIPTION;
  }
};

const displayName = (user) => (user && (user.name || user.username || user.email)) || 'Someone';

// Each part is built twice, once as escaped HTML and once as plain text, from
// the same pieces: { text } for words and { link, text } for a link.
const renderPieces = (pieces, format) =>
  pieces
    .map((piece) => {
      if (format === 'text') {
        return piece.text;
      }
      if (piece.link) {
        return `<a href="${escapeHtml(piece.link)}" style="color: inherit; font-weight: 600;">${escapeHtml(piece.text)}</a>`;
      }
      return escapeHtml(piece.text);
    })
    .join('');

const buildParts = ({
  type,
  data,
  actorName,
  card,
  board,
  cardUrl,
  boardUrl,
  fromListName,
  toListName,
}) => {
  const actor = { text: actorName };
  const cardPiece = { text: card.name, link: cardUrl };
  const boardPiece = { text: board.name, link: boardUrl };
  const onBoard = [{ text: ' on the ' }, boardPiece, { text: ' board' }];

  switch (type) {
    case Types.COMMENT_CARD:
      return {
        subject: `${actorName} commented on ${card.name}`,
        lead: [actor, { text: ' commented on ' }, cardPiece, ...onBoard, { text: ':' }],
        quote: mentionMarkupToText((data && data.text) || ''),
      };
    case Types.MENTION_IN_COMMENT:
      return {
        subject: `${actorName} mentioned you on ${card.name}`,
        lead: [
          actor,
          { text: ' mentioned you in a comment on ' },
          cardPiece,
          ...onBoard,
          { text: ':' },
        ],
        quote: mentionMarkupToText((data && data.text) || ''),
      };
    case Types.ADD_MEMBER_TO_CARD:
      return {
        subject: `${actorName} added you to ${card.name}`,
        lead: [actor, { text: ' added you to ' }, cardPiece, ...onBoard, { text: '.' }],
        quote: null,
      };
    case Types.MOVE_CARD:
      return {
        subject: `${actorName} moved ${card.name} to ${toListName}`,
        lead: [
          actor,
          { text: ' moved ' },
          cardPiece,
          { text: ` from ${fromListName} to ${toListName}` },
          ...onBoard,
          { text: '.' },
        ],
        quote: null,
      };
    default:
      return null;
  }
};

const buildFooter = (reason, brandName, board) => {
  switch (reason) {
    case Reasons.CARD_SUBSCRIPTION:
      return [
        {
          text: `You received this email because you are subscribed to this card in ${brandName}. You can unsubscribe from the card itself.`,
        },
      ];
    case Reasons.BOARD_SUBSCRIPTION:
      return [
        { text: 'You received this email because you are subscribed to the ' },
        { text: board.name },
        { text: ` board in ${brandName}.` },
      ];
    case Reasons.MENTION:
      return [{ text: 'You received this email because you were mentioned in a comment.' }];
    case Reasons.CARD_MEMBER:
      return [{ text: 'You received this email because you were added to this card.' }];
    default:
      return [];
  }
};

const renderHtml = ({ branding, lead, quote, cardUrl, footer }) => {
  const header = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.name)}" height="32" style="display: block; height: 32px; width: auto; border: 0;">`
    : `<span style="font-size: 18px; font-weight: 700; color: ${branding.accentColor};">${escapeHtml(branding.name)}</span>`;

  const quoteHtml = quote
    ? `<tr><td style="padding: 0 32px 20px;"><div style="border-left: 3px solid ${branding.accentColor}; padding: 8px 0 8px 14px; color: #333333; white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(quote)}</div></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin: 0; padding: 0; background-color: #f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f5f7;">
<tr><td align="center" style="padding: 24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; background-color: #ffffff; border-radius: 6px; border-top: 4px solid ${branding.accentColor}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #172b4d;">
<tr><td style="padding: 24px 32px 16px;">${header}</td></tr>
<tr><td style="padding: 0 32px 16px;">${renderPieces(lead, 'html')}</td></tr>
${quoteHtml}
<tr><td style="padding: 4px 32px 28px;"><a href="${escapeHtml(cardUrl)}" style="display: inline-block; background-color: ${branding.accentColor}; color: #ffffff; text-decoration: none; font-weight: 600; padding: 10px 22px; border-radius: 6px;">Open the card</a></td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.5; color: #6b778c;">
<tr><td style="padding: 16px 32px 0;">${renderPieces(footer, 'html')}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
};

const renderText = ({ lead, quote, cardUrl, footer }) => {
  const lines = [renderPieces(lead, 'text'), ''];
  if (quote) {
    quote.split('\n').forEach((line) => lines.push(line ? `> ${line}` : '>'));
    lines.push('');
  }
  lines.push(`Open the card: ${cardUrl}`, '', '--', renderPieces(footer, 'text'), '');
  return lines.join('\n');
};

/**
 * Returns { subject, html, text, references } for one notification, or null
 * for a type that is not emailed.
 *
 * `references` is the same for every email about one card, so mail clients
 * that thread on it keep a card's emails together.
 */
const buildNotificationEmail = ({
  type,
  data,
  card,
  board,
  actorUser,
  isCardSubscriber = false,
  fromListName = '',
  toListName = '',
  baseUrl,
  branding,
}) => {
  const brand = normalizeBranding(branding);
  const root = (baseUrl || '').replace(/\/+$/, '');
  const cardUrl = `${root}/cards/${card.id}`;
  const boardUrl = `${root}/boards/${board.id}`;

  const parts = buildParts({
    type,
    data,
    actorName: displayName(actorUser),
    card,
    board,
    cardUrl,
    boardUrl,
    fromListName,
    toListName,
  });
  if (!parts) {
    return null;
  }

  const footer = buildFooter(reasonFor(type, isCardSubscriber), brand.name, board);

  let host = 'planka';
  try {
    host = new URL(root).hostname || host;
  } catch (error) {
    // An unreadable BASE_URL still gives a stable thread id.
  }

  return {
    subject: brand.subjectPrefix ? `${brand.subjectPrefix} ${parts.subject}` : parts.subject,
    html: renderHtml({
      branding: brand,
      lead: parts.lead,
      quote: parts.quote,
      cardUrl,
      footer,
    }),
    text: renderText({ lead: parts.lead, quote: parts.quote, cardUrl, footer }),
    references: `<card-${card.id}@${host}>`,
  };
};

module.exports = {
  Types,
  Reasons,
  DEFAULT_BRAND_NAME,
  DEFAULT_ACCENT_COLOR,
  normalizeBranding,
  buildNotificationEmail,
};
