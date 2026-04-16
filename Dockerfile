# Using Microsoft's official Playwright image — ships chromium + all the
# system libs (libnss3, libcups, fonts-liberation, …) a browser needs. Match
# the Playwright version in package.json so the bundled chromium matches too.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

ENV NODE_ENV=production \
    HEADLESS=true \
    PORT=3000

WORKDIR /app

# Copy manifests first to keep the npm install layer cacheable.
COPY package*.json ./

# No devDependencies in the image — nodemon isn't needed at runtime.
# --ignore-scripts skips the `playwright install chromium` postinstall since
# the base image already ships a matched chromium.
RUN npm install --omit=dev --ignore-scripts

COPY . .

# Dedicated, writable dirs for the storage-state file and failure
# screenshots. Mount a volume here to persist the PartsLink24 session
# across container restarts (otherwise we re-login on cold start, which
# takes ~20s but works fine).
RUN mkdir -p /app/sessions /app/artifacts

EXPOSE 3000
CMD ["node", "src/server.js"]
