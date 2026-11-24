#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json ignoreCommand). Exit 0 skips the build, exit 1 builds.
#
# Every push to a pull request used to build a preview, and each kept deployment counts toward the
# plan's function storage. GitHub CI (check, rls, e2e) already tests every push, so previews are
# built only when someone wants to look at one:
#   - production (merges to main) always builds;
#   - a preview builds only when the commit message contains [preview]
#     (for example: git commit --allow-empty -m "Slice 5.7a: ready for review [preview]").
if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "Production build."
  exit 1
fi
case "${VERCEL_GIT_COMMIT_MESSAGE:-}" in
  *"[preview]"*)
    echo "Preview requested with [preview]."
    exit 1
    ;;
esac
echo "Preview skipped. Push a commit with [preview] in its message to build one."
exit 0
