# syntax=docker/dockerfile:1.29.0@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

ARG RUNTIME_BASE=ghcr.io/renovatebot/renovate:44.236.4@sha256:2b0daae619c4dc49ec7c7dfa83319712b3a7f566a7703022f3a381cedd3976e9
FROM ${RUNTIME_BASE}

ARG RUNTIME_BASE
ARG RENOVATE_VERSION
ARG SOURCE_REVISION

# The stable backport leaves the official runtime's production dependencies unchanged.
USER root
RUN rm -rf /usr/local/renovate/dist
COPY --chown=0:0 dist/ /usr/local/renovate/dist/
COPY --chown=0:0 package.json renovate-schema.json renovate-global-schema.json renovate-inherited-schema.json license /usr/local/renovate/

LABEL org.opencontainers.image.source="https://github.com/rldyourmnd/renovate" \
  org.opencontainers.image.revision="${SOURCE_REVISION}" \
  org.opencontainers.image.version="${RENOVATE_VERSION}" \
  org.label-schema.version="${RENOVATE_VERSION}" \
  org.opencontainers.image.base.name="${RUNTIME_BASE}" \
  org.opencontainers.image.licenses="AGPL-3.0-only"

USER 12021
