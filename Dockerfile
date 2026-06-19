# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Do not copy .env; environment variables are injected at runtime.
ENV NODE_ENV=production
EXPOSE 5001

USER node

CMD ["node", "server.js"]
