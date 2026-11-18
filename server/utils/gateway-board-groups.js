/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Board places given by gateway groups. Each linked board is declared once, as
// a members marker in the server's Caddy snippet for PLANKA, which the
// container reads from GATEWAY_BOARDS_FILE:
//
//   # scaffold-members: rch-registrars -- board "Registrars" in "Teaching" as editor
//
// The scaffold reads the same line to let PLANKA read that group from the
// gateway. The gateway-board-sync hook then reads each linked group's members
// and keeps PLANKA in step:
//
//   - a member of the group without a PLANKA account gets one, named from the
//     address, so that they can be put on cards before they first sign in;
//   - the project and board are created if they do not exist;
//   - a member of the group gets a place on the board;
//   - a place the group gave is taken away once the person leaves the group;
//   - a place someone added by hand is never touched, even on a linked board.
//
// Each place a group gave is recorded in gateway_board_grant (one row per
// board, person and group), which is how a group's places are told apart from
// those added by hand.
//
// Kept free of Sails globals so that it can be unit-tested on its own.

const { nameFromEmail } = require('./gateway-identity');

const ROLES = {
  editor: { role: 'editor', canComment: null },
  commenter: { role: 'viewer', canComment: true },
  viewer: { role: 'viewer', canComment: false },
};

// Strongest first: a person whom two linked groups place on one board gets
// the stronger of the two places.
const STRENGTH = ['editor', 'commenter', 'viewer'];

// The scaffold's rule for group names, which the gateway also accepts.
const GROUP_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// Gateway group names that are base roles, never real groups.
const RESERVED_GROUPS = ['admin', 'user', 'guest'];

const MIN_TOKEN_LENGTH = 32;

const MARKER_PATTERN = /^\s*#\s*scaffold-members:\s*(.*)$/;
const BOARD_PATTERN = /^board\s+"([^"]+)"\s+in\s+"([^"]+)"\s+as\s+(\S+)\s*$/;

const EMAIL_PATTERN = /^[^\s@:,]+@[^\s@:,]+\.[^\s@:,]+$/;

const boardKey = (projectName, boardName) => `${projectName}\u0000${boardName}`;

/**
 * Reads the board links from the members markers in a Caddy snippet. A marker
 * whose text after " -- " is not a board line is reported in ignored, since
 * PLANKA reads groups for nothing else.
 *
 * @param {string} text The snippet.
 * @returns {{ links: object[], ignored: string[] }} One link per group and board:
 *   { group, projectName, boardName, level, role, canComment }.
 */
const parseBoardMarkers = (text) => {
  const links = [];
  const ignored = [];
  const seen = new Set();

  (text || '').split(/\r?\n/).forEach((line, index) => {
    const marker = line.match(MARKER_PATTERN);
    if (!marker) {
      return;
    }

    const where = `line ${index + 1}`;
    const parts = marker[1].match(/^(.*?)(?:^|\s+)--\s+(.*)$/);
    const groupsText = parts ? parts[1] : marker[1];
    const why = parts ? parts[2].trim() : '';

    const board = why.match(BOARD_PATTERN);
    if (!board) {
      ignored.push(`${where}: ${line.trim()}`);
      return;
    }

    const [, boardName, projectName, level] = board;
    if (!ROLES[level]) {
      throw new Error(
        `Board marker on ${where} has role "${level}"; use editor, commenter or viewer`,
      );
    }

    const groups = groupsText
      .split(/[\s,]+/)
      .map((group) => group.trim())
      .filter(Boolean);
    if (groups.length === 0) {
      throw new Error(`Board marker on ${where} names no group`);
    }

    groups.forEach((group) => {
      if (RESERVED_GROUPS.includes(group.toLowerCase()) || !GROUP_PATTERN.test(group)) {
        throw new Error(`Board marker on ${where} does not name a usable gateway group: ${group}`);
      }

      const key = `${boardKey(projectName, boardName)}|${group}`;
      if (seen.has(key)) {
        throw new Error(
          `Board markers link ${group} to "${boardName}" in "${projectName}" more than once`,
        );
      }
      seen.add(key);

      links.push({ group, projectName, boardName, level, ...ROLES[level] });
    });
  });

  return { links, ignored };
};

/**
 * The accounts to create before a run: every address in a group that was read
 * which has no PLANKA account yet, named from the address.
 *
 * @param {Map<string, {ok: boolean, members?: string[]}>} lists
 * @param {Map<string, object>} usersByEmail PLANKA accounts by lower-cased email.
 * @returns {{ email: string, name: string }[]}
 */
const accountsToCreate = (lists, usersByEmail) => {
  const emails = new Set();

  lists.forEach((list) => {
    if (list.ok) {
      list.members.forEach((email) => {
        const address = String(email).toLowerCase();
        if (EMAIL_PATTERN.test(address) && !usersByEmail.has(address)) {
          emails.add(address);
        }
      });
    }
  });

  return [...emails].sort().map((email) => ({ email, name: nameFromEmail(email) }));
};

const strongest = (levels) => STRENGTH.find((level) => levels.includes(level));

const pairKey = (boardId, userId) => `${boardId}:${userId}`;

/**
 * Works out what one sync run changes. Pure: the hook gathers the inputs and
 * applies the result.
 *
 * @param {object} inputs
 * @param {object[]} inputs.links parseBoardMarkers links, each with the boardId it
 *   resolved to.
 * @param {Map<string, {ok: boolean, members?: string[]}>} inputs.lists
 *   Each linked group's members as the gateway gave them; ok is false when the
 *   read failed, and that group's places are then left exactly as they are.
 * @param {Map<string, {id: string, isDeactivated: boolean}>} inputs.usersByEmail
 *   PLANKA accounts, keyed by lower-cased email.
 * @param {Map<string, {id: string, role: string, canComment: (boolean|null)}>} inputs.memberships
 *   Current places on the linked boards, keyed by "<board id>:<user id>".
 * @param {{boardId: string, userId: string, group: string}[]} inputs.grants
 *   Every gateway_board_grant row.
 * @param {Set<string>} [inputs.heldBoardIds] Boards whose marker is still
 *   present but did not resolve this run. Their grants are kept exactly as
 *   they are, so that a board that cannot be found for a while never turns
 *   its group places into places added by hand.
 */
const planChanges = ({
  links,
  lists,
  usersByEmail,
  memberships,
  grants,
  heldBoardIds = new Set(),
}) => {
  const plan = {
    create: [],
    update: [],
    remove: [],
    addGrants: [],
    dropGrants: [],
    held: [],
  };

  const linkByKey = new Map(links.map((link) => [`${link.boardId}|${link.group}`, link]));

  // Grants for a link that is no longer configured: forget them, and leave the
  // place itself alone, so it becomes an ordinary place managed by hand.
  const liveGrants = [];
  grants.forEach((grant) => {
    if (heldBoardIds.has(grant.boardId)) {
      return;
    }
    if (linkByKey.has(`${grant.boardId}|${grant.group}`)) {
      liveGrants.push(grant);
    } else {
      plan.dropGrants.push(grant);
    }
  });

  const grantsByPair = new Map();
  liveGrants.forEach((grant) => {
    const key = pairKey(grant.boardId, grant.userId);
    if (!grantsByPair.has(key)) {
      grantsByPair.set(key, { boardId: grant.boardId, userId: grant.userId, groups: new Set() });
    }
    grantsByPair.get(key).groups.add(grant.group);
  });

  // Who each link admits now. A failed read admits nobody new and removes
  // nobody. An empty list where the group has given places is held too: an
  // empty answer is far more likely a fault than a whole group leaving.
  const eligibleByLink = new Map();
  const settledLinks = new Set();

  links.forEach((link) => {
    const key = `${link.boardId}|${link.group}`;
    const list = lists.get(link.group);

    if (!list || !list.ok) {
      return;
    }

    const members = list.members || [];
    const hasGrants = liveGrants.some(
      (grant) => grant.boardId === link.boardId && grant.group === link.group,
    );

    if (members.length === 0 && hasGrants) {
      plan.held.push(link);
      return;
    }

    const eligible = new Set();
    members.forEach((email) => {
      const user = usersByEmail.get(String(email).toLowerCase());
      if (user && !user.isDeactivated) {
        eligible.add(user.id);
      }
    });

    eligibleByLink.set(key, eligible);
    settledLinks.add(key);
  });

  // Every pair that a link or a grant touches.
  const pairs = new Map(grantsByPair);
  links.forEach((link) => {
    const eligible = eligibleByLink.get(`${link.boardId}|${link.group}`);
    if (!eligible) {
      return;
    }
    eligible.forEach((userId) => {
      const key = pairKey(link.boardId, userId);
      if (!pairs.has(key)) {
        pairs.set(key, { boardId: link.boardId, userId, groups: new Set() });
      }
    });
  });

  pairs.forEach(({ boardId, userId, groups: grantedBefore }, key) => {
    const membership = memberships.get(key);

    // A place added by hand: never managed, whatever the groups say.
    if (membership && grantedBefore.size === 0) {
      return;
    }

    const grantedAfter = new Set();
    links
      .filter((link) => link.boardId === boardId)
      .forEach((link) => {
        const linkKey = `${boardId}|${link.group}`;
        if (settledLinks.has(linkKey)) {
          if (eligibleByLink.get(linkKey).has(userId)) {
            grantedAfter.add(link.group);
          }
        } else if (grantedBefore.has(link.group)) {
          // Unknown this run (read failed or held): keep what was there.
          grantedAfter.add(link.group);
        }
      });

    grantedBefore.forEach((group) => {
      if (!grantedAfter.has(group)) {
        plan.dropGrants.push({ boardId, userId, group });
      }
    });
    grantedAfter.forEach((group) => {
      if (!grantedBefore.has(group)) {
        plan.addGrants.push({ boardId, userId, group });
      }
    });

    if (grantedAfter.size === 0) {
      if (membership) {
        plan.remove.push({ boardId, userId, membershipId: membership.id });
      }
      return;
    }

    const level = strongest(
      [...grantedAfter].map((group) => linkByKey.get(`${boardId}|${group}`).level),
    );
    const { role, canComment } = ROLES[level];

    if (!membership) {
      plan.create.push({ boardId, userId, role, canComment });
    } else if (
      membership.role !== role ||
      (role === 'viewer' && Boolean(membership.canComment) !== canComment)
    ) {
      plan.update.push({ boardId, userId, membershipId: membership.id, role, canComment });
    }
  });

  return plan;
};

module.exports = {
  MIN_TOKEN_LENGTH,
  ROLES,
  accountsToCreate,
  boardKey,
  parseBoardMarkers,
  planChanges,
};
