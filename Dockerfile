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
CMD ["node", "dist/main"]
