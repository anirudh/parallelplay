#!/bin/sh
set -eu
printf '%s\n' '{"schemaVersion":1,"sequence":1,"type":"started"}'
printf '%s\n' '{"schemaVersion":1,"sequence":2,"type":"capability.used","capability":"network.http"}'
sleep 300
