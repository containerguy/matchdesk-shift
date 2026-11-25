FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app /app
EXPOSE 3000
USER node
CMD ["npm", "start"]
