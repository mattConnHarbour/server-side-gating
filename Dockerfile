FROM node:22-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY server.ts demo-server.ts ./
COPY validator ./validator
ENV NODE_ENV=production
CMD ["pnpm", "start"]
