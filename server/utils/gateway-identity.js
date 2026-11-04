/*!
 * Gateway sign-in (local modification of PLANKA, not part of the upstream project).
 * Copyright (c) 2024 PLANKA Software GmbH; modifications (c) 2026 Eamonn Upperton.
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Reads the identity that an authenticating reverse proxy (the "gateway")
// attaches to every request it has let through. The headers are trusted only
// when the request also carries the shared secret that the proxy injects, so a
// client that reaches PLANKA by some other route cannot assert an identity.
//
// Kept free of Sails globals so that it can be unit-tested on its own.

const crypto = require('crypto');

const SECRET_HEADER = 'x-gateway-secret';
const EMAIL_HEADER = 'remote-email';
const GROUPS_HEADER = 'remote-groups';

const MIN_SECRET_LENGTH = 32;

const ROLE_ORDER = ['admin', 'projectOwner', 'boardUser'];

const parseList = (value) =>
  (value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const readHeader = (headers, name) => {
  const value = headers[name];

  // Node joins repeated headers with ", "; an array only appears for a few
  // special headers, but refuse it rather than guess which copy is genuine.
  return typeof value === 'string' ? value : undefined;
};

const isSecretValid = (presented, expected) => {
  if (!presented || !expected) {
    return false;
  }

  const presentedBuffer = Buffer.from(presented);
  const expectedBuffer = Buffer.from(expected);

  if (presentedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(presentedBuffer, expectedBuffer);
};

// Plain address only: one "@", no whitespace, nothing the gateway would use for
// a non-person session (break-glass sessions arrive as "breakglass:<id>").
const EMAIL_PATTERN = /^[^\s@:,]+@[^\s@:,]+\.[^\s@:,]+$/;

/**
 * @param {object} headers Lower-cased request headers (Node's req.headers).
 * @param {string} secret The shared secret configured for the gateway.
 * @returns {{ email: string, groups: string[] } | null}
 */
const readGatewayIdentity = (headers, secret) => {
  if (!headers || !isSecretValid(readHeader(headers, SECRET_HEADER), secret)) {
    return null;
  }

  const rawEmail = readHeader(headers, EMAIL_HEADER);
  if (!rawEmail) {
    return null;
  }

  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return null;
  }

  return {
    email,
    groups: parseList(readHeader(headers, GROUPS_HEADER)),
  };
};

/**
 * Picks the highest PLANKA role whose configured groups intersect the user's
 * gateway groups, or null when none do (the user may not use PLANKA).
 *
 * @param {string[]} groups The user's gateway groups.
 * @param {{ admin: string[], projectOwner: string[], boardUser: string[] }} roleGroups
 * @returns {string | null}
 */
const resolveRole = (groups, roleGroups) => {
  const groupSet = new Set(groups);

  return (
    ROLE_ORDER.find((role) => (roleGroups[role] || []).some((group) => groupSet.has(group))) || null
  );
};

/**
 * Checks a signed-in PLANKA user against the gateway identity on a later
 * request. Returns the role that the gateway now implies for that user, or
 * null when the gateway no longer vouches for them: no trusted identity, a
 * different person, or a person who has lost every PLANKA group.
 *
 * @param {{ email: string, groups: string[] } | null} identity From readGatewayIdentity.
 * @param {string} userEmail The email of the user who owns the session.
 * @param {{ admin: string[], projectOwner: string[], boardUser: string[] }} roleGroups
 * @returns {string | null}
 */
const resolveVouchedRole = (identity, userEmail, roleGroups) => {
  if (!identity || !userEmail || identity.email !== userEmail.toLowerCase()) {
    return null;
  }

  return resolveRole(identity.groups, roleGroups);
};

// "jane.citizen@example.org" -> "Jane Citizen". Only used when an account is
// first created; the person can change it in PLANKA afterwards.
const nameFromEmail = (email) => {
  const localPart = email.split('@')[0];

  const name = localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return name || localPart;
};

module.exports = {
  MIN_SECRET_LENGTH,
  parseList,
  readGatewayIdentity,
  resolveRole,
  resolveVouchedRole,
  nameFromEmail,
};
