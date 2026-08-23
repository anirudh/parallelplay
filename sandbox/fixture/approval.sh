#!/bin/sh
set -eu
printf '%s\n' '{"schemaVersion":1,"sequence":1,"type":"started"}'
printf '%s\n' '{"schemaVersion":1,"sequence":2,"type":"approval.requested","requestId":"00000000-0000-4000-8000-000000000099","capability":"network.http","reason":"fixture requires public network"}'
sleep 300
