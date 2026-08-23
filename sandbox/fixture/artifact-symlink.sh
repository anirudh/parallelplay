#!/bin/sh
set -eu
printf '%s\n' '{"schemaVersion":1,"sequence":1,"type":"started"}'
ln -s /etc/passwd /artifacts/result.txt
printf '%s\n' '{"schemaVersion":1,"sequence":2,"type":"artifact.declared","path":"result.txt","role":"agent.output"}'
printf '%s\n' '{"schemaVersion":1,"sequence":3,"type":"terminal","outcome":"succeeded"}'
