# Publishing Checklist

## Pre-release Preparation

### 1. Code Quality & Testing

- [ ] All tests passing: `bun run test`
- [ ] Type checking clean: `bun run check`
- [ ] Build succeeds: `bun run build`
- [ ] Benchmark assertions pass: `bun run benchmark:assert`
- [ ] Manual smoke test with real project

### 2. Documentation

- [ ] README.md is up-to-date
- [ ] INSTALLATION.md reviewed
- [ ] CLI help text is accurate (`ragcode --help`)
- [ ] MCP tools documented
- [ ] API examples verified
- [ ] CHANGELOG.md updated with release notes

### 3. Package Configuration

**package.json checks:**
- [ ] `private: false` set
- [ ] Version bumped (follow semver)
- [ ] `keywords` filled for discoverability
- [ ] `repository` URL correct
- [ ] `bugs` URL correct
- [ ] `homepage` URL correct
- [ ] `license` field set
- [ ] `bin` entry points to compiled CLI
- [ ] `files` field configured (or use `.npmignore`)

### 4. Build Artifacts

- [ ] `dist/` contains compiled JavaScript
- [ ] CLI shebang present: `#!/usr/bin/env node`
- [ ] CLI is executable: `chmod +x dist/cli/index.js`
- [ ] Dependencies are production-ready (no dev-only deps in `dependencies`)

### 5. Environment & Compatibility

- [ ] Node.js >= 24 requirement documented
- [ ] Cross-platform paths tested (Windows, macOS, Linux)
- [ ] SQLite native bindings work on target platforms
- [ ] LanceDB compatibility verified

---

## npm Publishing Steps

### First-time Setup

```bash
# Login to npm
npm login

# Verify identity
npm whoami

# Set registry (if using custom)
npm config set registry https://registry.npmjs.org/
```

### Pre-publish Verification

```bash
# Dry run to see what will be published
npm publish --dry-run

# Check package contents
npm pack
tar -tzf ragcode-context-engine-*.tgz
```

### Publish to npm

```bash
# Version bump (choose one)
npm version patch  # 0.1.0 -> 0.1.1
npm version minor  # 0.1.0 -> 0.2.0
npm version major  # 0.1.0 -> 1.0.0

# Build and publish
npm run build
npm publish

# For beta/alpha releases
npm publish --tag beta
npm publish --tag alpha
```

### Post-publish Verification

```bash
# Install globally and test
npm install -g ragcode-context-engine@latest

# Verify commands work
ragcode --version
ragcode --help

# Test on a fresh project
cd /tmp/test-project
ragcode init
ragcode index .
```

---

## Alternative Distribution Methods

### 1. GitHub Releases

```bash
# Tag the release
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0

# Create GitHub release with artifacts
gh release create v0.1.0 \
  --title "v0.1.0" \
  --notes "Release notes here" \
  ./ragcode-context-engine-*.tgz
```

### 2. Docker Image

**Dockerfile** (create in project root):

```dockerfile
FROM node:24-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy built files
COPY dist/ ./dist/
COPY web/ ./web/

# Install globally
RUN npm link

EXPOSE 3000 5173

ENTRYPOINT ["ragcode"]
CMD ["--help"]
```

**Build and publish:**

```bash
# Build image
docker build -t ragcode/ragcode-engine:0.1.0 .
docker tag ragcode/ragcode-engine:0.1.0 ragcode/ragcode-engine:latest

# Push to Docker Hub
docker push ragcode/ragcode-engine:0.1.0
docker push ragcode/ragcode-engine:latest
```

### 3. Standalone Executables (pkg)

```bash
# Install pkg
npm install -g pkg

# Build executables
pkg package.json

# This creates:
# - ragcode-linux
# - ragcode-macos
# - ragcode-win.exe
```

**Add to package.json:**

```json
{
  "pkg": {
    "scripts": "dist/**/*.js",
    "targets": [
      "node24-linux-x64",
      "node24-macos-x64",
      "node24-win-x64"
    ],
    "outputPath": "binaries"
  }
}
```

---

## Version Management

### Semantic Versioning (semver)

- **Patch** (0.1.0 → 0.1.1): Bug fixes, no breaking changes
- **Minor** (0.1.0 → 0.2.0): New features, backward compatible
- **Major** (0.1.0 → 1.0.0): Breaking changes

### Pre-release Versions

```bash
# Alpha
npm version prerelease --preid=alpha
# 0.1.0 -> 0.1.1-alpha.0

# Beta
npm version prerelease --preid=beta
# 0.1.0 -> 0.1.1-beta.0

# Release candidate
npm version prerelease --preid=rc
# 0.1.0 -> 0.1.1-rc.0
```

---

## Post-release Tasks

- [ ] Announce release (Twitter, Reddit, Discord, etc.)
- [ ] Update dependent projects
- [ ] Monitor issue tracker for bug reports
- [ ] Update documentation site (if applicable)
- [ ] Add release to CHANGELOG.md
- [ ] Close milestone (if using GitHub milestones)

---

## Rollback Plan

If a release has critical bugs:

```bash
# Deprecate the bad version
npm deprecate ragcode-context-engine@0.1.1 "Critical bug, use 0.1.2 instead"

# Publish hotfix
npm version patch
npm publish

# Or unpublish within 72 hours (if no one depends on it)
npm unpublish ragcode-context-engine@0.1.1
```

---

## Continuous Deployment (Future)

Consider GitHub Actions workflow for automated publishing:

**.github/workflows/publish.yml:**

```yaml
name: Publish to npm

on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 24
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```
