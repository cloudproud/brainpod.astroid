FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG RELEASE_ID=dev
ENV RELEASE_ID=$RELEASE_ID
RUN npm run build

FROM node:24-alpine AS prune
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# No `output: standalone` — Next does not trace custom server files, so the
# runtime image carries real node_modules and runs dist/server/index.js.
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=prune /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY migrations ./migrations
COPY package.json next.config.ts ./

ARG RELEASE_ID=dev
ENV RELEASE_ID=$RELEASE_ID

USER 1000
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
