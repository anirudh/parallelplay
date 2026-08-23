#!/bin/sh
set -eu
printf '%s\n' '{"schemaVersion":1,"sequence":1,"type":"started"}'
home_hidden=true
[ ! -e /Users ] || home_hidden=false
marker_hidden=true
[ ! -e /tmp/parallelplay-operator-home-marker ] || marker_hidden=false
host_secret_hidden=true
[ -z "${PARALLELPLAY_TEST_HOST_SECRET+x}" ] || host_secret_hidden=false
credentials_hidden=true
[ ! -e /root/.docker/config.json ] || credentials_hidden=false
[ ! -e /home/parallelplay/.aws/credentials ] || credentials_hidden=false
[ ! -e /run/secrets ] || credentials_hidden=false
git_hidden=true
[ ! -e /workspace/.git ] || git_hidden=false
socket_hidden=true
[ ! -e /var/run/docker.sock ] || socket_hidden=false
root_read_only=true
printf x > /tmp/root-write-probe 2>/dev/null && root_read_only=false
network_blocked=true
timeout -s KILL 2 wget -q -O /scratch/network.out http://1.1.1.1 2>/dev/null && network_blocked=false
timeout -s KILL 2 nslookup example.com >/scratch/dns.out 2>/dev/null && network_blocked=false
workspace_write=true
printf x > /workspace/workspace-write-probe 2>/dev/null || workspace_write=false
artifact_write=true
printf x > /artifacts/write-probe 2>/dev/null || artifact_write=false
scratch_write=true
printf x > /scratch/write-probe 2>/dev/null || scratch_write=false
printf '{"homeHidden":%s,"markerHidden":%s,"hostSecretHidden":%s,"credentialsHidden":%s,"gitHidden":%s,"socketHidden":%s,"rootReadOnly":%s,"networkBlocked":%s,"workspaceWrite":%s,"artifactWrite":%s,"scratchWrite":%s}\n' \
  "$home_hidden" "$marker_hidden" "$host_secret_hidden" "$credentials_hidden" \
  "$git_hidden" "$socket_hidden" "$root_read_only" "$network_blocked" \
  "$workspace_write" "$artifact_write" "$scratch_write" > /artifacts/containment.json
printf '%s\n' '{"schemaVersion":1,"sequence":2,"type":"capability.used","capability":"workspace.write"}'
printf '%s\n' '{"schemaVersion":1,"sequence":3,"type":"capability.used","capability":"artifact.write"}'
printf '%s\n' '{"schemaVersion":1,"sequence":4,"type":"capability.used","capability":"scratch.write"}'
printf '%s\n' '{"schemaVersion":1,"sequence":5,"type":"artifact.declared","path":"containment.json","role":"agent.output"}'
printf '%s\n' '{"schemaVersion":1,"sequence":6,"type":"terminal","outcome":"succeeded"}'
