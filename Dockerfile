FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
ENV NODE_ENV=production

CMD ["sh", "-c", "node db/migrate.js && node db/seed.js && node server.js"]
