# syntax=docker/dockerfile:1.7
# Demo media origin. Build context: ./media
# Builds (or reuses, if media/dist is present in the context) the transcoded demo library, then
# serves it with nginx. Downloads come from Wikimedia Commons on first build.
FROM node:20.18-alpine AS build
RUN apk add --no-cache ffmpeg
WORKDIR /media
COPY . .
RUN node build.mjs

FROM nginx:1.27-alpine
COPY --from=build /media/dist /usr/share/nginx/media
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
