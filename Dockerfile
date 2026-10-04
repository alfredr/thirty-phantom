# The game as a container image: the Vite build, served by Caddy on port 80. The box server's proxy terminates TLS in
# front of it.
FROM node:24-alpine AS build
WORKDIR /app
# Git hooks are for development checkouts.
ENV HUSKY=0
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY deploy/serve.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
