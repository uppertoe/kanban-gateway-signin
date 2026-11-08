#!/usr/bin/env bash
# Gateway sign-in fork (local modification of PLANKA, see GATEWAY.md).
#
# Merges the newest upstream PLANKA release into a branch and opens a pull
# request for the owner to review. Run weekly by .github/workflows/upstream-sync.yml.
#
# - The newest release is the highest vX.Y.Z tag among upstream's published,
#   non-pre-release releases (the planka-X.Y.Z chart tags are skipped).
# - If main already contains it, nothing happens.
# - Otherwise the release is merged (never rebased) onto main as
#   upstream/vX.Y.Z. A clean merge is pushed, a pull request is opened, and
#   the Gateway build is started on the branch. Nothing is merged automatically.
# - A conflicting merge is abandoned and a GitHub issue lists the files.
# - A release that has been out for 7 days or more without reaching main
#   gets a reminder issue.
#
# Environment: GH_TOKEN (the workflow's GITHUB_TOKEN), GITHUB_REPOSITORY.
# For a local trial: DRY_RUN=1 prints instead of pushing, opening pull requests
# or issues, and TAG=vX.Y.Z picks the release instead of the newest.
set -euo pipefail

UPSTREAM=plankanban/planka
REPO=${GITHUB_REPOSITORY:-uppertoe/kanban-gateway-signin}
STALE_DAYS=7
DRY_RUN=${DRY_RUN:-}

run() {
  if [ -n "$DRY_RUN" ]; then
    printf 'DRY RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Opens an issue with this exact title unless one is already open.
open_issue() {
  local title=$1 body=$2 existing
  existing=$(gh issue list -R "$REPO" --state open --search "in:title \"$title\"" \
    --json number,title --jq ".[] | select(.title == \"$title\") | .number" | head -1)
  if [ -n "$existing" ]; then
    echo "Issue #$existing is already open: $title"
  else
    run gh issue create -R "$REPO" --title "$title" --body "$body"
  fi
}

releases=$(gh api "repos/$UPSTREAM/releases?per_page=50" --jq '
  .[] | select((.draft | not) and (.prerelease | not))
      | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
      | "\(.tag_name) \(.published_at)"')
if [ -n "${TAG:-}" ]; then
  line=$(printf '%s\n' "$releases" | awk -v t="$TAG" '$1 == t')
else
  line=$(printf '%s\n' "$releases" | sort -V -k1,1 | tail -1)
fi
tag=${line%% *}
published=${line#* }
if [ -z "$tag" ]; then
  echo "No upstream release found." >&2
  exit 1
fi
echo "Newest upstream release: $tag, published $published"

git fetch --quiet --no-tags "https://github.com/$UPSTREAM.git" "+refs/tags/$tag:refs/tags/$tag"
git fetch --quiet origin main
if git merge-base --is-ancestor "$tag" origin/main; then
  echo "main already contains $tag."
  exit 0
fi

branch="upstream/$tag"
pr_title="Merge upstream PLANKA $tag"
conflict_title="Upstream PLANKA $tag needs a manual merge"
published_s=$(date -u -d "$published" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$published" +%s)
age_days=$(( ($(date -u +%s) - published_s) / 86400 ))

if git ls-remote --exit-code --heads origin "$branch" >/dev/null; then
  # A branch from an earlier run: its pull request is open, or the owner has
  # closed it. Either way it is left alone.
  echo "Branch $branch already exists."
else
  git switch --quiet -c "$branch" origin/main
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

  if ! git merge --no-ff --no-edit -m "$pr_title" "$tag" >/dev/null; then
    # The fork replaces upstream's workflows, so a workflow upstream changed
    # and this fork deleted stays deleted.
    for f in $(git diff --name-only --diff-filter=U -- .github/workflows); do
      if ! git cat-file -e "HEAD:$f" 2>/dev/null; then
        git rm --quiet "$f"
      fi
    done
    conflicts=$(git diff --name-only --diff-filter=U)
    if [ -n "$conflicts" ]; then
      git merge --abort
      echo "The merge of $tag conflicts in:"
      printf '  %s\n' $conflicts
      body=$(printf '%s\n' \
        "Merging upstream PLANKA $tag into \`main\` conflicts in these files:" \
        "" \
        "$(printf -- '- `%s`\n' $conflicts)" \
        "" \
        "To resolve it, follow \"Keeping up with upstream\" in GATEWAY.md:" \
        "" \
        '```' \
        "git switch -c $branch origin/main" \
        "git fetch https://github.com/$UPSTREAM.git tag $tag --no-tags" \
        "git merge $tag" \
        '```' \
        "" \
        "Keep the local modifications that GATEWAY.md lists, then push the branch and open a pull request. The weekly run leaves the branch alone once it exists.")
      open_issue "$conflict_title" "$body"
    else
      git commit --quiet --no-edit
    fi
  fi

  if git merge-base --is-ancestor "$tag" HEAD; then
    # The fork replaces upstream's workflows, so a workflow upstream added is
    # dropped. (The workflow token cannot push workflow files in any case.)
    added=$(git diff --name-only --diff-filter=A origin/main HEAD -- .github/workflows | grep -v -x -e .github/workflows/gateway.yml -e .github/workflows/upstream-sync.yml || true)
    if [ -n "$added" ]; then
      git rm --quiet $added
      git commit --quiet --amend --no-edit
    fi
    run git push --quiet origin "$branch"
    body=$(printf '%s\n' \
      "Merges upstream PLANKA [$tag](https://github.com/$UPSTREAM/releases/tag/$tag) into \`main\` with \`git merge $tag\`, opened by the weekly upstream sync. Nothing merges automatically." \
      "" \
      "The Gateway build runs the gateway unit tests, builds the image and runs the end-to-end check on this branch. Before merging, read upstream's release notes and check that the local modifications listed in GATEWAY.md are intact.")
    run gh pr create -R "$REPO" --base main --head "$branch" --title "$pr_title" --body "$body"
    # A pull request opened with the workflow token starts no workflows, so
    # the build is started here; its result is recorded on the branch's commit.
    run gh workflow run gateway.yml -R "$REPO" --ref "$branch"
  fi
fi

if [ "$age_days" -ge "$STALE_DAYS" ]; then
  open_issue "Upstream PLANKA $tag is not on main after $STALE_DAYS days" \
    "Upstream PLANKA $tag was published on ${published%%T*} and has been out for $age_days days, but \`main\` does not contain it yet. Look for the open pull request \"$pr_title\" or the issue \"$conflict_title\"."
fi
