FROM node:22-alpine AS build
WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile 2>/dev/null || yarn install
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json yarn.lock* ./
RUN (yarn install --production --frozen-lockfile 2>/dev/null || yarn install --production) && yarn cache clean
COPY --from=build /app/dist ./dist
EXPOSE 8101
CMD ["node", "dist/index.js"]
