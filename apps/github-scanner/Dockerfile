# The repo-scanner worker.
#
# node:http service that clones a bounded slice of a GitHub repo and runs
# gitleaks (secrets in history) and osv-scanner (known-vuln dependencies) over
# it, returning findings to the web app's Inngest step. It never talks to the
# database; the web app is the only writer.
#
# Build context is the repository ROOT (mirrors apps/scanner):
#   docker build -f apps/github-scanner/Dockerfile -t scanlyfix/github-scanner .
#
# The two scanner binaries are pinned to exact versions and verified against
# their upstream SHA-256 checksums at build time, so a tampered or substituted
# release asset fails the build instead of shipping. The versions below MUST
# stay in sync with GITLEAKS_VERSION / OSV_SCANNER_VERSION in src/tools.ts.

# --- Stage 1: fetch + verify the pinned scanner binaries -----------------
FROM alpine:3.21 AS tools

ARG TARGETARCH

# Pinned tool versions — keep in sync with src/tools.ts.
ARG GITLEAKS_VERSION=8.30.1
ARG OSV_SCANNER_VERSION=2.5.1

RUN apk add --no-cache curl ca-certificates tar

RUN set -eux; \
    # Map Docker's TARGETARCH to each upstream's asset naming. gitleaks names
    # its x86-64 asset "x64"; osv-scanner names it "amd64". Checksums are the
    # SHA-256 digests published on the corresponding GitHub release.
    case "$TARGETARCH" in \
      amd64) gitleaks_arch=x64;   osv_arch=amd64; \
             gitleaks_sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb; \
             osv_sha=f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be ;; \
      arm64) gitleaks_arch=arm64; osv_arch=arm64; \
             gitleaks_sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080; \
             osv_sha=3d0f5aa5a6baa8eb32bcef247388e149ef6030a6634ccae6fa0d62681fb27a6d ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    # gitleaks ships a tarball containing the static binary.
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz" -o /tmp/gitleaks.tar.gz; \
    echo "${gitleaks_sha}  /tmp/gitleaks.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/gitleaks; \
    tar -xzf /tmp/gitleaks.tar.gz -C /tmp/gitleaks; \
    cp /tmp/gitleaks/gitleaks /usr/local/bin/gitleaks; \
    chmod 0755 /usr/local/bin/gitleaks; \
    rm -rf /tmp/gitleaks /tmp/gitleaks.tar.gz; \
    # osv-scanner ships a single static binary.
    curl -fsSL "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${osv_arch}" -o /usr/local/bin/osv-scanner; \
    echo "${osv_sha}  /usr/local/bin/osv-scanner" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/osv-scanner; \
    # Smoke-check that both binaries actually execute on this base. A
    # dynamically-linked or wrong-arch binary fails here, at build time,
    # instead of at the first scan.
    gitleaks version; \
    osv-scanner --version

# --- Stage 2: the service ------------------------------------------------
FROM node:22-alpine

ENV NODE_ENV=production \
    PNPM_HOME=/usr/local/bin
RUN corepack enable

# git performs the bounded clone; ca-certificates lets git (and Node's fetch)
# verify github.com's TLS.
RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Bring in the checksum-verified scanner binaries from the tools stage.
COPY --from=tools /usr/local/bin/gitleaks    /usr/local/bin/gitleaks
COPY --from=tools /usr/local/bin/osv-scanner /usr/local/bin/osv-scanner

# Workspace manifests first, so a source-only change does not reinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/github-scanner/package.json ./apps/github-scanner/
COPY packages/repo-checks/package.json ./packages/repo-checks/
COPY packages/checks/package.json     ./packages/checks/

# --filter pulls @scanlyfix/repo-checks (and its @scanlyfix/checks + yaml deps),
# which the worker needs to run the repo checks over the assembled context.
RUN pnpm install --frozen-lockfile --filter @scanlyfix/github-scanner...

COPY packages/checks      ./packages/checks
COPY packages/repo-checks ./packages/repo-checks
COPY apps/github-scanner  ./apps/github-scanner

WORKDIR /app/apps/github-scanner
EXPOSE 8081

# Runs as the image's non-root `node` user. Scans only write to an ephemeral
# temp dir, never into the image.
USER node

# SCANLYFIX_REPO_SCANNER_TOKEN must be supplied at run time. The process refuses
# to start without it rather than listening unauthenticated — see src/index.ts.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
