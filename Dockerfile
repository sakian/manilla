# Multi-stage build producing a small runtime image.
#
# Node 24 matches the local toolchain. The final stage runs Next's standalone
# output, which bundles only the dependencies actually reached at runtime.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Run as a non-root user. The node image already ships one.
RUN chown -R node:node /app
USER node

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Migrations and the schema travel with the image so the container can bring the
# database up to date on start.
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=build --chown=node:node /app/node_modules/postgres ./node_modules/postgres

EXPOSE 3000
CMD ["node", "server.js"]
