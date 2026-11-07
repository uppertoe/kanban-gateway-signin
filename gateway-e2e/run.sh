#!/usr/bin/env bash
# End-to-end check of the gateway sign-in patch. Usage: run.sh <patched-image>
set -u
cd "$(dirname "$0")"
P=http://127.0.0.1:13370
S=e2e-gateway-secret-0123456789abcdef
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got '$2', want '$3')"; fail=$((fail+1)); fi; }
wait_up() { for i in $(seq 1 90); do curl -fs -o /dev/null $P/api/bootstrap && return 0; sleep 2; done; echo "planka did not come up"; docker compose logs planka | tail -40; exit 1; }
sql() { docker compose exec -T db psql -U planka -d planka -tAc "$1"; }
code() { curl -s -o /tmp/e2e_body -w '%{http_code}' "$@"; }

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
check "card set up on a board with Sam as a member" "$(sql "select count(*) from board_membership where board_id='$board' and user_id='$samid'")" "1"
result=$(docker compose run --rm -T browser sh -c 'cd /tmp && npm install --silent --no-save playwright-core@1.58.2 >/dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /e2e/description.cjs "$0" "$1"' "$card" "Edited by a member with no username" 2>&1 | tail -1)
check "member with no username edits a card description in the browser" "$result" "saved"
check "description saved" "$(sql "select description from card where id='$card'")" "Edited by a member with no username"

# An administrator deactivates Jane: she stays out despite her group.
code -b /tmp/e2e_jar -X PATCH $P/api/users/$janeid -H "authorization: Bearer $admintok" -H "x-gateway-secret: $S" -H 'remote-email: admin@example.org' -H 'remote-groups: planka-admins' -H 'content-type: application/json' -d '{"isDeactivated":true}' >/dev/null
c=$(code -X POST $P/api/access-tokens/exchange-with-gateway -H "x-gateway-secret: $S" -H 'remote-email: jane.citizen@example.org' -H 'remote-groups: planka-users')
check "deactivated account refused" "$c $(grep -o 'User is deactivated' /tmp/e2e_body)" "403 User is deactivated"

echo "== $pass passed, $fail failed"
[ "$fail" = 0 ]
