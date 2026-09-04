# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__
ENV VITE_DEFAULT_API_KEY=__VITE_DEFAULT_API_KEY_PLACEHOLDER__
ENV VITE_API_PROXY_AVAILABLE=__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__
ENV VITE_API_PROXY_LOCKED=__VITE_API_PROXY_LOCKED_PLACEHOLDER__
ENV VITE_SERVER_MANAGED_API_CONFIG=__VITE_SERVER_MANAGED_API_CONFIG_PLACEHOLDER__
ENV VITE_DOCKER_DEPLOYMENT=__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__
ENV VITE_DOCKER_LEGACY_API_URL_USED=__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__
ENV VITE_SHOW_PRESET_CONFIG_ONLY=__VITE_SHOW_PRESET_CONFIG_ONLY_PLACEHOLDER__
ENV VITE_LOCK_PRESET_CONFIG_PARAMS=__VITE_LOCK_PRESET_CONFIG_PARAMS_PLACEHOLDER__
ENV VITE_PREVENT_PRESET_CONFIG_DELETION=__VITE_PREVENT_PRESET_CONFIG_DELETION_PLACEHOLDER__

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM nginx:alpine

RUN apk add --no-cache nodejs

ENV HOST=0.0.0.0
ENV PORT=80
ENV DEFAULT_API_URL=
ENV DEFAULT_API_KEY=
ENV API_PROXY_URL=
ENV ENABLE_API_PROXY=false
ENV LOCK_API_PROXY=false
ENV SHOW_PRESET_CONFIG_ONLY=false
ENV LOCK_PRESET_CONFIG_PARAMS=false
ENV PREVENT_PRESET_CONFIG_DELETION=false
ENV SERVER_MANAGED_API_CONFIG=true
ENV API_CONFIG_FILE=/etc/gpt-image-playground/api-config.env
ENV CHAT_API_URL=https://ai-pixel.online/v1
ENV IMAGE_1K_API_URL=https://ai-pixel.online/v1
ENV IMAGE_4K_API_URL=https://direct.linkai.pics/v1
ENV CHAT_API_KEY=
ENV IMAGE_1K_API_KEY=
ENV IMAGE_4K_API_KEY=
ENV ASYNC_TASK_DATA_DIR=/var/lib/gpt-image-playground/tasks
ENV ASYNC_TASK_CONCURRENCY=2

COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 deploy/migrate-api-env.envsh /docker-entrypoint.d/05-migrate-api-env.envsh
COPY --chmod=755 deploy/inject-api-url.sh /docker-entrypoint.d/40-inject-api-url.sh
COPY --chmod=755 deploy/async-task-server.mjs /opt/gpt-image-playground/async-task-server.mjs

RUN mkdir -p /var/lib/gpt-image-playground/tasks

EXPOSE 80

CMD ["sh", "-c", "node /opt/gpt-image-playground/async-task-server.mjs & exec nginx -g 'daemon off;'"]
