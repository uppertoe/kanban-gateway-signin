# Gateway sign-in (modified version of PLANKA)

**This is a modified version of PLANKA.** It is not made or supported by PLANKA
Software GmbH. The modification lets PLANKA sign people in from the identity
headers of an authenticating reverse proxy (the "gateway"), and switches off
PLANKA's own password sign-in while it is enabled. Everything else is upstream
PLANKA, used under the [PLANKA Community Licence](LICENSE.md) for internal use
within one organisation.

## How sign-in works

The reverse proxy authenticates every request before it reaches PLANKA and
adds three headers: `Remote-Email`, `Remote-Groups`, and `X-Gateway-Secret`,
a value that only the proxy and PLANKA know. PLANKA ignores the identity
headers on any request without the right secret.

1. The browser loads PLANKA. The login page asks the server for a session at
   `POST /api/access-tokens/exchange-with-gateway` instead of showing a form.
2. PLANKA reads the email and groups, picks the role from the groups, and
   finds the account by email. A new person gets an account on the spot. An
   account that an administrator has deactivated is refused.
3. The usual login steps then run (terms acceptance, and PLANKA's own TOTP if
   the person has turned it on), and PLANKA issues its normal session.
4. On every later request PLANKA checks that the gateway still vouches for the
   same email. If it does not, the session is treated as signed out and the
   login page signs in afresh. The same check applies the role that the
   person's current groups imply, so a promotion or demotion in the gateway
   takes effect on the next request. A person who has left every PLANKA group
   is treated as signed out. PLANKA writes to the database only when the role
   has changed.
5. Live updates and most of the client's requests travel over one websocket,
   which the gateway checks only when it connects. PLANKA trusts only the
   headers from that connection, never headers that the client adds to a
   socket request. When the role recorded for the account no longer matches
   the role from the connection, PLANKA refuses the request and the client
   signs in again on a new connection. Every page load and every reconnection
   also makes an ordinary request, which brings the role up to date.
6. Signing out of PLANKA also sends the browser to the gateway's sign-out
   page. Only a sign-out the person chose does this. When PLANKA refuses a
   stored token instead, for example one issued by an earlier PLANKA version,
   the client drops the token and the login page signs in afresh.

The role is set by group membership at sign-in and on every later request, so
it cannot be changed in PLANKA's user screen. People who belong to none of the
configured groups cannot use PLANKA. Project and board permissions are managed in PLANKA as usual.

## Settings

| Variable | Meaning |
|---|---|
| `GATEWAY_AUTH` | `true` turns gateway sign-in on and password sign-in off. |
| `GATEWAY_AUTH_SECRET` | The shared secret the proxy sends as `X-Gateway-Secret`. At least 32 characters. |
| `GATEWAY_ADMIN_GROUPS` | Gateway groups whose members become Admin. |
| `GATEWAY_PROJECT_OWNER_GROUPS` | Gateway groups whose members become Project Owner. |
| `GATEWAY_BOARD_USER_GROUPS` | Gateway groups whose members become Board User. |
| `GATEWAY_LOGOUT_URL` | Where the browser goes after signing out of PLANKA. |

Group lists are separated by commas or spaces. A person in several groups gets
the highest role. PLANKA refuses to start when `GATEWAY_AUTH=true` and the
secret is short or no group is configured.

The proxy must strip any client-supplied `Remote-*` and `X-Gateway-Secret`
headers before it adds its own, and PLANKA must not be reachable except
through the proxy.

## What the modification changes

All new files carry a header saying that they are a local modification.

- New: `server/utils/gateway-identity.js`, the header reader and role mapping,
  with tests in `server/test/utils/gateway-identity.test.js`, and
  `server/utils/gateway-actor.js`, the actor recorded for the gateway's changes.
- New: the `exchange-with-gateway` controller, the `getOrCreateOneWithGateway`
  and `applyGatewayRole` helpers, the `is-password-sign-in-allowed` policy, and
  the client's `GatewayContent` login screen.
- Changed: the settings (`config/custom.js`), routes and policies; the
  current-user hook (the per-request identity and role check, with tests in
  `server/test/hooks/current-user-gateway.test.js`); the user update
  controller (role edits refused); the user create controller and the
  administration's add-user form (no password and no role: an account added
  by an administrator has no password, like one the gateway creates, and its
  role starts at Board User until the person's groups set it at their first
  sign-in); the bootstrap response (`gateway` field);
  the client login saga, logout service and token API.
- Changed: upstream migration `20260807120000_remove_single_sign_on_support`
  no longer deactivates accounts that used single sign-on. Those accounts keep
  signing in, matched by email.

## Other changes

- PLANKA's automatic sign-out after a period without activity is off while
  gateway sign-in is on, and its setting is not shown in a person's
  preferences (`client/src/sagas/core/services/auto-logout.js`,
  `client/src/components/users/UserSettingsModal/PreferencesPane.jsx`). The
  gateway's session decides how long a person stays signed in, and PLANKA
  signs them straight back in while it lasts, so the timer only interrupted
  people, and it sent them to the gateway's sign-out page. Signing out in one
  tab still signs out the others.

- The "Discover PLANKA Pro" promotional banner at the top of the page is not
  shown (`client/src/components/common/Fixed/Fixed.jsx`), and nor is the
  "Discover PLANKA Pro" / "Upgrade team to Pro" item in the user menu
  (`client/src/components/users/UserActionsStep/UserActionsStep.jsx`). No
  licensing or copyright notice is affected.

## Keeping up with upstream

The modification lives on `main`, and each upstream release is merged into
it, never rebased, so `main` is never force-pushed.

### The weekly sync

Every Monday morning (Melbourne time), the Upstream sync workflow
(`.github/workflows/upstream-sync.yml`, running
`.github/scripts/upstream-sync.sh`) looks for upstream's newest release. It
takes the highest `vX.Y.Z` tag among published releases, skipping
pre-releases and the `planka-X.Y.Z` chart tags. If `main` already contains
it, the run ends there.

Otherwise the workflow branches from `main` as `upstream/vX.Y.Z` and runs
`git merge vX.Y.Z`. Upstream workflows that this fork has deleted or that
upstream has added are dropped, since the fork replaces them.

- **A clean merge** is pushed, and a pull request "Merge upstream PLANKA
  vX.Y.Z" is opened. The workflow then starts the Gateway build on the
  branch, which runs the server tests, builds the image and runs the
  end-to-end check. Nothing is merged automatically: read upstream's release
  notes, check the build, and merge the pull request yourself.
- **A conflicting merge** is abandoned, and an issue "Upstream PLANKA vX.Y.Z
  needs a manual merge" lists the conflicting files. Resolve it by hand as
  described below.
- **A release still off `main` after 7 days** gets a reminder issue.

Once the branch `upstream/vX.Y.Z` exists, later runs leave it alone, so
closing the pull request without merging stops the workflow from reopening
it. The workflow can also be started by hand from the Actions tab. It uses
the workflow's own token, so no secret has to be set.

### Merging a release by hand

When the weekly sync reports a conflict, or to merge a release yourself:

```
git switch -c upstream/vX.Y.Z origin/main
git fetch https://github.com/plankanban/planka.git tag vX.Y.Z --no-tags
git merge vX.Y.Z
```

Resolve each conflict in favour of keeping the local modifications listed
above, alongside upstream's changes; take upstream's lockfiles, and keep
upstream's deleted workflows deleted. Then push the branch and open a pull
request. The Gateway build runs on it as on any pull request.

### The end-to-end check

`gateway-e2e/run.sh <image>` upgrades a real upstream 2.1.1 database to the
new image and exercises gateway sign-in and role changes with curl,
including a role change taking effect on the next request. It then drives a
headless browser:

- a gateway-created person, who has no username, opens a card, saves its
  description and stays signed in while idle past their own automatic
  sign-out time;
- an administrator adds a person through the add-user form, which asks for
  no password or role;
- signing out of PLANKA hands over to the gateway's sign-out.

Set `E2E_PORT` to run it beside another stack on the same machine.
