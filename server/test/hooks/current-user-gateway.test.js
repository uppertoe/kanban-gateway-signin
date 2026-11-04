// Gateway sign-in (local modification of PLANKA). Unit tests for the
// per-request identity and role check in the current-user hook. The hook runs
// against a stand-in for Sails and the models, so no database is needed.

const { expect } = require('chai');

const defineCurrentUserHook = require('../../api/hooks/current-user');

const SECRET = 'a'.repeat(40);
const ACCESS_TOKEN = 'token-1';

const ROLE_GROUPS = {
  admin: ['planka-admins'],
  projectOwner: ['planka-owners'],
  boardUser: ['planka-users'],
};

const gatewayHeaders = (groups, email = 'jane@example.org') => ({
  'x-gateway-secret': SECRET,
  'remote-email': email,
  'remote-groups': groups,
});

describe('current-user hook (gateway)', () => {
  let savedUser;
  let savedSession;
  let storedUser;
  let roleWrites;
  let joinedRooms;
  let custom;

  const fakeSails = {
    config: {},
    log: { info() {}, warn() {}, error() {} },
    helpers: {
      utils: {
        verifyJwtToken: () => ({ subject: storedUser.id, issuedAt: new Date(0) }),
      },
      users: {
        applyGatewayRole: {
          with: async ({ record, role }) => {
            roleWrites.push(role);
            storedUser = { ...record, role };
            return storedUser;
          },
        },
      },
    },
    sockets: {
      join: (req, room) => joinedRooms.push(room),
    },
  };

  const apiHook = defineCurrentUserHook(fakeSails).routes.before['/api/*'].fn;
  const attachmentsHook = defineCurrentUserHook(fakeSails).routes.before['/attachments/*'].fn;

  const httpRequest = (headers) => ({
    headers: { authorization: `Bearer ${ACCESS_TOKEN}`, ...headers },
    cookies: {},
    setLocale() {},
  });

  const socketRequest = (handshakeHeaders, requestHeaders = {}) => ({
    isSocket: true,
    headers: { authorization: `Bearer ${ACCESS_TOKEN}`, ...requestHeaders },
    cookies: {},
    socket: { handshake: { headers: handshakeHeaders } },
    setLocale() {},
  });

  const run = async (hook, req) => {
    await hook(req, {}, () => {});
    return req.currentUser;
  };

  before(() => {
    savedUser = global.User;
    savedSession = global.Session;

    global.User = {
      INTERNAL: { id: '_internal' },
      qm: { getOneById: async (id) => (storedUser.id === id ? storedUser : null) },
    };
    global.Session = {
      qm: {
        getOneUndeletedByAccessToken: async (token) =>
          token === ACCESS_TOKEN ? { accessToken: token } : null,
      },
    };
  });

  after(() => {
    global.User = savedUser;
    global.Session = savedSession;
  });

  beforeEach(() => {
    storedUser = { id: '1', email: 'jane@example.org', role: 'admin' };
    roleWrites = [];
    joinedRooms = [];
    custom = {
      gatewayAuthEnabled: true,
      gatewayAuthSecret: SECRET,
      gatewayRoleGroups: ROLE_GROUPS,
    };
    fakeSails.config.custom = custom;
  });

  describe('HTTP requests', () => {
    it('accepts the session without a write when the role is unchanged', async () => {
      const user = await run(apiHook, httpRequest(gatewayHeaders('planka-admins')));

      expect(user.role).to.equal('admin');
      expect(roleWrites).to.deep.equal([]);
    });

    it('demotes the user before handling the request', async () => {
      const user = await run(apiHook, httpRequest(gatewayHeaders('planka-users')));

      expect(user.role).to.equal('boardUser');
      expect(roleWrites).to.deep.equal(['boardUser']);
    });

    it('promotes the user before handling the request', async () => {
      storedUser.role = 'boardUser';
      const user = await run(apiHook, httpRequest(gatewayHeaders('planka-owners planka-users')));

      expect(user.role).to.equal('projectOwner');
      expect(roleWrites).to.deep.equal(['projectOwner']);
    });

    it('refuses the session when the gateway vouches for someone else', async () => {
      const user = await run(
        apiHook,
        httpRequest(gatewayHeaders('planka-admins', 'other@example.org')),
      );

      expect(user).to.equal(undefined);
      expect(roleWrites).to.deep.equal([]);
    });

    it('refuses the session when the user has lost every PLANKA group', async () => {
      const user = await run(apiHook, httpRequest(gatewayHeaders('cms-editors')));

      expect(user).to.equal(undefined);
      expect(roleWrites).to.deep.equal([]);
    });

    it('refuses the session without gateway headers, as before', async () => {
      expect(await run(apiHook, httpRequest({}))).to.equal(undefined);
    });

    it('applies the same check to attachment requests', async () => {
      const req = {
        headers: gatewayHeaders('planka-users'),
        cookies: { accessToken: ACCESS_TOKEN },
      };
      const user = await run(attachmentsHook, req);

      expect(user.role).to.equal('boardUser');
      expect(roleWrites).to.deep.equal(['boardUser']);
    });

    it('leaves the internal access token alone', async () => {
      custom.internalAccessToken = ACCESS_TOKEN;
      const user = await run(apiHook, httpRequest({}));

      expect(user).to.equal(global.User.INTERNAL);
    });

    it('changes nothing when gateway sign-in is off', async () => {
      custom.gatewayAuthEnabled = false;
      const user = await run(apiHook, httpRequest(gatewayHeaders('planka-users')));

      expect(user.role).to.equal('admin');
      expect(roleWrites).to.deep.equal([]);
    });
  });

  describe('socket requests', () => {
    it('accepts the session when the handshake matches the account', async () => {
      const user = await run(apiHook, socketRequest(gatewayHeaders('planka-admins')));

      expect(user.role).to.equal('admin');
      expect(joinedRooms).to.include('@user:1');
    });

    it('refuses a stale connection instead of writing its role back', async () => {
      // The account was demoted by a newer HTTP request; this socket connected earlier.
      storedUser.role = 'boardUser';
      const user = await run(apiHook, socketRequest(gatewayHeaders('planka-admins')));

      expect(user).to.equal(undefined);
      expect(roleWrites).to.deep.equal([]);
      expect(joinedRooms).to.deep.equal([]);
    });

    it('refuses a connection that the gateway made for someone else', async () => {
      const user = await run(
        apiHook,
        socketRequest(gatewayHeaders('planka-admins', 'other@example.org')),
      );

      expect(user).to.equal(undefined);
    });

    it('ignores gateway headers that the client puts on the socket request', async () => {
      // A client cannot promote itself by sending its own Remote-Groups.
      storedUser.role = 'boardUser';
      const user = await run(
        apiHook,
        socketRequest(gatewayHeaders('planka-users'), gatewayHeaders('planka-admins')),
      );

      expect(user.role).to.equal('boardUser');
      expect(roleWrites).to.deep.equal([]);
    });

    it('keeps the current behaviour when the handshake has no gateway headers', async () => {
      const user = await run(apiHook, socketRequest({}));

      expect(user.role).to.equal('admin');
    });
  });
});
