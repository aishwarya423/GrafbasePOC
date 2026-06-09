FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js .
COPY schemas ./schemas

EXPOSE 4000
CMD ["npm", "start"]
