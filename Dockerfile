# Build web + run the server (which also serves web/dist).
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --workspaces --include-workspace-root
COPY . .
RUN npm run build --workspace web

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 4900
CMD ["npm", "start", "--workspace", "server"]
