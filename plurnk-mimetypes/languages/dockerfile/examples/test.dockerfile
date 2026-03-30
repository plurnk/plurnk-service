FROM node:22-alpine AS builder
ARG NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
LABEL maintainer="test@example.com"
WORKDIR /app
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
