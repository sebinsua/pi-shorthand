#!/bin/sh
# Runs the test suite on Linux, in a Debian container with bubblewrap. Needs Docker.
# --privileged lets bubblewrap create namespaces; /tmp is tmpfs because overlayfs can't keep its
# upper directory on the container's own overlay filesystem.
set -e
cd "$(dirname "$0")/.."
docker run --rm --privileged --tmpfs /tmp:exec -v "$PWD":/src:ro debian:trixie sh -c '
	set -e
	apt-get update -qq >/dev/null
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap git curl unzip lsof procps ca-certificates >/dev/null
	curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
	export PATH="$HOME/.bun/bin:$PATH"
	# --no-same-owner: owned by root here, or git refuses the copy ("dubious ownership") in bun install.
	mkdir /work && cd /src && tar --exclude=node_modules -cf - . | tar --no-same-owner -xf - -C /work
	cd /work && bun install >/dev/null
	bun test
'
