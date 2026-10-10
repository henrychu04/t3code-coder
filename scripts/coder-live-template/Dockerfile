FROM node:24-bookworm

ARG RESPONSE_MARKER=t3-coder-real-port-forward-ok
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /root/.t3-coder/node24/bin \
    && ln -s /usr/local/bin/node /root/.t3-coder/node24/bin/node \
    && printf '%s\n' '#!/bin/sh' 'exit 0' > /usr/local/bin/claude \
    && chmod 755 /usr/local/bin/claude \
    && mkdir -p /srv/t3-port-forward \
    && printf '%s\n' "$RESPONSE_MARKER" > /srv/t3-port-forward/index.html

ENV HOME=/root
WORKDIR /root
