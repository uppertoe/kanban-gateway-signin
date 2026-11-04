// Gateway sign-in (local modification of PLANKA). Unit tests for the header reader.

const { expect } = require('chai');
const {
  parseList,
  readGatewayIdentity,
  resolveRole,
  resolveVouchedRole,
  nameFromEmail,
} = require('../../utils/gateway-identity');

const SECRET = 'a'.repeat(40);

const headers = (overrides = {}) => ({
  'x-gateway-secret': SECRET,
  'remote-email': 'Jane.Citizen@Example.org',
  'remote-groups': 'planka-users, cms-editors',
  ...overrides,
});

describe('gateway-identity', () => {
  describe('readGatewayIdentity', () => {
    it('returns the lower-cased email and the groups when the secret matches', () => {
      expect(readGatewayIdentity(headers(), SECRET)).to.deep.equal({
        email: 'jane.citizen@example.org',
        groups: ['planka-users', 'cms-editors'],
      });
    });

    it('refuses a request without the secret', () => {
      const h = headers();
      delete h['x-gateway-secret'];
      expect(readGatewayIdentity(h, SECRET)).to.equal(null);
    });

    it('refuses a wrong secret of the same length', () => {
      expect(readGatewayIdentity(headers({ 'x-gateway-secret': 'b'.repeat(40) }), SECRET)).to.equal(
        null,
      );
    });

    it('refuses a wrong secret of a different length', () => {
      expect(readGatewayIdentity(headers({ 'x-gateway-secret': 'short' }), SECRET)).to.equal(null);
    });

    it('refuses everything when no secret is configured', () => {
      expect(readGatewayIdentity(headers({ 'x-gateway-secret': '' }), '')).to.equal(null);
      expect(readGatewayIdentity(headers(), undefined)).to.equal(null);
    });

    it('refuses a missing or malformed email', () => {
      const h = headers();
      delete h['remote-email'];
      expect(readGatewayIdentity(h, SECRET)).to.equal(null);
      expect(readGatewayIdentity(headers({ 'remote-email': 'not-an-email' }), SECRET)).to.equal(
        null,
      );
      expect(
        readGatewayIdentity(headers({ 'remote-email': 'a@example.org, b@example.org' }), SECRET),
      ).to.equal(null);
    });

    it('refuses a break-glass identity', () => {
      expect(
        readGatewayIdentity(headers({ 'remote-email': 'breakglass:ward-4' }), SECRET),
      ).to.equal(null);
      expect(
        readGatewayIdentity(headers({ 'remote-email': 'breakglass:x@example.org' }), SECRET),
      ).to.equal(null);
    });

    it('refuses a header that arrives as an array', () => {
      expect(
        readGatewayIdentity(
          headers({ 'remote-email': ['a@example.org', 'b@example.org'] }),
          SECRET,
        ),
      ).to.equal(null);
    });

    it('accepts an empty group list', () => {
      const h = headers();
      delete h['remote-groups'];
      expect(readGatewayIdentity(h, SECRET).groups).to.deep.equal([]);
    });
  });

  describe('resolveRole', () => {
    const roleGroups = {
      admin: ['planka-admins'],
      projectOwner: ['planka-owners'],
      boardUser: ['planka-users'],
    };

    it('picks the highest role the groups grant', () => {
      expect(resolveRole(['planka-users', 'planka-admins'], roleGroups)).to.equal('admin');
      expect(resolveRole(['planka-owners', 'planka-users'], roleGroups)).to.equal('projectOwner');
      expect(resolveRole(['planka-users'], roleGroups)).to.equal('boardUser');
    });

    it('returns null when no group grants a role', () => {
      expect(resolveRole(['cms-editors'], roleGroups)).to.equal(null);
      expect(resolveRole([], roleGroups)).to.equal(null);
    });

    it('tolerates a role with no groups configured', () => {
      expect(resolveRole(['planka-users'], { boardUser: ['planka-users'] })).to.equal('boardUser');
    });
  });

  describe('resolveVouchedRole', () => {
    const roleGroups = {
      admin: ['planka-admins'],
      projectOwner: ['planka-owners'],
      boardUser: ['planka-users'],
    };
    const identity = (groups, email = 'jane@example.org') => ({ email, groups });

    it('returns the role the gateway now implies for the same person', () => {
      expect(
        resolveVouchedRole(identity(['planka-users']), 'Jane@Example.org', roleGroups),
      ).to.equal('boardUser');
    });

    it('returns null for a different person', () => {
      expect(
        resolveVouchedRole(
          identity(['planka-admins'], 'other@example.org'),
          'jane@example.org',
          roleGroups,
        ),
      ).to.equal(null);
    });

    it('returns null when the person has lost every PLANKA group', () => {
      expect(
        resolveVouchedRole(identity(['cms-editors']), 'jane@example.org', roleGroups),
      ).to.equal(null);
    });

    it('returns null without a trusted identity', () => {
      expect(resolveVouchedRole(null, 'jane@example.org', roleGroups)).to.equal(null);
    });
  });

  describe('parseList', () => {
    it('splits on commas and whitespace', () => {
      expect(parseList('a, b  c,,d')).to.deep.equal(['a', 'b', 'c', 'd']);
      expect(parseList(undefined)).to.deep.equal([]);
    });
  });

  describe('nameFromEmail', () => {
    it('builds a display name from the local part', () => {
      expect(nameFromEmail('jane.citizen@example.org')).to.equal('Jane Citizen');
      expect(nameFromEmail('j_smith-jones@example.org')).to.equal('J Smith Jones');
      expect(nameFromEmail('upperteam@example.org')).to.equal('Upperteam');
    });
  });
});
