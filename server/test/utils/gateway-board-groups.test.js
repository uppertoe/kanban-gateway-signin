// Gateway sign-in (local modification of PLANKA). Unit tests for the board
// places that gateway groups give (utils/gateway-board-groups.js).

const { expect } = require('chai');

const {
  accountsToCreate,
  parseBoardMarkers,
  planChanges,
} = require('../../utils/gateway-board-groups');

describe('gateway board groups', () => {
  describe('parseBoardMarkers', () => {
    const snippet = [
      'planka.example.org {',
      '\t# scaffold-members: rch-registrars -- board "Registrars" in "Teaching" as editor',
      '\t# scaffold-members: rch-consultants, rch-fellows -- board "Registrars" in "Teaching" as commenter',
      '  #scaffold-members: team -- board "Q/A: 2026 -- plans" in "Ops / Admin" as viewer',
      '\t# scaffold-members: other -- read for a weekly email',
      '\t# an ordinary comment',
      '}',
    ].join('\n');

    it('reads one link per group and board, with the board named', () => {
      const { links } = parseBoardMarkers(snippet);

      expect(
        links.map((link) => [link.group, link.projectName, link.boardName, link.level]),
      ).to.deep.equal([
        ['rch-registrars', 'Teaching', 'Registrars', 'editor'],
        ['rch-consultants', 'Teaching', 'Registrars', 'commenter'],
        ['rch-fellows', 'Teaching', 'Registrars', 'commenter'],
        ['team', 'Ops / Admin', 'Q/A: 2026 -- plans', 'viewer'],
      ]);
      expect(links[1]).to.include({ role: 'viewer', canComment: true });
      expect(links[0]).to.include({ role: 'editor', canComment: null });
    });

    it('reports a members marker that is not a board line', () => {
      const { ignored } = parseBoardMarkers(snippet);

      expect(ignored).to.have.length(1);
      expect(ignored[0]).to.match(/^line 5: # scaffold-members: other/);
    });

    it('reads a snippet without markers as no links', () => {
      expect(parseBoardMarkers('site {\n}\n').links).to.deep.equal([]);
      expect(parseBoardMarkers('').links).to.deep.equal([]);
    });

    it('refuses a board line it cannot use', () => {
      expect(() =>
        parseBoardMarkers('# scaffold-members: regs -- board "B" in "P" as owner'),
      ).to.throw(/editor, commenter or viewer/);
      expect(() => parseBoardMarkers('# scaffold-members: -- board "B" in "P" as editor')).to.throw(
        /names no group/,
      );
      expect(() =>
        parseBoardMarkers('# scaffold-members: user -- board "B" in "P" as editor'),
      ).to.throw(/usable gateway group/);
      expect(() =>
        parseBoardMarkers('# scaffold-members: Guest -- board "B" in "P" as editor'),
      ).to.throw(/usable gateway group/);
      expect(() =>
        parseBoardMarkers('# scaffold-members: Registrars -- board "B" in "P" as editor'),
      ).to.throw(/usable gateway group/);
      expect(() =>
        parseBoardMarkers('# scaffold-members: night-shift.v2 -- board "B" in "P" as editor'),
      ).to.throw(/usable gateway group/);
      expect(() =>
        parseBoardMarkers(
          '# scaffold-members: regs -- board "B" in "P" as editor\n# scaffold-members: regs -- board "B" in "P" as viewer',
        ),
      ).to.throw(/more than once/);
    });
  });

  describe('accountsToCreate', () => {
    it('names an account for each listed address without one', () => {
      const lists = new Map([
        [
          'regs',
          { ok: true, members: ['tom.darling2@x.org', 'ann@x.org', 'Jo.Smith-Jones@x.org'] },
        ],
        ['cons', { ok: true, members: ['tom.darling2@x.org', 'not-an-address'] }],
        ['gone', { ok: false }],
      ]);
      const existing = new Map([['ann@x.org', { id: '1' }]]);

      expect(accountsToCreate(lists, existing)).to.deep.equal([
        { email: 'jo.smith-jones@x.org', name: 'Jo Smith-Jones' },
        { email: 'tom.darling2@x.org', name: 'Tom Darling' },
      ]);
    });
  });

  describe('planChanges', () => {
    const makeLink = (group, boardId, level) => {
      const roles = {
        editor: { role: 'editor', canComment: null },
        commenter: { role: 'viewer', canComment: true },
        viewer: { role: 'viewer', canComment: false },
      };
      return { group, boardId, level, projectName: 'P', boardName: `B${boardId}`, ...roles[level] };
    };

    const links = [
      makeLink('regs', '10', 'editor'),
      makeLink('cons', '10', 'viewer'),
      makeLink('regs', '20', 'commenter'),
    ];

    const users = new Map([
      ['ann@x.org', { id: '1', isDeactivated: false }],
      ['bob@x.org', { id: '2', isDeactivated: false }],
      ['cat@x.org', { id: '3', isDeactivated: false }],
      ['dee@x.org', { id: '4', isDeactivated: true }],
    ]);

    const ok = (...members) => ({ ok: true, members });

    const plan = ({
      lists,
      memberships = new Map(),
      grants = [],
      withLinks = links,
      heldBoardIds,
    }) =>
      planChanges({
        links: withLinks,
        lists,
        usersByEmail: users,
        memberships,
        grants,
        heldBoardIds,
      });

    it('adds every member who has an account, and records the grant', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok('ann@x.org', 'nobody@x.org', 'dee@x.org')],
          ['cons', ok()],
        ]),
      });

      expect(result.create).to.deep.equal([
        { boardId: '10', userId: '1', role: 'editor', canComment: null },
        { boardId: '20', userId: '1', role: 'viewer', canComment: true },
      ]);
      expect(result.addGrants).to.deep.equal([
        { boardId: '10', userId: '1', group: 'regs' },
        { boardId: '20', userId: '1', group: 'regs' },
      ]);
      expect(result.remove).to.deep.equal([]);
    });

    it('matches addresses whatever their case', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok('Ann@X.org')],
          ['cons', ok()],
        ]),
      });

      expect(result.create.map((change) => change.userId)).to.deep.equal(['1', '1']);
    });

    it('removes a place the group gave once the person leaves the group', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok('ann@x.org')],
          ['cons', ok()],
        ]),
        memberships: new Map([['10:2', { id: 'm2', role: 'editor', canComment: null }]]),
        grants: [{ boardId: '10', userId: '2', group: 'regs' }],
      });

      expect(result.remove).to.deep.equal([{ boardId: '10', userId: '2', membershipId: 'm2' }]);
      expect(result.dropGrants).to.deep.include({ boardId: '10', userId: '2', group: 'regs' });
    });

    it('never touches a place added by hand, even for someone in the group', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok('bob@x.org')],
          ['cons', ok()],
        ]),
        memberships: new Map([
          ['10:2', { id: 'm2', role: 'viewer', canComment: false }],
          ['10:3', { id: 'm3', role: 'editor', canComment: null }],
        ]),
      });

      // Bob is in regs but was added by hand as a viewer: no change and no grant.
      // Cat is in no group and was added by hand: stays.
      expect(result.update).to.deep.equal([]);
      expect(result.remove).to.deep.equal([]);
      expect(result.addGrants).to.deep.equal([{ boardId: '20', userId: '2', group: 'regs' }]);
    });

    it('gives the stronger place when two groups link the same board', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok('ann@x.org')],
          ['cons', ok('ann@x.org')],
        ]),
      });

      expect(result.create).to.deep.include({
        boardId: '10',
        userId: '1',
        role: 'editor',
        canComment: null,
      });
    });

    it('steps a place down when the stronger group is left', () => {
      const result = plan({
        // Bob keeps regs non-empty, so the empty-list hold does not apply.
        lists: new Map([
          ['regs', ok('bob@x.org')],
          ['cons', ok('ann@x.org')],
        ]),
        memberships: new Map([['10:1', { id: 'm1', role: 'editor', canComment: null }]]),
        grants: [
          { boardId: '10', userId: '1', group: 'regs' },
          { boardId: '10', userId: '1', group: 'cons' },
        ],
      });

      expect(result.update).to.deep.equal([
        { boardId: '10', userId: '1', membershipId: 'm1', role: 'viewer', canComment: false },
      ]);
      expect(result.remove).to.deep.equal([]);
      expect(result.dropGrants).to.deep.equal([{ boardId: '10', userId: '1', group: 'regs' }]);
    });

    it('puts back a group place that someone removed by hand', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok('ann@x.org')],
          ['cons', ok()],
        ]),
        grants: [{ boardId: '10', userId: '1', group: 'regs' }],
      });

      expect(result.create).to.deep.include({
        boardId: '10',
        userId: '1',
        role: 'editor',
        canComment: null,
      });
    });

    it('removes a deactivated person whom the group placed', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok('dee@x.org')],
          ['cons', ok()],
        ]),
        memberships: new Map([['10:4', { id: 'm4', role: 'editor', canComment: null }]]),
        grants: [{ boardId: '10', userId: '4', group: 'regs' }],
      });

      expect(result.remove).to.deep.equal([{ boardId: '10', userId: '4', membershipId: 'm4' }]);
    });

    it('changes nothing for a group whose read failed', () => {
      const result = plan({
        lists: new Map([
          ['regs', { ok: false }],
          ['cons', ok()],
        ]),
        memberships: new Map([['10:2', { id: 'm2', role: 'editor', canComment: null }]]),
        grants: [{ boardId: '10', userId: '2', group: 'regs' }],
      });

      expect(result).to.deep.include({
        create: [],
        update: [],
        remove: [],
        addGrants: [],
        dropGrants: [],
      });
    });

    it('holds removals when a group that has given places comes back empty', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok()],
          ['cons', ok()],
        ]),
        memberships: new Map([['10:2', { id: 'm2', role: 'editor', canComment: null }]]),
        grants: [{ boardId: '10', userId: '2', group: 'regs' }],
      });

      expect(result.remove).to.deep.equal([]);
      expect(result.dropGrants).to.deep.equal([]);
      expect(result.held.map((link) => link.group)).to.deep.equal(['regs']);
    });

    it('leaves the places alone when a link is taken out of the setting', () => {
      const result = plan({
        withLinks: [makeLink('cons', '10', 'viewer')],
        lists: new Map([['cons', ok()]]),
        memberships: new Map([['10:2', { id: 'm2', role: 'editor', canComment: null }]]),
        grants: [{ boardId: '10', userId: '2', group: 'regs' }],
      });

      expect(result.remove).to.deep.equal([]);
      expect(result.dropGrants).to.deep.equal([{ boardId: '10', userId: '2', group: 'regs' }]);
    });

    it('holds the places on a board whose marker did not resolve this run', () => {
      const result = plan({
        withLinks: [makeLink('cons', '10', 'viewer')],
        lists: new Map([
          ['cons', ok()],
          ['regs', ok()],
        ]),
        memberships: new Map([['20:2', { id: 'm2', role: 'viewer', canComment: true }]]),
        grants: [{ boardId: '20', userId: '2', group: 'regs' }],
        heldBoardIds: new Set(['20']),
      });

      expect(result).to.deep.include({
        create: [],
        update: [],
        remove: [],
        addGrants: [],
        dropGrants: [],
      });
    });

    it('changes nothing when everything is already in step', () => {
      const result = plan({
        lists: new Map([
          ['regs', ok('ann@x.org')],
          ['cons', ok()],
        ]),
        memberships: new Map([
          ['10:1', { id: 'm1', role: 'editor', canComment: null }],
          ['20:1', { id: 'm5', role: 'viewer', canComment: true }],
        ]),
        grants: [
          { boardId: '10', userId: '1', group: 'regs' },
          { boardId: '20', userId: '1', group: 'regs' },
        ],
      });

      expect(result).to.deep.include({
        create: [],
        update: [],
        remove: [],
        addGrants: [],
        dropGrants: [],
      });
    });
  });
});
