// Branded notification emails (local modification of PLANKA). Unit tests for
// utils/notification-email.js.

const { expect } = require('chai');

const {
  Types,
  DEFAULT_BRAND_NAME,
  DEFAULT_ACCENT_COLOR,
  normalizeBranding,
  buildNotificationEmail,
} = require('../../utils/notification-email');

const base = {
  card: { id: '101', name: 'Airway audit' },
  board: { id: '202', name: 'Registrars' },
  actorUser: { name: 'Jane Smith' },
  baseUrl: 'https://planka.example.org/',
  branding: { name: 'Example Anaesthesia', accentColor: '#1e4468' },
};

const build = (overrides) => buildNotificationEmail({ ...base, ...overrides });

describe('notification email', () => {
  describe('subjects and opening lines', () => {
    it('names the card for a comment and quotes the comment', () => {
      const email = build({
        type: Types.COMMENT_CARD,
        data: { text: 'Looks good, @[Sam Lee](55) can you check?' },
        isCardSubscriber: true,
      });

      expect(email.subject).to.equal('Jane Smith commented on Airway audit');
      expect(email.text).to.contain(
        'Jane Smith commented on Airway audit on the Registrars board:',
      );
      expect(email.text).to.contain('> Looks good, @Sam Lee can you check?');
      expect(email.html).to.contain('Looks good, @Sam Lee can you check?');
    });

    it('says when the reader was mentioned', () => {
      const email = build({ type: Types.MENTION_IN_COMMENT, data: { text: 'Hi' } });

      expect(email.subject).to.equal('Jane Smith mentioned you on Airway audit');
      expect(email.text).to.contain(
        'Jane Smith mentioned you in a comment on Airway audit on the Registrars board:',
      );
    });

    it('says when the reader was added to a card', () => {
      const email = build({ type: Types.ADD_MEMBER_TO_CARD, data: {} });

      expect(email.subject).to.equal('Jane Smith added you to Airway audit');
      expect(email.text).to.contain(
        'Jane Smith added you to Airway audit on the Registrars board.',
      );
    });

    it('names both lists for a move', () => {
      const email = build({
        type: Types.MOVE_CARD,
        data: {},
        fromListName: 'To do',
        toListName: 'Done',
        isCardSubscriber: true,
      });

      expect(email.subject).to.equal('Jane Smith moved Airway audit to Done');
      expect(email.text).to.contain(
        'Jane Smith moved Airway audit from To do to Done on the Registrars board.',
      );
    });

    it('returns null for a type that is not emailed', () => {
      expect(build({ type: 'somethingElse', data: {} })).to.equal(null);
    });
  });

  describe('footers', () => {
    it('names the brand for a card subscriber', () => {
      const email = build({
        type: Types.COMMENT_CARD,
        data: { text: 'x' },
        isCardSubscriber: true,
      });

      expect(email.text).to.contain(
        'You received this email because you are subscribed to this card in Example Anaesthesia. You can unsubscribe from the card itself.',
      );
    });

    it('names the board for a board subscriber', () => {
      const email = build({
        type: Types.COMMENT_CARD,
        data: { text: 'x' },
        isCardSubscriber: false,
      });

      expect(email.text).to.contain(
        'You received this email because you are subscribed to the Registrars board in Example Anaesthesia.',
      );
    });

    it('explains a mention and an added member', () => {
      expect(build({ type: Types.MENTION_IN_COMMENT, data: { text: 'x' } }).text).to.contain(
        'You received this email because you were mentioned in a comment.',
      );
      expect(build({ type: Types.ADD_MEMBER_TO_CARD, data: {} }).text).to.contain(
        'You received this email because you were added to this card.',
      );
    });
  });

  describe('links, threading and escaping', () => {
    it('links the card and board from the base URL', () => {
      const email = build({ type: Types.ADD_MEMBER_TO_CARD, data: {} });

      expect(email.text).to.contain('Open the card: https://planka.example.org/cards/101');
      expect(email.html).to.contain('href="https://planka.example.org/cards/101"');
      expect(email.html).to.contain('href="https://planka.example.org/boards/202"');
    });

    it('gives every email about one card the same thread id', () => {
      const comment = build({ type: Types.COMMENT_CARD, data: { text: 'x' } });
      const move = build({ type: Types.MOVE_CARD, data: {}, toListName: 'Done' });

      expect(comment.references).to.equal('<card-101@planka.example.org>');
      expect(move.references).to.equal(comment.references);
    });

    it('escapes names and comment text in the HTML part', () => {
      const email = build({
        type: Types.COMMENT_CARD,
        data: { text: '<script>alert(1)</script>' },
        card: { id: '1', name: '<b>Card</b>' },
        actorUser: { name: 'A & B' },
      });

      expect(email.html).not.to.contain('<script>');
      expect(email.html).not.to.contain('<b>Card</b>');
      expect(email.html).to.contain('&lt;script&gt;');
      expect(email.html).to.contain('A &amp; B');
    });
  });

  describe('branding', () => {
    it('uses the brand colour and name, or the logo when one is set', () => {
      const plain = build({ type: Types.ADD_MEMBER_TO_CARD, data: {} });
      expect(plain.html).to.contain('#1e4468');
      expect(plain.html).to.contain('Example Anaesthesia');

      const withLogo = build({
        type: Types.ADD_MEMBER_TO_CARD,
        data: {},
        branding: { ...base.branding, logoUrl: 'https://example.org/logo.png' },
      });
      expect(withLogo.html).to.contain('<img src="https://example.org/logo.png"');
    });

    it('adds a subject prefix only when one is set', () => {
      const email = build({
        type: Types.ADD_MEMBER_TO_CARD,
        data: {},
        branding: { ...base.branding, subjectPrefix: '[Boards]' },
      });

      expect(email.subject).to.equal('[Boards] Jane Smith added you to Airway audit');
    });

    it('falls back to the defaults for missing or malformed settings', () => {
      expect(normalizeBranding({})).to.deep.equal({
        name: DEFAULT_BRAND_NAME,
        accentColor: DEFAULT_ACCENT_COLOR,
        logoUrl: null,
        subjectPrefix: '',
      });
      expect(
        normalizeBranding({
          accentColor: 'red; background: url(x)',
          logoUrl: 'data:text/html,hello',
        }),
      ).to.include({ accentColor: DEFAULT_ACCENT_COLOR, logoUrl: null });
    });
  });
});
