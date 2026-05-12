FROM node:20-alpine
WORKDIR /app

# ffmpeg is required to transcode AMR/3GP call recordings → MP3 so
# browsers (which never ship an AMR decoder) can play them inline.
# 'apk add' from Alpine repos — well-maintained, ~25MB image bloat.
RUN apk add --no-cache ffmpeg

COPY package*.json ./
# --no-fund/--no-audit silences noise; optional deps can fail without aborting
RUN npm install --omit=dev --no-fund --no-audit --include=optional || npm install --omit=dev --no-fund --no-audit

COPY . .

EXPOSE 3000
ENV NODE_ENV=production

CMD ["sh", "-c", "node db/migrate.js && node db/seed.js && node server.js"]
