# ---- Build Stage ----
FROM oven/bun:1.1.13 AS build

WORKDIR /app

COPY . .

RUN bun install

# Build TypeScript (if you have a build script, otherwise use tsc directly)
RUN bun run build

# ---- Production Stage ----
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y xvfb unzip && rm -rf /var/lib/apt/lists/*

# Install Bun in the production image
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lockb ./

EXPOSE 80

ENV NODE_ENV=production PORT=80 DISPLAY=:99

CMD Xvfb :99 -screen 0 1280x720x24 & bun dist/index.js
