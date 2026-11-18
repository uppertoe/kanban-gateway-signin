#!/usr/bin/env bash
# End-to-end check of the gateway sign-in patch. Usage: run.sh <patched-image>
set -u
cd "$(dirname "$0")"
E2E_PORT=${E2E_PORT:-13370}; export E2E_PORT
P=http://127.0.0.1:$E2E_PORT
S=e2e-gateway-secret-0123456789abcdef
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got '$2', want '$3')"; fail=$((fail+1)); fi; }
wait_up() { for i in $(seq 1 90); do curl -fs -o /dev/null $P/api/bootstrap && return 0; sleep 2; done; echo "planka did not come up"; docker compose logs planka | tail -40; exit 1; }
sql() { docker compose exec -T db psql -U planka -d planka -tAc "$1"; }
code() { curl -s -o /tmp/e2e_body -w '%{http_code}' "$@"; }

MEMBERS_DIR=$(mktemp -d); export MEMBERS_DIR; chmod 755 "$MEMBERS_DIR"; export BOARDS_FILE=
export PLANKA_IMAGE=x; docker compose down -v >/dev/null 2>&1
echo "== phase 1: upstream 2.1.1 with an SSO-flagged account"
export PLANKA_IMAGE=ghcr.io/plankanban/planka:2.1.1; docker compose up -d >/dev/null 2>&1; wait_up
sql "update user_account set is_sso_user = true where email = 'admin@example.org'" >/dev/null
check "2.1.1 seed admin is SSO-flagged" "$(sql "select is_sso_user from user_account where email='admin@example.org'")" "t"

echo "== phase 2: upgrade to the patched image ($1)"
export PLANKA_IMAGE=$1; docker compose up -d >/dev/null 2>&1; sleep 5; wait_up
check "migrated SSO account stays active" "$(sql "select is_deactivated from user_account where email='admin@example.org'")" "f"
check "identity_provider_user dropped" "$(sql "select to_regclass('identity_provider_user') is null")" "t"
check "bootstrap advertises gateway" "$(curl -s $P/api/bootstrap | grep -c '"gateway"')" "1"

check "password login refused" "$(code -X POST $P/api/access-tokens -H 'content-type: application/json' -d '{"emailOrUsername":"admin@example.org","password":"seed-password-123"}')" "404"
check "exchange without secret refused" "$(code -X POST $P/api/access-tokens/exchange-with-gateway -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins')" "401"
check "exchange with wrong secret refused" "$(code -X POST $P/api/access-tokens/exchange-with-gateway -H 'x-gateway-secret: wrong' -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins')" "401"
check "break-glass identity refused" "$(code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: breakglass:ward-4' -H 'remote-groups: planka-users')" "401"
check "member of no Planka group refused" "$(code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: outsider@example.org' -H 'remote-groups: cms-editors')" "403"
check "outsider not created" "$(sql "select count(*) from user_account where email='outsider@example.org'")" "0"

# Admin first sign-in: terms are required before the instance is initialised.
rm -f /tmp/e2e_jar; c=$(code -c /tmp/e2e_jar -X POST "$P/api/access-tokens/exchange-with-gateway?withHttpOnlyToken=true" -H "x-gateway-secret: $S" -H 'remote-email: Admin@Example.org' -H 'remote-groups: planka-admins')
check "admin sign-in asks for terms" "$c $(grep -o 'Terms acceptance required' /tmp/e2e_body | head -1)" "403 Terms acceptance required"
pending=$(grep -o '"pendingToken":"[^"]*"' /tmp/e2e_body | cut -d'"' -f4)
sig=$(curl -s "$P/api/terms?language=en-US" | grep -o '"signature":"[^"]*"' | cut -d'"' -f4)
c=$(code -b /tmp/e2e_jar -X POST $P/api/access-tokens/accept-terms -H 'content-type: application/json' -d "{\"pendingToken\":\"$pending\",\"signature\":\"$sig\"}")
[ "$c" = 200 ] || echo "   (accept-terms body: $(head -c 300 /tmp/e2e_body); sig=$sig)"
check "admin accepts terms and gets a token" "$c" "200"
admintok=$(grep -o '"item":"[^"]*"' /tmp/e2e_body | cut -d'"' -f4)

check "admin token works with matching gateway identity" "$(code -b /tmp/e2e_jar $P/api/users/me -H "authorization: Bearer $admintok" -H "x-gateway-secret: $S" -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins')" "200"
check "admin token refused under another identity" "$(code -b /tmp/e2e_jar $P/api/users/me -H "authorization: Bearer $admintok" -H "x-gateway-secret: $S" -H 'remote-email: jane@example.org')" "401"
check "admin token refused without gateway headers" "$(code -b /tmp/e2e_jar $P/api/users/me -H "authorization: Bearer $admintok")" "401"

# New board user: created on first sign-in.
c=$(code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: jane.citizen@example.org' -H 'remote-groups: planka-users')
echo "   (jane first sign-in: $c $(head -c 120 /tmp/e2e_body))"
pending=$(grep -o '"pendingToken":"[^"]*"' /tmp/e2e_body | cut -d'"' -f4)
if [ -n "$pending" ]; then code -X POST $P/api/access-tokens/accept-terms -H 'content-type: application/json' -d "{\"pendingToken\":\"$pending\",\"signature\":\"$sig\"}" >/dev/null; fi
check "board user created with role and name" "$(sql "select role||'|'||name from user_account where email='jane.citizen@example.org'")" "boardUser|Jane Citizen"

# Promotion and demotion follow the groups at the next sign-in.
code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: jane.citizen@example.org' -H 'remote-groups: planka-owners planka-users' >/dev/null
check "promoted to project owner by group" "$(sql "select role from user_account where email='jane.citizen@example.org'")" "projectOwner"
c=$(code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: jane.citizen@example.org' -H 'remote-groups: planka-users')
check "demoted back to board user, token issued" "$c $(sql "select role from user_account where email='jane.citizen@example.org'")" "200 boardUser"
janetok=$(grep -o '"item":"[^"]*"' /tmp/e2e_body | cut -d'"' -f4)
janeid=$(sql "select id from user_account where email='jane.citizen@example.org'")

check "role edit in Planka refused" "$(code -b /tmp/e2e_jar -X PATCH $P/api/users/$janeid -H "authorization: Bearer $admintok" -H "x-gateway-secret: $S" -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins' -H 'content-type: application/json' -d '{"role":"admin"}')" "403"
check "password change refused" "$(code -X PATCH $P/api/users/$janeid/password -H "authorization: Bearer $janetok" -H "x-gateway-secret: $S" -H 'remote-email: jane.citizen@example.org' -H 'remote-groups: planka-users' -H 'content-type: application/json' -d '{"password":"x","currentPassword":"y"}')" "404"

# Promotion and demotion also follow the groups on the next request with an
# existing token, without a fresh sign-in.
jane() { code $P/api/users/me -H "authorization: Bearer $janetok" -H "x-gateway-secret: $S" -H 'remote-email: jane.citizen@example.org' -H "remote-groups: $1"; }
check "promoted on the next request" "$(jane 'planka-owners planka-users') $(sql "select role from user_account where email='jane.citizen@example.org'")" "200 projectOwner"
check "demoted on the next request" "$(jane planka-users) $(sql "select role from user_account where email='jane.citizen@example.org'")" "200 boardUser"
check "token refused once every Planka group is gone" "$(jane cms-editors) $(sql "select role from user_account where email='jane.citizen@example.org'")" "401 boardUser"

# A person created by gateway sign-in has no username. Upstream 2.3.0 crashed
# the description editor on any board with such a member, so a browser signed
# in as one opens a card on a board they belong to and edits its description.
c=$(code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: sam.taylor@example.org' -H 'remote-groups: planka-users')
pending=$(grep -o '"pendingToken":"[^"]*"' /tmp/e2e_body | cut -d'"' -f4)
if [ -n "$pending" ]; then code -X POST $P/api/access-tokens/accept-terms -H 'content-type: application/json' -d "{\"pendingToken\":\"$pending\",\"signature\":\"$sig\"}" >/dev/null; fi
check "gateway-created user has no username" "$(sql "select coalesce(username, 'none') from user_account where email='sam.taylor@example.org'")" "none"
samid=$(sql "select id from user_account where email='sam.taylor@example.org'")
admin() { curl -s -b /tmp/e2e_jar -X POST "$P/api$1" -H "authorization: Bearer $admintok" -H "x-gateway-secret: $S" -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins' -H 'content-type: application/json' -d "$2" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
project=$(admin /projects '{"type":"private","name":"Editor check"}')
board=$(admin /projects/$project/boards '{"name":"Board","position":65536}')
list=$(admin /boards/$board/lists '{"type":"active","name":"List","position":65536}')
card=$(admin /lists/$list/cards '{"type":"project","name":"Card","position":65536}')
admin /boards/$board/board-memberships "{\"userId\":\"$samid\",\"role\":\"editor\"}" >/dev/null
# Sam's own automatic sign-out is set to two minutes; in gateway mode it is
# off, so the browser stays idle past it below and must still be signed in.
sql "update user_account set auto_logout_mode = '2m' where id = '$samid'" >/dev/null
check "card set up on a board with Sam as a member" "$(sql "select count(*) from board_membership where board_id='$board' and user_id='$samid'")" "1"
result=$(docker compose run --rm -T browser sh -c 'cd /tmp && npm install --silent --no-save playwright-core@1.58.2 >/dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /e2e/description.cjs "$0" "$1" "$2"' "$card" "Edited by a member with no username" 135 2>&1 | tail -1)
check "member with no username edits a card description, then stays signed in while idle" "$result" "saved"
check "description saved" "$(sql "select description from card where id='$card'")" "Edited by a member with no username"

# Under gateway sign-in an administrator adds a person by email and name
# alone: the account has no password, and its role starts at Board User until
# the person's groups set it at their first sign-in. A password and role sent
# anyway are ignored.
api_add() { code -b /tmp/e2e_jar -X POST $P/api/users -H "authorization: Bearer $admintok" -H "x-gateway-secret: $S" -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins' -H 'content-type: application/json' -d "$1"; }
check "admin adds a user without a password" "$(api_add '{"email":"lee.wong@example.org","name":"Lee Wong"}')" "200"
check "user added without a password or role has neither set" "$(sql "select role||'|'||coalesce(password, 'none') from user_account where email='lee.wong@example.org'")" "boardUser|none"
check "a password and role sent anyway are ignored" "$(api_add '{"email":"kim.ng@example.org","name":"Kim Ng","password":"Some-Password-123","role":"admin"}') $(sql "select role||'|'||coalesce(password, 'none') from user_account where email='kim.ng@example.org'")" "200 boardUser|none"
result=$(docker compose run --rm -T -e GATEWAY_EMAIL=admin@example.org -e GATEWAY_GROUPS=planka-admins browser sh -c 'cd /tmp && npm install --silent --no-save playwright-core@1.58.2 >/dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /e2e/add-user.cjs "$0" "$1"' "ana.ruiz@example.org" "Ana Ruiz" 2>&1 | tail -1)
check "admin adds a user in the browser with no password or role asked" "$result" "added"
check "user added in the browser" "$(sql "select role||'|'||name from user_account where email='ana.ruiz@example.org'")" "boardUser|Ana Ruiz"

# Signing out of PLANKA in the browser hands over to the gateway's sign-out.
result=$(docker compose run --rm -T browser sh -c 'cd /tmp && npm install --silent --no-save playwright-core@1.58.2 >/dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /e2e/logout.cjs "$0"' "https://auth.example.org/logout?rd=http://localhost:1337/" 2>&1 | tail -1)
check "signing out of PLANKA hands over to the gateway's sign-out" "$result" "handed over"

# Board places from gateway groups. The server's Caddy snippet names each
# linked board once; PLANKA creates a missing project and board, creates a
# named account for every group member, and keeps the places in step. Kim is
# added by hand to a board the sync created and then joins a linked group, so
# that place must stay untouched. The sync only ever uses boards it created:
# a project of a marker's name that already exists is never taken over.
members() { printf '%s' "$2" > "$MEMBERS_DIR/$1.json"; }
boardid() { sql "select b.id from board b join project p on p.id=b.project_id where p.name='$1' and b.name='$2'"; }
place() { sql "select m.role||'|'||coalesce(m.can_comment::text,'-')||'|'||(select count(*) from gateway_board_grant g where g.board_id=m.board_id and g.user_id=m.user_id) from board_membership m join user_account u on u.id=m.user_id where m.board_id='$1' and u.email='$2'"; }
until_place() { for i in $(seq 1 30); do [ "$(place "$1" "$2")" = "$3" ] && break; sleep 2; done; place "$1" "$2"; }
# A Project Owner prepares a shared project and board of a marker's names,
# hands the project to an administrator, leaves its managers and keeps an
# editor seat on the board. The sync must not take that board over.
c=$(code -X POST "$P/api/access-tokens/exchange-with-gateway" -H "x-gateway-secret: $S" -H 'remote-email: pat.owner@example.org' -H 'remote-groups: planka-owners')
pending=$(grep -o '"pendingToken":"[^"]*"' /tmp/e2e_body | cut -d'"' -f4)
if [ -n "$pending" ]; then code -X POST $P/api/access-tokens/accept-terms -H 'content-type: application/json' -d "{\"pendingToken\":\"$pending\",\"signature\":\"$sig\"}" >/dev/null; fi
pattok=$(grep -o '"item":"[^"]*"' /tmp/e2e_body | cut -d'"' -f4)
pat() { curl -s -X "$1" "$P/api$2" -H "authorization: Bearer $pattok" -H "x-gateway-secret: $S" -H 'remote-email: pat.owner@example.org' -H 'remote-groups: planka-owners' -H 'content-type: application/json' ${3:+-d "$3"}; }
trapproject=$(pat POST /projects '{"type":"shared","name":"RCH Trap"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
pat POST /projects/$trapproject/boards '{"name":"Trap","position":65536}' >/dev/null
adminid=$(sql "select id from user_account where email='admin@example.org'")
pat POST /projects/$trapproject/project-managers "{\"userId\":\"$adminid\"}" >/dev/null
patmanager=$(sql "select pm.id from project_manager pm join user_account u on u.id=pm.user_id where pm.project_id='$trapproject' and u.email='pat.owner@example.org'")
pat DELETE /project-managers/$patmanager >/dev/null
check "trap set up: only an administrator manages the project, and Pat keeps a board seat" "$(sql "select count(*) from project_manager pm join user_account u on u.id=pm.user_id where pm.project_id='$trapproject' and u.role<>'admin'")|$(sql "select m.role from board_membership m join user_account u on u.id=m.user_id join board b on b.id=m.board_id where b.project_id='$trapproject' and u.email='pat.owner@example.org'")" "0|editor"
sharedproject=$(admin /projects '{"type":"shared","name":"Shared check"}')
admin /projects/$sharedproject/boards '{"name":"Board","position":65536}' >/dev/null
members regs '["sam.taylor@example.org", "Lee.Wong@example.org", "tom.darling2@example.org"]'
members cons '["ana.ruiz@example.org"]'
cat > "$MEMBERS_DIR/planka.caddy" <<'SNIPPET'
planka.example.org {
	# scaffold-members: regs -- board "Registrars" in "Linked boards" as editor
	# scaffold-members: cons, regs -- board "Everyone" in "Everyone" as commenter
	# scaffold-members: regs -- board "Board" in "Shared check" as editor
	# scaffold-members: regs -- board "Plans" in "Editor check" as editor
	# scaffold-members: regs -- board "Trap" in "RCH Trap" as editor
	# scaffold-members: other -- read for something else
}
SNIPPET
export BOARDS_FILE=/boards/planka.caddy
docker compose up -d planka >/dev/null 2>&1; sleep 5; wait_up
for i in $(seq 1 30); do linked=$(boardid 'Linked boards' Registrars); [ -n "$linked" ] && break; sleep 2; done
for i in $(seq 1 30); do existing=$(boardid Everyone Everyone); [ -n "$existing" ] && break; sleep 2; done
check "missing project created as shared, and its board" "$(sql "select coalesce(p.owner_project_manager_id::text, 'shared') from project p join board b on b.project_id=p.id where b.id='$linked'")" "shared"
check "board creator is the longest-standing admin, placed by hand" "$(until_place $linked admin@example.org 'editor|-|0')" "editor|-|0"
check "account created before sign-in, named without the number" "$(for i in $(seq 1 30); do r=$(sql "select name||'|'||role||'|'||coalesce(password,'none') from user_account where email='tom.darling2@example.org'"); [ -n "$r" ] && break; sleep 2; done; echo "$r")" "Tom Darling|boardUser|none"
check "group member placed as editor, with its grant" "$(until_place $linked sam.taylor@example.org 'editor|-|1')" "editor|-|1"
check "member matched whatever the address's case" "$(until_place $linked lee.wong@example.org 'editor|-|1')" "editor|-|1"
check "new account placed on the board" "$(until_place $linked tom.darling2@example.org 'editor|-|1')" "editor|-|1"
check "commenter link placed on a second board the sync created" "$(until_place $existing ana.ruiz@example.org 'viewer|true|1')" "viewer|true|1"
kimid=$(sql "select id from user_account where email='kim.ng@example.org'")
admin /boards/$existing/board-memberships "{\"userId\":\"$kimid\",\"role\":\"viewer\",\"canComment\":false}" >/dev/null
members cons '["ana.ruiz@example.org", "kim.ng@example.org"]'; sleep 12
check "place added by hand left alone after its holder joins a linked group" "$(place $existing kim.ng@example.org)" "viewer|false|0"
check "marker for another purpose ignored" "$(docker compose logs planka 2>&1 | grep -c 'not a board line was ignored')" "1"
check "an existing project of a marker's name is never taken over, even an administrator's" "$(sql "select count(*) from gateway_board_link where project_name in ('Shared check', 'Editor check', 'RCH Trap')")|$(sql "select count(*) from gateway_board_grant g join board b on b.id=g.board_id join project p on p.id=b.project_id where p.name in ('Shared check', 'Editor check', 'RCH Trap')")|$(docker compose logs planka 2>&1 | grep -c 'already exists that the sync did not create' | awk '{print ($1>=3)}')" "0|0|1"
check "the sync records the project and board it created" "$(sql "select count(*) from gateway_board_link where board_id='$existing' and project_id=(select project_id from board where id='$existing')")" "1"

# Renaming a linked board does no harm: the sync keeps using the recorded board.
sql "update board set name='Registrars 2026' where id='$linked'" >/dev/null

members regs '["sam.taylor@example.org", "tom.darling2@example.org"]'
check "a person who leaves the group loses the place" "$(until_place $linked lee.wong@example.org '')" ""
check "and the place on the other linked board" "$(until_place $existing lee.wong@example.org '')" ""
check "the place added by hand stays" "$(place $existing kim.ng@example.org)" "viewer|false|0"

# A board the sync created and someone deleted is created again in its project.
everyoneproject=$(sql "select project_id from board where id='$existing'")
admin_delete() { curl -s -o /dev/null -b /tmp/e2e_jar -X DELETE "$P/api$1" -H "authorization: Bearer $admintok" -H "x-gateway-secret: $S" -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins'; }
admin_delete /boards/$existing
for i in $(seq 1 30); do again=$(boardid Everyone Everyone); [ -n "$again" ] && [ "$again" != "$existing" ] && break; sleep 2; done
check "a deleted board is created again in the recorded project" "$([ -n "$again" ] && [ "$again" != "$existing" ] && echo new)|$(sql "select project_id from board where id='$again'")|$(sql "select count(*) from project where name='Everyone'")" "new|$everyoneproject|1"
existing=$again
check "and its group places come back" "$(until_place $existing ana.ruiz@example.org 'viewer|true|1')" "viewer|true|1"

members regs 'fail'; sleep 12
check "a failed read removes nobody" "$(place $linked sam.taylor@example.org)" "editor|-|1"
members regs '[]'; sleep 12
check "an empty list is held rather than emptying the board" "$(place $linked sam.taylor@example.org)" "editor|-|1"

members regs '["sam.taylor@example.org", "tom.darling2@example.org", "new.starter@example.org"]'
check "a new member gets an account and a place before signing in" "$(until_place $linked new.starter@example.org 'editor|-|1')" "editor|-|1"
c=$(code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: new.starter@example.org' -H 'remote-groups: planka-users regs')
check "their first sign-in uses that account" "$(sql "select count(*) from user_account where email='new.starter@example.org'")" "1"
check "a renamed board is kept, and no second board is made" "$(sql "select count(*) from board where name in ('Registrars', 'Registrars 2026')")|$(sql "select name from board where id='$linked'")" "1|Registrars 2026"

# A missing members token turns the sync off and leaves PLANKA running.
export PLANKA_MEMBERS_TOKEN=short
docker compose up -d planka >/dev/null 2>&1; sleep 5; wait_up
check "with no usable token PLANKA still starts and the sync is off" "$(docker compose logs planka 2>&1 | grep -c 'Gateway board sync is off')" "1"
unset PLANKA_MEMBERS_TOKEN; export BOARDS_FILE=
docker compose up -d planka >/dev/null 2>&1; sleep 5; wait_up

# An administrator deactivates Jane: she stays out despite her group.
code -b /tmp/e2e_jar -X PATCH $P/api/users/$janeid -H "authorization: Bearer $admintok" -H "x-gateway-secret: $S" -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins' -H 'content-type: application/json' -d '{"isDeactivated":true}' >/dev/null
c=$(code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: jane.citizen@example.org' -H 'remote-groups: planka-users')
check "deactivated account refused" "$c $(grep -o 'User is deactivated' /tmp/e2e_body)" "403 User is deactivated"

rm -rf "$MEMBERS_DIR"
echo "== $pass passed, $fail failed"
[ "$fail" = 0 ]
