# ---- Build Stage ----
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS build

WORKDIR /app

COPY . .
RUN npm install

# Build TypeScript
RUN npm run build

# ---- Production Stage ----
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS production

WORKDIR /app

RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 80

ENV NODE_ENV=production PORT=80 DISPLAY=:99

CMD Xvfb :99 -screen 0 1280x720x24 & node dist/index.js
