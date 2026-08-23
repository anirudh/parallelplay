#!/bin/sh
set -eu

printf '%s\n' '{"schemaVersion":2,"sequence":1,"type":"started"}'
test "${PARALLELPLAY_CONTEXT:-}" = "/context/context.json"
test -r /context/context.json
cp /context/context.json /artifacts/context-copy.json

context_read_only=true
printf x >> /context/context.json 2>/dev/null && context_read_only=false
database_hidden=true
[ ! -e /database ] || database_hidden=false
source_store_hidden=true
[ ! -e /source-store ] || source_store_hidden=false
artifact_store_hidden=true
[ ! -e /artifact-store ] || artifact_store_hidden=false
git_hidden=true
[ ! -e /workspace/.git ] || git_hidden=false
printf '{"contextReadOnly":%s,"databaseHidden":%s,"sourceStoreHidden":%s,"artifactStoreHidden":%s,"gitHidden":%s}\n' \
  "$context_read_only" "$database_hidden" "$source_store_hidden" "$artifact_store_hidden" "$git_hidden" \
  > /artifacts/context-security.json

printf '%s\n' 'agent candidate' >> README.md
printf '%s\n' '{"schemaVersion":2,"sequence":2,"type":"capability.used","capability":"workspace.write"}'
printf '%s\n' '{"schemaVersion":2,"sequence":3,"type":"capability.used","capability":"artifact.write"}'
printf '%s\n' '{"schemaVersion":2,"sequence":4,"type":"artifact.declared","path":"context-copy.json","role":"context.copy"}'
printf '%s\n' '{"schemaVersion":2,"sequence":5,"type":"artifact.declared","path":"context-security.json","role":"context.security"}'
printf '%s\n' '{"schemaVersion":2,"sequence":6,"type":"usage","cpuMillis":1,"memoryPeakBytes":1048576}'
printf '%s\n' '{"schemaVersion":2,"sequence":7,"type":"terminal","outcome":"succeeded"}'
