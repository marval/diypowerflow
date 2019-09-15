FROM node:10-slim
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "project.js"]

EXPOSE 3333
