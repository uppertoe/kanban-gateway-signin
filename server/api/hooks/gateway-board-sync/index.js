/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

/**
 * gateway-board-sync hook
 *
 * @description :: Keeps the boards linked in GATEWAY_BOARDS_FILE in step with
 *                 their gateway groups (see utils/gateway-board-groups.js).
 *                 Runs shortly after start-up, then every
 *                 GATEWAY_BOARD_SYNC_INTERVAL seconds, and a few seconds after
 *                 the gateway creates an account, so that a new person finds
 *                 their boards waiting.
 */

const { accountsToCreate, boardKey, planChanges } = require('../../../utils/gateway-board-groups');
const { getGatewayActor } = require('../../../utils/gateway-actor');

const FETCH_TIMEOUT_MS = 10 * 1000;
const FIRST_RUN_DELAY_MS = 15 * 1000;
const SOON_DELAY_MS = 3 * 1000;
const MAX_MEMBERS = 5000;

module.exports = function defineGatewayBoardSyncHook(sails) {
  let running = false;
  let again = false;
  let soonTimer = null;

  const config = () => sails.config.custom.gatewayBoardSync;

  // Reads one group from the gateway members endpoint. Any doubt about the
  // answer counts as a failed read, which leaves that group's places alone.
  const readGroup = async (group) => {
    const { membersUrl, membersToken } = config();

    try {
      const response = await fetch(`${membersUrl}/v1/groups/${encodeURIComponent(group)}/members`, {
        headers: { authorization: `Bearer ${membersToken}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status !== 200) {
        sails.log.warn(`Gateway board sync: reading ${group} returned ${response.status}`);
        return { ok: false };
      }

      const body = await response.json();
      if (
        !body ||
        String(body.group).toLowerCase() !== group ||
        !Array.isArray(body.members) ||
        body.members.length > MAX_MEMBERS ||
        !body.members.every((email) => typeof email === 'string' && email.includes('@'))
      ) {
        sails.log.warn(`Gateway board sync: the answer for ${group} was not a member list`);
        return { ok: false };
      }

      return { ok: true, members: body.members.map((email) => email.toLowerCase()) };
    } catch (error) {
      sails.log.warn(`Gateway board sync: reading ${group} failed: ${error.message}`);
      return { ok: false };
    }
  };

  const getGrants = async () => {
    const result = await sails.sendNativeQuery(
      'SELECT board_id, user_id, group_name FROM gateway_board_grant',
    );

    return result.rows.map((row) => ({
      boardId: String(row.board_id),
      userId: String(row.user_id),
      group: row.group_name,
    }));
  };

  const addGrant = ({ boardId, userId, group }) =>
    sails.sendNativeQuery(
      'INSERT INTO gateway_board_grant (board_id, user_id, group_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [boardId, userId, group],
    );

  const dropGrant = ({ boardId, userId, group }) =>
    sails.sendNativeQuery(
      'DELETE FROM gateway_board_grant WHERE board_id = $1 AND user_id = $2 AND group_name = $3',
      [boardId, userId, group],
    );

  // Creates an account, named from the address, for each group member who has
  // none, so that they can be put on cards before they first sign in. The
  // account starts as a Board User; the person's groups set the role at their
  // first sign-in, where they are matched by email.
  const createAccounts = async (lists, usersByEmail, users) => {
    /* eslint-disable no-restricted-syntax, no-await-in-loop */
    for (const { email, name } of accountsToCreate(lists, usersByEmail)) {
      try {
        const user = await sails.helpers.users.createOne.with({
          values: { email, name, role: User.Roles.BOARD_USER },
          actorUser: getGatewayActor(),
        });
        usersByEmail.set(email, user);
        users.push(user);
        sails.log.info(`Gateway board sync: created an account for ${email} (${name})`);
      } catch (error) {
        if (error === 'activeLimitReached') {
          sails.log.error(
            'Gateway board sync: the active user limit is reached, so no more accounts were created',
          );
          return;
        }
        if (error !== 'emailAlreadyInUse' && error !== 'usernameAlreadyInUse') {
          throw error;
        }
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */
  };

  // The owner of projects and boards that the sync creates: PLANKA makes the
  // creator a project manager and a member of the board, so this must be a
  // real account. The longest-standing active administrator is used.
  const getOwner = async () => {
    const [owner] = await User.find({ role: User.Roles.ADMIN, isDeactivated: false })
      .sort('id')
      .limit(1);
    return owner || null;
  };

  const getRecordedLinks = async () => {
    const result = await sails.sendNativeQuery(
      'SELECT project_name, board_name, project_id, board_id FROM gateway_board_link',
    );
    return new Map(
      result.rows.map((row) => [
        boardKey(row.project_name, row.board_name),
        {
          projectId: String(row.project_id),
          boardId: row.board_id === null ? null : String(row.board_id),
        },
      ]),
    );
  };

  const recordLink = (projectName, boardName, projectId, boardId) =>
    sails.sendNativeQuery(
      'INSERT INTO gateway_board_link (project_name, board_name, project_id, board_id) VALUES ($1, $2, $3, $4) ON CONFLICT (project_name, board_name) DO UPDATE SET project_id = EXCLUDED.project_id, board_id = EXCLUDED.board_id',
      [projectName, boardName, projectId, boardId],
    );

  // Creates a shared project owned by the given administrator and records it
  // for its marker in one transaction, so that a run cut short can never
  // leave a project the sync made but did not record. Then tells the
  // administrators' open pages and the webhooks, as PLANKA's own helper does.
  const createRecordedProject = async (projectName, boardName, owner) => {
    const project = await sails.getDatastore().transaction(async (db) => {
      const created = await Project.create({ type: Project.Types.SHARED, name: projectName })
        .fetch()
        .usingConnection(db);
      await ProjectManager.create({ projectId: created.id, userId: owner.id })
        .fetch()
        .usingConnection(db);
      await sails
        .sendNativeQuery(
          'INSERT INTO gateway_board_link (project_name, board_name, project_id, board_id) VALUES ($1, $2, $3, NULL) ON CONFLICT (project_name, board_name) DO UPDATE SET project_id = EXCLUDED.project_id, board_id = NULL',
          [projectName, boardName, created.id],
        )
        .usingConnection(db);
      return created;
    });

    const scoper = sails.helpers.projects.makeScoper.with({ record: project });
    scoper.projectManagerUserIds = [owner.id];
    const userIds = await scoper.getUserIdsWithFullProjectVisibility();
    userIds.forEach((userId) => {
      sails.sockets.broadcast(`user:${userId}`, 'projectCreate', { item: project });
    });

    const webhooks = await Webhook.qm.getAll();
    sails.helpers.utils.sendWebhooks.with({
      webhooks,
      event: Webhook.Events.PROJECT_CREATE,
      buildData: () => ({ item: project }),
      user: owner,
    });

    return project;
  };

  const createBoard = async (project, boardName, owner) => {
    const projectBoards = await Board.find({ projectId: project.id });
    const position = projectBoards.reduce((max, item) => Math.max(max, item.position), 0) + 65536;
    const { board } = await sails.helpers.boards.createOne.with({
      values: { name: boardName, position, project },
      actorUser: owner,
    });
    return board;
  };

  // Finds each linked board. The sync only ever uses a project and board it
  // created itself and recorded in gateway_board_link: a recorded board is
  // used whatever it is now called, and a recorded project whose board has
  // been deleted gets a new board. For a marker with no record, the sync
  // creates the project (shared) and the board, unless a project of that name
  // already exists; someone else's project is never taken over, so that
  // marker waits, with an error logged, until the project is renamed.
  const resolveBoards = async (configuredLinks, lists) => {
    const boards = new Map();
    const projects = new Map();
    const boardIdByKey = new Map();
    const recorded = await getRecordedLinks();
    let owner;
    const getOwnerOnce = async () => {
      owner = owner === undefined ? await getOwner() : owner;
      return owner;
    };

    const wanted = new Map();
    // A marker whose groups could not be read this run (not yet approved on
    // the gateway, for example) creates nothing; a board it already has is
    // still used.
    const readable = new Set();
    configuredLinks.forEach((link) => {
      const key = boardKey(link.projectName, link.boardName);
      wanted.set(key, link);
      const list = lists.get(link.group);
      if (list && list.ok) {
        readable.add(key);
      }
    });

    /* eslint-disable no-restricted-syntax, no-await-in-loop */
    for (const [key, { projectName, boardName }] of wanted) {
      const where = `"${boardName}" in "${projectName}"`;
      const record = recorded.get(key);
      let project = record ? await Project.qm.getOneById(record.projectId) : null;
      let board = record && record.boardId ? await Board.qm.getOneById(record.boardId) : null;

      if (board && (!project || String(board.projectId) !== String(project.id))) {
        project = await Project.qm.getOneById(board.projectId);
      }

      if (!board && readable.has(key)) {
        if (!project) {
          const namedProjects = await Project.find({ name: projectName });
          if (namedProjects.length > 0) {
            sails.log.error(
              `Gateway board sync: a project called "${projectName}" already exists that the sync did not create, so ${where} was not created; rename that project to let the sync create its own`,
            );
          } else if (!(await getOwnerOnce())) {
            sails.log.error(
              `Gateway board sync: there is no active administrator to own a new project, so ${where} was not created`,
            );
          } else {
            project = await createRecordedProject(projectName, boardName, owner);
            sails.log.info(`Gateway board sync: created the project "${projectName}"`);
          }
        }

        if (project) {
          if (!(await getOwnerOnce())) {
            sails.log.error(
              `Gateway board sync: there is no active administrator to own a new board, so ${where} was not created`,
            );
          } else {
            board = await createBoard(project, boardName, owner);
            sails.log.info(`Gateway board sync: created the board ${where}`);
          }
          await recordLink(
            projectName,
            boardName,
            String(project.id),
            board ? String(board.id) : null,
          );
        }
      }

      if (board && project) {
        projects.set(String(project.id), project);
        boards.set(String(board.id), board);
        boardIdByKey.set(key, String(board.id));
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    const links = configuredLinks
      .filter((link) => boardIdByKey.has(boardKey(link.projectName, link.boardName)))
      .map((link) => ({
        ...link,
        boardId: boardIdByKey.get(boardKey(link.projectName, link.boardName)),
      }));

    // Boards recorded for a marker that is still present but did not resolve.
    const heldBoardIds = new Set();
    wanted.forEach((link, key) => {
      const record = recorded.get(key);
      if (!boardIdByKey.has(key) && record && record.boardId) {
        heldBoardIds.add(record.boardId);
      }
    });

    return { boards, projects, links, heldBoardIds };
  };

  const syncOnce = async () => {
    const { links: configuredLinks } = config();

    const lists = new Map();
    // One read at a time keeps well inside the gateway's per-app rate limit.
    // eslint-disable-next-line no-restricted-syntax
    for (const group of new Set(configuredLinks.map((link) => link.group))) {
      // eslint-disable-next-line no-await-in-loop
      lists.set(group, await readGroup(group));
    }

    const emails = [
      ...new Set([...lists.values()].flatMap((list) => (list.ok ? list.members : []))),
    ];
    const users = emails.length > 0 ? await User.find({ email: emails }) : [];
    const usersByEmail = new Map(users.map((user) => [user.email.toLowerCase(), user]));

    await createAccounts(lists, usersByEmail, users);

    const { boards, projects, links, heldBoardIds } = await resolveBoards(configuredLinks, lists);

    const boardMemberships =
      boards.size > 0 ? await BoardMembership.qm.getByBoardIds([...boards.keys()]) : [];
    const memberships = new Map(
      boardMemberships.map((membership) => [
        `${membership.boardId}:${membership.userId}`,
        membership,
      ]),
    );

    const grants = await getGrants();

    const plan = planChanges({
      links,
      lists,
      usersByEmail,
      memberships,
      grants,
      heldBoardIds,
    });

    plan.held.forEach((link) => {
      sails.log.warn(
        `Gateway board sync: ${link.group} came back empty, so nobody was removed from "${link.boardName}" in "${link.projectName}"`,
      );
    });

    const actorUser = getGatewayActor();
    const userCache = new Map(users.map((user) => [String(user.id), user]));
    const getUser = async (userId) => {
      if (!userCache.has(userId)) {
        userCache.set(userId, await User.qm.getOneById(userId));
      }
      return userCache.get(userId);
    };

    // Places that turned out to have been added by hand meanwhile: no grant.
    const skipped = new Set();

    /* eslint-disable no-restricted-syntax, no-await-in-loop */
    for (const change of plan.create) {
      const board = boards.get(change.boardId);
      const user = await getUser(change.userId);
      try {
        await sails.helpers.boardMemberships.createOne.with({
          values: {
            board,
            user,
            role: change.role,
            ...(change.role === 'viewer' && { canComment: change.canComment }),
          },
          project: projects.get(String(board.projectId)),
          actorUser,
        });
        sails.log.info(
          `Gateway board sync: added ${user.email} to board ${change.boardId} (${change.role})`,
        );
      } catch (error) {
        if (error !== 'userAlreadyBoardMember') {
          throw error;
        }
        skipped.add(`${change.boardId}:${change.userId}`);
      }
    }

    for (const change of plan.update) {
      const board = boards.get(change.boardId);
      const user = await getUser(change.userId);
      const record = memberships.get(`${change.boardId}:${change.userId}`);
      await sails.helpers.boardMemberships.updateOne.with({
        record,
        values: {
          role: change.role,
          ...(change.role === 'viewer' && { canComment: change.canComment }),
        },
        project: projects.get(String(board.projectId)),
        board,
        actorUser,
      });
      sails.log.info(
        `Gateway board sync: changed ${user.email} on board ${change.boardId} to ${change.role}`,
      );
    }

    for (const grant of plan.addGrants) {
      if (!skipped.has(`${grant.boardId}:${grant.userId}`)) {
        await addGrant(grant);
      }
    }

    for (const change of plan.remove) {
      const board = boards.get(change.boardId);
      const user = await getUser(change.userId);
      const record = memberships.get(`${change.boardId}:${change.userId}`);
      if (board && user && record) {
        await sails.helpers.boardMemberships.deleteOne.with({
          record,
          user,
          project: projects.get(String(board.projectId)),
          board,
          actorUser,
        });
        sails.log.info(`Gateway board sync: removed ${user.email} from board ${change.boardId}`);
      }
    }

    for (const grant of plan.dropGrants) {
      await dropGrant(grant);
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */
  };

  const run = async () => {
    if (running) {
      again = true;
      return;
    }

    running = true;
    try {
      do {
        again = false;
        // eslint-disable-next-line no-await-in-loop
        await syncOnce();
      } while (again);
    } catch (error) {
      sails.log.error(`Gateway board sync failed: ${error.stack || error}`);
    } finally {
      running = false;
    }
  };

  return {
    /**
     * Asks for a run a few seconds from now; calls close together share one.
     */
    requestSync() {
      if (!config() || soonTimer) {
        return;
      }

      soonTimer = setTimeout(() => {
        soonTimer = null;
        run();
      }, SOON_DELAY_MS);
    },

    /**
     * Runs when this Sails app loads/lifts.
     */
    async initialize() {
      const { gatewayBoardSyncError } = sails.config.custom;
      if (gatewayBoardSyncError) {
        sails.log.error(
          `Gateway board sync is off, because its settings cannot be used: ${gatewayBoardSyncError}`,
        );
      }

      if (!config()) {
        return;
      }

      sails.log.info(
        `Initializing custom hook (\`gateway-board-sync\`): ${config().links.length} linked board group(s)`,
      );
      config().ignored.forEach((line) => {
        sails.log.warn(
          `Gateway board sync: a members marker that is not a board line was ignored, ${line}`,
        );
      });

      sails.on('lifted', () => {
        setTimeout(run, FIRST_RUN_DELAY_MS);
        setInterval(run, config().intervalMs);
      });
    },
  };
};
