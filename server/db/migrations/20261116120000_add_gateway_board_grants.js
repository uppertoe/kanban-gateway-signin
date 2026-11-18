/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Records each board place that a gateway group gave (see
// utils/gateway-board-groups.js). A place with no row here was added by hand,
// and the group sync never touches it. Rows go with their board or person.

// gateway_board_link records the project and board the sync created for each
// board marker. The sync only ever uses boards it created itself, so renaming
// one does no harm, and a project or board that someone else made is never
// taken over. A deleted board is created again in the recorded project.

module.exports.up = async (knex) => {
  await knex.schema.createTable('gateway_board_link', (table) => {
    table.bigInteger('id').primary().defaultTo(knex.raw('next_id()'));

    table.text('project_name').notNullable();
    table.text('board_name').notNullable();
    table
      .bigInteger('project_id')
      .notNullable()
      .references('id')
      .inTable('project')
      .onDelete('CASCADE');
    table.bigInteger('board_id').references('id').inTable('board').onDelete('SET NULL');

    table.timestamp('created_at', true).notNullable().defaultTo(knex.fn.now());

    table.unique(['project_name', 'board_name']);
  });

  await knex.schema.createTable('gateway_board_grant', (table) => {
    table.bigInteger('id').primary().defaultTo(knex.raw('next_id()'));

    table
      .bigInteger('board_id')
      .notNullable()
      .references('id')
      .inTable('board')
      .onDelete('CASCADE');
    table
      .bigInteger('user_id')
      .notNullable()
      .references('id')
      .inTable('user_account')
      .onDelete('CASCADE');
    table.text('group_name').notNullable();

    table.timestamp('created_at', true).notNullable().defaultTo(knex.fn.now());

    table.unique(['board_id', 'user_id', 'group_name']);
    table.index('user_id');
  });
};

module.exports.down = async (knex) => {
  await knex.schema.dropTable('gateway_board_grant');
  await knex.schema.dropTable('gateway_board_link');
};
