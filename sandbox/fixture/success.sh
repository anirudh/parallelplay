#!/bin/sh
set -eu
printf '%s\n' '{"schemaVersion":1,"sequence":1,"type":"started"}'
printf '%s\n' 'agent candidate' >> README.md
printf '%s\n' 'fixture artifact' > /artifacts/result.txt
printf '%s\n' '{"schemaVersion":1,"sequence":2,"type":"capability.used","capability":"workspace.write"}'
printf '%s\n' '{"schemaVersion":1,"sequence":3,"type":"capability.used","capability":"artifact.write"}'
printf '%s\n' '{"schemaVersion":1,"sequence":4,"type":"artifact.declared","path":"result.txt","role":"agent.output"}'
printf '%s\n' '{"schemaVersion":1,"sequence":5,"type":"usage","cpuMillis":1,"memoryPeakBytes":1048576}'
printf '%s\n' '{"schemaVersion":1,"sequence":6,"type":"terminal","outcome":"succeeded"}'
