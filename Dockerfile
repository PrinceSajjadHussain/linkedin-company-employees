FROM apify/actor-node:20 AS builder

COPY package*.json ./
RUN npm install --include=dev --audit=false

COPY . ./
RUN npm run build

FROM apify/actor-node:20

COPY package*.json ./
RUN npm install --omit=dev --audit=false

COPY --from=builder /usr/src/app/dist ./dist
COPY .actor ./.actor

CMD ["npm", "run", "start:prod"]
