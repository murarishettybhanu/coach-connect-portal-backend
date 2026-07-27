# syntax=docker/dockerfile:1

# ---- Build stage (full image: has toolchain to compile native deps like bcrypt) ----
FROM node:22 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package*.json ./
# Reuse node_modules compiled in the builder (same glibc base), then drop dev deps.
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
# Liveness: the app serves a root route under the /api global prefix.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD ["node","-e","fetch('http://localhost:'+(process.env.PORT||3000)+'/api').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Drop root privileges (the `node` user ships in the official image).
USER node
CMD ["node", "dist/main"]
