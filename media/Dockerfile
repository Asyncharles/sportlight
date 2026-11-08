# syntax=docker/dockerfile:1.7
# Demo media origin. Build context: ./media
# Builds (or reuses, if media/dist is present in the context) the core open sports set from
# open-sources.json, then serves it with nginx. Downloads come straight from Wikimedia Commons,
# which asks bulk clients to identify themselves: pass MEDIA_CONTACT (a project URL or email).
FROM alpine:3.20 AS build
RUN apk add --no-cache ffmpeg python3
WORKDIR /media
COPY . .
ARG MEDIA_CONTACT=""
RUN MEDIA_CONTACT="$MEDIA_CONTACT" python3 collect-open.py

FROM nginx:1.27-alpine
COPY --from=build /media/dist /usr/share/nginx/media
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
