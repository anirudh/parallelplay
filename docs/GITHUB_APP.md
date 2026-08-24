# GitHub App setup and permissions

Create a dedicated GitHub App for the repositories ParallelPlay will observe. Grant metadata read and only the required repository permissions: Contents, Pull requests, Issues, and Checks. Check-run writes require a GitHub App.

Store the App ID, installation ID, and private key as host-side secret references. Installation tokens remain memory-only. Git credentials must be supplied through a pipe-backed helper, never an argument or stored URL.

After exact human promotion of an action/target policy, the adapter may create or update check runs, machine-owned `parallelplay:*` labels, generated comments, immutable `parallelplay/candidate/<revision-digest>` refs, and draft pull requests or their title/body. It uses idempotency markers, compare-and-observe semantics, request IDs, and live reconciliation.

It cannot update or delete a human branch or text, force-push, mark a draft ready, merge, release, deploy, change repository settings/protection, or manage permissions, workflows, environments, or secrets. Generated text is rejected before authority or network access when it contains a secret-like value, mention, slash command, active HTML, image, or non-allowlisted link.

For the 0.1.0 pilot, start Attention with the detached GitHub adapter manifest and a new evidence path:

```sh
bin/parallelplay attention-app serve \
  --db <fresh-db> \
  --operator-id <operator> \
  --github-manifest <github-app.extension-manifest.json> \
  --github-pilot-output <new-evidence.json> \
  --port 0
```

Attention creates a state-bound GitHub App manifest flow. The callback exchanges the temporary code host-side, retains the returned private key only in host memory, and directs installation exclusively to `anirudh/parallelplay-fixture`. The operator then verifies the installation ID, promotes the exact one-hour fixture policy, and runs the pilot. Later sessions may instead resolve `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` from the host environment.

The pilot observes the installation repository list before acting, reconciles every effect, verifies duplicate convergence, and rejects merge, ready-for-review, protected-branch, trigger-like, and secret-like requests without recording an authorized effect. Its sanitized result links the retained public branches, check, label, comment, and draft pull request.
