#!/usr/bin/env bash
# Set up GitHub -> GitLab mirroring for local repos.
#
# For every repo it: (1) creates a private GitLab project with the same name if missing,
# (2) writes .github/workflows/mirror-to-gitlab.yml, commits and pushes it to GitHub,
# (3) stores your GitLab token as the GITLAB_TOKEN secret on the GitHub repo.
# After that, every push to GitHub (and a nightly run) copies all branches and tags to GitLab.
#
# Usage (Git Bash):
#   scripts/mirror-to-gitlab.sh                 # the default repo list below
#   scripts/mirror-to-gitlab.sh jalter Nebula   # only these repos
#   DRY_RUN=1 scripts/mirror-to-gitlab.sh       # show what would happen, change nothing
#
# The GitLab personal access token (scope: api) comes from, in order: the GITLAB_TOKEN environment
# variable, the Windows credential vault (saved by an earlier run), or a hidden prompt. After a prompt
# you can save it in the vault (encrypted for your Windows account) so new repos need no typing.
#   scripts/mirror-to-gitlab.sh --forget        # delete the saved token (do this when it expires)
# The token is only sent to gitlab.com and stored as a GitHub secret. It is never written to a file.
set -euo pipefail

GITHUB_USER="${GITHUB_USER:-Haruru0-0}"
GITLAB_USER="${GITLAB_USER:-Haruru0-0}"
BASE_DIR="${BASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DEFAULT_REPOS=(jalter Nebula PortaGen aesthetic-portfolio-os notioncraft-ai steam-games-analysis)
REPOS=("${@:-${DEFAULT_REPOS[@]}}")
DRY_RUN="${DRY_RUN:-0}"

export PATH="$PATH:/c/Program Files/GitHub CLI"
command -v gh >/dev/null || { echo "gh (GitHub CLI) is not installed or not on PATH"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first"; exit 1; }

VAULT_RESOURCE="jalter-gitlab-mirror"
PS_VAULT='[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;'

vault_get() {
  powershell.exe -NoProfile -Command "$PS_VAULT try { \$c = \$v.Retrieve('$VAULT_RESOURCE','token'); \$c.RetrievePassword(); \$c.Password } catch {}" 2>/dev/null | tr -d ''
}
vault_set() {
  TOKEN_IN="$1" powershell.exe -NoProfile -Command "$PS_VAULT try { \$v.Remove(\$v.Retrieve('$VAULT_RESOURCE','token')) } catch {}; \$v.Add((New-Object Windows.Security.Credentials.PasswordCredential '$VAULT_RESOURCE','token',\$env:TOKEN_IN))" 2>/dev/null
}
vault_forget() {
  powershell.exe -NoProfile -Command "$PS_VAULT try { \$v.Remove(\$v.Retrieve('$VAULT_RESOURCE','token')); 'removed' } catch { 'nothing saved' }" 2>/dev/null | tr -d ''
}

if [ "${1:-}" = "--forget" ]; then
  echo "Saved GitLab token: $(vault_forget)"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  TOKEN="dry-run"
else
  TOKEN="${GITLAB_TOKEN:-}"
  if [ -z "$TOKEN" ]; then
    TOKEN="$(vault_get)"
    [ -z "$TOKEN" ] || echo "Using the GitLab token saved in the Windows vault."
  fi
  if [ -z "$TOKEN" ]; then
    read -rsp "GitLab personal access token (api scope): " TOKEN; echo
    [ -n "$TOKEN" ] || { echo "No token given"; exit 1; }
    read -rp "Save it in the Windows vault so you are not asked again? [y/N] " save
    if [ "$save" = "y" ] || [ "$save" = "Y" ]; then vault_set "$TOKEN" && echo "Saved."; fi
  fi
fi

read -r -d '' WORKFLOW <<'YAML' || true
name: Mirror to GitLab

on:
  push:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: mirror-to-gitlab
  cancel-in-progress: false

jobs:
  mirror:
    runs-on: ubuntu-latest
    steps:
      - name: Copy branches and tags to GitLab
        env:
          GH_TOKEN: ${{ github.token }}
          GITLAB_TOKEN: ${{ secrets.GITLAB_TOKEN }}
          GITLAB_USER: __GITLAB_USER__
          REPO_NAME: ${{ github.event.repository.name }}
        run: |
          set -euo pipefail
          git clone --bare "https://x-access-token:${GH_TOKEN}@github.com/${{ github.repository }}.git" repo.git
          cd repo.git
          # GitLab protects the default branch and refuses forced updates: lift that for the mirror.
          for branch in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
            encoded=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$branch")
            curl -s -o /dev/null -X DELETE -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
              "https://gitlab.com/api/v4/projects/${GITLAB_USER}%2F${REPO_NAME}/protected_branches/${encoded}" || true
          done
          git push --prune "https://oauth2:${GITLAB_TOKEN}@gitlab.com/${GITLAB_USER}/${REPO_NAME}.git" \
            '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
YAML
WORKFLOW="${WORKFLOW//__GITLAB_USER__/$GITLAB_USER}"


for repo in "${REPOS[@]}"; do
  echo "=== $repo"
  dir="$BASE_DIR/$repo"
  [ -d "$dir/.git" ] || { echo "  skipped: $dir is not a git repo"; continue; }

  # 1. GitLab project (a 400 'already taken' answer means it exists, which is fine)
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] create private GitLab project $GITLAB_USER/$repo"
  else
    code=$(curl -s -o /tmp/gl-create.out -w '%{http_code}' -X POST -H "PRIVATE-TOKEN: $TOKEN" \
      --data-urlencode "name=$repo" --data-urlencode "path=$repo" --data "visibility=private" \
      https://gitlab.com/api/v4/projects)
    case "$code" in
      201) echo "  GitLab project created" ;;
      400) echo "  GitLab project already exists (or name taken); continuing" ;;
      401) echo "  GitLab rejected the token (401); stopping"; exit 1 ;;
      *)   echo "  GitLab answered HTTP $code; stopping"; cat /tmp/gl-create.out; exit 1 ;;
    esac
  fi

  # 2. Secret first, so the workflow's first run (triggered by the push below) can authenticate
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] gh secret set GITLAB_TOKEN --repo $GITHUB_USER/$repo"
  else
    printf '%s' "$TOKEN" | gh secret set GITLAB_TOKEN --repo "$GITHUB_USER/$repo"
    echo "  secret GITLAB_TOKEN set"
  fi

  # 3. Workflow file, commit and push
  file="$dir/.github/workflows/mirror-to-gitlab.yml"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] write $file, commit and push the current branch"
    continue
  fi
  mkdir -p "$(dirname "$file")"
  printf '%s\n' "$WORKFLOW" > "$file"
  if [ -n "$(git -C "$dir" status --porcelain -- .github/workflows/mirror-to-gitlab.yml)" ]; then
    git -C "$dir" add .github/workflows/mirror-to-gitlab.yml
    git -C "$dir" commit -q -m "ci: mirror to GitLab on every push" -- .github/workflows/mirror-to-gitlab.yml
    echo "  workflow committed"
  else
    echo "  workflow already up to date"
  fi
  branch="$(git -C "$dir" branch --show-current)"
  remote="$(git -C "$dir" remote | grep -x origin || true)"
  [ -n "$remote" ] || { echo "  no 'origin' remote; push it yourself"; continue; }
  git -C "$dir" push -q origin "$branch"
  echo "  pushed $branch to origin"
done

echo "Done. Check the Actions tab of each GitHub repo, then the projects on https://gitlab.com/$GITLAB_USER"
