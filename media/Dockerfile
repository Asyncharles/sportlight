# syntax=docker/dockerfile:1.7
# Demo media origin. Build context: ./media
# Builds (or reuses, if media/dist is present in the context) the transcoded demo library, then
# serves it with nginx. Downloads the checked-in open sports collection on first build.
FROM node:24-alpine AS build
RUN apk add --no-cache ffmpeg python3 py3-pip
RUN python3 -m venv /opt/yt-dlp && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]"
ENV YT_DLP=/opt/yt-dlp/bin/yt-dlp
WORKDIR /media
COPY . .
ARG MEDIA_CONTACT=""
RUN MEDIA_CONTACT="$MEDIA_CONTACT" python3 collect-open.py

FROM nginx:1.27-alpine
COPY --from=build /media/dist /usr/share/nginx/media
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
